// executor/server.js
const express = require('express');
const path = require('path'); // Needed for resolving host paths
const languageDefinitions = require('./language_definitions');
const ExecutionService = require('./ExecutionService');

const app = express();
// Increase payload limit for code submissions, etc.
app.use(express.json({ limit: '5mb' })); 

const executionService = new ExecutionService(languageDefinitions);

const DEFAULT_EXECUTE_TIMEOUT_MS = 2000; // For user code execution
const DEFAULT_EXECUTE_MEMORY_KB = 256 * 1024; // 256MB
const DEFAULT_EVALUATE_TIMEOUT_MS = 10000; // For evaluator scripts
const DEFAULT_INTERACTIVE_USER_TIMEOUT_MS = 5000; // User program limit in interactive session
const DEFAULT_INTERACTIVE_USER_MEMORY_KB = 256 * 1024; // User program memory in interactive session
// Note: evaluator_time_limit_ms for startInteractiveSession is not directly handled by a global default here,
// as the interactive session itself has a user TLE, and evaluator is expected to be quick.
// The `startInteractiveSession` method itself might have an internal guard for evaluator.

// Endpoint for running user code
app.post('/execute', async (req, res) => {
    const { language, code, stdin, time_limit_ms, memory_limit_kb } = req.body;

    if (!language || code === undefined) { // code can be an empty string
        return res.status(400).json({ error_type: 'missing_parameters', message: 'Missing language or code' });
    }
    if (!languageDefinitions[language]) {
        return res.status(400).json({ error_type: 'unsupported_language', message: `Language '${language}' is not supported.` });
    }

    try {
        const result = await executionService.executeCode({
            language,
            code,
            stdin: stdin || '', // Default to empty string if not provided
            time_limit_ms: parseInt(time_limit_ms, 10) || DEFAULT_EXECUTE_TIMEOUT_MS,
            memory_limit_kb: parseInt(memory_limit_kb, 10) || DEFAULT_EXECUTE_MEMORY_KB,
        });
        
        // Determine status code based on result
        if (result.errorType) {
            // Consider specific error types for different status codes if needed
            // e.g., compile_error might be 400, timeout/memory_exceeded 400 or 500 depending on perspective
            return res.status(400).json(result); // Client-side correctable errors (e.g. bad code)
        }
        return res.status(200).json(result);

    } catch (error) {
        console.error('Critical error in /execute endpoint:', error);
        return res.status(500).json({ 
            error_type: 'internal_server_error', 
            message: error.message || 'An unexpected error occurred during execution.' 
        });
    }
});

// Endpoint for custom evaluation
app.post('/evaluate', async (req, res) => {
    const {
        evaluator_script_host_path, // Actual path on the host where executor/server.js can find it
        user_solution_content,      // String content of user's output
        test_data_host_path,        // Actual path on the host for the test case data file
        max_points,
        evaluator_language = 'python', // Default to python for evaluators
        timeout = DEFAULT_EVALUATE_TIMEOUT_MS // Timeout for the evaluator script itself
    } = req.body;

    if (!evaluator_script_host_path || user_solution_content === undefined || !test_data_host_path || max_points === undefined) {
        return res.status(400).json({
            success: false,
            error_type: "missing_parameters",
            message: "Missing required parameters for evaluation. Expected: evaluator_script_host_path, user_solution_content, test_data_host_path, max_points."
        });
    }
    
    if (!languageDefinitions[evaluator_language]) {
         return res.status(400).json({
            success: false,
            error_type: 'unsupported_language',
            message: `Evaluator language '${evaluator_language}' is not supported.`
        });
    }

    try {
        // Ensure host paths are resolved to absolute paths for security and consistency
        const resolvedEvaluatorPath = path.resolve(evaluator_script_host_path);
        const resolvedTestDataPath = path.resolve(test_data_host_path);

        // Basic check: ensure these resolved paths are not trying to escape a base directory if needed (not implemented here)

        const result = await executionService.evaluateCode({
            evaluator_script_host_path: resolvedEvaluatorPath,
            user_solution_content,
            test_data_host_path: resolvedTestDataPath,
            max_points: parseFloat(max_points), // Ensure max_points is a number
            evaluator_language,
            timeout_ms: parseInt(timeout, 10) || DEFAULT_EVALUATE_TIMEOUT_MS,
        });
        
        // `evaluateCode` returns { success: boolean, ... }
        if (!result.success) {
            // If evaluateCode itself indicates failure (e.g. evaluator crash, bad output)
            return res.status(400).json(result); // Or 500 if it's an internal evaluator setup issue
        }
        return res.status(200).json(result);

    } catch (error) {
        console.error('Critical error in /evaluate endpoint:', error);
        return res.status(500).json({ 
            success: false,
            error_type: 'internal_server_error', 
            message: error.message || 'An unexpected error occurred during evaluation.' 
        });
    }
});

// Endpoint for interactive execution
app.post('/execute_interactive', async (req, res) => {
    const {
        language,
        code,
        evaluator_script_host_path,
        evaluator_language,
        evaluator_startup_data, // Optional
        time_limit_ms,
        memory_limit_kb,
        // evaluator_time_limit_ms // This is not directly used by startInteractiveSession in current design
                                  // but could be added to evaluatorOptions if needed by service
    } = req.body;

    // 2.a. Parameter Validation
    if (!language || code === undefined || !evaluator_script_host_path || !evaluator_language) {
        return res.status(400).json({
            error_type: 'missing_parameters',
            message: 'Missing required parameters: language, code, evaluator_script_host_path, or evaluator_language.'
        });
    }

    if (!languageDefinitions[language]) {
        return res.status(400).json({
            error_type: 'unsupported_language',
            message: `User language '${language}' is not supported.`
        });
    }
    if (!languageDefinitions[evaluator_language]) {
        return res.status(400).json({
            error_type: 'unsupported_language',
            message: `Evaluator language '${evaluator_language}' is not supported.`
        });
    }

    const userTimeLimit = parseInt(time_limit_ms, 10) || DEFAULT_INTERACTIVE_USER_TIMEOUT_MS;
    const userMemoryLimit = parseInt(memory_limit_kb, 10) || DEFAULT_INTERACTIVE_USER_MEMORY_KB;

    let tempDir;
    try {
        // 2.b. Resolve Host Paths
        const resolvedEvaluatorPath = path.resolve(evaluator_script_host_path);

        // Create tempDir, following pattern from other endpoints
        tempDir = await executionService._createTempDir();

        // 2.c. Call executionService.startInteractiveSession
        const userCodeOptions = { language, code };
        const evaluatorOptions = {
            scriptPath: resolvedEvaluatorPath,
            language: evaluator_language,
            startupDataForEvaluator: evaluator_startup_data // Pass it along, service will handle
        };
        
        const result = await executionService.startInteractiveSession(
            userCodeOptions,
            evaluatorOptions,
            userTimeLimit,
            userMemoryLimit,
            tempDir // Pass tempDir to the service method
        );

        // 2.d. Handle Response from startInteractiveSession
        // `startInteractiveSession` returns a comprehensive result object.
        // Status within the result object (e.g., result.status = 'Accepted', 'WrongAnswer', 'TimeLimitExceeded')
        // indicates the outcome of the interaction. HTTP status should be 200 if service call succeeded.
        if (result.status === 'CompileError' || result.status === 'Error' || result.status === 'EvaluatorError' || result.status === 'InternalError') {
             // These are errors that mean the session could not run or completed with a system/setup problem
            return res.status(400).json(result);
        }
        // For 'Accepted', 'WrongAnswer', 'TimeLimitExceeded', 'MemoryLimitExceeded', 'RuntimeError',
        // these are valid outcomes of the execution itself.
        return res.status(200).json(result);

    } catch (error) {
        console.error('Critical error in /execute_interactive endpoint:', error);
        // This catches errors from _createTempDir, path.resolve, or unexpected errors in startInteractiveSession
        return res.status(500).json({
            error_type: 'internal_server_error',
            message: error.message || 'An unexpected error occurred during interactive execution.'
        });
    } finally {
        if (tempDir) {
            await executionService._cleanupTempDir(tempDir);
        }
    }
});


const PORT = process.env.EXECUTOR_PORT || process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`New Node.js Executor service listening on port ${PORT}`);
});
