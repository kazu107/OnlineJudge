// executor/server.js
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json());

app.post('/run', (req, res) => {
    const { language, code } = req.body;
    if (!language || !code) {
        return res.status(400).json({ error: 'Missing language or code' });
    }

    // 一時ディレクトリの作成
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-'));
    let filename = '';
    switch (language) {
        case 'python': filename = 'solution.py'; break;
        case 'cpp': filename = 'solution.cpp'; break;
        case 'javascript': filename = 'solution.js'; break;
        case 'ruby': filename = 'solution.rb'; break;
        case 'java': filename = 'Main.java'; break;
        default:
            return res.status(400).json({ error: 'Unsupported language' });
    }
    const solutionPath = path.join(tmpDir, filename);
    fs.writeFileSync(solutionPath, code);

    // run.sh を実行（このスクリプトは、run.sh 内で入力ファイルがなければ単にコードを実行し、
    // 出力の最後に "TIME_MS:<実行時間> MEM:<メモリ使用量>" を出力するようにしている前提）
    exec(`./run.sh ${language} ${solutionPath}`, { cwd: tmpDir }, (error, stdout, stderr) => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (error) {
            return res.status(500).json({ error: stderr || error.message });
        }
        res.json({ output: stdout });
    });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Executor service listening on port ${PORT}`);
});
