// next-app/pages/problems/[id].js
import { useState } from 'react';
import fs from 'fs';
import path from 'path';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

// カスタム MarkdownRenderer（LaTeX やコードブロックのカスタムスタイル付き）
function MarkdownRenderer({ content }) {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={{
                code({ node, inline, className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || '');
                    if (!inline && match) {
                        return (
                            <pre
                                style={{
                                    backgroundColor: '#f5f5f5',
                                    padding: '1em',
                                    borderRadius: '5px',
                                    overflowX: 'auto',
                                    fontSize: '0.9em',
                                }}
                            >
                <code className={className} {...props}>
                  {children}
                </code>
              </pre>
                        );
                    }
                    return (
                        <code
                            className={className}
                            style={{
                                backgroundColor: '#f0f0f0',
                                padding: '0.2em 0.4em',
                                borderRadius: '3px',
                                fontSize: '0.95em',
                            }}
                            {...props}
                        >
                            {children}
                        </code>
                    );
                },
            }}
        >
            {content}
        </ReactMarkdown>
    );
}

export default function ProblemPage({ id, statementContent, explanationContent }) {
    const [activeTab, setActiveTab] = useState('problem');
    const [language, setLanguage] = useState('python');
    const [code, setCode] = useState('');
    // results を配列で管理（逐次追加）
    const [results, setResults] = useState([]);
    const [submitting, setSubmitting] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setResults([]); // 前回結果クリア
        setSubmitting(true);
        // 提出ボタン押下直後に提出結果タブに切替え
        setActiveTab('result');

        // POST 提出を fetch で実行。レスポンスは SSE 形式のストリーム
        const response = await fetch('/api/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ problemId: id, language, code }),
        });

        if (!response.body) {
            setSubmitting(false);
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        // SSE のパース：イベントは "data: ..." 行が2つ連続して空行で区切られる
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let parts = buffer.split('\n\n');
            // 最後の部分は未完成のイベントかもしれないので保持
            buffer = parts.pop() || '';
            parts.forEach(part => {
                // 各イベントは "data: {...}" という行
                const lines = part.split('\n');
                for (const line of lines) {
                    if (line.startsWith('data:')) {
                        const jsonStr = line.replace(/^data:\s*/, '');
                        try {
                            const event = JSON.parse(jsonStr);
                            // finished イベントが送られたら提出終了
                            if (event.finished) {
                                setSubmitting(false);
                            } else {
                                // 新しいテストケース結果を state に追加
                                setResults(prev => [...prev, event]);
                            }
                        } catch (err) {
                            console.error('Failed to parse SSE event:', err);
                        }
                    }
                }
            });
        }
        setSubmitting(false);
    };

    return (
        <div style={{ backgroundColor: '#ddd', minHeight: '100vh', padding: '2rem' }}>
            <div style={{
                maxWidth: '1000px',
                margin: '0 auto',
                backgroundColor: '#fff',
                padding: '2rem',
                boxShadow: '0 0 10px rgba(0,0,0,0.1)'
            }}>
                {/* タブ部分 */}
                <div style={{ marginBottom: '1rem' }}>
                    <button onClick={() => setActiveTab('problem')}
                            style={{
                                marginRight: '1rem',
                                padding: '0.5rem 1rem',
                                backgroundColor: activeTab === 'problem' ? '#ccc' : 'transparent',
                            }}>
                        問題文
                    </button>
                    <button onClick={() => setActiveTab('result')}
                            style={{
                                marginRight: '1rem',
                                padding: '0.5rem 1rem',
                                backgroundColor: activeTab === 'result' ? '#ccc' : 'transparent',
                            }}>
                        提出結果
                    </button>
                    <button onClick={() => setActiveTab('explanation')}
                            style={{
                                padding: '0.5rem 1rem',
                                backgroundColor: activeTab === 'explanation' ? '#ccc' : 'transparent',
                            }}>
                        解説
                    </button>
                </div>

                {/* タブごとのコンテンツ */}
                <div>
                    {activeTab === 'problem' && (
                        <div>
                            <MarkdownRenderer content={statementContent} />
                            <div style={{ marginTop: '2rem' }}>
                                <h2>ソースコードを提出する</h2>
                                <form onSubmit={handleSubmit}>
                                    <div>
                                        <label>言語: </label>
                                        <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                                            <option value="python">Python</option>
                                            <option value="cpp">C++</option>
                                            <option value="javascript">JavaScript</option>
                                            <option value="ruby">Ruby</option>
                                            <option value="java">Java</option>
                                        </select>
                                    </div>
                                    <div style={{ marginTop: '1rem' }}>
                    <textarea rows="10" cols="60"
                              placeholder="コードをここに貼り付けてください"
                              value={code}
                              onChange={(e) => setCode(e.target.value)} />
                                    </div>
                                    <button type="submit" style={{ marginTop: '1rem' }} disabled={submitting}>
                                        {submitting ? '判定中...' : '提出'}
                                    </button>
                                </form>
                            </div>
                        </div>
                    )}

                    {activeTab === 'result' && (
                        <div>
                            <h2>提出結果</h2>
                            {results.length > 0 ? (
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                    <tr>
                                        <th style={{ border: '1px solid #ccc', padding: '0.5rem' }}>テストケース名</th>
                                        <th style={{ border: '1px solid #ccc', padding: '0.5rem' }}>結果</th>
                                        <th style={{ border: '1px solid #ccc', padding: '0.5rem' }}>実行時間 (ms)</th>
                                        <th style={{ border: '1px solid #ccc', padding: '0.5rem' }}>メモリ使用量 (KB)</th>
                                    </tr>
                                    </thead>
                                    <tbody>
                                    {results.map((tc, index) => (
                                        <tr key={index}>
                                            <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{tc.testCase}</td>
                                            <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{tc.status}</td>
                                            <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{tc.time}</td>
                                            <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{tc.memory}</td>
                                        </tr>
                                    ))}
                                    </tbody>
                                </table>
                            ) : (
                                <p>{submitting ? '判定中…' : 'まだ結果がありません。'}</p>
                            )}
                        </div>
                    )}

                    {activeTab === 'explanation' && (
                        <div>
                            <h2>解説</h2>
                            {explanationContent ? (
                                <MarkdownRenderer content={explanationContent} />
                            ) : (
                                <p>解説はまだ用意されていません。</p>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// getStaticPaths: 問題フォルダ内の問題一覧を読み込む例
export async function getStaticPaths() {
    const problemsDir = path.join(process.cwd(), 'problems');
    const files = fs.readdirSync(problemsDir);
    const paths = files.map((file) => ({ params: { id: file } }));
    return { paths, fallback: false };
}

// getStaticProps: 指定された問題フォルダ内の Markdown ファイルを読み込む例
export async function getStaticProps({ params }) {
    const problemDir = path.join(process.cwd(), 'problems', params.id);
    const statementPath = path.join(problemDir, 'statement.md');
    const statementContent = fs.readFileSync(statementPath, 'utf8');

    let explanationContent = '';
    const explanationPath = path.join(problemDir, 'explanation.md');
    if (fs.existsSync(explanationPath)) {
        explanationContent = fs.readFileSync(explanationPath, 'utf8');
    }

    return {
        props: {
            id: params.id,
            statementContent,
            explanationContent,
        },
    };
}
