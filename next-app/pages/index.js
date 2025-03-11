import { useState, useEffect } from 'react';

export default function Home() {
    const sampleCodes = {
        python: "print('Hello, World!')",
        cpp: `#include <iostream>
using namespace std;
int main() {
    cout << "Hello, World!";
    return 0;
}`,
        javascript: "console.log('Hello, World!');",
        ruby: "puts 'Hello, World!'",
        java: `public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}`
    };

    const [language, setLanguage] = useState('python');
    const [code, setCode] = useState(sampleCodes['python']);
    const [result, setResult] = useState('');

    // 言語選択時にサンプルコードをセット
    const handleLanguageChange = (e) => {
        const lang = e.target.value;
        setLanguage(lang);
        setCode(sampleCodes[lang]);
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setResult('実行中...');
        const res = await fetch('/api/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, language }),
        });
        const data = await res.json();
        setResult(data.result);
    };

    return (
        <div style={{ padding: '2rem' }}>
            <h1>多言語コード実行サンプル</h1>
            <form onSubmit={handleSubmit}>
                <div>
                    <label>言語: </label>
                    <select value={language} onChange={handleLanguageChange}>
                        <option value="python">Python</option>
                        <option value="cpp">C++</option>
                        <option value="javascript">JavaScript</option>
                        <option value="ruby">Ruby</option>
                        <option value="java">Java</option>
                    </select>
                </div>
                <div style={{ marginTop: '1rem' }}>
                    <label>コード:</label>
                    <br />
                    <textarea
                        rows="10"
                        cols="60"
                        value={code}
                        onChange={e => setCode(e.target.value)}
                        placeholder="ここにコードを入力"
                    />
                </div>
                <button type="submit" style={{ marginTop: '1rem' }}>実行</button>
            </form>
            <div style={{ marginTop: '1rem' }}>
                <h2>結果:</h2>
                <pre>{result}</pre>
            </div>
        </div>
    );
}
