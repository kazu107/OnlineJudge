// next-app/pages/api/submit.js
// import { exec } from 'child_process'; // No longer using direct exec for standard evaluation's primary path
import fs from 'fs';
import path from 'path';
import os from 'os';
import fetch from 'node-fetch';

const EXECUTOR_BASE_URL = process.env.EXECUTOR_URL || 'http://localhost:3001';
const CONTAINER_EVALUATOR_PATH = "/app/evaluator.py";
const CONTAINER_USER_SOLUTION_PATH = "/app/user_solution.txt";
const CONTAINER_TEST_DATA_PATH = "/app/test_data.file";

function sendSse(res, data, flushFn) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    flushFn();
}

async function handleStandardEvaluation(req, res, flush, problemId, language, code, meta, tmpDir /*, solutionPath - code is passed directly now */) {
    const categories = meta.test_case_categories;
    const problemTimeoutMs = meta.timeout || 2000;
    const problemMemoryKb = meta.memory_limit_kb;

    if (!categories || !Array.isArray(categories)) {
        sendSse(res, { type: 'error', message: 'Invalid problem metadata: test_case_categories not found or not an array' }, flush);
        return;
    }

    let totalPointsEarned = 0;
    const maxTotalPoints = categories.reduce((sum, cat) => sum + (cat.points || 0), 0);
    const categorySummaries = [];

    for (const category of categories) {
        let categoryPointsAwarded = category.points || 0;
        let allTestsInThisCategoryPassed = true;

        for (const testCase of category.test_cases) {
            const testCaseName = path.basename(testCase.input);
            const inputFilePath = path.join(process.cwd(), testCase.input);
            let currentTestCaseResult = { type: 'test_case_result', category_name: category.category_name, testCase: testCaseName };

            if (!fs.existsSync(inputFilePath)) {
                currentTestCaseResult = { ...currentTestCaseResult, status: 'Error', message: 'Input file not found' };
                sendSse(res, currentTestCaseResult, flush);
                allTestsInThisCategoryPassed = false;
                continue;
            }
            const stdinContent = fs.readFileSync(inputFilePath, 'utf8');

            try {
                const executePayload = {
                    language,
                    code,
                    stdin: stdinContent,
                    time_limit_ms: problemTimeoutMs,
                    memory_limit_kb: problemMemoryKb
                };
                const executorExecuteUrl = `${EXECUTOR_BASE_URL}/execute`;
                const executeResponse = await fetch(executorExecuteUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(executePayload),
                    timeout: problemTimeoutMs + 2000 // Network + buffer timeout
                });

                const result = await executeResponse.json();
                let testStatus = '';
                
                if (!executeResponse.ok || result.errorType) {
                    // Map executor error types to judge statuses
                    switch (result.errorType) {
                        case 'compile_error': testStatus = 'Compilation Error'; break;
                        case 'timeout': testStatus = 'TLE'; break;
                        case 'memory_exceeded': testStatus = 'MLE'; break;
                        case 'runtime_error': testStatus = 'Runtime Error'; break;
                        default: testStatus = 'Error';
                    }
                    currentTestCaseResult = { ...currentTestCaseResult, status: testStatus, message: result.message || result.stderr || result.error, time: result.durationMs, memory: result.memoryKb, got: result.stdout };
                } else {
                    // Successful execution, now check output
                    const output = result.stdout.trim(); // Executor returns stdout without extra processing
                    const execTimeMs = result.durationMs;
                    const memUsage = result.memoryKb;

                    const expectedOutputPath = path.join(process.cwd(), testCase.output);
                    if (!fs.existsSync(expectedOutputPath)) {
                        testStatus = 'Error';
                        currentTestCaseResult.message = 'Expected output file not found';
                    } else {
                        const expectedOutput = fs.readFileSync(expectedOutputPath, 'utf8').trim();
                        if (output === expectedOutput) {
                            testStatus = 'Accepted';
                        } else {
                            testStatus = 'Wrong Answer';
                            currentTestCaseResult.expected = expectedOutput;
                        }
                    }
                    currentTestCaseResult = { ...currentTestCaseResult, status: testStatus, time: execTimeMs, memory: memUsage, got: output };
                }
            } catch (err) {
                currentTestCaseResult = { ...currentTestCaseResult, status: 'Error', message: `Submission execution failed: ${err.message}` };
                 if (err.type === 'request-timeout' || err.code === 'ETIMEDOUT') {
                    currentTestCaseResult.status = 'TLE'; // Or a specific system TLE
                    currentTestCaseResult.message = "Execution request timed out.";
                }
            }
            sendSse(res, currentTestCaseResult, flush);
            if (currentTestCaseResult.status !== 'Accepted') allTestsInThisCategoryPassed = false;
        }

        if (!allTestsInThisCategoryPassed) categoryPointsAwarded = 0;
        totalPointsEarned += categoryPointsAwarded;
        sendSse(res, { type: 'category_result', category_name: category.category_name, category_points_earned: categoryPointsAwarded, category_max_points: category.points || 0, all_tests_in_category_passed: allTestsInThisCategoryPassed }, flush);
        categorySummaries.push({ category_name: category.category_name, points_earned: categoryPointsAwarded, max_points: category.points || 0 });
    }
    sendSse(res, { type: 'final_result', total_points_earned: totalPointsEarned, max_total_points: maxTotalPoints, category_summary: categorySummaries }, flush);
}

async function handleCustomEvaluation(req, res, flush, problemId, language, code, meta, tmpDir) {
    let totalPointsEarned = 0;
    const maxTotalPoints = meta.max_total_points || meta.test_cases.reduce((sum, tc) => sum + (tc.points || 0), 0);
    const testCaseResultsSummary = [];

    for (const testCase of meta.test_cases) {
        const testCaseId = testCase.id || path.basename(testCase.data_file);
        let pointsEarnedForTestCase = 0;
        let testCaseStatus = "Processing";
        let message = "";
        let userStdoutContent = ""; // This will now be passed as content, not path
        let evaluatorStderr = "";
        let userCodeExecutionTime = null;
        let userCodeMemoryUsage = null;


        const userCodeExecTimeout = meta.time_limit_ms || meta.timeout || 5000;
        const userCodeMemoryLimit = meta.memory_limit_kb;

        try {
            let stdinContent = ""; // For custom eval, user code usually doesn't take problem-instance specific stdin
                                  // but this can be adapted if needed.
            const executePayload = {
                language,
                code,
                stdin: stdinContent,
                time_limit_ms: userCodeExecTimeout,
                memory_limit_kb: userCodeMemoryLimit
            };
            const executorExecuteUrl = `${EXECUTOR_BASE_URL}/execute`;
            const executeResponse = await fetch(executorExecuteUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(executePayload),
                timeout: userCodeExecTimeout + 2000 // Network + buffer
            });

            const executeResult = await executeResponse.json();
            userCodeExecutionTime = executeResult.durationMs;
            userCodeMemoryUsage = executeResult.memoryKb;

            if (!executeResponse.ok || executeResult.errorType) {
                testCaseStatus = "User Code Error";
                switch (executeResult.errorType) {
                    case 'compile_error': testCaseStatus = 'Compilation Error'; break;
                    case 'timeout': testCaseStatus = 'User Code TLE'; break;
                    case 'memory_exceeded': testCaseStatus = 'User Code MLE'; break;
                    case 'runtime_error': testCaseStatus = 'User Code Runtime Error'; break;
                }
                message = executeResult.message || executeResult.stderr || executeResult.error || "User code execution failed on executor.";
                userStdoutContent = executeResult.stdout || ""; // Capture stdout even on error
            } else {
                userStdoutContent = executeResult.stdout;
                testCaseStatus = "User Code Executed";
            }
        } catch (err) {
            testCaseStatus = "User Code Error";
            message = `Failed to execute user code via executor: ${err.message}`;
            if (err.type === 'request-timeout' || err.code === 'ETIMEDOUT') {
                 testCaseStatus = "User Code TLE";
                 message = "User code execution timed out (communication with executor).";
            }
        }

        if (testCaseStatus === "User Code Executed") {
            const evaluatorScriptHostPath = path.join(process.cwd(), meta.custom_evaluator_options.evaluator_script);
            const testDataHostPath = path.join(process.cwd(), testCase.data_file);
            const evaluatorTimeout = meta.custom_evaluator_options.evaluator_time_limit_ms || 10000;

            if (!fs.existsSync(evaluatorScriptHostPath)) {
                testCaseStatus = "System Error"; message = "Evaluator script not found on host.";
            } else if (!fs.existsSync(testDataHostPath)) {
                testCaseStatus = "System Error"; message = `Test data file ${testCase.data_file} not found on host.`;
            } else {
                const evaluatePayload = {
                    evaluator_script_host_path: evaluatorScriptHostPath,
                    user_solution_content: userStdoutContent, // Pass content directly
                    test_data_host_path: testDataHostPath,
                    // Container paths are now handled by the executor service if it needs them internally
                    // For child_process based executor, these specific container paths might not be directly used
                    // in the /evaluate call if the evaluator runs on the host or in a predefined env.
                    // However, if the new executor still uses Docker for evaluators, it would need them.
                    // Assuming the new executor handles paths based on host paths now for evaluators.
                    max_points: testCase.points.toString(),
                    evaluator_language: meta.custom_evaluator_options.evaluator_language || 'python3', // executor uses 'python' not python3
                    timeout: evaluatorTimeout // This is timeout_ms for the executor's evaluateCode
                };

                try {
                    const executorEvaluateUrl = `${EXECUTOR_BASE_URL}/evaluate`;
                    const evaluateResponse = await fetch(executorEvaluateUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(evaluatePayload),
                        timeout: evaluatorTimeout + 2000 // Network + buffer
                    });

                    const evaluateResult = await evaluateResponse.json();

                    if (!evaluateResponse.ok || !evaluateResult.success) {
                        testCaseStatus = "Evaluation Error";
                        message = evaluateResult.message || `Executor /evaluate failed with status ${evaluateResponse.status}`;
                        evaluatorStderr = evaluateResult.stderr || "";
                    } else {
                        pointsEarnedForTestCase = parseFloat(evaluateResult.evaluation_result.score) || 0;
                        message = evaluateResult.evaluation_result.message || "Evaluation completed.";
                        if(evaluateResult.evaluation_result.error) {
                            testCaseStatus = "Evaluator Reported Error";
                            message += ` (Evaluator Error: ${evaluateResult.evaluation_result.error})`;
                            pointsEarnedForTestCase = 0;
                        } else {
                            testCaseStatus = "Custom Evaluated";
                        }
                        evaluatorStderr = evaluateResult.stderr || "";
                    }
                } catch (err) {
                    testCaseStatus = "Evaluation Error";
                    message = `Failed to run evaluation via executor: ${err.message}`;
                     if (err.type === 'request-timeout' || err.code === 'ETIMEDOUT') {
                        testCaseStatus = "Evaluation TLE";
                        message = "Evaluation timed out (communication with executor).";
                    }
                }
            }
        }
        
        totalPointsEarned += pointsEarnedForTestCase;
        const sseEventData = {
            type: 'test_case_result',
            test_case_id: testCaseId,
            status: testCaseStatus,
            points_earned: pointsEarnedForTestCase,
            max_points: testCase.points,
            message: message,
            time: userCodeExecutionTime, // User code execution time from /execute
            memory: userCodeMemoryUsage, // User code memory usage from /execute
            stdout_user: userStdoutContent, 
            stderr_evaluator: evaluatorStderr 
        };
        sendSse(res, sseEventData, flush);
        testCaseResultsSummary.push({id: testCaseId, score: pointsEarnedForTestCase, max_points: testCase.points, status: testCaseStatus, message: message});
    }
    sendSse(res, { type: 'final_result', total_points_earned: totalPointsEarned, max_total_points: maxTotalPoints, test_case_summary: testCaseResultsSummary }, flush);
}

async function handleInteractiveEvaluation(req, res, flush, problemId, language, code, meta, tmpDir) {
    // 2.a. Initial Setup
    const { interactive_evaluator_options, test_cases } = meta;
    const problemTimeLimitMs = meta.time_limit_ms || 3000; // Default time limit for user's code
    const problemMemoryLimitKb = meta.memory_limit_kb || 256000; // Default memory limit

    if (!interactive_evaluator_options || !interactive_evaluator_options.evaluator_script_relative_path || !interactive_evaluator_options.evaluator_language) {
        sendSse(res, { type: 'error', message: 'Invalid problem metadata: interactive_evaluator_options missing or incomplete.' }, flush);
        return;
    }
    if (!test_cases || !Array.isArray(test_cases)) {
        sendSse(res, { type: 'error', message: 'Invalid problem metadata: test_cases not found or not an array for interactive problem.' }, flush);
        return;
    }

    let totalPointsEarned = 0;
    const maxTotalPoints = meta.total_max_points || test_cases.reduce((sum, tc) => sum + (tc.points || 0), 0);
    const testCaseResultsSummary = [];

    // 2.b. Loop Through Test Cases
    for (const testCase of test_cases) {
        const testCaseId = testCase.id || `test_case_${testCaseResultsSummary.length + 1}`;
        let pointsEarnedForTestCase = 0;
        let currentStatus = "Processing";
        let resultMessage = "";
        let resultTime = null;
        let resultMemory = null;
        let interactionLog = [];
        let userStderr = "";
        let evaluatorStderr = "";

        try {
            // 2.b.i. Prepare for /execute_interactive call
            const evaluatorScriptPath = path.join(process.cwd(), 'problems', problemId, interactive_evaluator_options.evaluator_script_relative_path);
            const evaluatorLanguage = interactive_evaluator_options.evaluator_language;
            
            // Ensure evaluator script exists (optional, executor also checks)
            if (!fs.existsSync(evaluatorScriptPath)) {
                 currentStatus = "System Error";
                 resultMessage = `Evaluator script not found at ${evaluatorScriptPath}`;
                 sendSse(res, { type: 'test_case_result', problem_type: 'interactive', test_case_id: testCaseId, status: currentStatus, points_earned: 0, max_points: testCase.points, message: resultMessage, interaction_log: [], user_stderr: '', evaluator_stderr: '' }, flush);
                 testCaseResultsSummary.push({ id: testCaseId, score: 0, max_points: testCase.points, status: currentStatus, message: resultMessage });
                 continue;
            }

            let evaluatorStartupData = null;
            if (testCase.evaluator_params) {
                try {
                    evaluatorStartupData = JSON.stringify(testCase.evaluator_params);
                } catch (stringifyError) {
                    currentStatus = "System Error";
                    resultMessage = `Failed to stringify evaluator_params for test case ${testCaseId}: ${stringifyError.message}`;
                    sendSse(res, { type: 'test_case_result', problem_type: 'interactive', test_case_id: testCaseId, status: currentStatus, points_earned: 0, max_points: testCase.points, message: resultMessage, interaction_log: [], user_stderr: '', evaluator_stderr: '' }, flush);
                    testCaseResultsSummary.push({ id: testCaseId, score: 0, max_points: testCase.points, status: currentStatus, message: resultMessage });
                    continue; 
                }
            }

            const executePayload = {
                language,
                code,
                evaluator_script_host_path: evaluatorScriptPath,
                evaluator_language: evaluatorLanguage,
                evaluator_startup_data: evaluatorStartupData,
                time_limit_ms: problemTimeLimitMs,
                memory_limit_kb: problemMemoryLimitKb
            };

            // 2.b.ii. Call /execute_interactive Endpoint
            const executorInteractiveUrl = `${EXECUTOR_BASE_URL}/execute_interactive`;
            // Timeout for fetch should be greater than user program's time limit + some buffer for evaluator & network
            // Assuming evaluator is quick, adding a fixed buffer. If evaluator has its own configurable limit, use that.
            const fetchTimeout = problemTimeLimitMs + (interactive_evaluator_options.evaluator_time_limit_ms || 5000) + 3000; // Added 3s buffer

            const executeResponse = await fetch(executorInteractiveUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(executePayload),
                timeout: fetchTimeout 
            });

            const result = await executeResponse.json();

            // 2.b.iii. Process Response
            currentStatus = result.status || "Error"; // Executor should provide a status
            resultMessage = result.message || "No message from executor.";
            resultTime = result.durationMs;
            resultMemory = result.memoryKb;
            interactionLog = result.interaction_log || [];
            userStderr = result.user_stderr || "";
            evaluatorStderr = result.evaluator_stderr || "";
            
            if (!executeResponse.ok) { // HTTP error from executor
                 if (result.error_type && result.message) { // Executor sent a structured error
                    currentStatus = result.status || "Executor Error"; // Use status from executor if available
                    resultMessage = `Executor error: ${result.message} (Type: ${result.error_type})`;
                 } else { // Non-JSON error or other HTTP error from executor
                    currentStatus = "Executor Error";
                    resultMessage = `Executor service returned HTTP ${executeResponse.status}. Response: ${await executeResponse.text()}`;
                 }
            } else { // HTTP OK, use status from result payload
                if (result.status === 'Accepted') {
                    pointsEarnedForTestCase = testCase.points || 0;
                }
                // Other statuses from executor ('WrongAnswer', 'TimeLimitExceeded', 'RuntimeError', 'CompileError', 'EvaluatorError')
                // result in 0 points for the test case.
            }

        } catch (err) {
            currentStatus = "Submission Error"; // Error in this submit.js logic
            resultMessage = `Failed to process interactive test case ${testCaseId}: ${err.message}`;
            if (err.name === 'AbortError' || err.type === 'request-timeout' || err.code === 'ETIMEDOUT') { // fetch timeout
                currentStatus = "Network Timeout"; 
                resultMessage = `Request to executor timed out for test case ${testCaseId}. Check executor service.`;
            }
             interactionLog = [{source: 'system_error', data: resultMessage, timestamp: Date.now()}]; // Add system error to log
        }
        
        totalPointsEarned += pointsEarnedForTestCase;

        // Send Test Case Result via SSE
        sendSse(res, { 
            type: 'test_case_result', 
            problem_type: 'interactive', 
            test_case_id: testCaseId, 
            status: currentStatus, 
            points_earned: pointsEarnedForTestCase, 
            max_points: testCase.points, 
            message: resultMessage, 
            time: resultTime, 
            memory: resultMemory, 
            interaction_log: interactionLog, 
            user_stderr: userStderr, 
            evaluator_stderr: evaluatorStderr 
        }, flush);
        
        testCaseResultsSummary.push({ 
            id: testCaseId, 
            score: pointsEarnedForTestCase, 
            max_points: testCase.points, 
            status: currentStatus, 
            message: resultMessage,
            time: resultTime,
            memory: resultMemory
            // Do not include full interaction log in summary, it can be large
        });
    }

    // 2.c. Send Final Result
    sendSse(res, { 
        type: 'final_result', 
        total_points_earned: totalPointsEarned, 
        max_total_points: maxTotalPoints, 
        test_case_summary: testCaseResultsSummary 
    }, flush);
}


export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).end();
        return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const flush = () => { if (res.flush) res.flush(); };

    const { problemId, language, code } = req.body;
    if (!problemId || !language || !code) {
        sendSse(res, { type: 'error', message: 'Missing parameters' }, flush);
        res.end();
        return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `submission-${problemId}-`));
    
    const metaPath = path.join(process.cwd(), 'problems', problemId, 'meta.json');
    if (!fs.existsSync(metaPath)) {
        sendSse(res, { type: 'error', message: 'Problem meta not found' }, flush);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        res.end();
        return;
    }
    
    let meta;
    try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (e) {
        sendSse(res, { type: 'error', message: `Failed to parse meta.json: ${e.message}` }, flush);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        res.end();
        return;
    }

    try {
        if (meta.evaluation_mode === "interactive") {
            if (!meta.interactive_evaluator_options || !meta.interactive_evaluator_options.evaluator_script_relative_path || !meta.test_cases) {
                sendSse(res, { type: 'error', message: 'Invalid meta.json for interactive problem: missing options, script path, or test_cases.' }, flush);
            } else {
                await handleInteractiveEvaluation(req, res, flush, problemId, language, code, meta, tmpDir);
            }
        } else if (meta.evaluation_mode === "custom_evaluator") {
            if (!meta.custom_evaluator_options || !meta.custom_evaluator_options.evaluator_script || !meta.test_cases) {
                 sendSse(res, { type: 'error', message: 'Invalid meta.json for custom_evaluator: missing options, script, or test_cases.' }, flush);
            } else {
                await handleCustomEvaluation(req, res, flush, problemId, language, code, meta, tmpDir);
            }
        } else { // Default to standard evaluation
            if (!meta.test_case_categories || !Array.isArray(meta.test_case_categories)) {
                 sendSse(res, { type: 'error', message: 'Invalid meta.json for standard evaluation: test_case_categories missing.' }, flush);
            } else {
                await handleStandardEvaluation(req, res, flush, problemId, language, code, meta, tmpDir);
            }
        }
    } catch (error) {
        console.error("Critical error in submission handler:", error);
        sendSse(res, { type: 'error', message: `An unexpected server error occurred: ${error.message}` }, flush);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        res.end();
    }
}
