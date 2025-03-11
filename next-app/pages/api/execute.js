import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).json({ result: 'Method Not Allowed' });
        return;
    }

    const { code, language } = req.body;
    if (!code || !language) {
        res.status(400).json({ result: 'コードまたは言語が指定されていません' });
        return;
    }

    // 一時ディレクトリの作成
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-'));
    let filename = '';
    switch(language) {
        case 'python':
            filename = 'code.py';
            break;
        case 'cpp':
            filename = 'code.cpp';
            break;
        case 'javascript':
            filename = 'code.js';
            break;
        case 'ruby':
            filename = 'code.rb';
            break;
        case 'java':
            // 修正: ファイル名を Main.java に変更
            filename = 'Main.java';
            break;
        default:
            res.status(400).json({ result: '未対応の言語です' });
            return;
    }
    const filePath = path.join(tmpDir, filename);

    // ユーザーコードを一時ファイルに書き出し
    fs.writeFileSync(filePath, code);

    // Dockerコンテナでコード実行
    // ※ executor: 事前にビルドしたDockerイメージ名
    const dockerCmd = `docker run --rm -v ${tmpDir}:/code executor ${language} /code/${filename}`;

    exec(dockerCmd, { timeout: 5000 }, (error, stdout, stderr) => {
        // 実行後、一時ディレクトリを削除
        fs.rmSync(tmpDir, { recursive: true, force: true });

        if (error) {
            res.status(200).json({ result: stderr || error.message });
            return;
        }
        res.status(200).json({ result: stdout });
    });
}
