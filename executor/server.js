// executor/server.js
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json());

const DOCKER_IMAGE = process.env.DOCKER_IMAGE || 'executor-image'; // Use environment variable or default
const DEFAULT_TIMEOUT = 10000; // Default timeout for exec, e.g., 10 seconds

// Existing endpoint for running user code (sandboxed execution via run.sh)
app.post('/execute', (req, res) => {
    const { language, code, stdin } = req.body; // stdin is optional
    if (!language || !code) {
        return res.status(400).json({ error: 'Missing language or code' });
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-'));
    let filename = '';
    // Determine filename based on language
    switch (language) {
        case 'python': filename = 'solution.py'; break;
        case 'cpp': filename = 'solution.cpp'; break;
        case 'javascript': filename = 'solution.js'; break;
        case 'ruby': filename = 'solution.rb'; break;
        case 'java': filename = 'Main.java'; break;
        default:
            fs.rmSync(tmpDir, { recursive: true, force: true });
            return res.status(400).json({ error: 'Unsupported language' });
    }
    const solutionPath = path.join(tmpDir, filename);
    fs.writeFileSync(solutionPath, code);

    let command = `./run.sh ${language} ${solutionPath}`;
    if (stdin) {
        const inputFile = path.join(tmpDir, 'input.txt');
        fs.writeFileSync(inputFile, stdin);
        // run.sh should be modified to accept input file path if it doesn't already
        // For now, assuming run.sh can handle input via stdin redirection or by reading input.txt
        // If run.sh reads input.txt by convention when it exists:
        // command = `cat input.txt | ./run.sh ${language} ${solutionPath}`; // Alternative approach
    }

    // Execute run.sh which handles compilation, execution, and resource measurement
    exec(command, { cwd: tmpDir, timeout: DEFAULT_TIMEOUT }, (error, stdout, stderr) => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (error) {
            // Check for timeout explicitly
            if (error.signal === 'SIGTERM' || error.killed) { // SIGTERM is often sent by timeout
                return res.status(500).json({ error: 'Execution timed out', stderr: stderr || error.message, signal: error.signal });
            }
            return res.status(500).json({ error: stderr || error.message });
        }
        res.json({ output: stdout, stderr: stderr }); // Include stderr for non-fatal warnings
    });
});


// New endpoint for custom evaluation
app.post('/evaluate', (req, res) => {
    const {
        evaluator_script_host_path, // Actual path on the host where executor/server.js can find it
        user_solution_host_path,    // Actual path on the host
        test_data_host_path,        // Actual path on the host
        evaluator_script_container_path, // Path as it will be seen inside the new container
        user_solution_container_path, // Path as it will be seen inside the new container
        test_data_container_path,     // Path as it will be seen inside the new container
        max_points,
        evaluator_language = 'python3', // Default to python3, can be parameterized later
        timeout = DEFAULT_TIMEOUT     // Timeout for the evaluator itself
    } = req.body;

    if (!evaluator_script_host_path || !user_solution_host_path || !test_data_host_path ||
        !evaluator_script_container_path || !user_solution_container_path || !test_data_container_path ||
        max_points === undefined) {
        return res.status(400).json({
            success: false,
            error_type: "missing_parameters",
            message: "Missing required parameters for evaluation. Ensure all host and container paths, and max_points are provided."
        });
    }

    // Basic security check: Ensure host paths are somewhat reasonable (e.g., within a defined base directory)
    // This is a placeholder for more robust path validation if needed.
    // For now, we trust the paths provided by the calling service (e.g., submit.js)
    // which should have its own validation.

    const startTime = Date.now();

    const dockerCommand = [
        'docker run --rm',
        `--network none`, // No network access for security
        `-v "${path.resolve(evaluator_script_host_path)}":"${evaluator_script_container_path}:ro"`, // Mount evaluator read-only
        `-v "${path.resolve(user_solution_host_path)}":"${user_solution_container_path}:ro"`, // Mount user solution read-only
        `-v "${path.resolve(test_data_host_path)}":"${test_data_container_path}:ro"`,       // Mount test data read-only
        DOCKER_IMAGE,
        evaluator_language, // e.g., python3
        `"${evaluator_script_container_path}"`,
        `"${user_solution_container_path}"`,
        `"${test_data_container_path}"`,
        `"${max_points.toString()}"` // Ensure max_points is passed as a string
    ].join(' ');

    // console.log(`Executing Docker command for evaluation: ${dockerCommand}`);

    exec(dockerCommand, { timeout }, (error, stdout, stderr) => {
        const executionTimeMs = Date.now() - startTime;
        if (error) {
            let errorType = "runtime_error";
            if (error.signal === 'SIGTERM' || error.killed) { // SIGTERM can be from timeout
                errorType = "timeout";
            }
            // console.error(`Evaluation error: ${error.message}, stderr: ${stderr}`);
            return res.status(500).json({
                success: false,
                error_type: errorType,
                message: error.message,
                stderr: stderr,
                execution_time_ms: executionTimeMs
            });
        }

        try {
            const evaluationResult = JSON.parse(stdout.trim());
            return res.json({
                success: true,
                evaluation_result: evaluationResult,
                execution_time_ms: executionTimeMs,
                stderr: stderr // Include stderr even on success for warnings from evaluator
            });
        } catch (parseError) {
            // console.error(`Evaluation output parse error: ${parseError.message}, stdout: ${stdout}`);
            return res.status(500).json({
                success: false,
                error_type: "output_parse_error",
                message: "Failed to parse evaluator output as JSON.",
                stdout: stdout,
                stderr: stderr,
                execution_time_ms: executionTimeMs
            });
        }
    });
});


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Executor service listening on port ${PORT}`);
});