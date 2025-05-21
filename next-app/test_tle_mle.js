// next-app/test_tle_mle.js
import handler from './pages/api/submit.js';
import fs from 'fs';
import path from 'path';

const TLE_CODE_PYTHON = `
import time
time.sleep(3) # Problem1 timeout is 2s
print("Finished after sleep")
`;

const MLE_CODE_PYTHON = `
# Attempt to allocate memory that should exceed 256MB RSS
# Python string internals can be complex; creating a large list of strings
# or a bytearray might be more reliable for forcing RSS high.
try:
    # Each char in a Python string can take more than 1 byte in memory internally (e.g., UCS-2, UCS-4)
    # Let's aim for a list of strings to make it more fragmented and potentially hit RSS harder.
    # 256000 KB = 256 * 1024 * 1024 bytes
    # Target slightly above: 300 MB
    # A list of 300 1MB strings.
    one_mb_string = 'A' * (1024 * 1024) # 1MB string
    my_list = []
    for _ in range(300): # 300 iterations * 1MB = 300MB
        my_list.append(one_mb_string)
    # Concatenating them into one massive string might also work,
    # but the list itself might be enough if strings are not shared.
    # result_string = "".join(my_list) 
    # print(len(result_string))
    print(f"Allocated list of {len(my_list)} MB-sized strings.")
except MemoryError:
    print("MemoryError caught during large allocation")

# Fallback, simpler large string (Python might optimize this differently)
# s = 'a' * (300 * 1024 * 1024)
# print(len(s))
`;


async function runTest(testName, codeContent, problemId, language) {
    console.log(`\n--- Running ${testName} Test ---`);
    let sseEvents = [];
    const mockReq = {
        method: 'POST',
        body: {
            problemId: problemId,
            language: language,
            code: codeContent,
        },
    };

    const mockRes = {
        _headers: {},
        setHeader: (key, value) => {
            mockRes._headers[key] = value;
        },
        write: (data) => {
            // console.log('SSE raw data:', data); // For debugging
            sseEvents.push(data);
        },
        flush: () => { /* console.log('Flush called'); */ }, // Mock flush
        end: () => { /* console.log('End called'); */ },    // Mock end
        status: (statusCode) => { // Mock status for error cases before SSE starts
            console.error(`Error status ${statusCode} called on res`);
            return { end: () => console.error(`res.end() called after status ${statusCode}`) };
        }
    };

    try {
        await handler(mockReq, mockRes);
    } catch (e) {
        console.error(`Error during handler execution for ${testName}:`, e);
        // Add a synthetic error event if the handler itself crashes
        sseEvents.push(`data: ${JSON.stringify({ testCase: "HandlerError", status: "ScriptError", message: e.toString() })}\n\n`);
    }
    
    console.log(`SSE Headers for ${testName}:`, mockRes._headers);

    const parsedEvents = [];
    let eventBuffer = "";
    sseEvents.forEach(chunk => {
        eventBuffer += chunk;
        let parts = eventBuffer.split('\n\n');
        eventBuffer = parts.pop() || ''; // Keep incomplete event in buffer
        parts.forEach(part => {
            const lines = part.split('\n');
            for (const line of lines) {
                if (line.startsWith('data:')) {
                    const jsonStr = line.substring(5).trim();
                    try {
                        parsedEvents.push(JSON.parse(jsonStr));
                    } catch (e) {
                        console.error(`Failed to parse JSON: ${jsonStr}`, e);
                        parsedEvents.push({ error: "Invalid JSON", raw: jsonStr });
                    }
                }
            }
        });
    });
     // Process any remaining buffer content (if the stream didn't end with \n\n)
    if (eventBuffer.trim() !== "") {
        const lines = eventBuffer.split('\n');
        for (const line of lines) {
            if (line.startsWith('data:')) {
                const jsonStr = line.substring(5).trim();
                try {
                    parsedEvents.push(JSON.parse(jsonStr));
                } catch (e) {
                    console.error(`Failed to parse JSON from remaining buffer: ${jsonStr}`, e);
                    parsedEvents.push({ error: "Invalid JSON in remaining buffer", raw: jsonStr });
                }
            }
        }
    }


    console.log(`${testName} Results:`);
    let allCorrectStatus = true;
    let expectedStatus = '';
    if (testName === 'TLE') expectedStatus = 'TLE';
    if (testName === 'MLE') expectedStatus = 'MLE';

    parsedEvents.forEach((event, index) => {
        if (event.finished) {
            console.log(`Event ${index}: Submission finished`);
            return;
        }
        if (event.error && event.error === "Missing parameters" || event.error === "Problem meta not found" || event.error === "Unsupported language") {
             console.log(`Event ${index}: Critical error: ${event.error}`);
             allCorrectStatus = false;
             return;
        }
        if (event.status !== expectedStatus) {
            // Allow "Error" for MLE test cases if the process crashes hard before executor script can report MEM.
            // This can happen if the Python interpreter itself is killed by OOM killer.
            if (!(testName === 'MLE' && event.status === 'Error' && event.message && (event.message.includes('Error: Command failed') || event.message.includes('signal: null')))) {
                 allCorrectStatus = false;
            }
        }
        console.log(`Event ${index}: ${JSON.stringify(event)}`);
    });

    if (parsedEvents.length === 0) {
        console.log("No events captured.");
        allCorrectStatus = false;
    } else if (parsedEvents.filter(e => !e.finished && !e.error).length === 0 && ! (parsedEvents.some(e=>e.error)) ) {
        console.log("No actual test case result events captured.");
        allCorrectStatus = false;
    }


    console.log(`${testName} Test Passed: ${allCorrectStatus}`);
    return { events: parsedEvents, passed: allCorrectStatus };
}

async function main() {
    // Ensure CWD is next-app for problem path resolution, if this script is in next-app
    // process.chdir(path.dirname(new URL(import.meta.url).pathname)); // Not needed if run from next-app
    
    const tleResults = await runTest('TLE', TLE_CODE_PYTHON, 'problem1', 'python');
    const mleResults = await runTest('MLE', MLE_CODE_PYTHON, 'problem1', 'python');

    console.log("\n--- Summary ---");
    console.log(`TLE Test Overall Passed: ${tleResults.passed}`);
    console.log(`MLE Test Overall Passed: ${mleResults.passed}`);
    
    if (!tleResults.passed || !mleResults.passed) {
        // console.error("One or more tests failed. See logs above.");
        // process.exit(1); // Exit with error code if tests fail
    }
}

main().catch(e => {
    console.error("Unhandled error in main:", e);
    // process.exit(1);
});
