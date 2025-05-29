// next-app/pages/api/submit.js
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).end();
        return;
    }

    // Set headers for SSE (Server-Sent Events)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache'); // Ensure no caching of this response
    res.setHeader('Connection', 'keep-alive'); // Keep the connection open for streaming

    // Helper function to flush the response buffer immediately
    const flush = () => {
        if (res.flush) res.flush(); // res.flush() is available on Node.js response objects
    };

    const { problemId, language, code } = req.body; // Extract parameters from the request body
    if (!problemId || !language || !code) {
        res.write(`data: ${JSON.stringify({ error: 'Missing parameters' })}\n\n`);
        flush();
        res.end();
        return;
    }

    // Create a temporary directory for the submission files
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-'));

    // Determine the solution filename based on the selected language
    let filename = '';
    switch (language) {
        case 'python': filename = 'solution.py'; break;
        case 'cpp': filename = 'solution.cpp'; break;
        case 'javascript': filename = 'solution.js'; break;
        case 'ruby': filename = 'solution.rb'; break;
        case 'java': filename = 'Main.java'; break;
        default:
            res.write(`data: ${JSON.stringify({ error: 'Unsupported language' })}\n\n`);
            flush();
            res.end();
            return;
    }
    const solutionPath = path.join(tmpDir, filename); // Path to the solution file in the temporary directory
    fs.writeFileSync(solutionPath, code); // Write the submitted code to the solution file

    // Load the problem's metadata (meta.json)
    const metaPath = path.join(process.cwd(), 'problems', problemId, 'meta.json'); // Path to the meta.json file
    if (!fs.existsSync(metaPath)) {
        res.write(`data: ${JSON.stringify({ error: 'Problem meta not found' })}\n\n`); // Send error if meta.json is missing
        flush();
        res.end();
        return;
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const categories = meta.test_case_categories; // Test case categories defined in meta.json
    const timeout = meta.timeout || 2000; // Execution timeout in milliseconds, defaults to 2000ms
    const memory_limit_kb = meta.memory_limit_kb; // Memory limit in KB

    if (!categories || !Array.isArray(categories)) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Invalid problem metadata: test_case_categories not found or not an array' })}\n\n`); // Error for invalid metadata
        flush();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        res.end();
        return;
    }

    // Construct and send test_suite_info event
    const testSuiteInfo = {
        type: 'test_suite_info',
        data: {
            categories: categories.map(category => ({
                name: category.category_name,
                test_cases: category.test_cases.map(tc => path.basename(tc.input))
            }))
        }
    };
    res.write(`data: ${JSON.stringify(testSuiteInfo)}\n\n`);
    flush();

    let totalPointsEarned = 0;
    const maxTotalPoints = categories.reduce((sum, cat) => sum + (cat.points || 0), 0);
    const categorySummaries = [];

    try {
        for (const category of categories) {
            let categoryPointsAwarded = category.points || 0;
            let allTestsInThisCategoryPassed = true;

            const testCasePromises = category.test_cases.map(async (testCase) => {
                const testCaseName = path.basename(testCase.input);
                // Consider using independent temporary directories or filenames for each test case for parallel execution without Docker.
                // With Docker, each container gets its own isolated environment.
                // The current approach writes to a shared `input.txt` in `tmpDir` before each Docker run.
                // This is generally fine as Docker containers will copy the volume state at the time of `docker run`.
                // For non-Docker parallel execution, unique input/output handling per test case would be critical.

                const inputFilePath = path.join(process.cwd(), testCase.input); // Path to the input file for the current test case
                if (!fs.existsSync(inputFilePath)) {
                    return {
                        type: 'test_case_result',
                        category_name: category.category_name,
                        testCase: testCaseName,
                        status: 'Error',
                        message: 'Input file not found'
                    };
                }
                const inputContent = fs.readFileSync(inputFilePath, 'utf8');
                // Note: fs.writeFileSync should ideally be part of the isolated execution context
                // or ensure unique input files if multiple non-containerized commands run in parallel on the same tmpDir.
                // With Docker, each container gets its own /code/input.txt if we write it just before exec.
                // For simplicity, we assume dockerCmd handles input via stdin or a uniquely named file if necessary.
                // The current dockerCmd reads /code/input.txt, so we'll write it right before the exec.
                // This part is tricky with parallel local writes. A better approach for non-Docker or shared tmpDir
                // would be to pass input content directly or use uniquely named input files.
                // Given the Docker setup, writing to a common 'input.txt' in the *host's* tmpDir just before
                // *each* Docker execution is okay because each Docker container will copy the *current* state
                // of the mapped volume.

                // For parallel local execution without Docker, one would need per-test-case temp subdirectories.
                // Create a uniquely named input file for this specific test case run if not using Docker's isolation.
                // const localInputPath = path.join(tmpDir, `input_${testCaseName}.txt`);
                // fs.writeFileSync(localInputPath, inputContent);
                // For Docker, writing to a common 'input.txt' is fine as it's mapped per container.
                fs.writeFileSync(path.join(tmpDir, 'input.txt'), inputContent); // Write current test case's input to input.txt


                const dockerCmd = `docker run --rm -v ${tmpDir}:/code executor ${language} /code/${filename}`; // Docker command to execute the solution
                let currentTestCaseResult = {}; // Stores the result for the current test case

                try {
                    let execResult = await execCommand(dockerCmd, timeout); // Execute the command, `await` handles the Promise
                    let output = ''; // Program's output
                    let execTimeMs = null; // Execution time in milliseconds
                    let memUsage = null;
                    let testStatus = '';

                    const combinedOutput = (execResult.stdout || '') + "\n" + (execResult.stderr || '');
                    if (typeof combinedOutput === 'string' && combinedOutput.trim() !== '') {
                        const lines = combinedOutput.trim().split('\n');
                        const lastLine = lines[lines.length - 1];
                        const timeRegex = /^TIME_MS:(\d+)\s+MEM:(\d+)$/;
                        const match = lastLine.match(timeRegex);
                        if (match) {
                            execTimeMs = match[1]; // Extract execution time
                            memUsage = match[2];   // Extract memory usage
                            // If TLE, the output might be incomplete, but metrics are still valid
                            if (execResult.tle) {
                                output = lines.slice(0, -1).join('\n').trim(); // Output before the metrics line
                            } else {
                                // For non-TLE, the actual program output is everything before the metrics line
                                output = lines.slice(0, -1).join('\n').trim();
                            }
                        } else {
                             // No metrics line found, output is the whole combined output
                            output = combinedOutput.trim();
                        }
                    }


                    if (execResult.tle) {
                        testStatus = 'TLE'; // Time Limit Exceeded
                        // Output might already be set if metrics were present despite TLE
                        if (output === '' && typeof combinedOutput === 'string') output = combinedOutput.trim();

                    } else {
                        // Output was already processed if metrics line was present
                        // If no metrics line, output is already `combinedOutput.trim()`

                        if (memory_limit_kb && memUsage && parseInt(memUsage, 10) > memory_limit_kb) {
                            testStatus = 'MLE'; // Memory Limit Exceeded
                        } else {
                            const expectedOutputPath = path.join(process.cwd(), testCase.output);
                            if (!fs.existsSync(expectedOutputPath)) {
                                testStatus = 'Error';
                                currentTestCaseResult.message = 'Expected output file not found';
                            } else {
                                const expectedOutput = fs.readFileSync(expectedOutputPath, 'utf8').trim();
                                if (output.trim() === expectedOutput) {
                                    testStatus = 'Accepted';
                                } else {
                                    testStatus = 'Wrong Answer';
                                    currentTestCaseResult.expected = expectedOutput;
                                }
                            }
                        }
                    }

                    currentTestCaseResult = {
                        ...currentTestCaseResult,
                        type: 'test_case_result',
                        category_name: category.category_name,
                        testCase: testCaseName,
                        status: testStatus,
                        time: execTimeMs,
                        memory: memUsage,
                        got: output
                    };

                    if (testStatus === 'TLE') {
                        currentTestCaseResult.signal = execResult.signal;
                        currentTestCaseResult.killed = execResult.killed; // Store kill signal info for TLE
                    }

                } catch (err) { // Catch errors from execCommand or other issues during test case execution
                    currentTestCaseResult = {
                        type: 'test_case_result',
                        category_name: category.category_name,
                        testCase: testCaseName,
                        status: 'Error',
                        message: err.toString() // Provide a more detailed error message
                    };
                }
                return currentTestCaseResult; // Return the result for this test case
            });

            // Wait for all test cases in the current category to complete
            const results = await Promise.all(testCasePromises.map(p => p.catch(e => {
                // This catch block handles unexpected errors in the promise construction or logic within testCasePromises.map,
                // not typically errors from execCommand itself (which are handled and resolved).
                console.error("Unexpected error in test case promise:", e); // Log the error server-side
                return { // Return a structured error object for the client
                    type: 'test_case_result',
                    // category_name and testCase might not be available if the error is very early
                    status: 'Error',
                    message: 'An unexpected server error occurred while processing the test case.'
                };
            })));

            // Send results for each test case in the category
            for (const result of results) {
                // Ensure category_name and testCase are present, especially for errors caught by Promise.all.catch
                const originalTestCase = category.test_cases[results.indexOf(result)]; // Assumes results maintain order
                if (!result.category_name) result.category_name = category.category_name;
                if (!result.testCase) result.testCase = path.basename(originalTestCase.input);

                res.write(`data: ${JSON.stringify(result)}\n\n`); // Send test case result as SSE
                flush();
                if (result.status !== 'Accepted') {
                    allTestsInThisCategoryPassed = false;
                }
            }

            if (!allTestsInThisCategoryPassed) {
                categoryPointsAwarded = 0;
            }
            totalPointsEarned += categoryPointsAwarded;

            const categoryResultEvent = {
                type: 'category_result',
                category_name: category.category_name,
                category_points_earned: categoryPointsAwarded,
                category_max_points: category.points || 0,
                all_tests_in_category_passed: allTestsInThisCategoryPassed,
            };
            res.write(`data: ${JSON.stringify(categoryResultEvent)}\n\n`);
            flush();

            categorySummaries.push({
                category_name: category.category_name,
                points_earned: categoryPointsAwarded,
            max_points: category.points || 0 // Max points for this category
            });
    } // End of loop through categories
    } catch (error) {
        // Catch any unexpected errors during the main processing loop (e.g., issues not caught by individual test case catches)
        console.error("Error during test execution:", error); // Log the error server-side
        res.write(`data: ${JSON.stringify({ type: 'error', message: `Server error during execution: ${error.message}` })}\n\n`); // Send error to client
        flush();
        // Consider whether final_result should still be sent or if res.end() is sufficient here
    } finally {
        // Cleanup: Remove the temporary directory
        fs.rmSync(tmpDir, { recursive: true, force: true });

        // Send the final overall result
        const finalResultEvent = {
        type: 'final_result',
        total_points_earned: totalPointsEarned,
        max_total_points: maxTotalPoints,
        category_summary: categorySummaries
    };
    res.write(`data: ${JSON.stringify(finalResultEvent)}\n\n`);
    flush();
    res.end();
}

// Promisified version of child_process.exec with timeout handling
function execCommand(cmd, timeout) {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout: timeout }, (error, stdout, stderr) => {
            if (error) {
                // Check for Time Limit Exceeded (TLE) conditions
                if (error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT' || error.killed) {
                    // For TLE, resolve with details including any output produced before termination
                    resolve({
                        tle: true, // Indicate TLE
                        killed: error.killed,
                        signal: error.signal,
                        stdout: stdout || '', // Capture any stdout
                        stderr: stderr || ''  // Capture any stderr
                    });
                } else {
                    // For other execution errors, reject the promise
                    reject(stderr || error.message);
                }
            } else {
                // On successful execution (exit code 0)
                resolve((stdout || '') + "\n" + (stderr || '')); // Combine stdout and stderr
            }
        });
    });
}