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

export default function ProblemPage({ id, statementContent, explanationContent, evaluationMode, problemMaxPoints, problemTestCasesMeta }) {
    const [activeTab, setActiveTab] = useState('problem');
    const [language, setLanguage] = useState('python');
    const [code, setCode] = useState('');
    
    // Updated state variables for category-based results
    const [testCaseResults, setTestCaseResults] = useState([]); // Individual test case results
    const [categoryResults, setCategoryResults] = useState({}); // { categoryName: { earned: 0, max: 0, allPassed: false }, ... }
    const [finalResult, setFinalResult] = useState(null); // { total_earned: 0, max_total: 0, summary: [] }
    const [submitting, setSubmitting] = useState(false);

    // State for new UI:
    const [testSuite, setTestSuite] = useState(null); // Holds all test cases info from 'test_suite_info'
    const [openCategories, setOpenCategories] = useState({}); // Tracks open/closed state of category accordions

    const handleSubmit = async (e) => {
        e.preventDefault();
        // Clear previous results and new states
        setTestCaseResults([]);
        setCategoryResults({});
        setFinalResult(null);
        setTestSuite(null); // Clear test suite
        setOpenCategories({}); // Reset open categories
        
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
                                setTestSuite(event.test_cases || []);
                                const initialOpenCategories = {};
                                if (event.test_cases) {
                                    event.test_cases.forEach(tc => {
                                        if (tc.category_name) { // Ensure category_name exists
                                            initialOpenCategories[tc.category_name] = true; // Default to open
                                        }
                                    });
                                }
                                setOpenCategories(initialOpenCategories);
                            } else if (event.type === 'test_case_result') {
                                setTestCaseResults(prev => [...prev, event]);
                            } else if (event.type === 'category_result') { // Standard mode specific
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
                                    // Use problemMaxPoints from props as the definitive max score from meta.json
                                    max_total_points: problemMaxPoints, 
                                    summary: evaluationMode === "custom_evaluator" ? event.test_case_summary : event.category_summary
                                });
                                setSubmitting(false); // Submission processing finished
                            } else if (event.type === 'error') { // Handle backend error messages (type: 'error')
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

    // Helper function to group test cases by category
    const groupTestSuiteByCategory = (suite) => {
        if (!suite) return [];
        const groups = suite.reduce((acc, tc) => {
            const categoryName = tc.category_name || 'Uncategorized'; // Fallback for uncategorized
            if (!acc[categoryName]) {
                acc[categoryName] = [];
            }
            acc[categoryName].push(tc);
            return acc;
        }, {});
        return Object.entries(groups).map(([categoryName, testCasesInCategory]) => ({
            categoryName,
            testCasesInCategory,
        }));
    };

    // Toggle category visibility
    const toggleCategory = (categoryName) => {
        setOpenCategories(prev => ({ ...prev, [categoryName]: !prev[categoryName] }));
    };
    
    // Helper to get category display order for standard mode
    const getCategoryOrderForStandardMode = () => {
        if (evaluationMode === "standard" && finalResult && finalResult.summary) {
            // Ensure summary is an array before mapping (it should be for standard mode)
            return Array.isArray(finalResult.summary) ? finalResult.summary.map(cat => cat.category_name) : [];
        }
        // Fallback for standard mode if finalResult.summary isn't ready or not an array
        return evaluationMode === "standard" ? Object.keys(categoryResults) : [];
    };
    
    // Helper to get test case meta for custom mode
    const getTestCaseMeta = (testCaseId) => {
        if (evaluationMode === "custom_evaluator" && problemTestCasesMeta) {
            return problemTestCasesMeta.find(tcMeta => tcMeta.id === testCaseId);
        }
        return null;
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
                            {submitting && !testSuite && !finalResult && <p>テストスイートを読み込み中...</p>}
                            {submitting && testSuite && testCaseResults.length === 0 && !finalResult && <p>判定中...</p>}
                            
                            {finalResult && finalResult.error && (
                                <div style={{ padding: '1rem', backgroundColor: '#ffdddd', border: '1px solid #ff0000', borderRadius: '5px', color: '#D8000C'}}>
                                    <p><strong>エラーが発生しました:</strong> {typeof finalResult.error === 'object' ? JSON.stringify(finalResult.error) : finalResult.error}</p>
                                </div>
                            )}

                            {/* Conditionally render Overall Score Display if not problem_tsp */}
                            {id !== "problem_tsp" && finalResult && finalResult.total_earned !== undefined && (
                                <div style={{ margin: '1rem 0', padding: '1rem', backgroundColor: '#e6f7ff', border: '1px solid #91d5ff', borderRadius: '5px' }}>
                                    <h3>総合得点: {finalResult.total_earned} / {finalResult.max_total_points || problemMaxPoints} 点</h3>
                                </div>
                            )}

                            {/* New UI for displaying test cases from testSuite */}
                            {testSuite && groupTestSuiteByCategory(testSuite).map(({ categoryName, testCasesInCategory }) => (
                                <div key={categoryName} style={{ marginBottom: '1rem' }}>
                                    <div 
                                        onClick={() => toggleCategory(categoryName)}
                                        style={{ 
                                            padding: '0.8rem', 
                                            marginTop: '1rem', 
                                            border: '1px solid #ddd',
                                            borderRadius: '5px 5px 0 0',
                                            backgroundColor: '#e9ecef',
                                            cursor: 'pointer',
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            alignItems: 'center'
                                        }}
                                    >
                                        <h4>{categoryName}</h4>
                                        <span>{openCategories[categoryName] ? '▲' : '▼'}</span>
                                    </div>
                                    {openCategories[categoryName] && (
                                        <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #ddd', borderTop: 'none' }}>
                                            <thead>
                                                <tr>
                                                    <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa', textAlign: 'left' }}>テストケース</th>
                                                    <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa', textAlign: 'left' }}>結果</th>
                                                    {/* Conditionally render Points Header if not problem_tsp for custom_evaluator */}
                                                    {evaluationMode === "custom_evaluator" && id !== "problem_tsp" && <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa', textAlign: 'left' }}>得点</th>}
                                                    {evaluationMode === "standard" && <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa', textAlign: 'left' }}>実行時間 (ms)</th>}
                                                    {evaluationMode === "standard" && <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa', textAlign: 'left' }}>メモリ (KB)</th>}
                                                    <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa', textAlign: 'left' }}>メッセージ/詳細</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {testCasesInCategory.map((suiteTc, index) => {
                                                    // Find the result for this test case
                                                    // For standard mode, suiteTc.id might be composite. resultTc.testCase is the simple name.
                                                    // For custom mode, suiteTc.id directly matches resultTc.test_case_id.
                                                    const resultTc = testCaseResults.find(r => 
                                                        evaluationMode === "custom_evaluator" ? r.test_case_id === suiteTc.id :
                                                        (r.category_name === suiteTc.category_name && r.testCase === suiteTc.name)
                                                    );

                                                    const status = resultTc ? resultTc.status : "判定中...";
                                                    const pointsEarned = resultTc ? (resultTc.points_earned ?? resultTc.score) : "-";
                                                    const maxPts = resultTc ? resultTc.max_points : (getTestCaseMeta(suiteTc.id)?.max_points || '-');
                                                    
                                                    let message = resultTc ? resultTc.message || "" : "";
                                                    if (resultTc && resultTc.status === 'Wrong Answer' && resultTc.expected) message = `Expected: ${resultTc.expected}, Got: ${resultTc.got || ''}`;
                                                    else if (resultTc && (resultTc.status === 'TLE' || resultTc.status === 'MLE') && resultTc.got) message = `Output: ${resultTc.got}`;
                                                    else if (resultTc && resultTc.status === 'Error' && resultTc.message) message = resultTc.message;


                                                    let statusColor = 'inherit';
                                                    if (status === 'Accepted' || (status === 'Custom Evaluated' && pointsEarned > 0 && pointsEarned === maxPts)) statusColor = 'green';
                                                    else if (status === 'Custom Evaluated' && pointsEarned > 0) statusColor = 'orange';
                                                    else if (status !== "判定中..." && (status.includes('Error') || status.includes('Wrong') || status.includes('TLE') || status.includes('MLE') || pointsEarned === 0)) statusColor = 'red';
                                                    
                                                    const execTime = resultTc?.time ?? '-';
                                                    const memoryUsage = resultTc?.memory ?? '-';

                                                    return (
                                                        <tr key={suiteTc.id || index} style={{ backgroundColor: index % 2 === 0 ? '#fff' : '#f9f9f9' }}>
                                                            <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{suiteTc.name}</td>
                                                            <td style={{ border: '1px solid #ccc', padding: '0.5rem', color: statusColor }}>{status}</td>
                                                            {/* Conditionally render Points Cell if not problem_tsp for custom_evaluator */}
                                                            {evaluationMode === "custom_evaluator" && id !== "problem_tsp" && <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{pointsEarned} / {maxPts}</td>}
                                                            {evaluationMode === "standard" && <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{execTime}</td>}
                                                            {evaluationMode === "standard" && <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{memoryUsage}</td>}
                                                            <td style={{ border: '1px solid #ccc', padding: '0.5rem', fontSize: '0.9em' }}>
                                                                {message}
                                                                {resultTc && resultTc.stdout_user && evaluationMode === "custom_evaluator" && <div style={{fontSize: '0.8em', whiteSpace: 'pre-wrap', maxHeight: '60px', overflowY: 'auto', backgroundColor: '#f0f0f0', padding: '3px', marginTop: '3px'}}>User STDOUT: {resultTc.stdout_user}</div>}
                                                                {resultTc && resultTc.stderr_evaluator && evaluationMode === "custom_evaluator" && <div style={{fontSize: '0.8em', whiteSpace: 'pre-wrap', maxHeight: '60px', overflowY: 'auto', backgroundColor: '#f0f0f0', padding: '3px', marginTop: '3px'}}>Evaluator STDERR: {resultTc.stderr_evaluator}</div>}
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    )}
                                </div>
                            ))}
                            
                            {/* Keep existing final result display, but conditionally hide overall score for problem_tsp */}
                            {id !== "problem_tsp" && finalResult && finalResult.total_earned !== undefined && (
                                 <div style={{ marginTop: '2rem', padding: '1rem', backgroundColor: '#e6f7ff', border: '1px solid #91d5ff', borderRadius: '5px' }}>
                                    <h3>総合得点: {finalResult.total_earned} / {finalResult.max_total_points || problemMaxPoints} 点</h3>
                                    {/* Display category summaries for standard mode still, if available in finalResult.summary */}
                                    {/* This part of the summary might also be duplicative if the main table already shows category points for standard */}
                                    {evaluationMode === "standard" && finalResult.summary && Array.isArray(finalResult.summary) && (
                                        <div style={{marginTop: '1rem'}}>
                                            <h4>カテゴリ別得点:</h4>
                                            <ul style={{listStyleType: 'none', paddingLeft: 0}}>
                                                {finalResult.summary.map(catSummary => (
                                                    <li key={catSummary.category_name}>
                                                        {catSummary.category_name}: {catSummary.points_earned} / {catSummary.max_points}
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </div>
                            )}
                            {/* If it's problem_tsp and final result is available, show a message or nothing for overall score */}
                            {id === "problem_tsp" && finalResult && finalResult.total_earned !== undefined && (
                                <div style={{ marginTop: '2rem', padding: '1rem', backgroundColor: '#e9ecef', border: '1px solid #ced4da', borderRadius: '5px', textAlign: 'center' }}>
                                    <p style={{margin:0, fontSize: '0.9em', color: '#495057'}}>この問題では総合得点は表示されません。各テストケースの総移動距離を参考にしてください。</p>
                                </div>
                            )}


                            {!submitting && !testSuite && !finalResult && (
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

    // Read meta.json to get evaluation_mode and other necessary info
    const metaPath = path.join(problemDir, 'meta.json');
    let evaluationMode = "standard"; // Default
    let problemMaxPoints = 100; // Default or sum
    let problemTestCasesMeta = null;

    if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        evaluationMode = meta.evaluation_mode || "standard";
        
        if (evaluationMode === "custom_evaluator") {
            problemMaxPoints = meta.max_total_points || (meta.test_cases ? meta.test_cases.reduce((sum, tc) => sum + (tc.points || 0), 0) : 0);
            problemTestCasesMeta = meta.test_cases ? meta.test_cases.map(tc => ({ 
                id: tc.id, 
                max_points: tc.points || 0, 
                description: tc.description || '' 
            })) : [];
        } else { // Standard mode (category-based)
            problemMaxPoints = meta.test_case_categories ? meta.test_case_categories.reduce((sum, cat) => sum + (cat.points || 0), 0) : 0;
            // For standard mode, problemTestCasesMeta is not strictly needed in the same way,
            // but categories could be passed if a pre-defined list of categories is useful before results stream in.
            // For now, keeping it null for standard mode as category info comes from SSE.
        }
    }

    return {
        props: {
            id: params.id,
            statementContent,
            explanationContent,
            evaluationMode,
            problemMaxPoints,
            problemTestCasesMeta
        },
    };
}
