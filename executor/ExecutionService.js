// executor/ExecutionService.js
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { spawn, exec } = require('child_process'); // exec for simple ps, spawn for main processes

class ExecutionService {
    constructor(languageDefinitions) {
        this.languageDefinitions = languageDefinitions;
    }

    async _createTempDir() {
        return fs.mkdtemp(path.join(os.tmpdir(), 'executor-'));
    }

    async _cleanupTempDir(tempDir) {
        if (tempDir && tempDir.startsWith(os.tmpdir())) { // Basic safety check
            try {
                await fs.rm(tempDir, { recursive: true, force: true });
            } catch (err) {
                console.error(`Error cleaning up temp directory ${tempDir}:`, err);
            }
        }
    }

    async compile(language, code, tempDir, timeLimitMs = 10000) {
        const langDef = this.languageDefinitions[language];
        if (!langDef || !langDef.needs_compilation) {
            // If no compilation needed or language not defined for compilation,
            // still write the source file and return its path.
            // The caller (executeCode) will decide what to do.
            if (!langDef) throw new Error(`Language definition for '${language}' not found.`);
            const sourceFilePath = path.join(tempDir, `source${langDef.source_file_extension}`);
            await fs.writeFile(sourceFilePath, code);
            return { executablePath: sourceFilePath, compilationSuccess: true };
        }

        const sourceFileName = `source${langDef.source_file_extension}`;
        const sourceFilePath = path.join(tempDir, sourceFileName);
        await fs.writeFile(sourceFilePath, code);

        // For C++, outputName is path without extension. For Java, it's the directory.
        let outputNameOrDir;
        if (language === 'java') {
            outputNameOrDir = tempDir; // javac -d <dir>
        } else {
            outputNameOrDir = path.join(tempDir, 'executable'); // e.g., /tmp/executor-xyz/executable
        }
        
        const [compileCommand, ...compileArgs] = langDef.get_compilation_command(sourceFilePath, outputNameOrDir);

        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            const compiler = spawn(compileCommand, compileArgs, { cwd: tempDir });
            let stdout = '';
            let stderr = '';
            let timedOut = false;

            const timer = setTimeout(() => {
                timedOut = true;
                compiler.kill('SIGKILL');
                reject({
                    errorType: 'compile_timeout',
                    message: 'Compilation timed out.',
                    stderr,
                    durationMs: Date.now() - startTime,
                });
            }, timeLimitMs);

            compiler.stdout.on('data', (data) => stdout += data.toString());
            compiler.stderr.on('data', (data) => stderr += data.toString());

            compiler.on('error', (err) => {
                clearTimeout(timer);
                reject({
                    errorType: 'compile_error',
                    message: `Compilation failed to start: ${err.message}`,
                    stderr,
                    durationMs: Date.now() - startTime,
                });
            });

            compiler.on('close', (code) => {
                clearTimeout(timer);
                if (timedOut) return; // Already handled by timer reject

                const durationMs = Date.now() - startTime;
                if (code === 0) {
                    let executablePath = outputNameOrDir;
                    if (language === 'java') {
                         // For Java, executablePath is the source file path, run() will derive class name
                        executablePath = sourceFilePath;
                    } else if (langDef.compiled_file_extension === '') {
                        // C++ executable has no extension by default from g++
                        executablePath = outputNameOrDir; // This is already /tmp/executor-xyz/executable
                    } else if (langDef.compiled_file_extension) {
                         executablePath = outputNameOrDir + langDef.compiled_file_extension;
                    }
                    resolve({ executablePath, compilationSuccess: true, stdout, stderr, durationMs });
                } else {
                    reject({
                        errorType: 'compile_error',
                        message: 'Compilation failed.',
                        exitCode: code,
                        stdout,
                        stderr,
                        durationMs,
                    });
                }
            });
        });
    }

    async run(executablePathOrScriptPath, language, stdinStr = '', timeLimitMs = 2000, memoryLimitKb = 256000, tempDir) {
        const langDef = this.languageDefinitions[language];
        if (!langDef) {
            throw new Error(`Language definition for '${language}' not found for execution.`);
        }

        const [command, ...args] = langDef.get_execution_command(executablePathOrScriptPath);
        const cpuTimeLimitS = Math.ceil(timeLimitMs / 1000);
        const isWindows = os.platform() === 'win32';

        let shellCommand = '';
        let spawnOptions = { cwd: tempDir, detached: !isWindows }; // detached for process group killing on Unix

        if (isWindows) {
            // ulimit not available on Windows. Construct direct command.
            // Memory/CPU limit enforcement will be harder here.
            // Timeout will be handled by JavaScript setTimeout + taskkill.
            shellCommand = command; // command is already the executable
            spawnOptions.shell = false; // spawn command directly
            if (args.length > 0) spawnOptions.args = args; // pass args to spawn if any
        } else {
            // Linux/macOS: Use ulimit within a shell command
            // Properly escape command and arguments for shell execution
            const escapedCommand = command.replace(/"/g, '\\"');
            const escapedArgs = args.map(arg => arg.replace(/"/g, '\\"'));
            
            // Note: -S uses soft limits. -H for hard limits.
            // -t: CPU time in seconds.
            // -v: virtual memory in KB.
            // `exec` replaces the shell process with the command, inheriting limits.
            shellCommand = `ulimit -S -v ${memoryLimitKb} -S -t ${cpuTimeLimitS}; exec "${escapedCommand}"`;
            if (escapedArgs.length > 0) {
                shellCommand += ` "${escapedArgs.join('" "')}"`;
            }
            spawnOptions.shell = true; // Execute the command through a shell
        }
        
        return new Promise((resolve) => {
            const startTime = Date.now();
            const child = spawn(shellCommand, isWindows ? args : [], spawnOptions); // Pass args directly only if not using shell string for command
            
            let stdout = '';
            let stderr = '';
            let timedOut = false;
            let memoryExceeded = false;
            let maxMemoryUsageKb = 0;
            let psInterval;

            const pid = child.pid;

            const timer = setTimeout(() => {
                timedOut = true;
                if (isWindows) {
                    exec(`taskkill /PID ${pid} /F /T`, (err) => { // /T kills child processes
                        if (err) console.error(`Failed to kill process ${pid} on Windows: ${err}`);
                    });
                } else if (pid) { // pid might not be set if spawn fails very early
                    try { process.kill(-pid, 'SIGKILL'); } // Kill process group
                    catch (e) { 
                        // console.warn(`Failed to kill process group -${pid}, attempting single kill: ${e.message}`);
                        try { child.kill('SIGKILL'); } catch (e2) {/* ignore */}
                    } 
                }
            }, timeLimitMs);

            if (!isWindows && pid) {
                psInterval = setInterval(async () => {
                    try {
                        const { stdout: psStdout } = await new Promise((res, rej) => 
                            exec(`ps -o rss= -p ${pid}`, (err, ps_stdout) => err ? rej(err) : res({stdout: ps_stdout}))
                        );
                        const currentMemoryKb = parseInt(psStdout.trim(), 10);
                        if (!isNaN(currentMemoryKb)) {
                            maxMemoryUsageKb = Math.max(maxMemoryUsageKb, currentMemoryKb);
                            if (currentMemoryKb > memoryLimitKb) {
                                memoryExceeded = true;
                                if (pid) {
                                   try { process.kill(-pid, 'SIGKILL'); }
                                   catch (e) { 
                                       try { child.kill('SIGKILL'); } catch (e2) {/* ignore */}
                                   }
                                }
                            }
                        }
                    } catch (err) {
                        // Process might have already exited
                        // console.warn(`Memory check for PID ${pid} failed (process likely exited): ${err.message}`);
                        if (psInterval) clearInterval(psInterval); // Stop polling if ps fails (e.g. process gone)
                    }
                }, 200); // Check memory every 200ms
            }

            child.stdout.on('data', (data) => stdout += data.toString());
            child.stderr.on('data', (data) => stderr += data.toString());

            if (stdinStr) {
                try {
                    child.stdin.write(stdinStr);
                    child.stdin.end();
                } catch (e) {
                    console.error("Error writing to child stdin:", e);
                }
            } else {
                 try { child.stdin.end(); } catch(e) {/* ignore */}
            }
            
            child.on('error', (err) => {
                // This usually means the command could not be spawned (e.g., command not found)
                clearTimeout(timer);
                if (psInterval) clearInterval(psInterval);
                resolve({
                    stdout, stderr, exitCode: null, signal: null, durationMs: Date.now() - startTime,
                    memoryKb: maxMemoryUsageKb, errorType: 'spawn_error', message: err.message
                });
            });

            child.on('close', (code, signal) => {
                clearTimeout(timer);
                if (psInterval) clearInterval(psInterval);
                
                const durationMs = Date.now() - startTime;
                let errorType = null;

                if (timedOut) {
                    errorType = 'timeout';
                } else if (memoryExceeded) {
                    errorType = 'memory_exceeded';
                } else if (signal === 'SIGXCPU' || (code === null && signal === 'SIGTERM' && durationMs >= timeLimitMs -100) ) { // SIGTERM might be from ulimit -t
                    errorType = 'timeout'; // CPU time limit exceeded via ulimit
                } else if (signal === 'SIGSEGV' || (code !== 0 && code !== null) ) { // SIGSEGV for memory errors, or non-zero exit for runtime
                    errorType = 'runtime_error';
                } else if (signal) { // Other signals
                    errorType = 'runtime_error';
                     stderr += `\nProcess terminated by signal: ${signal}`;
                }
                // Note: `ulimit -v` often results in the process being killed by SIGKILL or SIGSEGV
                // if it tries to allocate more memory, or malloc fails.
                // The memory polling is a secondary check.

                resolve({ stdout, stderr, exitCode: code, signal, durationMs, memoryKb: maxMemoryUsageKb, errorType });
            });
        });
    }

    async executeCode({ language, code, stdin, time_limit_ms, memory_limit_kb }) {
        const langDef = this.languageDefinitions[language];
        if (!langDef) return { errorType: 'unsupported_language', message: `Language '${language}' is not supported.` };

        const tempDir = await this._createTempDir();
        let result;
        let executablePath = '';

        try {
            if (langDef.needs_compilation) {
                const compileResult = await this.compile(language, code, tempDir, Math.max(time_limit_ms, 5000)); // Give compilation at least 5s
                executablePath = compileResult.executablePath;
                if (!compileResult.compilationSuccess) {
                    // compile() already rejects with structured error
                    // This path should ideally not be taken if compile rejects.
                    // This is a safeguard if compile() was changed to resolve with error info.
                    return { ...compileResult, errorType: compileResult.errorType || 'compile_error' };
                }
            } else {
                const sourceFileName = `source${langDef.source_file_extension}`;
                executablePath = path.join(tempDir, sourceFileName);
                await fs.writeFile(executablePath, code);
            }
            
            result = await this.run(executablePath, language, stdin, time_limit_ms, memory_limit_kb, tempDir);

        } catch (err) { // Catch errors from compile() or other unexpected issues
            result = {
                stdout: err.stdout || '', 
                stderr: err.stderr || err.message, 
                exitCode: err.exitCode, 
                signal: err.signal, 
                durationMs: err.durationMs, 
                memoryKb: 0, 
                errorType: err.errorType || 'internal_error',
                message: err.message
            };
        } finally {
            await this._cleanupTempDir(tempDir);
        }
        return result;
    }

    async evaluateCode({ 
        evaluator_script_host_path, // This is the path on the host where executor service is running
        user_solution_content,      // This is the actual content (stdout) from user's code
        test_data_host_path,        // Path on the host for test data
        max_points, 
        evaluator_language, 
        timeout_ms 
    }) {
        // For custom evaluation, the evaluator script is run directly by this ExecutionService.
        // It's assumed that this service itself might be in a restricted environment,
        // but it's not spawning another Docker container for the evaluator.
        // The paths are host paths accessible to this service.

        const langDef = this.languageDefinitions[evaluator_language];
        if (!langDef) {
            return { success: false, error_type: 'unsupported_language', message: `Evaluator language '${evaluator_language}' is not supported.` };
        }

        const tempDir = await this._createTempDir();
        let result;
        const userSolutionFilePath = path.join(tempDir, 'user_solution.txt');
        const evaluatorScriptInTempDir = path.join(tempDir, path.basename(evaluator_script_host_path));

        try {
            await fs.writeFile(userSolutionFilePath, user_solution_content);
            await fs.copyFile(evaluator_script_host_path, evaluatorScriptInTempDir);
            await fs.chmod(evaluatorScriptInTempDir, 0o755); // Ensure evaluator is executable

            // Command for evaluator: evaluator_script user_solution_file test_data_file max_points
            // The paths passed to evaluator are paths within tempDir or direct host paths.
            // For simplicity, let's assume evaluator can handle absolute paths for test_data_host_path.
            const argsForRun = [
                evaluatorScriptInTempDir, // This is now the path to the script to execute
                userSolutionFilePath, 
                test_data_host_path, // Evaluator script needs to know how to access this
                max_points.toString()
            ];
            
            // We use a simplified call to run, or a direct spawn, as ulimit wrapping might be different for evaluators
            // Using a direct spawn here for clarity, assuming evaluator resource limits are handled by caller or default.
            // Or, reuse this.run but ensure its command construction is flexible.
            // For now, a direct spawn:
            const [command, ...initialArgs] = langDef.get_execution_command(evaluatorScriptInTempDir);
            const allArgs = initialArgs.concat(argsForRun.slice(1)); // evaluatorScriptInTempDir is already the command/first arg

            const evalStartTime = Date.now();
            const evaluatorProcess = spawn(command, allArgs, { cwd: tempDir, timeout: timeout_ms });

            let stdout = '';
            let stderr = '';
            
            evaluatorProcess.stdout.on('data', (data) => stdout += data.toString());
            evaluatorProcess.stderr.on('data', (data) => stderr += data.toString());

            return new Promise((resolve) => {
                evaluatorProcess.on('error', (err) => {
                    resolve({ success: false, error_type: 'evaluator_spawn_error', message: err.message, stderr, durationMs: Date.now() - evalStartTime });
                });
                evaluatorProcess.on('close', (code, signal) => {
                    const durationMs = Date.now() - evalStartTime;
                    if (signal || code !== 0) { // Timeout (if timeout option in spawn worked) or runtime error
                        let errorType = 'evaluator_runtime_error';
                        if (signal === 'SIGTERM' || (code === null && signal === 'SIGKILL' && durationMs >= timeout_ms - 100)) { // SIGKILL from timeout
                            errorType = 'evaluator_timeout';
                        }
                        resolve({ success: false, error_type: errorType, message: `Evaluator exited with code ${code}, signal ${signal}.`, stdout, stderr, durationMs });
                        return;
                    }
                    try {
                        const evaluationResult = JSON.parse(stdout.trim());
                        resolve({ success: true, evaluation_result: evaluationResult, stderr, durationMs });
                    } catch (parseError) {
                        resolve({ success: false, error_type: 'evaluator_output_parse_error', message: 'Failed to parse evaluator output.', stdout, stderr, durationMs });
                    }
                });
            });

        } catch (err) {
            result = { success: false, error_type: 'internal_evaluator_error', message: err.message };
        } finally {
            await this._cleanupTempDir(tempDir);
        }
        return result;
    }

    async startInteractiveSession(userCodeOptions, evaluatorOptions, timeLimitMs, memoryLimitKb, tempDir) {
        // TODO: Implement interactive evaluation logic
        // userCodeOptions: { language, code, executablePath }
        // evaluatorOptions: { scriptPath, language, startupDataForEvaluator }
        // timeLimitMs, memoryLimitKb for user's program

        const langDefUser = this.languageDefinitions[userCodeOptions.language];
        if (!langDefUser) {
            return { 
                status: 'Error', 
                message: `User language '${userCodeOptions.language}' is not supported.`,
                interaction_log: [],
                durationMs: 0,
                memoryKb: 0,
                user_stderr: '',
                evaluator_stderr: ''
            };
        }

        const langDefEvaluator = this.languageDefinitions[evaluatorOptions.language];
        if (!langDefEvaluator) {
            return {
                status: 'Error',
                message: `Evaluator language '${evaluatorOptions.language}' is not supported.`,
                interaction_log: [],
                durationMs: 0,
                memoryKb: 0,
                user_stderr: '',
                evaluator_stderr: ''
            };
        }

        let userExecutablePath = userCodeOptions.executablePath;
        let userCompileError = null;

        // 2.a. User Program Preparation
        if (userCodeOptions.code) {
            if (!langDefUser.needs_compilation) {
                const sourceFileName = `source${langDefUser.source_file_extension}`;
                userExecutablePath = path.join(tempDir, sourceFileName);
                try {
                    await fs.writeFile(userExecutablePath, userCodeOptions.code);
                } catch (writeError) {
                    return {
                        status: 'Error',
                        message: `Failed to write user source code: ${writeError.message}`,
                        interaction_log: [], durationMs: 0, memoryKb: 0, user_stderr: '', evaluator_stderr: ''
                    };
                }
            } else {
                try {
                    // Give compilation a bit more time, similar to executeCode
                    const compileResult = await this.compile(userCodeOptions.language, userCodeOptions.code, tempDir, Math.max(timeLimitMs, 10000));
                    if (!compileResult.compilationSuccess) {
                        // This structure is based on how compile() rejects
                        userCompileError = {
                            status: 'CompileError',
                            message: compileResult.message || 'User code compilation failed.',
                            user_stderr: compileResult.stderr || '',
                            evaluator_stderr: '',
                            interaction_log: [],
                            durationMs: compileResult.durationMs || 0,
                            memoryKb: 0,
                        };
                    }
                    userExecutablePath = compileResult.executablePath;
                } catch (err) { // Catch errors from compile()
                    userCompileError = {
                        status: 'CompileError',
                        message: err.message || 'User code compilation failed unexpectedly.',
                        user_stderr: err.stderr || '',
                        evaluator_stderr: '',
                        interaction_log: [],
                        durationMs: err.durationMs || 0,
                        memoryKb: 0,
                    };
                }
            }
        }

        if (userCompileError) {
            return userCompileError;
        }

        if (!userExecutablePath) {
            return {
                status: 'Error',
                message: 'User executable path is missing after preparation.',
                interaction_log: [], durationMs: 0, memoryKb: 0, user_stderr: '', evaluator_stderr: ''
            };
        }
        
        // Ensure user executable exists if path was provided directly
        if (userCodeOptions.executablePath) {
            try {
                await fs.access(userExecutablePath);
            } catch (accessError) {
                 return {
                    status: 'Error',
                    message: `User executable path not found or not accessible: ${userExecutablePath}`,
                    interaction_log: [], durationMs: 0, memoryKb: 0, user_stderr: '', evaluator_stderr: ''
                };
            }
        }


        // 2.b. Evaluator Preparation
        const [evaluatorCommand, ...evaluatorArgsBase] = langDefEvaluator.get_execution_command(evaluatorOptions.scriptPath);
        let evaluatorArgs = [...evaluatorArgsBase];

        // Handle startupDataForEvaluator - simplistic approach: pass as first arg if present
        // A more robust solution might involve environment variables or specific evaluator script design
        if (evaluatorOptions.startupDataForEvaluator) {
            evaluatorArgs.push(evaluatorOptions.startupDataForEvaluator);
        }
        
        const interaction_log = [];
        let userProgram, evaluatorScript;
        let user_stderr = '', evaluator_stderr = '';
        let finalStatus = 'Pending'; // Possible values: Accepted, WrongAnswer, RuntimeError, TimeLimitExceeded, MemoryLimitExceeded, EvaluatorError, InternalError
        let finalMessage = '';
        let userDurationMs = 0;
        let userMemoryKb = 0;

        const cleanupProcesses = (signal = 'SIGKILL') => {
            if (userProgram && userProgram.pid && !userProgram.killed) {
                try {
                    if (os.platform() === 'win32') {
                        exec(`taskkill /PID ${userProgram.pid} /F /T`);
                    } else {
                        process.kill(-userProgram.pid, signal); // Kill process group
                    }
                } catch (e) { /* ignore */ }
                try { userProgram.kill(signal); } catch (e) { /* ignore */ }
            }
            if (evaluatorScript && evaluatorScript.pid && !evaluatorScript.killed) {
                try { evaluatorScript.kill(signal); } catch (e) { /* ignore */ }
            }
        };
        
        return new Promise(async (resolve) => {
            // 3.c. Spawning User Program (adapted from run method)
            const [userCmd, ...userArgs] = langDefUser.get_execution_command(userExecutablePath);
            const cpuTimeLimitS = Math.ceil(timeLimitMs / 1000);
            const isWindows = os.platform() === 'win32';
            let userShellCommand = '';
            let userSpawnOptions = { cwd: tempDir, detached: !isWindows, stdio: ['pipe', 'pipe', 'pipe'] };

            if (isWindows) {
                userShellCommand = userCmd;
                userSpawnOptions.shell = false;
                if (userArgs.length > 0) userSpawnOptions.args = userArgs;
            } else {
                const escapedCommand = userCmd.replace(/"/g, '\\"');
                const escapedArgs = userArgs.map(arg => arg.replace(/"/g, '\\"'));
                userShellCommand = `ulimit -S -v ${memoryLimitKb} -S -t ${cpuTimeLimitS}; exec "${escapedCommand}"`;
                if (escapedArgs.length > 0) {
                    userShellCommand += ` "${escapedArgs.join('" "')}"`;
                }
                userSpawnOptions.shell = true;
            }

            const userStartTime = Date.now();
            userProgram = spawn(userShellCommand, isWindows ? userArgs : [], userSpawnOptions);

            let userTimedOut = false;
            let userMemoryExceeded = false;
            let maxMemoryUsageKb = 0;
            let psInterval;

            const userTimer = setTimeout(() => {
                userTimedOut = true;
                finalStatus = 'TimeLimitExceeded';
                finalMessage = 'User program exceeded time limit.';
                cleanupProcesses('SIGKILL'); // Force kill
            }, timeLimitMs);

            if (!isWindows && userProgram.pid) {
                psInterval = setInterval(async () => {
                    if (!userProgram || userProgram.killed || userProgram.exitCode !== null) {
                        clearInterval(psInterval);
                        return;
                    }
                    try {
                        const { stdout: psStdout } = await new Promise((res, rej) => 
                            exec(`ps -o rss= -p ${userProgram.pid}`, (err, ps_stdout) => err ? rej(err) : res({stdout: ps_stdout}))
                        );
                        const currentMemoryKb = parseInt(psStdout.trim(), 10);
                        if (!isNaN(currentMemoryKb)) {
                            maxMemoryUsageKb = Math.max(maxMemoryUsageKb, currentMemoryKb);
                            if (currentMemoryKb > memoryLimitKb) {
                                userMemoryExceeded = true;
                                finalStatus = 'MemoryLimitExceeded';
                                finalMessage = 'User program exceeded memory limit.';
                                cleanupProcesses('SIGKILL'); // Force kill
                            }
                        }
                    } catch (err) { // Process might have exited
                        clearInterval(psInterval);
                    }
                }, 200);
            }

            // 3.c. Spawning Evaluator Script
            // For now, evaluator has a more generous timeout (e.g., timeLimitMs + 5s) or no specific limit from this script.
            // Its resource usage is not strictly monitored by this service.
            evaluatorScript = spawn(evaluatorCommand, evaluatorArgs, { cwd: tempDir, stdio: ['pipe', 'pipe', 'pipe'] });
            
            // Error handling for spawns
            userProgram.on('error', (err) => {
                if (finalStatus !== 'Pending') return; // Already determined by TLE/MLE or other event
                finalStatus = 'RuntimeError';
                finalMessage = `User program failed to start: ${err.message}`;
                user_stderr += `\nUser program spawn error: ${err.message}`;
                cleanupProcesses();
                clearTimeout(userTimer);
                if (psInterval) clearInterval(psInterval);
                resolveInteraction();
            });

            evaluatorScript.on('error', (err) => {
                if (finalStatus !== 'Pending') return;
                finalStatus = 'EvaluatorError';
                finalMessage = `Evaluator script failed to start: ${err.message}`;
                evaluator_stderr += `\nEvaluator script spawn error: ${err.message}`;
                cleanupProcesses();
                clearTimeout(userTimer);
                if (psInterval) clearInterval(psInterval);
                resolveInteraction();
            });


            // 3.d. Interactive Loop & Piping & 3.e. Interaction Log
            userProgram.stdout.on('data', (data) => {
                const textData = data.toString();
                interaction_log.push({ source: 'user', data: textData, timestamp: Date.now() });
                if (evaluatorScript && !evaluatorScript.stdin.destroyed) {
                    try {
                        evaluatorScript.stdin.write(data);
                    } catch (e) {
                        console.error("Error writing to evaluator stdin:", e);
                        // Potentially an error condition, evaluator might have closed stdin
                    }
                }
            });

            evaluatorScript.stdout.on('data', (data) => {
                const textData = data.toString();
                interaction_log.push({ source: 'evaluator', data: textData, timestamp: Date.now() });

                // Check for AC/WA signals
                if (textData.includes('__AC__')) {
                    if (finalStatus === 'Pending') { // Ensure not already TLE/MLE etc.
                        finalStatus = 'Accepted';
                        finalMessage = textData.substring(textData.indexOf('__AC__') + 6).trim();
                    }
                    cleanupProcesses(); // Signal evaluator to stop, then user program
                } else if (textData.includes('__WA__')) {
                     if (finalStatus === 'Pending') {
                        finalStatus = 'WrongAnswer';
                        finalMessage = textData.substring(textData.indexOf('__WA__') + 6).trim();
                    }
                    cleanupProcesses();
                } else {
                    if (userProgram && !userProgram.stdin.destroyed) {
                        try {
                            userProgram.stdin.write(data);
                        } catch (e) {
                            console.error("Error writing to user program stdin:", e);
                            // User program might have closed stdin
                        }
                    }
                }
            });

            userProgram.stderr.on('data', (data) => {
                user_stderr += data.toString();
                interaction_log.push({ source: 'user_stderr', data: data.toString(), timestamp: Date.now() });
            });
            evaluatorScript.stderr.on('data', (data) => {
                evaluator_stderr += data.toString();
                interaction_log.push({ source: 'evaluator_stderr', data: data.toString(), timestamp: Date.now() });
            });
            
            // Monitoring Exit
            let userExited = false;
            let evaluatorExited = false;

            userProgram.on('close', (code, signal) => {
                userExited = true;
                userDurationMs = Date.now() - userStartTime;
                userMemoryKb = maxMemoryUsageKb; // Capture memory usage
                clearTimeout(userTimer);
                if (psInterval) clearInterval(psInterval);

                if (finalStatus === 'Pending') { // Not yet decided by TLE, MLE, or evaluator signal
                    if (userTimedOut) { // Should have been caught by timer, but as a fallback
                        finalStatus = 'TimeLimitExceeded';
                        finalMessage = 'User program exceeded time limit.';
                    } else if (userMemoryExceeded) {
                        finalStatus = 'MemoryLimitExceeded';
                        finalMessage = 'User program exceeded memory limit.';
                    } else if (code === 0 && !signal) {
                        // User program exited cleanly, but evaluator didn't signal AC/WA yet.
                        // This could be WA if evaluator is still running and waiting for more input.
                        // Or, if evaluator also exited, it depends on evaluator's state.
                        if (!evaluatorExited) finalStatus = 'WrongAnswer'; // Assume WA if evaluator expects more
                        finalMessage = finalMessage || 'User program exited successfully but no AC/WA from evaluator.';
                    } else {
                        finalStatus = 'RuntimeError';
                        finalMessage = `User program exited with code ${code}, signal ${signal}.`;
                        if (signal) user_stderr += `\nUser program terminated by signal: ${signal}`;
                    }
                }
                // If user program exits, evaluator should also be stopped unless it already exited.
                if (!evaluatorExited) {
                    try { evaluatorScript.stdin.end(); } catch(e) {/* ignore */} // Signal no more input
                }
                checkAndResolve();
            });

            evaluatorScript.on('close', (code, signal) => {
                evaluatorExited = true;
                if (finalStatus === 'Pending') { // Not yet decided by user TLE/MLE or explicit evaluator AC/WA via stdout
                    if (code === 0 && !signal) {
                        // Evaluator exited cleanly, but didn't send AC/WA signal.
                        // This is unusual if protocol relies on __AC__/__WA__ in stdout. Could be EvaluatorError.
                        finalStatus = 'EvaluatorError';
                        finalMessage = 'Evaluator exited cleanly without signaling result (AC/WA).';
                    } else {
                        finalStatus = 'EvaluatorError';
                        finalMessage = `Evaluator script exited with code ${code}, signal ${signal}.`;
                        if (signal) evaluator_stderr += `\nEvaluator script terminated by signal: ${signal}`;
                    }
                }
                // If evaluator exits, user program should be stopped unless it already exited.
                if (!userExited) {
                     // This might be an issue, user program might be in infinite loop or waiting for input
                     // that evaluator will no longer provide.
                    cleanupProcesses('SIGKILL'); // Force kill user program
                    if (finalStatus === 'Pending') { // If user program was running fine till this point
                       finalStatus = 'WrongAnswer'; // Or some other status indicating user didn't finish
                       finalMessage = 'User program terminated as evaluator exited.';
                    }
                }
                checkAndResolve();
            });

            const resolveInteraction = () => {
                // Ensure cleanup one last time
                cleanupProcesses();
                clearTimeout(userTimer);
                if (psInterval) clearInterval(psInterval);

                // Fallback if status is still pending (should not happen if logic is correct)
                if (finalStatus === 'Pending') {
                    finalStatus = 'InternalError';
                    finalMessage = 'Evaluation ended with an undetermined status.';
                }
                
                resolve({
                    status: finalStatus,
                    message: finalMessage,
                    interaction_log,
                    durationMs: userDurationMs, // User program's duration
                    memoryKb: userMemoryKb,   // User program's memory
                    user_stderr: user_stderr.trim(),
                    evaluator_stderr: evaluator_stderr.trim()
                });
            };

            let resolved = false;
            const checkAndResolve = () => {
                if (resolved) return;
                // Resolve once both processes have exited OR a definitive state (TLE, MLE, AC, WA from evaluator) is reached.
                // TLE/MLE/AC/WA conditions should trigger resolveInteraction directly or via cleanup.
                if ((userExited && evaluatorExited) || 
                    ['Accepted', 'WrongAnswer', 'TimeLimitExceeded', 'MemoryLimitExceeded', 'RuntimeError', 'EvaluatorError', 'InternalError'].includes(finalStatus) && finalStatus !== 'Pending') {
                    resolved = true;
                    resolveInteraction();
                }
            };

            // Initial piping to evaluator if startupData is provided (as first "turn" from user, conceptually)
            // No, this was handled by passing it as arg.
            // If evaluator needs initial stdin data, it should be from user program's first output.

            // Ensure stdin streams are ended if the other process closes its stdout before ending.
            userProgram.stdout.on('end', () => {
                if (evaluatorScript && !evaluatorScript.stdin.destroyed) {
                    try { evaluatorScript.stdin.end(); } catch(e) {/* ignore */}
                }
            });
            evaluatorScript.stdout.on('end', () => {
                if (userProgram && !userProgram.stdin.destroyed) {
                     try { userProgram.stdin.end(); } catch(e) {/* ignore */}
                }
            });

        }); // End of Promise
    }
}

module.exports = ExecutionService;
