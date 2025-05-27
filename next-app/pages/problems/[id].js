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

export default function ProblemPage({ id, statementContent, explanationContent, allTestCasesMeta }) {
    const [activeTab, setActiveTab] = useState('problem');
    const [language, setLanguage] = useState('python');
    const [code, setCode] = useState('');

    // Updated state variables for category-based results
    const [testCaseResults, setTestCaseResults] = useState([]); // Individual test case results
    const [categoryResults, setCategoryResults] = useState({}); // { categoryName: { earned: 0, max: 0, allPassed: false }, ... }
    const [finalResult, setFinalResult] = useState(null); // { total_earned: 0, max_total: 0, summary: [] }
    const [collapsedCategories, setCollapsedCategories] = useState({}); // { categoryName: boolean }

    const [submitting, setSubmitting] = useState(false);

    const toggleCategoryCollapse = (categoryName) => {
        setCollapsedCategories(prev => ({
            ...prev,
            [categoryName]: !prev[categoryName] // Toggle state, defaults to true if undefined
        }));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        // Clear previous results and initialize with "判定中"
        const initialResults = allTestCasesMeta.flatMap(category =>
            category.testCases.map(tcName => ({
                testCase: tcName,
                category_name: category.categoryName,
                status: "判定中",
                time: null,
                memory: null,
                expected: null, // Add expected and got for consistency
                got: null,
                message: null
            }))
        );
        setTestCaseResults(initialResults);
        setCategoryResults({});
        setFinalResult(null);
        // Reset collapsed state for categories to be open by default on new submission
        setCollapsedCategories({});


        setSubmitting(true);
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


                            if (event.type === 'test_case_result') {
                                setTestCaseResults(prevResults =>
                                    prevResults.map(tc =>
                                        (tc.testCase === event.testCase && tc.category_name === event.category_name)
                                            ? { ...tc, ...event } // Merge to keep existing fields if not overwritten
                                            : tc
                                    )
                                );
                            } else if (event.type === 'category_result') {
                                setCategoryResults(prev => ({
                                    ...prev,
                                    [event.category_name]: {
                                        earned: event.category_points_earned,
                                        max: event.category_max_points,
                                        allPassed: event.all_tests_in_category_passed
                                    }
                                }));
                            } else if (event.type === 'final_result') {
                                setFinalResult({
                                    total_earned: event.total_points_earned,
                                    max_total: event.max_total_points,
                                    summary: event.category_summary // Store summary for rendering order
                                });
                                setSubmitting(false); // Submission processing finished
                            } else if (event.error) { // Handle backend error messages
                                console.error('Backend error event:', event.error);
                                // Optionally, display this error to the user
                                // For example, by adding to a new state like `submissionError`
                                setFinalResult({ error: event.error }); // Indicate error in final result
                                setSubmitting(false);
                            }
                        } catch (err) {
                            console.error('Failed to parse SSE event:', jsonStr, err);
                        }
                    }
                }
            });
        }
        // If loop finishes but submitting is still true (e.g. stream ended abruptly before final_result)
        if (submitting) {
            setSubmitting(false);
            console.warn("SSE stream finished without a final_result event.");
        }
    };

    // Helper to get category display order from finalResult or fallback to categoryResults keys
    const getCategoryOrder = () => {
        if (finalResult && finalResult.summary) {
            return finalResult.summary.map(cat => cat.category_name);
        }
        return Object.keys(categoryResults);
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
                            {submitting && testCaseResults.length === 0 && !finalResult && <p>判定中…</p>}

                            {finalResult && finalResult.error && (
                                <div style={{ padding: '1rem', backgroundColor: '#ffdddd', border: '1px solid #ff0000', borderRadius: '5px', color: '#D8000C'}}>
                                    <p><strong>エラーが発生しました:</strong> {typeof finalResult.error === 'object' ? JSON.stringify(finalResult.error) : finalResult.error}</p>
                                </div>
                            )}

                            {finalResult && finalResult.total_earned !== undefined && (
                                <div style={{ margin: '1rem 0', padding: '1rem', backgroundColor: '#e6f7ff', border: '1px solid #91d5ff', borderRadius: '5px' }}>
                                    <h3>総合得点: {finalResult.total_earned} / {finalResult.max_total_points} 点</h3>
                                </div>
                            )}

                            {getCategoryOrder().map(categoryName => {
                                const categoryData = categoryResults[categoryName];
                                const categorySummary = finalResult?.summary?.find(s => s.category_name === categoryName);
                                const earnedPoints = categorySummary?.points_earned ?? categoryData?.earned ?? 0;
                                const maxPoints = categorySummary?.max_points ?? categoryData?.max ?? 0;
                                const allPassed = categoryData?.allPassed ?? (earnedPoints === maxPoints && maxPoints > 0);

                                const categoryHeaderStyle = {
                                    padding: '0.8rem',
                                    marginTop: '1rem',
                                    border: '1px solid #ddd',
                                    borderRadius: collapsedCategories[categoryName] ? '5px' : '5px 5px 0 0',
                                    backgroundColor: allPassed ? '#d4edda' : (categoryData ? '#f8d7da' : '#e9ecef'), // Green if all passed, Red if processed and failed, Grey if not yet processed
                                    color: allPassed ? '#155724' : (categoryData ? '#721c24' : '#495057'),
                                    cursor: 'pointer', // Add cursor pointer to indicate it's clickable
                                    display: 'flex', // Use flex to align items
                                    justifyContent: 'space-between', // Space between title and indicator
                                    alignItems: 'center' // Align items vertically
                                };
                                const isCollapsed = collapsedCategories[categoryName];

                                return (
                                    <div key={categoryName} style={{ marginBottom: '1rem' }}>
                                        <div style={categoryHeaderStyle} onClick={() => toggleCategoryCollapse(categoryName)}>
                                            <h4>{categoryName}: {earnedPoints} / {maxPoints} 点</h4>
                                            <span>{isCollapsed ? '▶' : '▼'}</span>
                                        </div>
                                        {!isCollapsed && (
                                            <>
                                                <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #ddd', borderTop: 'none' }}>
                                                    <thead>
                                                    <tr>
                                                        <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa' }}>テストケース名</th>
                                                        <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa' }}>結果</th>
                                                        <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa' }}>実行時間 (ms)</th>
                                                        <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa' }}>メモリ (KB)</th>
                                                    </tr>
                                                    </thead>
                                                    <tbody>
                                            {testCaseResults
                                                .filter(tc => tc.category_name === categoryName)
                                                .map((tc, index) => (
                                                <tr key={`${categoryName}-${tc.testCase}-${index}`} style={{ backgroundColor: index % 2 === 0 ? '#fff' : '#f9f9f9' }}>
                                                            <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{tc.testCase}</td>
                                                    <td style={{ border: '1px solid #ccc', padding: '0.5rem', color: tc.status === 'Accepted' ? 'green' : (tc.status === 'Wrong Answer' || tc.status === 'TLE' || tc.status === 'MLE' || tc.status === 'Error' ? 'red' : (tc.status === '判定中' ? 'blue' : 'inherit')) }}>
                                                                {tc.status}
                                                        {tc.status === 'Wrong Answer' && tc.expected !== null && tc.got !== null && (
                                                                    <div style={{fontSize: '0.8em', whiteSpace: 'pre-wrap', maxHeight: '100px', overflowY: 'auto', backgroundColor: '#fff0f0', padding: '5px', marginTop: '5px'}}>
                                                                <p style={{margin:0}}>Expected: {String(tc.expected)}</p>
                                                                <p style={{margin:0}}>Got: {String(tc.got)}</p>
                                                                    </div>
                                                                )}
                                                        {(tc.status === 'TLE' || tc.status === 'MLE') && tc.got !== null && (
                                                                    <div style={{fontSize: '0.8em', whiteSpace: 'pre-wrap', maxHeight: '100px', overflowY: 'auto', backgroundColor: '#fff0f0', padding: '5px', marginTop: '5px'}}>
                                                                <p style={{margin:0}}>Output: {String(tc.got)}</p>
                                                                    </div>
                                                                )}
                                                        {tc.status === 'Error' && tc.message !== null && (
                                                                    <div style={{fontSize: '0.8em', whiteSpace: 'pre-wrap', maxHeight: '100px', overflowY: 'auto', backgroundColor: '#fff0f0', padding: '5px', marginTop: '5px'}}>
                                                                <p style={{margin:0}}>Error: {String(tc.message)}</p>
                                                                    </div>
                                                                )}
                                                            </td>
                                                    <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{tc.time === null ? (tc.status === "判定中" ? "判定中..." : "-") : tc.time}</td>
                                                    <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{tc.memory === null ? (tc.status === "判定中" ? "判定中..." : "-") : tc.memory}</td>
                                                        </tr>
                                                    ))}
                                                    </tbody>
                                                </table>
                                                {/* This part might need adjustment if initial "判定中" rows are always present */}
                                                {testCaseResults.filter(tc => tc.category_name === categoryName && tc.status !== "判定中").length === 0 &&
                                                 allTestCasesMeta.find(cat => cat.categoryName === categoryName)?.testCases.length > 0 &&
                                                 !submitting && finalResult && /* Only show "no results" if submission is done and still no concrete results */ (
                                                    <div style={{padding: '0.5rem', textAlign: 'center', border: '1px solid #ddd', borderTop:'none', backgroundColor: '#fff'}}>
                                                        <p>このカテゴリーのテストケース結果はまだありません (判定完了後)。</p>
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </div>
                                );
                            })}
                            {/* Show this message only if no submission has been made yet, or if allTestCasesMeta is empty */}
                            {!submitting && testCaseResults.every(tc => tc.status === "判定中") && (!finalResult || finalResult?.summary?.length === 0) && (!allTestCasesMeta || allTestCasesMeta.length === 0) && (
                                <p>コードを提出すると、ここに結果が表示されます。</p>
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

    const metaPath = path.join(problemDir, 'meta.json');
    let allTestCasesMeta = [];
    if (fs.existsSync(metaPath)) {
        const metaContent = fs.readFileSync(metaPath, 'utf8');
        const meta = JSON.parse(metaContent);
        if (meta.test_case_categories && Array.isArray(meta.test_case_categories)) {
            allTestCasesMeta = meta.test_case_categories.map(category => ({
                categoryName: category.category_name,
                testCases: category.test_cases.map(tc => path.basename(tc.input, path.extname(tc.input)))
            }));
        }
    }

    return {
        props: {
            id: params.id,
            statementContent,
            explanationContent,
            allTestCasesMeta,
        },
    };
}