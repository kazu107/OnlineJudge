// next-app/pages/api/submit.js
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Helper function to recursively copy a directory
function copyDirRecursiveSync(src, dest) {
    try {
        fs.mkdirSync(dest, { recursive: true });
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (let entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                copyDirRecursiveSync(srcPath, destPath);
            } else {
                // Ensure the destination directory exists before copying the file
                fs.mkdirSync(path.dirname(destPath), { recursive: true });
                fs.copyFileSync(srcPath, destPath);
            }
        }
    } catch (error) {
        // Log the error or handle it as needed
        console.error(`Error copying directory from ${src} to ${dest}:`, error);
        // Re-throw the error if you want to stop execution or handle it upstream
        throw error;
    }
}

const MAX_PARALLEL_EXECUTIONS = os.cpus().length > 0 ? os.cpus().length : 2;

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).end();
        return;
    }

    // SSE 用ヘッダー設定
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    let compiledArtifactsDir = null; // To store path to compiled artifacts for C++/Java
    
    const sendEvent = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        if (typeof res.flush === 'function') { 
            res.flush();
        }
    };

    const { problemId, language, code: userCode } = req.body; // Renamed code to userCode
    if (!problemId || !language || !userCode) {
        sendEvent({ type: 'error', error: 'Missing parameters: problemId, language, or code.' });
        res.end();
        return;
    }

    // Determine base filename for the language
    let baseFilename = '';
    switch (language) {
        case 'python': baseFilename = 'solution.py'; break;
        case 'cpp': baseFilename = 'solution.cpp'; break;
        case 'javascript': baseFilename = 'solution.js'; break;
        case 'ruby': baseFilename = 'solution.rb'; break;
        case 'java': baseFilename = 'Main.java'; break; 
        default:
            sendEvent({ type: 'error', error: `Unsupported language: ${language}` });
            res.end();
            return;
    }

    // Pre-compilation step for C++ and Java
    if (language === 'cpp' || language === 'java') {
        const compileTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `compile-${problemId}-`));
        try {
            const sourceFilePathInCompileDir = path.join(compileTmpDir, baseFilename);
            fs.writeFileSync(sourceFilePathInCompileDir, userCode);

            const compileDockerCmd = `docker run --rm -v ${compileTmpDir}:/code executor ${language} /code/${baseFilename}`;
            // Timeout for compilation can be longer, e.g., 10 seconds
            const compilationTimeoutMs = meta.compilation_timeout || 10000; 
            
            sendEvent({ type: 'compilation_started', message: `Compiling ${language} code...` });
            const compileResult = await execCommand(compileDockerCmd, compilationTimeoutMs);

            // Check for compilation errors
            // run.sh exits with 1 on compile error, which execCommand should capture in compileResult.error
            // Also check if primary artifact exists.
            let primaryArtifactMissing = false;
            if (language === 'cpp' && !fs.existsSync(path.join(compileTmpDir, 'a.out'))) {
                primaryArtifactMissing = true;
            } else if (language === 'java' && !fs.existsSync(path.join(compileTmpDir, 'Main.class'))) {
                // This check might need to be more robust if Main.java is not the main file or is in a package.
                // Assuming Main.class is the key indicator for now.
                primaryArtifactMissing = true;
            }

            if (compileResult.error || primaryArtifactMissing) {
                let errorMessage = `Compilation failed for ${language}.`;
                if (compileResult.stderr) {
                    errorMessage += `\nStderr: ${compileResult.stderr}`;
                }
                if (compileResult.stdout) { // Sometimes compilers output errors to stdout
                    errorMessage += `\nStdout: ${compileResult.stdout}`;
                }
                 if (primaryArtifactMissing && !compileResult.error) {
                    errorMessage += `\nError: Compiled artifact (e.g., a.out or Main.class) not found after compilation.`;
                }

                sendEvent({ type: 'compilation_error', message: errorMessage });
                fs.rmSync(compileTmpDir, { recursive: true, force: true });
                res.end();
                return;
            }

            sendEvent({ type: 'compilation_succeeded', message: 'Compilation successful. Preparing for execution...' });
            compiledArtifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), `artifacts-${problemId}-`));
            
            if (language === 'cpp') {
                fs.copyFileSync(path.join(compileTmpDir, 'a.out'), path.join(compiledArtifactsDir, 'a.out'));
            } else { // Java
                copyDirRecursiveSync(compileTmpDir, compiledArtifactsDir); // Copy all class files and potential package structures
            }

        } catch (e) {
            sendEvent({ type: 'compilation_error', message: `An unexpected error occurred during compilation setup: ${e.message}` });
            fs.rmSync(compileTmpDir, { recursive: true, force: true });
            if (compiledArtifactsDir && fs.existsSync(compiledArtifactsDir)) { // Clean up artifacts dir if created before error
                fs.rmSync(compiledArtifactsDir, { recursive: true, force: true });
            }
            res.end();
            return;
        } finally {
            if (fs.existsSync(compileTmpDir)) {
                fs.rmSync(compileTmpDir, { recursive: true, force: true });
            }
        }
    }

    // Load problem metadata
    const metaPath = path.join(process.cwd(), 'problems', problemId, 'meta.json');
    if (!fs.existsSync(metaPath)) {
        sendEvent({ type: 'error', error: `Problem metadata not found for ID: ${problemId}` });
        res.end();
        return;
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const problemCategories = meta.test_case_categories; // Renamed from 'categories'
    const problemTimeoutMs = meta.timeout || 2000; 
    const problemMemoryLimitKb = meta.memory_limit_kb || (256 * 1024); // Default 256MB

    if (!problemCategories || !Array.isArray(problemCategories)) {
        sendEvent({ type: 'error', error: 'Invalid problem metadata: test_case_categories missing or not an array.' });
        res.end();
        return;
    }

    // Prepare all test run tasks
    const allTestRunTasks = [];
    const isPrecompiled = (language === 'cpp' || language === 'java') && compiledArtifactsDir !== null;

    for (const category of problemCategories) {
        if (!category.test_cases || !Array.isArray(category.test_cases)) continue;
        for (const testCase of category.test_cases) {
            const inputFilePath = path.join(process.cwd(), testCase.input);
            const outputFilePath = path.join(process.cwd(), testCase.output);
            const testCaseName = path.basename(testCase.input);

            let taskConfigBase = {
                language, 
                userCode: isPrecompiled ? null : userCode, // No need to pass userCode again if precompiled
                baseFilename,
                problemTimeoutMs, problemMemoryLimitKb,
                categoryName: category.category_name,
                testCaseName,
                isFileError: false,
                fileErrorMessage: '',
                isPrecompiled: isPrecompiled,
                compiledArtifactsPath: isPrecompiled ? compiledArtifactsDir : null
            };

            if (!fs.existsSync(inputFilePath) || !fs.existsSync(outputFilePath)) {
                taskConfigBase.isFileError = true;
                taskConfigBase.fileErrorMessage = `Input or output file not found for ${testCaseName}`;
                taskConfigBase.inputContent = ''; 
                taskConfigBase.expectedOutputContent = '';
            } else {
                taskConfigBase.inputContent = fs.readFileSync(inputFilePath, 'utf8');
                taskConfigBase.expectedOutputContent = fs.readFileSync(outputFilePath, 'utf8');
            }
            allTestRunTasks.push(taskConfigBase);
        }
    }

    const allCollectedResults = [];
    const taskQueue = [...allTestRunTasks]; // Clone the tasks array for workers to pull from
    
    const workerPromises = [];
    for (let i = 0; i < MAX_PARALLEL_EXECUTIONS; i++) {
        workerPromises.push((async () => {
            while (taskQueue.length > 0) {
                const taskConfig = taskQueue.shift(); // Dequeue task
                if (!taskConfig) continue; // Should not happen if taskQueue.length > 0 check is proper

                let result;
                if (taskConfig.isFileError) {
                    result = {
                        type: 'test_case_result',
                        category_name: taskConfig.categoryName,
                        testCase: taskConfig.testCaseName,
                        status: 'Error',
                        message: taskConfig.fileErrorMessage,
                        time:0, memory:0 // No execution
                    };
                } else {
                    result = await runSingleTestCase(taskConfig);
                }
                
                sendEvent(result); // Send individual test case result via SSE
                allCollectedResults.push(result); // Store for final aggregation
            }
        })());
    }

    await Promise.all(workerPromises); // Wait for all worker loops to complete

    // Cleanup compiledArtifactsDir if it was used
    if (compiledArtifactsDir && fs.existsSync(compiledArtifactsDir)) {
        fs.rmSync(compiledArtifactsDir, { recursive: true, force: true });
    }

    // Aggregate results
    let totalPointsEarned = 0;
    const maxTotalPoints = problemCategories.reduce((sum, cat) => sum + (cat.points || 0), 0);
    const categorySummariesForFinalResult = []; // Renamed from categorySummaries

    for (const category of problemCategories) {
        const expectedTestCasesMeta = category.test_cases || [];
        const testCasesResultsForThisCategory = allCollectedResults.filter(r => r.category_name === category.category_name);
        
        let allTestsInThisCategoryPassed = true;
        if (expectedTestCasesMeta.length === 0) {
            allTestsInThisCategoryPassed = true; 
        } else if (testCasesResultsForThisCategory.length !== expectedTestCasesMeta.length) {
            allTestsInThisCategoryPassed = false; 
        } else {
            for (const tcResult of testCasesResultsForThisCategory) {
                if (tcResult.status !== 'Accepted') {
                    allTestsInThisCategoryPassed = false;
                    break;
                }
            }
        }
        
        let categoryPointsAwarded = 0;
        if (allTestsInThisCategoryPassed) {
            categoryPointsAwarded = category.points || 0;
        } else {
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
        sendEvent(categoryResultEvent);

        categorySummariesForFinalResult.push({
            category_name: category.category_name,
            points_earned: categoryPointsAwarded,
            max_points: category.points || 0
        });
    }

    const finalResultEvent = {
        type: 'final_result',
        total_points_earned: totalPointsEarned,
        max_total_points: maxTotalPoints,
        category_summary: categorySummariesForFinalResult // Use renamed variable
    };
    sendEvent(finalResultEvent);
    
    res.end();
}

// execCommand: Executes a shell command with timeout, capturing stdout, stderr, and TLE/error info.
// It attempts to parse TIME_MS and MEM_KB from the last line of output if present.
function execCommand(cmd, timeoutMs) {
    return new Promise((resolve) => {
        // Ensure command is executed with a shell that understands timeout if it's part of cmd string.
        // Or, rely on exec's built-in timeout.
        exec(cmd, { timeout: timeoutMs, shell: true }, (error, stdout, stderr) => {
            const stdoutStr = stdout.toString().trim();
            const stderrStr = stderr.toString().trim();
            let execTimeMs = null;
            let memUsageKb = null;
            let tle = false;

            // Try to parse TIME_MS and MEM_KB from the last non-empty line of combined output.
            const combinedOutputForParsing = (stdoutStr + '\n' + stderrStr).trim();
            const lines = combinedOutputForParsing.split('\n');
            
            if (lines.length > 0) {
                const lastLine = lines[lines.length - 1];
                // Ensure robust parsing, e.g. ignore if not numbers or if line is not *only* this.
                const timeMatch = lastLine.match(/TIME_MS:(\d+)/);
                const memMatch = lastLine.match(/MEM_KB:(\d+)/); 
                if (timeMatch && lastLine.includes("TIME_MS:") && timeMatch.index === lastLine.indexOf("TIME_MS:")) {
                     if (memMatch && lastLine.includes("MEM_KB:") && memMatch.index === lastLine.indexOf("MEM_KB:")) {
                        // Check if the line structure is "TIME_MS:val MEM_KB:val" or "MEM_KB:val TIME_MS:val"
                        const timePart = `TIME_MS:${timeMatch[1]}`;
                        const memPart = `MEM_KB:${memMatch[1]}`;
                        const cleanedLine = lastLine.replace(timePart, "").replace(memPart, "").trim();
                        if (cleanedLine === "") { // Only time and mem info on the line
                            execTimeMs = parseInt(timeMatch[1], 10);
                            memUsageKb = parseInt(memMatch[1], 10);
                        }
                     } else if (!lastLine.includes("MEM_KB:")) { // Only TIME_MS
                        const timePart = `TIME_MS:${timeMatch[1]}`;
                        if (lastLine.replace(timePart, "").trim() === "") {
                            execTimeMs = parseInt(timeMatch[1], 10);
                        }
                     }
                } else if (memMatch && lastLine.includes("MEM_KB:") && memMatch.index === lastLine.indexOf("MEM_KB:")) { // Only MEM_KB
                     if (!lastLine.includes("TIME_MS:")) {
                        const memPart = `MEM_KB:${memMatch[1]}`;
                        if (lastLine.replace(memPart, "").trim() === "") {
                            memUsageKb = parseInt(memMatch[1], 10);
                        }
                     }
                }
            }

            if (error) {
                // Check for TLE conditions (signal SIGTERM from timeout, or specific error codes/messages)
                if (error.signal === 'SIGTERM' || error.code === 124 || (error.killed && timeoutMs && error.message.includes('ETIMEDOUT'))) {
                    tle = true;
                }
                resolve({
                    stdout: stdoutStr,
                    stderr: stderrStr,
                    error: error, 
                    tle: tle,
                    signal: error.signal,
                    killed: error.killed,
                    execTimeMs: execTimeMs, 
                    memUsageKb: memUsageKb   
                });
            } else {
                resolve({
                    stdout: stdoutStr,
                    stderr: stderrStr,
                    error: null,
                    tle: false,
                    execTimeMs: execTimeMs,
                    memUsageKb: memUsageKb
                });
            }
        });
    });
}

async function runSingleTestCase(config) {
    const {
        language,
        userCode, // Will be null if isPrecompiled is true
        baseFilename, 
        inputContent,
        expectedOutputContent,
        problemTimeoutMs,
        problemMemoryLimitKb,
        categoryName,
        testCaseName,
        isPrecompiled,          // New parameter
        compiledArtifactsPath   // New parameter (path to the directory)
    } = config;

    const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `judgerun-${categoryName.replace(/[^a-zA-Z0-9]/g, '_')}-${testCaseName.replace('.txt', '')}-`));
    
    let result = {
        type: 'test_case_result',
        category_name: categoryName,
        testCase: testCaseName,
        status: 'Error', 
        time: null, 
        memory: null, 
        got: '',
        expected: '',
        message: '', 
        signal: null
    };

    try {
        fs.writeFileSync(path.join(testTmpDir, 'input.txt'), inputContent);

        if (isPrecompiled) {
            if (language === 'cpp') {
                fs.copyFileSync(path.join(compiledArtifactsPath, 'a.out'), path.join(testTmpDir, 'a.out'));
            } else if (language === 'java') {
                // Copy all contents from compiledArtifactsDir to testTmpDir for Java
                copyDirRecursiveSync(compiledArtifactsPath, testTmpDir);
            }
        } else {
            // For non-precompiled languages (Python, JS, Ruby), write the user code directly.
            const solutionFilePath = path.join(testTmpDir, baseFilename);
            fs.writeFileSync(solutionFilePath, userCode);
        }

        const dockerMemoryLimit = `${problemMemoryLimitKb}k`;
        let dockerCmdParts = [
            'docker run --rm',
            '--network=none',
            `--memory=${dockerMemoryLimit}`,
            '--cpus="1.0"',
            `-v ${testTmpDir}:/code`
        ];

        if (isPrecompiled) {
            dockerCmdParts.push('-e EXECUTE_ONLY=true');
        }
        
        dockerCmdParts.push(`executor ${language} /code/${baseFilename}`);
        const dockerCmd = dockerCmdParts.join(' ');
        
        const commandTimeout = problemTimeoutMs + 1000; // 1s buffer for overhead
        const execResult = await execCommand(dockerCmd, commandTimeout);

        result.time = execResult.execTimeMs;
        result.memory = execResult.memUsageKb; 

        const outputFilePath = path.join(testTmpDir, 'output.txt');
        if (fs.existsSync(outputFilePath)) {
            result.got = fs.readFileSync(outputFilePath, 'utf8').trim();
        } else { 
            let stdoutToParse = execResult.stdout;
            if (execResult.execTimeMs !== null || execResult.memUsageKb !== null) {
                const lines = execResult.stdout.split('\n');
                const lastLine = lines.length > 0 ? lines[lines.length-1] : "";
                if (lastLine.includes("TIME_MS:") && lastLine.includes("MEM_KB:")) {
                    const testLine = lastLine.replace(/TIME_MS:\d+/, "").replace(/MEM_KB:\d+/, "").replace(/\s/g, "");
                    if (testLine === "") {
                        lines.pop();
                        stdoutToParse = lines.join('\n');
                    }
                }
            }
            result.got = stdoutToParse.trim();
        }
        
        const stderrFilePath = path.join(testTmpDir, 'stderr.txt');
        let stderrContent = "";
        if (fs.existsSync(stderrFilePath)) {
            stderrContent = fs.readFileSync(stderrFilePath, 'utf8').trim();
        } else { 
            stderrContent = execResult.stderr.trim();
            if (execResult.execTimeMs !== null || execResult.memUsageKb !== null) {
                const lines = stderrContent.split('\n');
                const lastLine = lines.length > 0 ? lines[lines.length-1] : "";
                 if (lastLine.includes("TIME_MS:") && lastLine.includes("MEM_KB:")) {
                    const testLine = lastLine.replace(/TIME_MS:\d+/, "").replace(/MEM_KB:\d+/, "").replace(/\s/g, "");
                    if (testLine === "") {
                        lines.pop();
                        stderrContent = lines.join('\n').trim();
                    }
                }
            }
        }

        if (stderrContent) {
             result.got = (result.got ? result.got + "\n--- STDERR ---\n" : '') + stderrContent;
        }

        if (execResult.tle) {
            result.status = 'TLE';
            result.signal = execResult.signal;
        } else if (execResult.error) { 
            result.status = 'Error';
            result.message = `Execution error: ${execResult.error.message || 'Unknown execution error'}`;
            if (stderrContent && !result.message.includes(stderrContent)) { 
                result.message += ` (stderr: ${stderrContent})`;
            }
        } else if (result.memory !== null && problemMemoryLimitKb && result.memory > problemMemoryLimitKb) {
            result.status = 'MLE';
        } else {
            const expected = expectedOutputContent.trim();
            if (result.got.trim() === expected) {
                result.status = 'Accepted';
            } else {
                result.status = 'Wrong Answer';
                result.expected = expected;
            }
        }

    } catch (e) { 
        result.status = 'Error';
        result.message = `Internal judging system error: ${e.message || String(e)}`;
    } finally {
        fs.rmSync(testTmpDir, { recursive: true, force: true }); 
    }
    return result;
}