// next-app/pages/api/submit.js
import { exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const MAX_PARALLEL = 1; 

export default async function handler(req, res) {
    if (req.method !== 'POST') { res.status(405).end(); return; }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const flush = () => res.flush && res.flush();

    const { problemId, language, code } = req.body;
    if (!problemId || !language || !code) { res.write(`data: ${JSON.stringify({ error: 'Missing parameters' })}

`); flush(); res.end(); return; }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-'));
    const LANG_FILENAME = { python: 'solution.py', cpp: 'solution.cpp', javascript: 'solution.js', ruby: 'solution.rb', java: 'Main.java' };
    const filename = LANG_FILENAME[language];
    if (!filename) { res.write(`data: ${JSON.stringify({ error: 'Unsupported language' })}

`); flush(); fs.rmSync(tmpDir, { recursive: true, force: true }); res.end(); return; }
    fs.writeFileSync(path.join(tmpDir, filename), code);

    const metaPath = path.join(process.cwd(), 'problems', problemId, 'meta.json');
    if (!fs.existsSync(metaPath)) { res.write(`data: ${JSON.stringify({ error: 'Problem meta not found' })}

`); flush(); fs.rmSync(tmpDir, { recursive: true, force: true }); res.end(); return; }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const { test_case_categories: categories, timeout = 2000, memory_limit_kb } = meta;

    if (!Array.isArray(categories)) { res.write(`data: ${JSON.stringify({ error: 'Invalid problem metadata: test_case_categories not found or not an array' })}

`); flush(); fs.rmSync(tmpDir, { recursive: true, force: true }); res.end(); return; }
    
    res.write(`data: ${JSON.stringify({ type: 'test_suite_info', data: { categories: categories.map((c) => ({ name: c.category_name, test_cases: c.test_cases.map((tc) => path.basename(tc.input)) })) } })}

`);
    flush();

    let totalPointsEarned = 0;
    let finalRawDistance = null; // <--- 追加: 最終的な生の距離
    const maxTotalPoints = categories.reduce((s, c) => s + (c.points || 0), 0);
    const categorySummaries = [];

    for (const category of categories) {
        let calculatedCategoryScore = 0;
        let categoryRawDistance = null; // <--- 追加: カテゴリごとの生の距離
        let allTestsInCategoryPassedOrScored = true;

        const totalTestsInCategory = category.test_cases.length;
        const results = new Array(totalTestsInCategory);

        for (let start = 0; start < totalTestsInCategory; start += MAX_PARALLEL) {
            const slice = category.test_cases.slice(start, start + MAX_PARALLEL);
            await Promise.all(
                slice.map((tc, offset) =>
                    runTestCaseParallel({
                        testCase: tc, category, idx: start + offset, tmpDir, filename, language, timeout, memory_limit_kb, meta,
                    }).then((r) => { results[start + offset] = r; })
                )
            );
            for (let i = start; i < Math.min(start + MAX_PARALLEL, totalTestsInCategory); i++) {
                const r = results[i];
                res.write(`data: ${JSON.stringify(r)}

`);
                flush();
                if (r.status !== 'Accepted' && r.status !== 'Scored') {
                    allTestsInCategoryPassedOrScored = false;
                }
            }
        }
        
        if (results.length > 0) {
            if (meta.evaluation_mode === "custom") {
                const firstResult = results[0]; 
                if (firstResult && firstResult.status === 'Scored') { // Check firstResult exists
                    calculatedCategoryScore = firstResult.score;
                    categoryRawDistance = firstResult.raw_distance; // <--- カテゴリの生の距離を設定
                    if (finalRawDistance === null && categoryRawDistance !== null) { // <--- 最初の有効な生の距離を最終距離に
                        finalRawDistance = categoryRawDistance;
                    }
                } else {
                    allTestsInCategoryPassedOrScored = false;
                    calculatedCategoryScore = 0;
                }
            } else { 
                if (allTestsInCategoryPassedOrScored) calculatedCategoryScore = category.points || 0;
                else calculatedCategoryScore = 0;
            }
        } else { 
            allTestsInCategoryPassedOrScored = false; calculatedCategoryScore = 0;
        }
        
        totalPointsEarned += calculatedCategoryScore;

        res.write(`data: ${JSON.stringify({ type: 'category_result', category_name: category.category_name, category_points_earned: calculatedCategoryScore, category_max_points: category.points || 0, all_tests_in_category_passed: allTestsInCategoryPassedOrScored, category_raw_distance: categoryRawDistance })}

`);
        flush();

        categorySummaries.push({ category_name: category.category_name, points_earned: calculatedCategoryScore, max_points: category.points || 0, raw_distance: categoryRawDistance });
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.write(`data: ${JSON.stringify({ type: 'final_result', total_points_earned: totalPointsEarned, max_total_points: maxTotalPoints, category_summary: categorySummaries, final_raw_distance: finalRawDistance })}

`); // <--- final_raw_distance を追加
    flush();
    res.end();
}

async function runTestCaseParallel({ testCase, category, idx, tmpDir, filename, language, timeout, memory_limit_kb, meta }) {
    const name = path.basename(testCase.input);
    const tcDir = fs.mkdtempSync(path.join(tmpDir, `tc-${idx}-`));
    fs.copyFileSync(path.join(tmpDir, filename), path.join(tcDir, filename));
    const inputSrc = path.join(process.cwd(), testCase.input);
    if (!fs.existsSync(inputSrc)) { return { type: 'test_case_result', category_name: category.category_name, testCase: name, status: 'Error', message: 'Input file not found for test case execution.', score: 0, raw_distance: null, time: null, memory: null, got: '', expected: '' }; }
    fs.writeFileSync(path.join(tcDir, 'input.txt'), fs.readFileSync(inputSrc, 'utf8'));

    const dockerCmd = `docker run --rm -v ${tcDir}:/code executor ${language} /code/${filename}`;
    let execOut;
    try { execOut = await execCommand(dockerCmd, timeout * 4); } 
    catch (e) { return { type: 'test_case_result', category_name: category.category_name, testCase: name, status: 'Error', message: `User code execution failed: ${e.toString()}`, score: 0, raw_distance: null, time: null, memory: null, got: '', expected: '' }; }

    let output = ''; let timeMs = null; let memKb = null;
    const combinedUserOutput = (execOut.stdout || '') + '\n' + (execOut.stderr || '');
    if (combinedUserOutput.trim()) { 
        const lines = combinedUserOutput.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        const match = lastLine.match(/^TIME_MS:(\d+)\s+MEM:(\d+)$/);
        if (match) { timeMs = match[1]; memKb = match[2]; output = lines.slice(0, -1).join('\n').trim(); } 
        else { output = combinedUserOutput.trim(); }
    }

    let evaluationResult = { status: '', score: 0, raw_distance: null, message: '', got: output, expected: '', time: timeMs, memory: memKb }; // <--- raw_distance フィールド追加

    if (execOut.tle) { evaluationResult.status = 'TLE'; evaluationResult.score = 0; /* raw_distance is null */ } 
    else if (meta.evaluation_mode === "custom" && meta.custom_evaluator_options && meta.custom_evaluator_options.evaluator_script) {
        const evaluatorScriptPath = path.join(process.cwd(), meta.custom_evaluator_options.evaluator_script);
        const testInputPathForEvaluator = path.join(process.cwd(), testCase.input);
        if (!fs.existsSync(evaluatorScriptPath) || !fs.existsSync(testInputPathForEvaluator)) { evaluationResult.status = 'Error'; evaluationResult.message = !fs.existsSync(evaluatorScriptPath) ? `Evaluator script not found: ${evaluatorScriptPath}` : `Test input for evaluator not found: ${testInputPathForEvaluator}`; evaluationResult.score = 0; /* raw_distance is null */ } 
        else {
            try {
                const evalCmdParts = ['python3', evaluatorScriptPath, testInputPathForEvaluator];
                const evalProc = spawn(evalCmdParts[0], evalCmdParts.slice(1), { timeout: timeout * 2 });
                let evalStdout = ''; let evalStderr = '';
                evalProc.stdout.on('data', (data) => evalStdout += data.toString());
                evalProc.stderr.on('data', (data) => evalStderr += data.toString());
                evalProc.stdin.write(output); evalProc.stdin.end();

                await new Promise((resolve, reject) => {
                    let processError = null;
                    evalProc.on('error', (err) => { processError = err; reject(err); });
                    evalProc.on('close', (code) => {
                        if (processError) { evaluationResult.status = 'Error'; evaluationResult.message = `Failed to start evaluator script: ${processError.message}`; evaluationResult.score = 0; /* raw_distance is null */ resolve(); return; }
                        const currentCategoryPoints = category.points || 0; 
                        // let distance = NaN; // distance variable is not needed here with the new logic
                        if (evalStderr.trim().toLowerCase().includes("error:") || code !== 0) {
                            evaluationResult.status = 'Error'; evaluationResult.message = `Evaluator script failed (exit code ${code}). If stderr is empty, check stdout. Evaluator stdout: ${evalStdout.trim()}`; if (evalStderr.trim()) evaluationResult.message += `\nEvaluator Stderr: ${evalStderr.trim()}`; evaluationResult.score = 0; /* raw_distance is null */
                        } else {
                            const distanceVal = parseFloat(evalStdout.trim()); // Renamed to avoid conflict
                            if (isNaN(distanceVal) || distanceVal < 0) {
                                evaluationResult.status = 'Error'; evaluationResult.message = `Evaluator output (distance) was not a valid non-negative number: ${evalStdout.trim()}.`; if (evalStderr.trim()) evaluationResult.message += `\nEvaluator Stderr: ${evalStderr.trim()}`; evaluationResult.score = 0; /* raw_distance is null */
                            } else {
                                evaluationResult.status = 'Scored';
                                evaluationResult.score = Math.max(0, currentCategoryPoints - distanceVal);
                                evaluationResult.raw_distance = distanceVal; // <--- 生の距離をセット
                                evaluationResult.message = `Distance: ${distanceVal.toFixed(4)}. Score: ${evaluationResult.score} (Max Points: ${currentCategoryPoints} - Distance: ${distanceVal.toFixed(4)})`;
                                if (evalStderr.trim()) evaluationResult.message += `\nEvaluator stderr (warnings/info): ${evalStderr.trim()}`;
                            }
                        }
                        resolve();
                    });
                });
            } catch (e) { evaluationResult.status = 'Error'; evaluationResult.message = `Exception during custom evaluation: ${e.toString()}`; evaluationResult.score = 0; /* raw_distance is null */ }
        }
    } else { 
        const expectedPath = path.join(process.cwd(), testCase.output);
        if (!fs.existsSync(expectedPath)) { evaluationResult.status = 'Error'; evaluationResult.message = 'Expected output file not found'; evaluationResult.score = 0; } 
        else { 
            evaluationResult.expected = fs.readFileSync(expectedPath, 'utf8').trim();
            if (evaluationResult.got.trim() === evaluationResult.expected) {
                evaluationResult.status = 'Accepted';
                // Score for 'Accepted' is handled at category level in handler
            } else {
                evaluationResult.status = 'Wrong Answer';
                evaluationResult.score = 0; // WA means 0 points for this test case's contribution
            }
        }
    }

    if (memory_limit_kb && memKb && +memKb > memory_limit_kb) { 
        if (!['Error', 'TLE', 'MLE'].includes(evaluationResult.status)) { 
            evaluationResult.status = 'MLE'; 
        }
        evaluationResult.score = 0; // MLE is 0 points
        // raw_distance remains as is (could be null or a value if MLE happened after evaluator)
    }
    
    fs.rmSync(tcDir, { recursive: true, force: true });
    return {
        type: 'test_case_result', category_name: category.category_name, testCase: name,
        status: evaluationResult.status, score: evaluationResult.score, raw_distance: evaluationResult.raw_distance, // <--- raw_distance を返す
        time: evaluationResult.time, memory: evaluationResult.memory,
        got: evaluationResult.got.substring(0, 1000), expected: evaluationResult.expected.substring(0, 1000),
        message: evaluationResult.message,
    };
}

function execCommand(cmd, timeout) { 
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                if (err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT' || (err.message && err.message.includes('ETIMEDOUT'))) {
                    resolve({ tle: true, killed: err.killed, signal: err.signal, stdout: stdout || '', stderr: stderr || '' });
                } else { reject(new Error(`Command failed: ${cmd}\n${stderr || err.message}`)); }
            } else { resolve({ stdout: stdout || '', stderr: stderr || '' }); }
        });
    });
}
