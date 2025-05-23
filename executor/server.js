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

const PORT = process.env.EXECUTOR_PORT || process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`New Node.js Executor service listening on port ${PORT}`);
});
