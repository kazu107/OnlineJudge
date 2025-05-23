// executor/language_definitions.js
const path = require('path');

const definitions = {
  python: {
    language_id: 'python',
    source_file_extension: '.py',
    needs_compilation: false,
    get_execution_command: (scriptPath) => ['python3', scriptPath],
  },
  javascript: {
    language_id: 'javascript',
    source_file_extension: '.js',
    needs_compilation: false,
    get_execution_command: (scriptPath) => ['node', scriptPath],
  },
  cpp: {
    language_id: 'cpp',
    source_file_extension: '.cpp',
    compiled_file_extension: '', // No extension for executable on Linux/macOS
    needs_compilation: true,
    // outputName is path without extension, e.g. /tmp/submission-xyz/solution
    get_compilation_command: (sourcePath, outputName) => [
      'g++',
      sourcePath,
      '-o',
      outputName,
      '-std=c++17',
      '-O2',
      // '-DONLINE_JUDGE', // Common competitive programming flag
      // '-Wall', // Enable warnings
    ],
    get_execution_command: (executablePath) => [executablePath],
  },
  java: {
    language_id: 'java',
    source_file_extension: '.java',
    // Java's "executable" is the class name, but we need the .class file for classpath
    compiled_file_extension: '.class', 
    needs_compilation: true,
    // sourcePath is e.g. /tmp/submission-xyz/Main.java
    // outputName is effectively the directory for class files, e.g. /tmp/submission-xyz/
    // The class name (e.g., Main) is derived from sourcePath.
    get_compilation_command: (sourcePath, outputDir) => [
      'javac',
      '-d', 
      outputDir, // Place .class files in this directory
      sourcePath
    ],
    // executablePath here will be the path to the source file (e.g. Main.java) or class name
    // For Java, we need the directory containing the class and the main class name.
    // We'll assume the main class name is the source file name without extension.
    get_execution_command: (sourceFilePath) => {
      const classDir = path.dirname(sourceFilePath);
      const mainClassName = path.basename(sourceFilePath, '.java');
      return ['java', '-cp', classDir, mainClassName];
    },
  },
  ruby: {
    language_id: 'ruby',
    source_file_extension: '.rb',
    needs_compilation: false,
    get_execution_command: (scriptPath) => ['ruby', scriptPath],
  },
};

module.exports = definitions;
