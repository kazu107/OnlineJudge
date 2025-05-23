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
}

module.exports = ExecutionService;
