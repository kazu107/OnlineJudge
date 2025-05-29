# Project Structure Documentation

This document explains the file structure of this project and the purpose of its key components.

## Overall Project Architecture

This project is an online judge system designed to compile and run user-submitted code in various programming languages, evaluating it against predefined test cases. It consists of two main parts:

1.  **Frontend (`next-app/`)**: A Next.js application that provides the user interface. Users can view problem statements, write code, and submit it for execution and evaluation.
2.  **Code Executor (`executor/`)**: A Docker-based environment responsible for securely running the user's code. It uses a Docker image that includes compilers and interpreters for supported languages.

### Code Execution Flow

The typical flow for executing user code is as follows:

1.  The user submits code and selects a language through the Next.js frontend.
2.  The request is sent to an API route within the `next-app` (specifically, `pages/api/execute.js`).
3.  This API route creates a temporary directory on the host machine and writes the user's code into a file within this directory.
4.  The API route then invokes `docker run`, using the `executor` Docker image. It mounts the temporary directory (containing the code) into the container's filesystem (usually at `/code`).
5.  Inside the Docker container, the `run.sh` script (the image's `ENTRYPOINT`) is executed. This script compiles (if necessary) and runs the user's code.
6.  `run.sh` also uses the `/usr/bin/time` utility to measure the execution time and memory usage of the user's code.
7.  The output from `run.sh` (including program output, time, and memory) is captured by the `docker run` command and sent back to the `next-app` API route.
8.  The API route then forwards this result to the frontend to be displayed to the user.

## Root Directory Files

The root directory contains configuration files for the project, the Next.js application, and the Docker setup.

*   **.gitignore**: Specifies intentionally untracked files that Git should ignore (e.g., `node_modules/`, `.env`, build artifacts).
*   **docker-compose.yml**: Defines and configures the multi-container Docker application.
    *   It sets up two services: `next-app` (the frontend) and `executor` (the code execution environment).
    *   The `next-app` service is built from the `./next-app` directory. It maps port 3000 and, importantly, mounts the Docker socket (`/var/run/docker.sock`). This allows the Next.js application itself to start and manage other Docker containers (specifically, instances of the `executor` service).
    *   The `executor` service is built from the `./executor` directory and results in an image named `executor`. This image is then used by `next-app`'s API routes to run code.
*   **jsconfig.json**: JavaScript configuration file, often used for specifying path aliases or other project-wide JS settings for IDEs.
*   **memo**: Contains developer notes and commands for building and running the project locally. For example:
    ```
    cd executor
    docker build -t executor .
    cd ..
    cd next-app
    npm install
    npm run dev
    cd ..

    http://localhost:3000/problems/problem1
    ```
*   **package.json**: The Node.js project manifest for the root.
    *   It includes scripts for running (`dev`), building (`build`), and starting (`start`) the Next.js application, often by proxying commands to the `next-app` directory.
    *   It lists dependencies, some of which are core to Next.js (`next`, `react`) and others for markdown processing (`react-markdown`, `remark-math`, etc.).
    *   It also contains a `heroku-postbuild` script (`cd next-app && npm install`), indicating setup for Heroku deployments where dependencies for the `next-app` are installed after the root dependencies.
    *   The `engines` field specifies the required Node.js version.
*   **package-lock.json**: Records the exact versions of dependencies used in the root project, ensuring reproducible builds.
*   **postcss.config.mjs**: Configuration file for PostCSS, a tool for transforming CSS with JavaScript plugins (often used with Tailwind CSS).
*   **Procfile**: Declares process types for platforms like Heroku. The line `web: cd next-app && npm run start` indicates that for the `web` process, Heroku should navigate to the `next-app` directory and run its `start` script.
*   **README.md**: Provides general information about the Next.js project, including how to get started, learn more about Next.js, and deploy on Vercel. It's largely the default README from `create-next-app`.
*   **next.config.mjs**: The main configuration file for the Next.js application. It can be used to customize builds, server behavior, environment variables, and more.
*   **tailwind.config.mjs**: Configuration file for Tailwind CSS, a utility-first CSS framework.

## `executor/` Directory

The `executor/` directory contains the components responsible for actually running the user-submitted code in a controlled environment.

*   **Dockerfile**: Defines the Docker image for the code executor.
    *   It starts from an `ubuntu:20.04` base image.
    *   It installs necessary tools: `build-essential` (for C/C++ compilation), `python3`, `nodejs`, `ruby`, `default-jdk` (for Java), and the `time` command (used for measuring resource usage).
    *   It copies `run.sh` into the container at `/run.sh`, makes it executable, and converts its line endings to LF.
    *   It sets `/run.sh` as the `ENTRYPOINT`, meaning this script is executed when a container is started from this image.
*   **package.json**: This file lists dependencies for the `executor/server.js`, notably `express`. (Note: In this project, this `package.json` appears to be identical or very similar to `next-app/package.json`).
*   **package-lock.json**: Records the exact versions of dependencies specified in `executor/package.json`.
*   **run.sh**: This is the core script executed by the Docker container.
    *   It takes two arguments: the programming language (`LANGUAGE`) and the path to the code file (`CODEFILE`) within the container (e.g., `/code/solution.py`).
    *   It uses a `case` statement to handle different languages:
        *   **python**: Executes using `python3`.
        *   **cpp**: Compiles using `g++` into `a.out`, then executes `a.out`.
        *   **javascript**: Executes using `node`.
        *   **ruby**: Executes using `ruby`.
        *   **java**: Compiles `Main.java` using `javac`, then executes the `Main` class using `java`.
    *   For each language, it checks if an `/code/input.txt` file exists and provides it as standard input to the executed program if present.
    *   It uses `/usr/bin/time -f "MEM:%M"` to capture the peak resident set size (memory usage) of the executed process.
    *   It measures the wall-clock execution time in milliseconds.
    *   It formats the output to include the program's standard output, followed by `TIME_MS:<elapsed_ms>` and `MEM:<mem_usage>`.
*   **server.js**: An Express.js application that sets up an HTTP server.
    *   It defines a `/run` endpoint that accepts `language` and `code` in the request body.
    *   This server is designed to write the received code to a temporary file and then execute it using `run.sh`.
    *   **Note**: While this server exists, the current implementation in `next-app/pages/api/execute.js` bypasses this HTTP server. Instead, the Next.js API route directly invokes `docker run` using the `executor` image and the `/run.sh` script within the container. This `server.js` might be intended for an alternative operational mode, local testing, or could be legacy code.

## `next-app/` Directory

This directory contains the Next.js frontend application, which provides the user interface for the online judge.

*   **package.json**: Defines the dependencies and scripts for the Next.js application. Dependencies include `next`, `react`, `react-dom`, `node-fetch` (for making API requests), and various markdown/KaTeX libraries for rendering problem statements.
*   **package-lock.json**: Records the exact versions of dependencies for the `next-app`.
*   **.gitignore**: Specifies files to be ignored by Git within the `next-app` directory.
*   **pages/**: Contains the application's pages and API routes.
    *   **`pages/index.js`**: The main landing page of the application.
        *   It lists available problems (fetched by reading the `problems/` directory names during build time using `getStaticProps`).
        *   It also features a simple code editor and execution form that uses the `/api/execute` endpoint for quick, ad-hoc code testing (not tied to a specific problem's test cases).
    *   **`pages/problems/[id].js`**: A dynamic page that displays a specific coding problem.
        *   Uses `getStaticPaths` to generate paths for all problems based on directory names in `next-app/problems/`.
        *   Uses `getStaticProps` to load the problem's statement (`statement.md`) and explanation (`explanation.md`) from the corresponding problem directory.
        *   Renders problem content using `react-markdown`, with support for LaTeX (via `remark-math` and `rehype-katex`).
        *   Provides a tabbed interface for "Problem Statement", "Submission Result", and "Explanation".
        *   Includes a code editor (textarea) and language selector for submitting solutions to the `/api/submit` endpoint.
        *   Handles Server-Sent Events (SSE) from `/api/submit` to display detailed, real-time judging results, including test suite structure, individual test case outcomes (Accepted, Wrong Answer, TLE, MLE), category scores, and the final overall score.
    *   **`pages/api/`**: Contains backend API routes for the Next.js application.
        *   **`pages/api/execute.js`**: An API route that handles ad-hoc code execution requests (typically from the form on `pages/index.js`).
            *   It receives `code` and `language` in a POST request.
            *   It creates a temporary directory on the host, writes the code to a file.
            *   It directly invokes `docker run` using the `executor` Docker image, mounting the temporary directory to `/code` within the container. The `/run.sh` script in the container executes the code.
            *   It returns the raw output from the execution, including any time/memory information appended by `run.sh`.
        *   **`pages/api/submit.js`**: A more complex API route for handling submissions against a specific problem's test cases.
            *   Receives `problemId`, `language`, and `code`.
            *   Uses Server-Sent Events (SSE) to stream results back to the client, allowing for real-time updates during the judging process.
            *   Reads the problem's `meta.json` to get test case paths, categories, points, time limits, and memory limits.
            *   For each test case associated with the problem:
                *   Creates a temporary directory for the execution.
                *   Writes the user's code to a language-appropriate file (e.g., `solution.py`).
                *   Copies the test case's input file (e.g., `test1.in`) to `input.txt` within the temporary directory.
                *   Executes the code using `docker run` with the `executor` image, similar to `execute.js`.
                *   Compares the program's output with the expected output file.
                *   Checks against time and memory limits defined in `meta.json`.
                *   Streams back detailed results for each test case (status, time, memory), category summaries, and a final score.
        *   **`pages/api/submit.test.js`**: Contains tests for the `submit.js` API route (though the file content wasn't reviewed, its name implies its purpose).
*   **problems/**: This directory stores the data for each coding problem. Each subdirectory represents a problem (e.g., `problem1/`).
    *   **`problemX/statement.md`**: The problem statement in Markdown format.
    *   **`problemX/explanation.md`**: (Optional) The explanation or solution approach for the problem, in Markdown.
    *   **`problemX/meta.json`**: A JSON file containing metadata for the problem, such as:
        *   Title, difficulty, author.
        *   Time limit (e.g., `timeout: 2000` in milliseconds).
        *   Memory limit (e.g., `memory_limit_kb: 262144` for 256MB).
        *   `test_case_categories`: An array defining categories of test cases, each with a name, points, and a list of `test_cases`. Each test case object specifies paths to its `input` and `output` files (relative to the `next-app` directory, e.g., `problems/problem1/tests/sample/sample1.in`).
    *   **`problemX/tests/`**: A directory containing the actual test case files (input and expected output files) organized into subdirectories (often corresponding to categories in `meta.json`).
*   **test_tle_mle.js**: A standalone Node.js script used for testing the Time Limit Exceeded (TLE) and Memory Limit Exceeded (MLE) detection capabilities of the `/api/submit` endpoint.
    *   It defines sample Python code snippets designed to trigger TLE and MLE conditions for a specific problem (e.g., `problem1`).
    *   It mocks HTTP requests to `/api/submit` and analyzes the streamed SSE responses to verify that TLE/MLE are correctly reported.

*(Note: `next.config.mjs` was not found within the `next-app/` directory during exploration. If it exists in the project root, it would configure aspects of the Next.js build and runtime behavior, such as custom webpack configurations, environment variables, or redirects.)*

## `.idea/` Directory

This directory contains configuration files specific to JetBrains IDEs (like IntelliJ IDEA, WebStorm, PyCharm, etc.).

*   It stores project-specific settings such as code style preferences, debugger configurations, version control integration details, and module information (`modules.xml`, `untitled7.iml`).
*   Files like `.gitignore` within `.idea/` ensure that user-specific IDE settings (e.g., `workspace.xml`) are not committed to the shared repository.
*   This directory is generally not relevant to the core logic or deployment of the project and is primarily for developer convenience when using a JetBrains IDE.
