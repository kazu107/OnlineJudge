// next-app/pages/api/submit.test.js

// IMPORTANT ASSUMPTION FOR THESE UNIT TESTS TO WORK:
// The 'handler' function in './submit.js' must be modified to support Dependency Injection
// for 'fs' and 'child_process.exec'. For example, its signature should be:
// export default async function handler(req, res, fsInternal = fs, cpExecInternal = exec)
// And it should use fsInternal and cpExecInternal throughout.
// Similarly, execCommand within submit.js should use cpExecInternal.
// Without this, these mocks will not be used by the original submit.js,
// and the tests would not be true unit tests and would likely fail as they use real fs/exec.

import handler from './submit.js'; 
import path from 'path'; // Ensure path is imported

// --- Mock 'fs' module ---
const mockFs = {
    _data: {}, 
    _filesExist: new Set(), 
    _fileContents: {}, 

    mkdtempSync: (prefix) => {
        // console.log(`Mock fs.mkdtempSync called with prefix: ${prefix}`);
        return 'mock-tmp-dir';
    },
    writeFileSync: (filepath, content) => {
        // console.log(`Mock fs.writeFileSync called for ${filepath} with content: ${content.substring(0,20)}...`);
        mockFs._data[filepath] = content;
    },
    readFileSync: (filepath, encoding) => {
        const key = filepath.includes(process.cwd()) ? filepath : path.join(process.cwd(), filepath);
        // console.log(`Mock fs.readFileSync trying key: ${key}`);
        if (mockFs._fileContents[key]) return mockFs._fileContents[key];
        if (mockFs._fileContents[filepath]) return mockFs._fileContents[filepath];
        // console.warn(`mockFs.readFileSync: No mock content for ${filepath} (resolved to ${key})`);
        // To simulate file not found if not explicitly mocked:
        // const err = new Error(`ENOENT: no such file or directory, open '${filepath}'`);
        // err.code = 'ENOENT';
        // throw err;
        return ''; // Default empty if not found, or throw error
    },
    existsSync: (filepath) => {
        const key = filepath.includes(process.cwd()) ? filepath : path.join(process.cwd(), filepath);
        const exists = mockFs._filesExist.has(key) || mockFs._filesExist.has(filepath);
        // console.log(`Mock fs.existsSync for key: ${key} - ${exists}`);
        return exists;
    },
    rmSync: (dirPath, options) => { /* console.log(`Mock fs.rmSync called for ${dirPath}`); */ },
    
    _reset: () => {
        mockFs._data = {};
        mockFs._filesExist = new Set();
        mockFs._fileContents = {};
    },
    _addFile: (filepath, content = '') => {
        // Ensure paths are resolved consistently with how handler might generate them
        const key = filepath.startsWith(process.cwd()) ? filepath : path.join(process.cwd(), filepath);
        // console.log(`Mock fs._addFile for key: ${key}`);
        mockFs._filesExist.add(key);
        mockFs._fileContents[key] = content;
    }
};

// --- Mock 'child_process' module ---
let mockExecBehavior = null;
const mockChildProcess = {
    exec: (command, options, callback) => {
        // console.log(`Mock child_process.exec called with command: ${command}`);
        if (mockExecBehavior) {
            mockExecBehavior(command, options, callback);
        } else {
            callback(null, 'Default mock stdout\nTIME_MS:0 MEM:0', '');
        }
    },
    _setExecBehavior: (customBehavior) => {
        mockExecBehavior = customBehavior;
    },
    _reset: () => {
        mockExecBehavior = null;
    }
};

// --- Test Infrastructure ---
let testsRun = 0;
let testsPassed = 0;
const capturedSseEvents = []; 

const mockReq = { method: 'POST', body: {} };
const mockRes = {
    _headers: {},
    setHeader: (key, value) => { mockRes._headers[key] = value; },
    write: (data) => { 
        // console.log(`mockRes.write: ${data}`); // Log raw data written
        capturedSseEvents.push(data); 
    },
    flush: () => {},
    end: () => {},
    status: (code) => {
        // console.error(`mockRes.status(${code}) called`);
        // Simulate an error event if status is called (usually for pre-SSE errors)
        capturedSseEvents.push(`data: ${JSON.stringify({httpErrorStatus: code, message: "Handler pre-SSE HTTP error"})}\n\n`);
        return mockRes; 
    }
};

function assertEquals(expected, actual, message) {
    testsRun++;
    if (JSON.stringify(expected) === JSON.stringify(actual)) {
        testsPassed++;
    } else {
        console.error(`FAIL: ${message}. Expected: ${JSON.stringify(expected)}, Actual: ${JSON.stringify(actual)}`);
    }
}

// Modified parseSse to be more inclusive for debugging
function parseSse(sseRawMessages) {
    const parsed = [];
    let buffer = "";
    sseRawMessages.forEach(chunk => {
        buffer += chunk;
        let parts = buffer.split('\n\n'); // SSE events are separated by double newlines
        buffer = parts.pop() || ''; // Keep incomplete event in buffer
        parts.forEach(part => {
            if (part.startsWith('data:')) {
                const jsonStr = part.substring(5).trim();
                try {
                    parsed.push(JSON.parse(jsonStr));
                } catch (e) { 
                    // console.error(`parseSse: Invalid JSON: ${jsonStr}`, e);
                    parsed.push({ error: "Invalid JSON", raw: jsonStr }); 
                }
            } else if (part.trim() !== '') {
                // console.warn(`parseSse: Received non-event part: "${part}"`);
            }
        });
    });
    // Process any remaining buffer content (if the stream didn't end with \n\n)
    if (buffer.trim().startsWith('data:')) {
        const jsonStr = buffer.substring(buffer.indexOf('data:') + 5).trim();
        try { 
            parsed.push(JSON.parse(jsonStr)); 
        } catch (e) { 
            // console.error(`parseSse: Invalid JSON in remainder: ${jsonStr}`, e);
            parsed.push({ error: "Invalid JSON in remainder", raw: jsonStr });
        }
    }
    return parsed; // Return all parsed JSON objects or error objects
}

// Corrected paths assuming CWD is /app/next-app/pages/api during test execution
const CWD = process.cwd(); // Should be /app/next-app/pages/api
// submit.js constructs paths from process.cwd() like: path.join(process.cwd(), 'problems', problemId, 'meta.json')
// So, if CWD is /app/next-app/pages/api, then metaPath will be /app/next-app/pages/api/problems/problem1/meta.json
// This means the mock FS needs to be keyed with these exact paths.
const MOCK_PROBLEMS_ROOT_IN_TEST_CWD = path.join(CWD, 'problems', 'problem1'); // This is where handler will look
const MOCK_META_JSON_PATH_FOR_HANDLER = path.join(MOCK_PROBLEMS_ROOT_IN_TEST_CWD, 'meta.json');
const MOCK_TEST_CASES_DIR_FOR_HANDLER = path.join(MOCK_PROBLEMS_ROOT_IN_TEST_CWD, 'tests');


const MOCK_META_CONTENT = {
    problem_id: "problem1",
    timeout: 1000, 
    memory_limit_kb: 102400, 
    test_cases: [
        // Paths relative to 'problems/problemId/' folder, as handler reconstructs them
        { input: "tests/input1.txt", output: "tests/output1.txt" }
    ]
};
// The handler will form full paths like:
// path.join(process.cwd(), 'problems', problemId, testCase.input) -> /app/next-app/pages/api/problems/problem1/tests/input1.txt
const MOCK_INPUT_FILE_PATH_FOR_HANDLER = path.join(MOCK_TEST_CASES_DIR_FOR_HANDLER, 'input1.txt');
const MOCK_OUTPUT_FILE_PATH_FOR_HANDLER = path.join(MOCK_TEST_CASES_DIR_FOR_HANDLER, 'output1.txt');


const DEFAULT_MOCK_REQ_BODY = {
    problemId: 'problem1',
    language: 'python',
    code: 'print("hello")'
};

async function runScenario(testName, execBehavior, reqBodyOverrides = {}, fsFileOverrides = {}) {
    console.log(`\n--- Running: ${testName} ---`);
    mockFs._reset();
    mockChildProcess._reset();
    capturedSseEvents.length = 0;
    mockRes._headers = {};

    // Setup default mocks for fs using paths handler will try to access
    mockFs._addFile(MOCK_META_JSON_PATH_FOR_HANDLER, JSON.stringify(MOCK_META_CONTENT));
    mockFs._addFile(MOCK_INPUT_FILE_PATH_FOR_HANDLER, "mock input data");
    mockFs._addFile(MOCK_OUTPUT_FILE_PATH_FOR_HANDLER, "expected_output_content");

    for (const relativePath in fsFileOverrides) {
        // Assume relativePath is like 'problems/problem1/meta.json' or 'problems/problem1/tests/output1.txt'
        const fullPath = path.join(CWD, relativePath);
        mockFs._addFile(fullPath, fsFileOverrides[relativePath]);
    }
    
    mockChildProcess._setExecBehavior(execBehavior);
    
    const currentReqBody = { ...DEFAULT_MOCK_REQ_BODY, ...reqBodyOverrides };
    mockReq.body = currentReqBody;

    // Crucially, pass the mocks to handler for DI.
    await handler(mockReq, mockRes, mockFs, mockChildProcess.exec);
    
    console.log("Raw captured SSE strings:", JSON.stringify(capturedSseEvents));
    const events = parseSse(capturedSseEvents);
    console.log("Parsed SSE events:", JSON.stringify(events, null, 2));
    return events;
}

// --- Test Cases ---
async function main() {
    console.log(`Test CWD: ${process.cwd()}`);
    console.log(`Meta JSON path for handler mock: ${MOCK_META_JSON_PATH_FOR_HANDLER}`);
    console.log(`Input file path for handler mock: ${MOCK_INPUT_FILE_PATH_FOR_HANDLER}`);
    console.log(`Output file path for handler mock: ${MOCK_OUTPUT_FILE_PATH_FOR_HANDLER}`);

    let events;

    // Scenarios a & b: TLE
    events = await runScenario(
        "TLE (SIGTERM/ETIMEDOUT)",
        (cmd, opts, cb) => {
            const err = new Error("Command timed out"); err.signal = 'SIGTERM';
            cb(err, "Partial output before TLE", "Partial stderr");
        }
    );
    if (events.length > 0 && events[0].testCase) { // Check if it's a test result event
        assertEquals('TLE', events[0].status, "Status should be TLE");
        assertEquals("Partial output before TLE", events[0].got, "TLE 'got' should contain stdout");
        assertEquals('SIGTERM', events[0].signal, "TLE event should include signal");
    } else { console.error(`FAIL: TLE test produced no valid events or wrong event type. Events: ${JSON.stringify(events)}`); testsRun++;}

    // Scenario c: MLE
    events = await runScenario(
        "MLE",
        (cmd, opts, cb) => { cb(null, "output\nTIME_MS:500 MEM:153600", ""); }
    );
    if (events.length > 0 && events[0].testCase) {
        assertEquals('MLE', events[0].status, "Status should be MLE");
        assertEquals("500", events[0].time, "MLE time");
        assertEquals("153600", events[0].memory, "MLE memory");
        assertEquals("output", events[0].got, "MLE 'got'");
    } else { console.error(`FAIL: MLE test produced no valid events. Events: ${JSON.stringify(events)}`); testsRun++;}

    // Scenario d: Accepted
    const acceptedExpectedOutput = "expected_output_for_accepted_test";
    events = await runScenario(
        "Accepted",
        (cmd, opts, cb) => { cb(null, `${acceptedExpectedOutput}\nTIME_MS:100 MEM:51200`, ""); },
        {},
        // Override the default expected output for this specific test case
        { [MOCK_OUTPUT_FILE_PATH_FOR_HANDLER]: acceptedExpectedOutput } 
    );
    if (events.length > 0 && events[0].testCase) {
        assertEquals('Accepted', events[0].status, "Status should be Accepted");
    } else { console.error(`FAIL: Accepted test produced no valid events. Events: ${JSON.stringify(events)}`); testsRun++;}

    // Scenario e: Wrong Answer
    const waExpected = "expected_for_wa";
    const waGot = "wrong_output_content_for_wa";
    events = await runScenario(
        "Wrong Answer",
        (cmd, opts, cb) => { cb(null, `${waGot}\nTIME_MS:100 MEM:51200`, ""); },
        {},
        { [MOCK_OUTPUT_FILE_PATH_FOR_HANDLER]: waExpected }
    );
    if (events.length > 0 && events[0].testCase) {
        assertEquals('Wrong Answer', events[0].status, "Status should be Wrong Answer");
        assertEquals(waGot, events[0].got, "WA 'got'");
        assertEquals(waExpected, events[0].expected, "WA 'expected'");
    } else { console.error(`FAIL: Wrong Answer test produced no valid events. Events: ${JSON.stringify(events)}`); testsRun++;}
    
    // Scenario f: Error (Generic exec error)
    events = await runScenario(
        "Error (Generic exec error)",
        (cmd, opts, cb) => {
            const err = new Error("Generic execution failure");
            cb(err, "stdout before generic error", "stderr with generic error info");
        }
    );
    if (events.length > 0 && events[0].testCase) {
        assertEquals('Error', events[0].status, "Status should be Error");
        assertEquals("stderr with generic error info", events[0].message, "Error message");
    } else { console.error(`FAIL: Generic Error test produced no valid events. Events: ${JSON.stringify(events)}`); testsRun++;}
    
    // Scenario: Missing parameters (problemId)
    await runScenario( // Re-run to isolate captured events
        "Error (Missing problemId)",
        (cmd, opts, cb) => cb(null, "", ""),
        { problemId: undefined } 
    );
    const missingParamRawEvent = capturedSseEvents.find(s => s.includes("Missing parameters"));
    if (missingParamRawEvent) {
        const missingParamEvent = JSON.parse(missingParamRawEvent.replace("data: ", ""));
        assertEquals('Missing parameters', missingParamEvent.error, "Should get 'Missing parameters' error");
    } else {
        console.error("FAIL: Missing Problem ID test did not produce the expected raw SSE event."); testsRun++;
    }


    console.log(`\n--- Unit Test Summary ---`);
    console.log(`Total Asserts: ${testsRun}, Passed: ${testsPassed}, Failed: ${testsRun - testsPassed}`);
    if (testsRun - testsPassed > 0) {
        console.error("Some unit tests failed. Review logs above.");
    } else {
        console.log("All unit tests passed (assuming DI for submit.js worked as expected).");
    }
}

main().catch(e => {
    console.error("Unhandled critical error during test execution:", e);
});
