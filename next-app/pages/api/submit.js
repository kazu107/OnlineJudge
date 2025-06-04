/* next-app/pages/api/submit.js
   ───────────────────────────────────────────────────────────────
   完全一致型 / 最適化型 共通ジャッジ
   ・meta.json の "timeout" ミリ秒で Docker コンテナを必ず kill
   ・Node 側の exec({timeout: ...}) は使用しない
────────────────────────────────────────────────────────────── */

import { exec } from 'child_process';
import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { fileURLToPath } from 'url';

// __dirname is not defined in ES module scope; recreate it for compatibility
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------- 共通ヘルパ ---------- */

function findProjectRoot(start = __dirname) {
    let cur = start;
    while (!fs.existsSync(path.join(cur, 'package.json'))) {
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
    }
    return cur;
}
const PROJECT_ROOT = findProjectRoot();
const toDockerPath = p => path.resolve(p).replace(/\\/g, '/');

function resolvePath(relOrAbs) {
    if (path.isAbsolute(relOrAbs)) return fs.existsSync(relOrAbs) ? relOrAbs : null;
    const cand = [
        path.join(PROJECT_ROOT, relOrAbs),
        path.join(process.cwd(),  relOrAbs),
    ];
    return cand.find(p => fs.existsSync(p)) || null;
}

/* exec → Promise（timeout 指定なし） */
function execCommand(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(stderr || err.message);
            else     resolve({ stdout, stderr });
        });
    });
}

const MAX_PARALLEL =
    process.env.MAX_PARALLEL
        ? Math.max(1, parseInt(process.env.MAX_PARALLEL, 10))
        : Math.max(1, Math.floor(os.cpus().length / 2));

/* ---------- 1 テストケース実行 ---------- */
async function runTest({
                           testCase, category, idx,
                           tmpDir, filename, language,
                           timeout, memory_limit_kb,
                           evaluation_mode, custom_opts,
                       }) {
    const name = path.basename(testCase.input);
    const tcDir = fs.mkdtempSync(path.join(tmpDir, `tc-${idx}-`));

    fs.copyFileSync(path.join(tmpDir, filename), path.join(tcDir, filename));
    const inputHost = resolvePath(testCase.input);
    if (!inputHost) {
        fs.rmSync(tcDir, {recursive: true, force: true});
        return {
            type: 'test_case_result', category_name: category.category_name,
            testCase: name, status: 'Error', message: `Input not found: ${testCase.input}`
        };
    }
    fs.copyFileSync(inputHost, path.join(tcDir, 'input.txt'));

    /* --- ユーザプログラム実行 (Docker + タイマー kill) --- */
    const cname = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const runCmd =
        `docker run --name ${cname} --rm -i ` +
        `-v "${toDockerPath(tcDir)}":/code executor ` +
        `${language} /code/${filename} < "${toDockerPath(path.join(tcDir, 'input.txt'))}"`;

    const runOut = await new Promise(resolve => {
        let timedOut = false;
        const child = exec(runCmd, {maxBuffer: 10 * 1024 * 1024}, (err, stdout, stderr) => {
            clearTimeout(killer);
            if (timedOut) {
                resolve({tle: true, stdout, stderr});         // 本当に TLE
            } else if (err) {
                resolve({error: true, stdout, stderr});       // 実行時エラー
            } else {
                resolve({stdout, stderr});                    // 正常終了
            }
        });
        /*
        child.on('close', (code, signal) => {
            console.log(
                `[debug] case=${cname} exitCode=${code} signal=${signal} timedOut=${timedOut}`
            );
        });
        */
        const killer = setTimeout(() => {
            /* child がもう閉じていれば何もしない */
            if (child.killed || child.exitCode !== null) return;
               timedOut = true;
               exec(`docker kill ${cname}`, () => {});
               child.kill('SIGKILL');
        }, timeout * 4);
    });

    /* 出力解析 */
    let output = (runOut.stdout||'').trim();
    let timeMs=null, memKb=null;
    const lines=output.split('\n');
    const last =lines.at(-1);
    const m=last.match(/^TIME_MS:(\d+)\s+MEM:(\d+)$/);
    if (m) { timeMs=m[1]; memKb=m[2]; output=lines.slice(0,-1).join('\n').trim(); }

    /* 判定 */
    let status='', rawDist=null, msg='';
    if (runOut.tle) status='TLE';
    else if (runOut.error) status='Error';    // ここを追加
    else if (evaluation_mode==='custom') {
        const evHost=resolvePath(custom_opts.evaluator_script);
        const tcDataHost=resolvePath(
            custom_opts.test_case_data_path_template.replace(
                '{test_case_name}', path.basename(testCase.input, path.extname(testCase.input))
            ));
        if (!evHost||!tcDataHost){ status='Error'; msg='Evaluator or test-case data file missing'; }
        else {
            fs.copyFileSync(evHost,     path.join(tcDir,'evaluator.py'));
            fs.copyFileSync(tcDataHost, path.join(tcDir,'tc.txt'));
            fs.writeFileSync(path.join(tcDir,'user.txt'), output + '\n');

            const evalCmd =
                `docker run --rm -i -v "${toDockerPath(tcDir)}":/w python:3.11-slim ` +
                `python /w/evaluator.py /w/tc.txt < "${toDockerPath(path.join(tcDir,'user.txt'))}"`;
            try {
                const evOut = await execCommand(evalCmd);
                const l = (evOut.stdout||'').trim().split('\n');
                const dist = parseFloat(l.at(-1));
                if (Number.isFinite(dist) && dist >= 0){ status='Scored'; rawDist=dist; }
                else { status='Wrong Answer'; msg='Invalid distance'; }
            } catch (e) { status='Error'; msg=e.toString(); }
        }
    } else {
        const expHost=resolvePath(testCase.output);
        if (!expHost) status='Error';
        else if (output.trim()===fs.readFileSync(expHost,'utf8').trim()) status='Accepted';
        else status='Wrong Answer';
        if (memory_limit_kb && memKb && +memKb > memory_limit_kb) status='MLE';
    }

    /* rmSync (リトライ付) */
    const rm=(retry=3)=>{try{fs.rmSync(tcDir,{recursive:true,force:true});}
    catch(e){if((e.code==='EBUSY'||e.code==='EPERM')&&retry>0)setTimeout(()=>rm(retry-1),100);}};
    rm();

    return { type:'test_case_result', category_name:category.category_name,
        testCase:name, status, time:timeMs, memory:memKb,
        got:output, raw_distance:rawDist, message:msg };
}

/* ---------- API ハンドラ ---------- */
export default async function handler(req,res){
    if(req.method!=='POST'){res.status(405).end();return;}

    res.setHeader('Content-Type','text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    const flush=()=>res.flush && res.flush();

    const {problemId,language,code}=req.body;
    if(!problemId||!language||!code){
        res.write(`data:${JSON.stringify({error:'Missing parameters'})}\n\n`);flush();res.end();return;
    }

    const tmpDir=fs.mkdtempSync(path.join(os.tmpdir(),'submission-'));
    const FN={python:'solution.py',cpp:'solution.cpp',javascript:'solution.js',ruby:'solution.rb',java:'Main.java'};
    const filename=FN[language];
    if(!filename){res.write(`data:${JSON.stringify({error:'Unsupported language'})}\n\n`);flush();res.end();return;}
    fs.writeFileSync(path.join(tmpDir,filename),code);

    const metaPath=resolvePath(`problems/${problemId}/meta.json`);
    if(!metaPath){res.write(`data:${JSON.stringify({error:'Problem meta not found'})}\n\n`);flush();res.end();return;}
    const meta=JSON.parse(fs.readFileSync(metaPath,'utf8'));
    const {evaluation_mode='default',custom_evaluator_options={},
        test_case_categories:cats,timeout=2000,memory_limit_kb}=meta;
    if(!Array.isArray(cats)){
        res.write(`data:${JSON.stringify({error:'Invalid problem meta'})}\n\n`);flush();
        fs.rmSync(tmpDir,{recursive:true,force:true});res.end();return;
    }

    res.write(`data:${JSON.stringify({type:'test_suite_info',
        data:{categories:cats.map(c=>({name:c.category_name,
                test_cases:c.test_cases.map(tc=>path.basename(tc.input))}))}})}\n\n`);flush();

    let totalPts=0,totalDist=0;
    const maxPts=cats.reduce((s,c)=>s+(c.points||0),0);
    const summaries=[];

    for(const cat of cats){
        const N=cat.test_cases.length;
        const results=new Array(N);let allPass=true;

        for(let st=0;st<N;st+=MAX_PARALLEL){
            await Promise.all(cat.test_cases.slice(st,st+MAX_PARALLEL).map((tc,off)=>
                runTest({testCase:tc,category:cat,idx:st+off,
                    tmpDir,filename,language,timeout,memory_limit_kb,
                    evaluation_mode,custom_opts:custom_evaluator_options})
                    .then(r=>{results[st+off]=r;})
            ));
            for(let i=st;i<Math.min(st+MAX_PARALLEL,N);i++){
                const r=results[i];
                res.write(`data:${JSON.stringify(r)}\n\n`);flush();
                if(r.status!=='Accepted'&&r.status!=='Scored')allPass=false;
                if(r.raw_distance!=null)totalDist+=r.raw_distance;
            }
        }

        let catPts=cat.points||0;
        if(evaluation_mode==='custom')catPts=0;
        else if(!allPass)catPts=0;
        totalPts+=catPts;

        res.write(`data:${JSON.stringify({type:'category_result',
            category_name:cat.category_name,
            category_points_earned:catPts,category_max_points:cat.points||0,
            all_tests_in_category_passed:allPass})}\n\n`);flush();

        summaries.push({category_name:cat.category_name,points_earned:catPts,max_points:cat.points||0});
    }

    if(evaluation_mode==='custom'){
        totalPts=Math.max(0,Math.floor(1_000_000_000-totalDist/1_000_000_000));
        if(summaries.length)summaries[0].points_earned=totalPts;
    }

    fs.rmSync(tmpDir,{recursive:true,force:true});
    res.write(`data:${JSON.stringify({type:'final_result',
        total_points_earned:totalPts,max_total_points:maxPts,
        category_summary:summaries,
        final_raw_distance:evaluation_mode==='custom'?totalDist:undefined})}\n\n`);flush();
    res.end();
}
