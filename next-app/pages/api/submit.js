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

    // SSE 用ヘッダー設定
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // すぐにフラッシュするヘルパー
    const flush = () => {
        if (res.flush) res.flush();
    };

    const { problemId, language, code } = req.body;
    if (!problemId || !language || !code) {
        res.write(`data: ${JSON.stringify({ error: 'Missing parameters' })}\n\n`);
        flush();
        res.end();
        return;
    }

    // 一時ディレクトリ作成
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-'));

    // 言語に応じたファイル名決定
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
    const solutionPath = path.join(tmpDir, filename);
    fs.writeFileSync(solutionPath, code);

    // 問題 meta.json の読み込み
    const metaPath = path.join(process.cwd(), 'problems', problemId, 'meta.json');
    if (!fs.existsSync(metaPath)) {
        res.write(`data: ${JSON.stringify({ error: 'Problem meta not found' })}\n\n`);
        flush();
        res.end();
        return;
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const categories = meta.test_case_categories;
    const timeout = meta.timeout || 2000; // Keep timeout at problem level
    const memory_limit_kb = meta.memory_limit_kb; // Keep memory limit at problem level

    if (!categories || !Array.isArray(categories)) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Invalid problem metadata: test_case_categories not found or not an array' })}\n\n`);
        flush();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        res.end();
        return;
    }

    let totalPointsEarned = 0;
    const maxTotalPoints = categories.reduce((sum, cat) => sum + (cat.points || 0), 0);
    const categorySummaries = [];

    for (const category of categories) {
        let categoryPointsAwarded = category.points || 0; // Points for this category
        let allTestsInThisCategoryPassed = true;
        // const testCaseResultsInCategory = []; // Optional: if sending all results again in category_result

        for (const testCase of category.test_cases) {
            const testCaseName = path.basename(testCase.input);
            const inputFilePath = path.join(process.cwd(), testCase.input);

            if (!fs.existsSync(inputFilePath)) {
                const errorResult = {
                    type: 'test_case_result',
                    category_name: category.category_name,
                    testCase: testCaseName,
                    status: 'Error',
                    message: 'Input file not found'
                };
                res.write(`data: ${JSON.stringify(errorResult)}\n\n`);
                flush();
                allTestsInThisCategoryPassed = false;
                // testCaseResultsInCategory.push(errorResult);
                continue;
            }
            const inputContent = fs.readFileSync(inputFilePath, 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'input.txt'), inputContent);

            const dockerCmd = `docker run --rm -v ${tmpDir}:/code executor ${language} /code/${filename}`;
            let currentTestCaseResult = {};

            try {
                let execResult = await execCommand(dockerCmd, timeout);
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
                        if (execResult.tle) {
                            output = lines.slice(0, -1).join('\n').trim();
                        }
                    } else {
                        if(execResult.tle){
                            output = combinedOutput.trim();
                        }
                    }
                }

                if (execResult.tle) {
                    testStatus = 'TLE';
                    if (output === '' && typeof combinedOutput === 'string') output = combinedOutput.trim();
                } else {
                    output = execResult; // execResult is a string here
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
                    got: output // Always include 'got' for WA, TLE, MLE, and even Accepted if desired
                };

                if (testStatus === 'TLE') {
                    currentTestCaseResult.signal = execResult.signal;
                    currentTestCaseResult.killed = execResult.killed;
                }
                // 'expected' is added for WA inside the logic block
                // 'message' is added for Error inside the logic block or catch block

            } catch (err) { // Catch errors from execCommand or other issues
                currentTestCaseResult = {
                    type: 'test_case_result',
                    category_name: category.category_name,
                    testCase: testCaseName,
                    status: 'Error',
                    message: err.toString()
                };
            }

            res.write(`data: ${JSON.stringify(currentTestCaseResult)}\n\n`);
            flush();
            // testCaseResultsInCategory.push(currentTestCaseResult);

            if (currentTestCaseResult.status !== 'Accepted') {
                allTestsInThisCategoryPassed = false;
            }
        } // End of test cases loop for a category

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
            // test_case_results_in_category: testCaseResultsInCategory // Optional
        };
        res.write(`data: ${JSON.stringify(categoryResultEvent)}\n\n`);
        flush();

        categorySummaries.push({
            category_name: category.category_name,
            points_earned: categoryPointsAwarded,
            max_points: category.points || 0
        });
    } // End of categories loop

    fs.rmSync(tmpDir, { recursive: true, force: true });

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