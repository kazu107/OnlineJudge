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
    const testCases = meta.test_cases;
    const timeout = meta.timeout || 2000;
    const memory_limit_kb = meta.memory_limit_kb; // Read memory_limit_kb

    for (let i = 0; i < testCases.length; i++) {
        const testCase = testCases[i];
        const inputFilePath = path.join(process.cwd(), testCase.input);
        if (!fs.existsSync(inputFilePath)) {
            res.write(`data: ${JSON.stringify({
                testCase: path.basename(testCase.input),
                status: 'Error',
                message: 'Input file not found'
            })}\n\n`);
            flush();
            continue;
        }
        const inputContent = fs.readFileSync(inputFilePath, 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'input.txt'), inputContent);

        // Docker コンテナ実行コマンド
        const dockerCmd = `docker run --rm -v ${tmpDir}:/code executor ${language} /code/${filename}`;
        try {
            let execResult = await execCommand(dockerCmd, timeout); // Renamed to execResult to avoid confusion

            let output = '';
            let execTimeMs = null;
            let memUsage = null;
            let testStatus = ''; // To store the status: TLE, MLE, Accepted, WA, Error

            // Try to parse time and memory from stdout/stderr if available (especially for TLE)
            const combinedOutput = (execResult.stdout || '') + "\n" + (execResult.stderr || '');
            if (typeof combinedOutput === 'string' && combinedOutput.trim() !== '') {
                const lines = combinedOutput.trim().split('\n');
                const lastLine = lines[lines.length - 1];
                const timeRegex = /^TIME_MS:(\d+)\s+MEM:(\d+)$/;
                const match = lastLine.match(timeRegex);
                if (match) {
                    execTimeMs = match[1];
                    memUsage = match[2];
                    // If we got time/mem, the actual output is the lines before the last one
                    if (execResult.tle) { // For TLE, we might not have popped lines yet
                        output = lines.slice(0, -1).join('\n').trim();
                    }
                } else {
                     // if no match, the whole combinedOutput is the program's output
                    if(execResult.tle){
                        output = combinedOutput.trim();
                    }
                }
            }
            
            if (execResult.tle) {
                testStatus = 'TLE';
                 // output might be from combinedOutput if parsing failed, or already set if parsing succeeded
                if (output === '' && typeof combinedOutput === 'string') output = combinedOutput.trim();

            } else {
                // Not TLE, so execResult should be a string (the actual output)
                output = execResult; // This is the actual program output string
                const lines = output.trim().split('\n');
                const lastLine = lines[lines.length - 1];
                const timeRegex = /^TIME_MS:(\d+)\s+MEM:(\d+)$/;
                const match = lastLine.match(timeRegex);

                if (match) {
                    execTimeMs = match[1];
                    memUsage = match[2];
                    lines.pop();
                    output = lines.join('\n').trim(); // Actual program output
                }
                // else, output remains as is, and execTimeMs/memUsage are null

                // Check for MLE only if not TLE
                if (memory_limit_kb && memUsage && parseInt(memUsage, 10) > memory_limit_kb) {
                    testStatus = 'MLE';
                } else {
                    // Proceed to check for Accepted or Wrong Answer
                    const expectedOutputPath = path.join(process.cwd(), testCase.output);
                    if (!fs.existsSync(expectedOutputPath)) {
                        res.write(`data: ${JSON.stringify({
                            testCase: path.basename(testCase.input),
                            status: 'Error',
                            message: 'Expected output file not found'
                        })}\n\n`);
                        flush();
                        continue;
                    }
                    const expectedOutput = fs.readFileSync(expectedOutputPath, 'utf8').trim();
                    if (output.trim() === expectedOutput) {
                        testStatus = 'Accepted';
                    } else {
                        testStatus = 'Wrong Answer';
                    }
                }
            }

            let resultToSend = {
                testCase: path.basename(testCase.input),
                status: testStatus,
                time: execTimeMs,
                memory: memUsage
            };

            if (testStatus === 'TLE') {
                resultToSend.signal = execResult.signal;
                resultToSend.killed = execResult.killed;
                resultToSend.got = output; // Include whatever output was captured for TLE
            } else if (testStatus === 'Wrong Answer') {
                const expectedOutputPath = path.join(process.cwd(), testCase.output);
                const expectedOutput = fs.readFileSync(expectedOutputPath, 'utf8').trim();
                resultToSend.expected = expectedOutput;
                resultToSend.got = output;
            } else if (testStatus === 'MLE') {
                 resultToSend.got = output; // Include output for MLE as well
            }


            res.write(`data: ${JSON.stringify(resultToSend)}\n\n`);
            flush();

        } catch (err) {
            // This catch block handles errors from execCommand (if it rejects)
            // or other unexpected errors in the try block.
            res.write(`data: ${JSON.stringify({
                testCase: path.basename(testCase.input),
                status: 'Error',
                message: err.toString() // err could be a string or an error object
            })}\n\n`);
            flush();
        }
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.write(`data: ${JSON.stringify({ finished: true })}\n\n`);
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
