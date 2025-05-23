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

    // tmpDir is primarily for standard evaluation if it needs to write solution/input files
    // For custom evaluation, user's code output is passed in memory.
    // However, problem data files and evaluator scripts are read from their persistent locations.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `submission-${problemId}-`));
    
    // For standard evaluation, user's code might still be written to disk if the old model expected it.
    // With the new executor, code is passed as string. This write might be vestigial for standard too.
    // Let's remove it from here and pass `code` string directly.
    // let userCodeSolutionFileName = ''; 
    // switch (language) { ... }
    // const userCodeSolutionPath = path.join(tmpDir, userCodeSolutionFileName);
    // fs.writeFileSync(userCodeSolutionPath, code); 

    const metaPath = path.join(process.cwd(), 'problems', problemId, 'meta.json');
    if (!fs.existsSync(metaPath)) {
        sendSse(res, { type: 'error', message: 'Problem meta not found' }, flush);
        fs.rmSync(tmpDir, { recursive: true, force: true }); // Clean tmpDir before exiting
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
        if (meta.evaluation_mode === "custom_evaluator") {
            if (!meta.custom_evaluator_options || !meta.custom_evaluator_options.evaluator_script || !meta.test_cases) {
                 sendSse(res, { type: 'error', message: 'Invalid meta.json for custom_evaluator: missing options, script, or test_cases.' }, flush);
            } else {
                // For custom eval, code string is passed directly. tmpDir might be used by handleCustomEvaluation for other temp files if any.
                await handleCustomEvaluation(req, res, flush, problemId, language, code, meta, tmpDir);
            }
        } else { // Default to standard evaluation
            if (!meta.test_case_categories || !Array.isArray(meta.test_case_categories)) {
                 sendSse(res, { type: 'error', message: 'Invalid meta.json for standard evaluation: test_case_categories missing.' }, flush);
            } else {
                // For standard eval, code string is passed directly. tmpDir is for input.txt per test case.
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

// Original execCommand, used by standard evaluation - THIS SHOULD BE REMOVED / REPLACED
// function execCommand(cmd, timeout) {
//     return new Promise((resolve, reject) => {
//         exec(cmd, { timeout: timeout }, (error, stdout, stderr) => {
//             if (error) {
//                 if (error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT') {
//                     resolve({ 
//                         tle: true, 
//                         killed: error.killed, 
//                         signal: error.signal,
//                         stdout: stdout || '', 
//                         stderr: stderr || '' 
//                     });
//                 } else {
//                     reject(stderr || error.message);
//                 }
//             } else {
//                 resolve((stdout || '') + "\n" + (stderr || ''));
//             }
//         });
//     });
// }
