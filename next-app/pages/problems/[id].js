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

    // New state for displaying all test cases with their statuses
    const [displayedResults, setDisplayedResults] = useState([]);
    const [categoryResults, setCategoryResults] = useState({}); // { categoryName: { earned: 0, max: 0, allPassed: false }, ... }
    const [finalResult, setFinalResult] = useState(null); // { total_earned: 0, max_total: 0, summary: [] }
    const [testSuite, setTestSuite] = useState(null); // Structure of all test cases (from test_suite_info)
    const [openCategories, setOpenCategories] = useState({}); // For accordion UI

    const [submitting, setSubmitting] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        // Clear previous results
        setTestSuite(null);
        setDisplayedResults([]); // Initialize/clear displayed results
        setCategoryResults({});
        setFinalResult(null);
        setOpenCategories({});

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

                            if (event.type === 'test_suite_info') {
                                setTestSuite(event.data); // Keep testSuite for category structure if needed elsewhere
                                const initialResults = [];
                                const initialOpenCategories = {};
                                if (event.data && event.data.categories) {
                                    event.data.categories.forEach(category => {
                                        initialOpenCategories[category.name] = true; // Default to open
                                        category.test_cases.forEach(tcName => {
                                            initialResults.push({
                                                categoryName: category.name,
                                                testCaseName: tcName,
                                                status: '判定待ち',
                                                time: null,
                                                memory: null,
                                            });
                                        });
                                    });
                                }
                                setDisplayedResults(initialResults);
                                setOpenCategories(initialOpenCategories);
                                setCategoryResults({}); // Reset category specific results
                            } else if (event.type === 'test_case_result') {
                                setDisplayedResults(prevResults =>
                                    prevResults.map(r =>
                                        r.categoryName === event.category_name && r.testCaseName === event.testCase
                                            ? {
                                                ...r,
                                                status: event.status,
                                                time: event.time,
                                                memory: event.memory,
                                                got: event.got,
                                                expected: event.expected,
                                                message: event.message,
                                            }
                                            : r
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
        if (testSuite && testSuite.categories) {
            return testSuite.categories.map(cat => cat.name);
        }
        return Object.keys(categoryResults);
    };

    const toggleCategory = (categoryName) => {
        setOpenCategories(prev => ({ ...prev, [categoryName]: !prev[categoryName] }));
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
                            {/* Initial "判定中..." message before testSuite is loaded */}
                            {submitting && !testSuite && !finalResult && <p>判定中...</p>}

                            {finalResult && finalResult.error && (
                                <div style={{ padding: '1rem', backgroundColor: '#ffdddd', border: '1px solid #ff0000', borderRadius: '5px', color: '#D8000C'}}>
                                    <p><strong>エラーが発生しました:</strong> {typeof finalResult.error === 'object' ? JSON.stringify(finalResult.error) : finalResult.error}</p>
                                </div>
                            )}

                            {finalResult && finalResult.total_earned !== undefined && (
                                <div style={{ margin: '1rem 0', padding: '1rem', backgroundColor: '#e6f7ff', border: '1px solid #91d5ff', borderRadius: '5px' }}>
                                    <h3>総合得点: {finalResult.total_earned} / {finalResult.max_total} 点</h3>
                                </div>
                            )}

                            {/* Display based on testSuite or final results */}
                            {getCategoryOrder().map(categoryName => {
                                const currentCategoryInSuite = testSuite?.categories.find(c => c.name === categoryName);
                                const categoryDataFromResults = categoryResults[categoryName]; // From category_result event
                                const categorySummaryFromFinal = finalResult?.summary?.find(s => s.category_name === categoryName);

                                const earnedPoints = categorySummaryFromFinal?.points_earned ?? categoryDataFromResults?.earned ?? 0;
                                const maxPoints = categorySummaryFromFinal?.max_points ?? categoryDataFromResults?.max ?? (currentCategoryInSuite ? (testSuite.categories.find(c=>c.name === categoryName)?.test_cases.length > 0 ? currentCategoryInSuite.test_cases.length * 10 : 0) : 0); // Fallback for max points if not in results yet
                                const allPassed = categoryDataFromResults?.allPassed ?? (earnedPoints === maxPoints && maxPoints > 0);

                                // Determine header style based on whether results for this category have started coming in or if it's final
                                let headerBgColor = '#e9ecef'; // Default grey for pending/not started
                                let headerColor = '#495057';
                                if (categoryDataFromResults || categorySummaryFromFinal) { // If any result for this category exists
                                    headerBgColor = allPassed ? '#d4edda' : '#f8d7da'; // Green if all passed, Red if any failed
                                    headerColor = allPassed ? '#155724' : '#721c24';
                                }


                                const categoryHeaderStyle = {
                                    padding: '0.8rem',
                                    marginTop: '1rem',
                                    border: '1px solid #ddd',
                                    borderRadius: openCategories[categoryName] ? '5px 5px 0 0' : '5px',
                                    backgroundColor: headerBgColor,
                                    color: headerColor,
                                    cursor: 'pointer',
                                    borderBottom: openCategories[categoryName] ? 'none' : '1px solid #ddd'
                                };

                                // Filter displayedResults for the current category
                                const testCasesForThisCategoryInDisplayedResults = displayedResults.filter(
                                    r => r.categoryName === categoryName
                                );

                                return (
                                    <div key={categoryName} style={{ marginBottom: '1rem' }}>
                                        <div style={categoryHeaderStyle} onClick={() => toggleCategory(categoryName)}>
                                            <h4>
                                                {categoryName}: {categoryDataFromResults || categorySummaryFromFinal ? `${earnedPoints} / ${maxPoints} 点` : '判定中...'}
                                                <span style={{ float: 'right', fontWeight: 'normal', fontSize: '0.9em' }}>{openCategories[categoryName] ? '▲' : '▼'}</span>
                                            </h4>
                                        </div>
                                        {openCategories[categoryName] && (
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
                                                {testCasesForThisCategoryInDisplayedResults.length > 0 ? (
                                                    testCasesForThisCategoryInDisplayedResults.map((result, index) => (
                                                        <tr key={`${categoryName}-${result.testCaseName}-${index}`} style={{ backgroundColor: index % 2 === 0 ? '#fff' : '#f9f9f9' }}>
                                                            <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{result.testCaseName}</td>
                                                            <td style={{ border: '1px solid #ccc', padding: '0.5rem', color: result.status === 'Accepted' ? 'green' : (result.status === 'Wrong Answer' || result.status === 'TLE' || result.status === 'MLE' || result.status === 'Error' ? 'red' : 'inherit') }}>
                                                                {result.status}
                                                                {result.status === 'Wrong Answer' && (
                                                                    <div style={{fontSize: '0.8em', whiteSpace: 'pre-wrap', maxHeight: '100px', overflowY: 'auto', backgroundColor: '#fff0f0', padding: '5px', marginTop: '5px'}}>
                                                                        <p style={{margin:0}}>Expected: {result.expected}</p>
                                                                        <p style={{margin:0}}>Got: {result.got}</p>
                                                                    </div>
                                                                )}
                                                                {(result.status === 'TLE' || result.status === 'MLE') && result.got && (
                                                                    <div style={{fontSize: '0.8em', whiteSpace: 'pre-wrap', maxHeight: '100px', overflowY: 'auto', backgroundColor: '#fff0f0', padding: '5px', marginTop: '5px'}}>
                                                                        <p style={{margin:0}}>Output: {result.got}</p>
                                                                    </div>
                                                                )}
                                                                {result.status === 'Error' && result.message && (
                                                                    <div style={{fontSize: '0.8em', whiteSpace: 'pre-wrap', maxHeight: '100px', overflowY: 'auto', backgroundColor: '#fff0f0', padding: '5px', marginTop: '5px'}}>
                                                                        <p style={{margin:0}}>Error: {result.message}</p>
                                                                    </div>
                                                                )}
                                                            </td>
                                                            <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{result.time ?? '-'}</td>
                                                            <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{result.memory ?? '-'}</td>
                                                        </tr>
                                                    ))
                                                ) : (
                                                    <tr>
                                                        <td colSpan="4" style={{ padding: '0.5rem', textAlign: 'center', border: '1px solid #ccc', backgroundColor: '#fff'}}>
                                                            {submitting || (testSuite && testSuite.categories.find(c => c.name === categoryName)?.test_cases.length > 0) ? 'テストケースを読み込んでいます...' : 'このカテゴリーのテストケースはありません。'}
                                                        </td>
                                                    </tr>
                                                )}
                                                </tbody>
                                            </table>
                                        )}
                                    </div>
                                );
                            })}
                            {/* Message when no results are available at all and not submitting */}
                            {!submitting && getCategoryOrder().length === 0 && !finalResult && (
                                <p>まだ結果がありません。</p>
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