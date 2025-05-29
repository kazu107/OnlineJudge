# Project Summary

## Overview

This project is a web application built with Next.js. It appears to be a platform for coding problems, where users can view problem statements, submit solutions, and have them executed. The project is containerized using Docker.

## Project Structure

The project is organized into the following main directories and files:

- **`/` (Root Directory)**:
    - `PROJECT_SUMMARY.md`: This file, providing an overview of the project.
    - `README.md`: Standard Next.js README with instructions for getting started and deployment.
    - `package.json`: Defines project dependencies and scripts for the root Next.js application.
    - `docker-compose.yml`: Configures the Docker services for the application (Next.js frontend and an executor service).
    - `next.config.mjs`, `postcss.config.mjs`, `tailwind.config.mjs`: Configuration files for Next.js, PostCSS, and Tailwind CSS.
    - `Procfile`: Likely used for Heroku deployment, specifies the command to run on startup.

- **`/next-app`**: This directory contains the main Next.js frontend application.
    - `package.json`: Defines dependencies and scripts specific to the Next.js frontend.
    - `pages/`: Contains the Next.js pages for the application.
        - `api/`: Contains API route handlers.
            - `execute.js`: Likely handles code execution requests.
            - `submit.js`: Likely handles solution submissions.
            - `submit.test.js`: Tests for the submission functionality.
        - `problems/`: Contains pages related to displaying coding problems.
            - `[id].js`: A dynamic route to display a specific problem based on its ID.
        - `index.js`: The main landing page of the application.
    - `problems/`: This directory seems to store the actual problem data.
        - `problem1/`: An example problem directory.
            - `explanation.md`: Explanation of the problem.
            - `meta.json`: Metadata for the problem (e.g., title, difficulty).
            - `statement.md`: The problem statement itself.
            - `tests/`: Contains test cases for the problem.

- **`/executor`**: This directory contains a separate service, likely responsible for executing user-submitted code.
    - `Dockerfile`: Defines the Docker image for the executor service.
    - `package.json`: Defines dependencies for the executor service, including Express.js, suggesting it's an HTTP server.
    - `server.js`: The entry point for the executor service, likely setting up an Express server to handle execution requests.
    - `run.sh`: A shell script, possibly used to run the executor service or its tests.

- **`.idea/`**: Directory for IntelliJ IDEA project configuration files.
- **`jsconfig.json`**: JavaScript configuration file, often used for setting up path aliases or other JS-related settings.
- **`memo`**: The purpose of this file is unclear from its name and lack of extension.
- **`.gitignore`**: Specifies intentionally untracked files that Git should ignore.

## Technologies Used

- **Frontend**:
    - Next.js (React framework)
    - React
    - Tailwind CSS
    - Markdown rendering (react-markdown, remark-html, rehype-katex, remark-math) for displaying problem statements and explanations.

- **Backend/Code Execution**:
    - Node.js
    - Express.js (for the executor service)
    - Docker (for containerizing the application and executor service)

- **Package Management**:
    - npm

- **Deployment**:
    - Likely Heroku (inferred from `Procfile` and `heroku-postbuild` script in `package.json`)
    - Vercel (mentioned in `README.md` as a deployment option for Next.js apps)

## Key Functionalities (Inferred)

- Displaying coding problems with statements, explanations, and examples.
- Allowing users to submit code solutions.
- Executing submitted code against predefined test cases.
- Providing feedback on code submissions (e.g., success, failure, errors, resource limits like TLE/MLE - inferred from `test_tle_mle.js`).
- API endpoints for code execution (`/api/execute`) and submission (`/api/submit`).
