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

    const handleSubmit = async (e) => {
        e.preventDefault();
        // Clear previous results
        setTestCaseResults([]);
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
                                setTestCaseResults(prev => [...prev, event]);
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
                            {submitting && testCaseResults.length === 0 && !finalResult && <p>判定中…</p>}
                            
                            {finalResult && finalResult.error && (
                                <div style={{ padding: '1rem', backgroundColor: '#ffdddd', border: '1px solid #ff0000', borderRadius: '5px', color: '#D8000C'}}>
                                    <p><strong>エラーが発生しました:</strong> {typeof finalResult.error === 'object' ? JSON.stringify(finalResult.error) : finalResult.error}</p>
                                </div>
                            )}

                            {finalResult && finalResult.total_earned !== undefined && (
                                <div style={{ margin: '1rem 0', padding: '1rem', backgroundColor: '#e6f7ff', border: '1px solid #91d5ff', borderRadius: '5px' }}>
                                    <h3>総合得点: {finalResult.total_earned} / {finalResult.max_total_points || problemMaxPoints} 点</h3>
                                </div>
                            )}

                            {/* Standard Evaluation Mode Display */}
                            {evaluationMode === "standard" && getCategoryOrderForStandardMode().map(categoryName => {
                                const categoryData = categoryResults[categoryName];
                                // finalResult.summary should be an array of category summaries for standard mode
                                const categorySummary = finalResult?.summary && Array.isArray(finalResult.summary) ? 
                                                        finalResult.summary.find(s => s.category_name === categoryName) : null;
                                
                                const earnedPoints = categorySummary?.points_earned ?? categoryData?.earned ?? 0;
                                const maxPoints = categorySummary?.max_points ?? categoryData?.max ?? 0;
                                const allPassed = categoryData?.allPassed ?? (earnedPoints === maxPoints && maxPoints > 0);

                                const categoryHeaderStyle = {
                                    padding: '0.8rem', marginTop: '1rem', border: '1px solid #ddd',
                                    borderRadius: '5px 5px 0 0',
                                    backgroundColor: allPassed ? '#d4edda' : (categoryData ? '#f8d7da' : '#e9ecef'),
                                    color: allPassed ? '#155724' : (categoryData ? '#721c24' : '#495057'),
                                    borderBottom: 'none'
                                };
                                
                                return (
                                    <div key={categoryName} style={{ marginBottom: '1rem' }}>
                                        <div style={categoryHeaderStyle}><h4>{categoryName}: {earnedPoints} / {maxPoints} 点</h4></div>
                                        <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #ddd' }}>
                                            <thead>
                                                <tr>
                                                    <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa' }}>テストケース名</th>
                                                    <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa' }}>結果</th>
                                                    <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa' }}>実行時間 (ms)</th>
                                                    <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa' }}>メモリ (KB)</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {testCaseResults.filter(tc => tc.category_name === categoryName).map((tc, index) => (
                                                    <tr key={index} style={{ backgroundColor: index % 2 === 0 ? '#fff' : '#f9f9f9' }}>
                                                        <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{tc.testCase}</td>
                                                        <td style={{ border: '1px solid #ccc', padding: '0.5rem', color: tc.status === 'Accepted' ? 'green' : 'red' }}>
                                                            {tc.status}
                                                            {/* Details for WA, TLE, MLE, Error */}
                                                            {(tc.status === 'Wrong Answer' || tc.status === 'Error' || tc.status === 'TLE' || tc.status === 'MLE') && (
                                                                <div style={{fontSize: '0.8em', whiteSpace: 'pre-wrap', maxHeight: '100px', overflowY: 'auto', backgroundColor: '#fff0f0', padding: '5px', marginTop: '5px'}}>
                                                                    {tc.status === 'Wrong Answer' && <p style={{margin:0}}>Expected: {tc.expected}</p>}
                                                                    {(tc.status === 'Wrong Answer' || tc.status === 'TLE' || tc.status === 'MLE') && tc.got && <p style={{margin:0}}>Got: {tc.got}</p>}
                                                                    {tc.status === 'Error' && tc.message && <p style={{margin:0}}>Error: {tc.message}</p>}
                                                                </div>
                                                            )}
                                                        </td>
                                                        <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{tc.time ?? '-'}</td>
                                                        <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{tc.memory ?? '-'}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                        {testCaseResults.filter(tc => tc.category_name === categoryName).length === 0 && !submitting && (
                                            <div style={{padding: '0.5rem', textAlign: 'center', border: '1px solid #ddd', borderTop:'none', backgroundColor: '#fff'}}>
                                                <p>このカテゴリーのテストケース結果はまだありません。</p>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}

                            {/* Custom Evaluator Mode Display */}
                            {evaluationMode === "custom_evaluator" && (
                                <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '1rem' }}>
                                    <thead>
                                        <tr>
                                            <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa' }}>テストケース ID</th>
                                            <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa' }}>説明</th>
                                            <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa' }}>結果</th>
                                            <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa' }}>得点</th>
                                            <th style={{ border: '1px solid #ccc', padding: '0.5rem', backgroundColor: '#f8f9fa' }}>メッセージ/詳細</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {(finalResult?.summary || testCaseResults.filter(tc => tc.type === 'test_case_result')).map((tc, index) => {
                                            // If using finalResult.summary, tc structure is {id, score, max_points, status, message}
                                            // If using testCaseResults, tc structure is {test_case_id, status, points_earned, max_points, message, stdout_user, stderr_evaluator}
                                            const id = tc.test_case_id || tc.id;
                                            const tcMeta = getTestCaseMeta(id);
                                            const status = tc.status;
                                            const pointsEarned = tc.points_earned ?? tc.score;
                                            const maxPts = tc.max_points ?? tcMeta?.max_points;
                                            const message = tc.message || "";
                                            const details = [];
                                            if(tc.stdout_user) details.push(`User Output: ${tc.stdout_user}`);
                                            if(tc.stderr_evaluator) details.push(`Evaluator Stderr: ${tc.stderr_evaluator}`);
                                            
                                            let statusColor = 'inherit';
                                            if (status === 'Custom Evaluated' && pointsEarned > 0 && pointsEarned === maxPts) statusColor = 'green';
                                            else if (status === 'Custom Evaluated' && pointsEarned > 0) statusColor = 'orange'; // Partial custom score
                                            else if (status && status.includes('Error') || pointsEarned === 0 && status !== 'Processing') statusColor = 'red';


                                            return (
                                                <tr key={id || index} style={{ backgroundColor: index % 2 === 0 ? '#fff' : '#f9f9f9' }}>
                                                    <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{id}</td>
                                                    <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{tcMeta?.description || '-'}</td>
                                                    <td style={{ border: '1px solid #ccc', padding: '0.5rem', color: statusColor }}>{status}</td>
                                                    <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>{pointsEarned ?? '-'} / {maxPts ?? '-'}</td>
                                                    <td style={{ border: '1px solid #ccc', padding: '0.5rem' }}>
                                                        {message}
                                                        {details.length > 0 && (
                                                            <div style={{fontSize: '0.8em', whiteSpace: 'pre-wrap', maxHeight: '100px', overflowY: 'auto', backgroundColor: '#f0f0f0', padding: '5px', marginTop: '5px'}}>
                                                                {details.join('\n')}
                                                            </div>
                                                        )}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            )}
                            
                            {!submitting && testCaseResults.length === 0 && !finalResult && (
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
