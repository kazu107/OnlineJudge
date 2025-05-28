// next-app/pages/problems/[id].js
import { useState, useEffect } from 'react'; // Added useEffect
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

export default function ProblemPage({ id, statementContent, explanationContent, problemMetaData }) { // Added problemMetaData
    const [activeTab, setActiveTab] = useState('problem');
    const [language, setLanguage] = useState('python');
    const [code, setCode] = useState('');

    // State for displaying test case results, initialized based on problemMetaData
    const [displayedResults, setDisplayedResults] = useState([]);
    // categoryResults and finalResult remain as they are for category-level and final scoring
    const [categoryResults, setCategoryResults] = useState({}); 
    const [finalResult, setFinalResult] = useState(null); 

    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (problemMetaData && problemMetaData.test_case_categories) {
            const initialResults = [];
            problemMetaData.test_case_categories.forEach(category => {
                if (category.test_cases && Array.isArray(category.test_cases)) {
                    category.test_cases.forEach(tc => {
                        initialResults.push({
                            key: `${category.category_name}-${tc.input_basename}`,
                            categoryName: category.category_name,
                            testCaseName: tc.input_basename,
                            status: "判定待ち", // Pending
                            time: null,
                            memory: null,
                            got: '',
                            expected: '',
                            message: null,
                        });
                    });
                }
            });
            setDisplayedResults(initialResults);
        }
    }, [problemMetaData]); // Initialize/reset when problemMetaData changes (e.g., page load)

    const handleSubmit = async (e) => {
        e.preventDefault();
        
        // Reset displayedResults to pending state for all test cases based on problemMetaData
        if (problemMetaData && problemMetaData.test_case_categories) {
            const initialResults = [];
            problemMetaData.test_case_categories.forEach(category => {
                if (category.test_cases && Array.isArray(category.test_cases)) {
                    category.test_cases.forEach(tc => {
                        initialResults.push({
                            key: `${category.category_name}-${tc.input_basename}`,
                            categoryName: category.category_name,
                            testCaseName: tc.input_basename,
                            status: "判定待ち",
                            time: null, memory: null, got: '', expected: '', message: null
                        });
                    });
                }
            });
            setDisplayedResults(initialResults);
        }
        
        // Clear previous category and final results
        setCategoryResults({});
        setFinalResult(null);

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
                                setDisplayedResults(prevResults => 
                                    prevResults.map(item => {
                                        if (item.categoryName === event.category_name && item.testCaseName === event.testCase) {
                                            return { 
                                                ...item, 
                                                status: event.status, 
                                                time: event.time, 
                                                memory: event.memory, 
                                                got: event.got, 
                                                expected: event.expected, // Should be set by backend only on WA
                                                message: event.message 
                                            };
                                        }
                                        return item;
                                    })
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

    // Category display order will now come from problemMetaData to ensure meta.json order
    const getCategoryOrder = () => {
        if (problemMetaData && problemMetaData.test_case_categories) {
            return problemMetaData.test_case_categories.map(cat => cat.category_name);
        }
        // Fallback if problemMetaData is not yet available (should be rare after init)
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
                            {/* Check if any result is still "判定待ち" or if submitting and no final result yet */}
                            {submitting && displayedResults.some(r => r.status === "判定待ち") && !finalResult && <p>判定中…</p>}
                            {!submitting && displayedResults.length === 0 && problemMetaData && <p>テストケース情報を待っています...</p>}


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

                            {/* Iterate over categories from problemMetaData to maintain order */}
                            {problemMetaData && problemMetaData.test_case_categories && problemMetaData.test_case_categories.map(category => {
                                const categoryName = category.category_name;
                                const categoryData = categoryResults[categoryName]; // From SSE event category_result
                                const categorySummary = finalResult?.summary?.find(s => s.category_name === categoryName);
                                
                                const earnedPoints = categorySummary?.points_earned ?? categoryData?.earned ?? 0;
                                const maxPoints = categorySummary?.max_points ?? categoryData?.max ?? category.points ?? 0; // Fallback to meta points
                                const allPassed = categoryData?.allPassed ?? (earnedPoints === maxPoints && maxPoints > 0);

                                const categoryHeaderStyle = {
                                    padding: '0.8rem',
                                    marginTop: '1rem',
                                    border: '1px solid #ddd',
                                    borderRadius: '5px 5px 0 0',
                                    backgroundColor: allPassed ? '#d4edda' : (categoryData || (finalResult && !submitting) ? '#f8d7da' : '#e9ecef')),
                                    color: allPassed ? '#155724' : (categoryData || (finalResult && !submitting) ? '#721c24' : '#495057'),
                                    borderBottom: 'none'
                                };
                                
                                // Filter displayedResults for the current category
                                const resultsInThisCategory = displayedResults.filter(dr => dr.categoryName === categoryName);

                                return (
                                    <div key={categoryName} style={{ marginBottom: '1rem' }}>
                                        <div style={categoryHeaderStyle}>
                                            <h4>{categoryName}: {earnedPoints} / {maxPoints} 点</h4>
                                        </div>
                                        <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #ddd' }}>
                                            <thead>
                                            <tr>
                                                <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa', width: '30%' }}>テストケース名</th>
                                                <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa', width: '40%' }}>結果</th>
                                                <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa', width: '15%' }}>実行時間 (ms)</th>
                                                <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa', width: '15%' }}>メモリ (KB)</th>
                                            </tr>
                                            </thead>
                                            <tbody>
                                            {resultsInThisCategory.map((tc, index) => (
                                                <tr key={tc.key} style={{ backgroundColor: index % 2 === 0 ? '#fff' : '#f9f9f9' }}>
                                                    <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{tc.testCaseName}</td>
                                                    <td style={{ border: '1px solid #ccc', padding: '0.5rem', color: tc.status === 'Accepted' ? 'green' : (tc.status === 'Wrong Answer' || tc.status === 'TLE' || tc.status === 'MLE' || tc.status === 'Error' ? 'red' : 'inherit') }}>
                                                        {tc.status}
                                                        {tc.status === 'Wrong Answer' && tc.expected && (
                                                            <div style={{fontSize: '0.8em', whiteSpace: 'pre-wrap', maxHeight: '100px', overflowY: 'auto', backgroundColor: '#fff0f0', padding: '5px', marginTop: '5px'}}>
                                                                <p style={{margin:0}}>Expected: {tc.expected}</p>
                                                                <p style={{margin:0}}>Got: {tc.got}</p>
                                                            </div>
                                                        )}
                                                        {(tc.status === 'TLE' || tc.status === 'MLE') && tc.got && (
                                                            <div style={{fontSize: '0.8em', whiteSpace: 'pre-wrap', maxHeight: '100px', overflowY: 'auto', backgroundColor: '#fff0f0', padding: '5px', marginTop: '5px'}}>
                                                                <p style={{margin:0}}>Output: {tc.got}</p>
                                                            </div>
                                                        )}
                                                        {tc.status === 'Error' && tc.message && (
                                                            <div style={{fontSize: '0.8em', whiteSpace: 'pre-wrap', maxHeight: '100px', overflowY: 'auto', backgroundColor: '#fff0f0', padding: '5px', marginTop: '5px'}}>
                                                                <p style={{margin:0}}>Error: {tc.message}</p>
                                                            </div>
                                                        )}
                                                    </td>
                                                    <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{tc.time ?? (tc.status !== '判定待ち' ? '-' : '')}</td>
                                                    <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{tc.memory ?? (tc.status !== '判定待ち' ? '-' : '')}</td>
                                                </tr>
                                            ))}
                                            </tbody>
                                        </table>
                                        {resultsInThisCategory.length === 0 && !submitting && (
                                            <div style={{padding: '0.5rem', textAlign: 'center', border: '1px solid #ddd', borderTop:'none', backgroundColor: '#fff'}}>
                                                <p>このカテゴリーのテストケース情報はありません。</p>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                            {/* Fallback message if problemMetaData hasn't loaded yet */}
                            {(!problemMetaData || !problemMetaData.test_case_categories) && !submitting && !finalResult && (
                                <p>テストケースの定義を読み込んでいます...</p>
                            )}
                             {/* Message if submission is done but no results (e.g. error before any test case ran) */}
                            {!submitting && displayedResults.every(r => r.status === "判定待ち") && finalResult && !finalResult.error && (
                                <p>結果がありません。提出に問題があった可能性があります。</p>
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

    // Load meta.json and process test case basenames
    const metaPath = path.join(problemDir, 'meta.json');
    let problemMetaData = null;
    if (fs.existsSync(metaPath)) {
        const metaFileContent = fs.readFileSync(metaPath, 'utf8');
        const metaData = JSON.parse(metaFileContent);
        if (metaData.test_case_categories && Array.isArray(metaData.test_case_categories)) {
            metaData.test_case_categories.forEach(category => {
                if (category.test_cases && Array.isArray(category.test_cases)) {
                    category.test_cases.forEach(testCase => {
                        if (testCase.input && typeof testCase.input === 'string') {
                            testCase.input_basename = path.basename(testCase.input);
                        } else {
                            testCase.input_basename = 'unknown_input'; // Fallback
                        }
                    });
                }
            });
        }
        problemMetaData = metaData;
    }


    return {
        props: {
            id: params.id,
            statementContent,
            explanationContent,
            problemMetaData, // Pass processed meta data
        },
    };
}