/* next-app/pages/api/submit.js */
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

/* ──────────────────────────────────────────────
   並列実行の上限
   - 既定値 : CPU コア数の半分（最低 1）
   - 環境変数 MAX_PARALLEL で上書き可
────────────────────────────────────────────── */
const MAX_PARALLEL = 1;

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).end();
        return;
    }

    /* ───── SSE ヘッダー ───── */
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const flush = () => res.flush && res.flush();

    /* ───── パラメータ取得 ───── */
    const { problemId, language, code } = req.body;
    if (!problemId || !language || !code) {
        res.write(`data: ${JSON.stringify({ error: 'Missing parameters' })}\n\n`);
        flush();
        res.end();
        return;
    }

    /* ───── 一時ディレクトリ ───── */
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-'));

    /* ───── ファイル名決定 ───── */
    const LANG_FILENAME = {
        python: 'solution.py',
        cpp: 'solution.cpp',
        javascript: 'solution.js',
        ruby: 'solution.rb',
        java: 'Main.java',
    };
    const filename = LANG_FILENAME[language];
    if (!filename) {
        res.write(`data: ${JSON.stringify({ error: 'Unsupported language' })}\n\n`);
        flush();
        res.end();
        return;
    }
    fs.writeFileSync(path.join(tmpDir, filename), code);

    /* ───── 問題メタ読み込み ───── */
    const metaPath = path.join(process.cwd(), 'problems', problemId, 'meta.json');
    if (!fs.existsSync(metaPath)) {
        res.write(`data: ${JSON.stringify({ error: 'Problem meta not found' })}\n\n`);
        flush();
        res.end();
        return;
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const { test_case_categories: categories, timeout = 2000, memory_limit_kb } =
        meta;

    if (!Array.isArray(categories)) {
        res.write(
            `data: ${JSON.stringify({
                error:
                    'Invalid problem metadata: test_case_categories not found or not an array',
            })}\n\n`
        );
        flush();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        res.end();
        return;
    }

    /* ───── テストスイート構造を通知 ───── */
    res.write(
        `data: ${JSON.stringify({
            type: 'test_suite_info',
            data: {
                categories: categories.map((c) => ({
                    name: c.category_name,
                    test_cases: c.test_cases.map((tc) => path.basename(tc.input)),
                })),
            },
        })}\n\n`
    );
    flush();

    /* ───── 各カテゴリーを処理 ───── */
    let totalPointsEarned = 0;
    const maxTotalPoints = categories.reduce(
        (s, c) => s + (c.points || 0),
        0
    );
    const categorySummaries = [];

    for (const category of categories) {
        let pointsAwarded = category.points || 0;
        let allPassed = true;

        const total = category.test_cases.length;
        const results = new Array(total); // インデックス順保持

        /* ----- MAX_PARALLEL 件ずつ実行 ----- */
        for (let start = 0; start < total; start += MAX_PARALLEL) {
            const slice = category.test_cases.slice(start, start + MAX_PARALLEL);

            await Promise.all(
                slice.map((tc, offset) =>
                    runTestCaseParallel({
                        testCase: tc,
                        category,
                        idx: start + offset,
                        tmpDir,
                        filename,
                        language,
                        timeout,
                        memory_limit_kb,
                    }).then((r) => {
                        results[start + offset] = r;
                    })
                )
            );

            /* バッチ完了 → 元の順番で SSE 送信 */
            for (
                let i = start;
                i < Math.min(start + MAX_PARALLEL, total);
                i++
            ) {
                const r = results[i];
                res.write(`data: ${JSON.stringify(r)}\n\n`);
                flush();
                if (r.status !== 'Accepted') allPassed = false;
            }
        }

        if (!allPassed) pointsAwarded = 0;
        totalPointsEarned += pointsAwarded;

        res.write(
            `data: ${JSON.stringify({
                type: 'category_result',
                category_name: category.category_name,
                category_points_earned: pointsAwarded,
                category_max_points: category.points || 0,
                all_tests_in_category_passed: allPassed,
            })}\n\n`
        );
        flush();

        categorySummaries.push({
            category_name: category.category_name,
            points_earned: pointsAwarded,
            max_points: category.points || 0,
        });
    }

    /* ───── 片付け＋最終結果 ───── */
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.write(
        `data: ${JSON.stringify({
            type: 'final_result',
            total_points_earned: totalPointsEarned,
            max_total_points: maxTotalPoints,
            category_summary: categorySummaries,
        })}\n\n`
    );
    flush();
    res.end();
}

/* ──────────────────────────────────────────────
   テストケースを 1 件だけ実行するヘルパー
────────────────────────────────────────────── */
async function runTestCaseParallel({
                                       testCase,
                                       category,
                                       idx,
                                       tmpDir,
                                       filename,
                                       language,
                                       timeout,
                                       memory_limit_kb,
                                   }) {
    const name = path.basename(testCase.input);

    /* -- 専用サブディレクトリを用意 -- */
    const tcDir = fs.mkdtempSync(path.join(tmpDir, `tc-${idx}-`));
    fs.copyFileSync(path.join(tmpDir, filename), path.join(tcDir, filename));

    /* -- 入力ファイル配置 -- */
    const inputSrc = path.join(process.cwd(), testCase.input);
    if (!fs.existsSync(inputSrc)) {
        fs.rmSync(tcDir, { recursive: true, force: true });
        return {
            type: 'test_case_result',
            category_name: category.category_name,
            testCase: name,
            status: 'Error',
            message: 'Input file not found',
        };
    }
    fs.writeFileSync(
        path.join(tcDir, 'input.txt'),
        fs.readFileSync(inputSrc, 'utf8')
    );

    /* -- Docker 実行 -- */
    const dockerCmd = `docker run --rm -v ${tcDir}:/code executor ${language} /code/${filename}`;
    let execOut;
    try {
        execOut = await execCommand(dockerCmd, timeout * 4);
    } catch (e) {
        fs.rmSync(tcDir, { recursive: true, force: true });
        return {
            type: 'test_case_result',
            category_name: category.category_name,
            testCase: name,
            status: 'Error',
            message: e.toString(),
        };
    }

    /* -- 判定ロジック -- */
    let output = '';
    let timeMs = null;
    let memKb = null;
    let status = '';

    const combined = (execOut.stdout || '') + '\n' + (execOut.stderr || '');
    if (combined.trim()) {
        const lines = combined.trim().split('\n');
        const last = lines[lines.length - 1];
        const m = last.match(/^TIME_MS:(\d+)\s+MEM:(\d+)$/);
        if (m) {
            timeMs = m[1];
            memKb = m[2];
            output = lines.slice(0, -1).join('\n').trim();
        } else {
            output = combined.trim();
        }
    }

    if (execOut.tle) {
        status = 'TLE';
    } else {
        const expectedPath = path.join(process.cwd(), testCase.output);
        if (!fs.existsSync(expectedPath)) {
            status = 'Error';
        } else if (
            output.trim() === fs.readFileSync(expectedPath, 'utf8').trim()
        ) {
            status = 'Accepted';
        } else {
            status = 'Wrong Answer';
        }
        if (memory_limit_kb && memKb && +memKb > memory_limit_kb) status = 'MLE';
    }

    fs.rmSync(tcDir, { recursive: true, force: true });

    return {
        type: 'test_case_result',
        category_name: category.category_name,
        testCase: name,
        status,
        time: timeMs,
        memory: memKb,
        got: output,
    };
}

/* ──────────────────────────────────────────────
   child_process.exec を Promise 化
────────────────────────────────────────────── */
function execCommand(cmd, timeout) {
    return new Promise((resolve, reject) => {
        exec(cmd, {timeout, maxBuffer: 10 * 1024 * 1024}, (err, stdout, stderr) => {
            if (err) {
                if (err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') {
                    resolve({
                        tle: true,
                        killed: err.killed,
                        signal: err.signal,
                        stdout: stdout || '',
                        stderr: stderr || '',
                    });
                } else {
                    reject(stderr || err.message);
                }
            } else {
                resolve({ stdout: stdout || '', stderr: stderr || '' });
            }
        });
    });
}
