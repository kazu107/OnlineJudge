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
            let output = await execCommand(dockerCmd, timeout);
            const lines = output.trim().split('\n');
            const lastLine = lines[lines.length - 1];
            // 正規表現を "TIME_MS:" に合わせる
            const timeRegex = /^TIME_MS:(\d+)\s+MEM:(\d+)$/;
            const match = lastLine.match(timeRegex);
            let execTimeMs = null, memUsage = null;
            if (match) {
                execTimeMs = match[1];
                memUsage = match[2];
                lines.pop();
                output = lines.join('\n').trim();
            }
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
            let testResult = {};
            if (output.trim() === expectedOutput) {
                testResult = {
                    testCase: path.basename(testCase.input),
                    status: 'Accepted',
                    time: execTimeMs,
                    memory: memUsage
                };
            } else {
                testResult = {
                    testCase: path.basename(testCase.input),
                    status: 'Wrong Answer',
                    expected: expectedOutput,
                    got: output,
                    time: execTimeMs,
                    memory: memUsage
                };
            }
            res.write(`data: ${JSON.stringify(testResult)}\n\n`);
            flush();
        } catch (err) {
            res.write(`data: ${JSON.stringify({
                testCase: path.basename(testCase.input),
                status: 'Error',
                message: err.toString()
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
                reject(stderr || error.message);
            } else {
                resolve((stdout || '') + "\n" + (stderr || ''));
            }
        });
    });
}
