// next-app/pages/api/submit.js
import { exec } from 'child_process'; // Used by standard evaluation's execCommand
import fs from 'fs';
import path from 'path';
import os from 'os';
import fetch from 'node-fetch'; // For making HTTP requests to the executor service

const EXECUTOR_BASE_URL = process.env.EXECUTOR_URL || 'http://localhost:3001';
const CONTAINER_EVALUATOR_PATH = "/app/evaluator.py"; // Fixed path inside evaluation container
const CONTAINER_USER_SOLUTION_PATH = "/app/user_solution.txt";
const CONTAINER_TEST_DATA_PATH = "/app/test_data.file"; // Extension might vary

// Helper to send SSE messages
function sendSse(res, data, flushFn) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    flushFn();
}

// Standard evaluation (category-based, direct Docker execution or via old execCommand)
async function handleStandardEvaluation(req, res, flush, problemId, language, code, meta, tmpDir, solutionPath) {
    const categories = meta.test_case_categories;
    const problemTimeout = meta.timeout || 2000;
    const memory_limit_kb = meta.memory_limit_kb;
    let userCodeFilename = path.basename(solutionPath);


    if (!categories || !Array.isArray(categories)) {
        sendSse(res, { type: 'error', message: 'Invalid problem metadata: test_case_categories not found or not an array' }, flush);
        return; // Early exit if meta structure is wrong for standard eval
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

            if (!fs.existsSync(inputFilePath)) {
                sendSse(res, { type: 'test_case_result', category_name: category.category_name, testCase: testCaseName, status: 'Error', message: 'Input file not found' }, flush);
                allTestsInThisCategoryPassed = false;
                continue;
            }
            const inputContent = fs.readFileSync(inputFilePath, 'utf8');
            // For standard evaluation, input.txt is typically created in tmpDir for Docker to use
            fs.writeFileSync(path.join(tmpDir, 'input.txt'), inputContent);

            // This `dockerCmd` is for the "standard" execution model which uses `executor` image directly
            // and the `executor` image's entrypoint or command (e.g. run.sh) handles the execution
            const dockerCmd = `docker run --rm -v "${tmpDir}":/code --network none ${meta.executor_image_name || "executor"} ${language} /code/${userCodeFilename}`;
            let currentTestCaseResult = {};

            try {
                // Using original execCommand for standard evaluation path
                let execResult = await execCommand(dockerCmd, problemTimeout); // Assuming execCommand is defined elsewhere or passed
                let output = '';
                let execTimeMs = null;
                let memUsage = null;
                let testStatus = '';

                const combinedOutput = (execResult.stdout || '') + "\n" + (execResult.stderr || '');
                if (typeof combinedOutput === 'string' && combinedOutput.trim() !== '') {
                    const lines = combinedOutput.trim().split('\n');
                    const lastLine = lines[lines.length - 1];
                    const timeRegex = /^TIME_MS:(\d+)\s+MEM:(\d+)$/;
                    const match = lastLine.match(timeRegex);
                    if (match) {
                        execTimeMs = match[1];
                        memUsage = match[2];
                        if (execResult.tle) output = lines.slice(0, -1).join('\n').trim();
                    } else {
                        if(execResult.tle) output = combinedOutput.trim();
                    }
                }

                if (execResult.tle) {
                    testStatus = 'TLE';
                    if (output === '' && typeof combinedOutput === 'string') output = combinedOutput.trim();
                } else {
                    output = execResult; // string output from successful execCommand
                    const lines = output.trim().split('\n');
                    const lastLine = lines[lines.length - 1];
                    const timeRegex = /^TIME_MS:(\d+)\s+MEM:(\d+)$/;
                    const match = lastLine.match(timeRegex);
                    if (match) {
                        execTimeMs = match[1];
                        memUsage = match[2];
                        lines.pop();
                        output = lines.join('\n').trim();
                    }

                    if (memory_limit_kb && memUsage && parseInt(memUsage, 10) > memory_limit_kb) {
                        testStatus = 'MLE';
                    } else {
                        const expectedOutputPath = path.join(process.cwd(), testCase.output);
                        if (!fs.existsSync(expectedOutputPath)) {
                            testStatus = 'Error';
                            currentTestCaseResult.message = 'Expected output file not found';
                        } else {
                            const expectedOutput = fs.readFileSync(expectedOutputPath, 'utf8').trim();
                            if (output.trim() === expectedOutput) testStatus = 'Accepted';
                            else {
                                testStatus = 'Wrong Answer';
                                currentTestCaseResult.expected = expectedOutput;
                            }
                        }
                    }
                }
                currentTestCaseResult = { ...currentTestCaseResult, type: 'test_case_result', category_name: category.category_name, testCase: testCaseName, status: testStatus, time: execTimeMs, memory: memUsage, got: output };
                if (testStatus === 'TLE') { currentTestCaseResult.signal = execResult.signal; currentTestCaseResult.killed = execResult.killed; }
            } catch (err) {
                currentTestCaseResult = { type: 'test_case_result', category_name: category.category_name, testCase: testCaseName, status: 'Error', message: err.toString() };
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


// Custom evaluation (using executor service's /execute and /evaluate)
async function handleCustomEvaluation(req, res, flush, problemId, language, code, meta, tmpDir) {
    let totalPointsEarned = 0;
    const maxTotalPoints = meta.max_total_points || meta.test_cases.reduce((sum, tc) => sum + (tc.points || 0), 0);
    const testCaseResultsSummary = []; // For the final_result summary

    for (const testCase of meta.test_cases) {
        const testCaseId = testCase.id || path.basename(testCase.data_file); // Use testCase.id if available
        let pointsEarnedForTestCase = 0;
        let testCaseStatus = "Processing"; // Initial status
        let message = "";
        let userStdoutContent = "";
        let evaluatorStderr = "";

        // 1. Execute User Code via Executor /execute
        const userCodeExecTimeout = meta.time_limit_ms || meta.timeout || 5000; // User code timeout
        let userOutputFilePathOnHost = "";

        try {
            // For some custom problems, input might be from testCase.data_file itself
            // For TSP, user code typically doesn't need stdin for the data file, it just generates a tour.
            // Assuming stdin is not needed for user code in TSP context for now.
            let stdinContent = "";
            // If problem needed input from data_file to user code:
            // if (testCase.data_file && fs.existsSync(path.join(process.cwd(), testCase.data_file))) {
            //    stdinContent = fs.readFileSync(path.join(process.cwd(), testCase.data_file), 'utf8');
            // }

            const executePayload = { language, code, stdin: stdinContent };
            const executorExecuteUrl = `${EXECUTOR_BASE_URL}/execute`;
            const executeResponse = await fetch(executorExecuteUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(executePayload),
                timeout: userCodeExecTimeout + 1000 // Network timeout slightly larger
            });

            if (!executeResponse.ok) {
                const errorData = await executeResponse.json().catch(() => ({ error: `Executor /execute failed with status ${executeResponse.status}` }));
                testCaseStatus = "User Code Error";
                message = errorData.error || "User code execution failed on executor.";
                if (errorData.signal) message += ` (Signal: ${errorData.signal})`;
            } else {
                const executeResult = await executeResponse.json();
                userStdoutContent = executeResult.output; // This is the user's solution (e.g., TSP tour)

                // Save user's output to a temporary file on host for evaluator
                userOutputFilePathOnHost = path.join(tmpDir, `user_output_${testCaseId}.txt`);
                fs.writeFileSync(userOutputFilePathOnHost, userStdoutContent);
                testCaseStatus = "User Code Executed"; // Intermediate status
            }
        } catch (err) {
            testCaseStatus = "User Code Error";
            message = `Failed to execute user code via executor: ${err.message}`;
            if (err.type === 'request-timeout' || err.code === 'ETIMEDOUT') { // node-fetch specific timeout
                testCaseStatus = "User Code TLE";
                message = "User code execution timed out (communication with executor).";
            }
        }

        // 2. If user code executed successfully, run evaluator via Executor /evaluate
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
                    user_solution_host_path: userOutputFilePathOnHost,
                    test_data_host_path: testDataHostPath,
                    evaluator_script_container_path: CONTAINER_EVALUATOR_PATH,
                    user_solution_container_path: CONTAINER_USER_SOLUTION_PATH,
                    test_data_container_path: CONTAINER_TEST_DATA_PATH,
                    max_points: testCase.points.toString(),
                    evaluator_language: meta.custom_evaluator_options.evaluator_language || 'python3',
                    timeout: evaluatorTimeout
                };

                try {
                    const executorEvaluateUrl = `${EXECUTOR_BASE_URL}/evaluate`;
                    const evaluateResponse = await fetch(executorEvaluateUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(evaluatePayload),
                        timeout: evaluatorTimeout + 1000 // Network timeout
                    });

                    if (!evaluateResponse.ok) {
                        const errorData = await evaluateResponse.json().catch(() => ({ message: `Executor /evaluate failed with status ${evaluateResponse.status}` }));
                        testCaseStatus = "Evaluation Error";
                        message = errorData.message || "Evaluation failed on executor.";
                        evaluatorStderr = errorData.stderr || "";
                    } else {
                        const evaluateResult = await evaluateResponse.json();
                        if (evaluateResult.success) {
                            pointsEarnedForTestCase = parseFloat(evaluateResult.evaluation_result.score) || 0;
                            message = evaluateResult.evaluation_result.message || "Evaluation completed.";
                            if(evaluateResult.evaluation_result.error) { // Error reported by evaluator script
                                testCaseStatus = "Evaluator Reported Error";
                                message += ` (Evaluator Error: ${evaluateResult.evaluation_result.error})`;
                                pointsEarnedForTestCase = 0; // Ensure score is 0 if evaluator reports an error
                            } else {
                                testCaseStatus = "Custom Evaluated"; // Final success status
                            }
                            evaluatorStderr = evaluateResult.stderr || "";
                        } else {
                            testCaseStatus = "Evaluation Error";
                            message = evaluateResult.message || "Evaluation process reported failure.";
                            evaluatorStderr = evaluateResult.stderr || "";
                        }
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
            stdout_user: userStdoutContent, // Optional: for debugging
            stderr_evaluator: evaluatorStderr // Optional: for debugging
        };
        sendSse(res, sseEventData, flush);
        testCaseResultsSummary.push({id: testCaseId, score: pointsEarnedForTestCase, max_points: testCase.points, status: testCaseStatus, message: message});
    } // End of custom test cases loop

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

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `submission-${problemId}-`));
    let userCodeSolutionFileName = ''; // Used for standard eval, might be different for custom if code isn't written to disk for /execute
    switch (language) {
        case 'python': userCodeSolutionFileName = 'solution.py'; break;
        case 'cpp': userCodeSolutionFileName = 'solution.cpp'; break;
        case 'javascript': userCodeSolutionFileName = 'solution.js'; break;
        case 'ruby': userCodeSolutionFileName = 'solution.rb'; break;
        case 'java': userCodeSolutionFileName = 'Main.java'; break;
        default:
            sendSse(res, { type: 'error', message: 'Unsupported language' }, flush);
            fs.rmSync(tmpDir, { recursive: true, force: true });
            res.end();
            return;
    }
    const userCodeSolutionPath = path.join(tmpDir, userCodeSolutionFileName); // For standard evaluation
    fs.writeFileSync(userCodeSolutionPath, code); // Write code for standard evaluation

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
        if (meta.evaluation_mode === "custom_evaluator") {
            if (!meta.custom_evaluator_options || !meta.custom_evaluator_options.evaluator_script || !meta.test_cases) {
                sendSse(res, { type: 'error', message: 'Invalid meta.json for custom_evaluator: missing custom_evaluator_options, evaluator_script, or test_cases array.' }, flush);
            } else {
                await handleCustomEvaluation(req, res, flush, problemId, language, code, meta, tmpDir);
            }
        } else { // Default to standard evaluation (category-based)
            // Ensure standard evaluation specific meta parts are present
            if (!meta.test_case_categories || !Array.isArray(meta.test_case_categories)) {
                sendSse(res, { type: 'error', message: 'Invalid problem metadata for standard evaluation: test_case_categories not found or not an array' }, flush);
            } else {
                await handleStandardEvaluation(req, res, flush, problemId, language, code, meta, tmpDir, userCodeSolutionPath);
            }
        }
    } catch (error) { // Catch any unexpected errors during handling
        console.error("Critical error in submission handler:", error);
        sendSse(res, { type: 'error', message: `An unexpected server error occurred: ${error.message}` }, flush);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        res.end();
    }
}

// Original execCommand, used by standard evaluation
function execCommand(cmd, timeout) {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout: timeout }, (error, stdout, stderr) => {
            if (error) {
                // Check for TLE conditions
                if (error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT') {
                    // For TLE, we still want to capture any stdout/stderr produced
                    resolve({
                        tle: true,
                        killed: error.killed,
                        signal: error.signal,
                        stdout: stdout || '',
                        stderr: stderr || ''
                    });
                } else {
                    // For other errors, reject as before
                    reject(stderr || error.message);
                }
            } else {
                // Success case
                resolve((stdout || '') + "\n" + (stderr || ''));
            }
        });
    });
}