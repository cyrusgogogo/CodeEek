import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { STAGES, STAGE_LABELS } from '../contracts.mjs';
import { MermaidDiagram, renderDiagramDocument } from './mermaid.jsx';
import css from './style.css';

export { renderDiagramDocument };
export const inject = ['slots', 'uiWorkspace'];
export async function api(method, params = {}, signal) {
  const fetcher = globalThis.__DSH_TRANSPORT__?.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetcher('api/code-reading', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }), ...(signal ? { signal } : {}) });
  const result = await response.json();
  if (!result.ok) throw new Error(`${result.error?.message ?? '阅读模式请求失败'}${result.error?.code ? ` (${result.error.code})` : ''}`);
  return result.value;
}
const uuid = () => crypto.randomUUID();
function BookIcon({ size = 18 }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1m0-15c3-2 7-2 10-1v15c-3-1-7-1-10 1V5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>; }
export function Markdown({ text, openEvidence }) {
  return <div className="cr-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => url.startsWith('evidence://') || /^https?:\/\//.test(url) ? url : ''} components={{
    img: ({ alt }) => <span className="cr-muted">[图片未自动加载：{alt || '外部媒体'}]</span>,
    a: ({ href, children }) => href?.startsWith('evidence://') ? <button className="cr-link" type="button" onClick={() => openEvidence(href.slice(11))}>{children}</button> : href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    code: ({ className, children }) => className === 'language-mermaid' ? <MermaidDiagram source={String(children).trim()} /> : <code className={className}>{children}</code>
  }}>{text}</ReactMarkdown></div>;
}
function Source({ source, close, repositories }) {
  if (!source) return null;
  const evidence = source.evidence; const repo = repositories.find(r => r.id === evidence.repoId);
  return <section className="cr-card cr-source" aria-label="代码证据"><div className="cr-row"><strong>{repo?.name} · {evidence.path}:{evidence.startLine}–{evidence.endLine}</strong><button type="button" onClick={close}>关闭证据</button></div>
    <p className="cr-path">{evidence.repoId} · {evidence.symbol || '未指定符号线索'}<br />读取版本 SHA256：{evidence.hash}</p>
    {source.stale && <div className="cr-banner" role="alert">旧证据已失效或不可读取。以下是当前源码（如可读），不是旧版本的承诺；需要重新取证。{source.reason && ` 原因：${source.reason}`}</div>}
    <pre>{source.lines?.map(line => <div className="cr-source-line" key={line.number}><span>{line.number}</span><code>{line.text}</code></div>)}</pre>
  </section>;
}
function ProjectForm({ workspaces, pickDirectory, onCreate, busy, cancel }) {
  const [title, setTitle] = useState(''); const [repos, setRepos] = useState([{ name: '', path: '' }]);
  const update = (index, field, value) => setRepos(rows => rows.map((r, i) => i === index ? { ...r, [field]: value } : r));
  return <section className="cr-empty cr-card"><h2>新建阅读项目</h2><p className="cr-muted">选择需要联合理解的仓库。绑定后不可随工作区切换而改变；需要新增仓库时新建阅读项目，保留原项目的证据与历史。</p>
    <form className="cr-form" onSubmit={event => { event.preventDefault(); onCreate({ title, repositories: repos }); }}>
      <label>项目名称<input required maxLength={120} value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：订单与支付调用链" /></label>
      {workspaces.length > 0 && <label>从 DSH 工作区添加<select value="" onChange={e => { const ws = workspaces.find(w => w.workspaceId === e.target.value); if (ws) setRepos(rows => [...rows.filter(r => r.path.trim()), { name: ws.title, path: ws.path, workspaceId: ws.workspaceId }]); }}><option value="">选择工作区…</option>{workspaces.map(w => <option key={w.workspaceId} value={w.workspaceId}>{w.title} — {w.path}</option>)}</select></label>}
      {repos.map((repo, index) => <div className="cr-repo" key={index}><input aria-label={`仓库 ${index + 1} 名称`} required maxLength={60} value={repo.name} onChange={e => update(index, 'name', e.target.value)} placeholder="仓库名称" /><input aria-label={`仓库 ${index + 1} 目录`} required value={repo.path} onChange={e => update(index, 'path', e.target.value)} placeholder="本地仓库绝对路径" /><div className="cr-row"><button type="button" onClick={async () => { const p = await pickDirectory(); if (p) { update(index, 'path', p); if (!repo.name) update(index, 'name', p.split(/[\\/]/).filter(Boolean).pop()); } }}>选择目录</button>{repos.length > 1 && <button type="button" onClick={() => setRepos(rows => rows.filter((_, i) => i !== index))}>移除</button>}</div></div>)}
      <div className="cr-row"><button type="button" disabled={repos.length >= 12} onClick={() => setRepos(rows => [...rows, { name: '', path: '' }])}>添加仓库</button><button className="cr-primary" disabled={busy} type="submit">创建并开始阅读</button><button type="button" disabled={busy} onClick={cancel}>取消</button></div>
    </form>
  </section>;
}
export function ReadingPanel({ useWorkspaces, pickDirectory }) {
  const workspaces = useWorkspaces ? useWorkspaces(state => state.items) : [];
  const [listing, setListing] = useState({ projects: [], root: '', diagnostics: [] });
  const [activeId, setActiveId] = useState(() => localStorage.getItem('dsh-code-reading:active') ?? '');
  const [snapshot, setSnapshot] = useState(null); const [creating, setCreating] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [tab, setTab] = useState('lessons'); const [draft, setDraft] = useState(''); const [topic, setTopic] = useState(''); const [source, setSource] = useState(null); const [models, setModels] = useState(null); const [model, setModel] = useState('');
  const [repoId, setRepoId] = useState(''); const [query, setQuery] = useState(''); const [results, setResults] = useState(null); const [waiting, setWaiting] = useState(false); const [olderMessages, setOlderMessages] = useState([]);
  const activeRef = useRef(activeId); activeRef.current = activeId; const snapshotAbort = useRef(null); const waitingBaseline = useRef(-1); const pendingPrompt = useRef(null);
  async function refreshList() { const result = await api('list'); setListing(result); return result; }
  async function refresh(id = activeRef.current) {
    if (!id) return null;
    snapshotAbort.current?.abort(); const controller = new AbortController(); snapshotAbort.current = controller;
    try { const value = await api('snapshot', { sessionId: id }, controller.signal); if (activeRef.current === id) { setSnapshot(value); setModel(value.modelSelection ? `${value.modelSelection.provider}\u0000${value.modelSelection.model}` : ''); if (!value.running && (value.turnEnd?.seq ?? -1) > waitingBaseline.current) { setWaiting(false); if (value.turnEnd?.reason.kind !== 'completed') setNotice(`本轮已结束：${value.turnEnd.reason.kind}。可检查对话留痕后重试。`); } } return value; } catch (e) { if (e.name !== 'AbortError') throw e; return null; }
  }
  async function perform(operation) { setBusy(true); setError(''); try { await operation(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  useEffect(() => {
    let alive = true;
    api('list').then(value => { if (!alive) return; setListing(value); if (activeRef.current && !value.projects.some(p => p.sessions.some(s => s.id === activeRef.current))) setActiveId(''); }).catch(e => { if (alive) setError(e.message); });
    api('models').then(value => { if (alive) setModels(value); }).catch(e => { if (alive) setNotice(`模型目录暂不可用：${e.message}`); });
    return () => { alive = false; snapshotAbort.current?.abort(); };
  }, []);
  useEffect(() => {
    localStorage.setItem('dsh-code-reading:active', activeId); setSnapshot(null); setSource(null); setResults(null); setOlderMessages([]); setWaiting(false); setTopic(''); setDraft(''); setModel(''); pendingPrompt.current = null;
    if (activeId) refresh(activeId).then(value => { if (value && activeRef.current === activeId) { setTopic(value.topic); setRepoId(value.project.repositories[0]?.id ?? ''); } }).catch(e => setError(e.message));
    else snapshotAbort.current?.abort();
  }, [activeId]);
  useEffect(() => {
    if (!activeId || !(snapshot?.running || waiting)) return;
    const timer = setTimeout(() => refresh(activeId).catch(e => { setError(e.message); setWaiting(false); }), 1200);
    return () => clearTimeout(timer);
  }, [activeId, snapshot, waiting]);
  const running = !!snapshot?.running || waiting;
  async function send(text) {
    const id = activeId; if (!snapshot || !text.trim()) return;
    if (!model) throw new Error('尚未确认本会话模型，请先选择模型');
    const [provider, modelId] = model.split('\u0000');
    const request = pendingPrompt.current?.text === text && pendingPrompt.current.sessionId === id && pendingPrompt.current.expectedRevision === snapshot.revision && pendingPrompt.current.expectedModel.provider === provider && pendingPrompt.current.expectedModel.model === modelId ? pendingPrompt.current : { sessionId: id, requestId: uuid(), text, expectedRevision: snapshot.revision, expectedModel: { provider, model: modelId } };
    pendingPrompt.current = request; waitingBaseline.current = snapshot.turnEnd?.seq ?? -1;
    const accepted = await api('prompt', request); pendingPrompt.current = null;
    if (activeRef.current === id) { setWaiting(accepted.replayed ? accepted.running : true); setDraft(''); if (accepted.replayed && !accepted.running) setNotice('此请求已经由 DSH 接纳并处理；保留原结果，不会重复阅读。'); await refresh(id); }
  }
  async function chooseStage(stage, selectedTopic = topic) { const id = activeId; await api('stage', { sessionId: id, expectedRevision: snapshot.revision, stage, topic: selectedTopic }); if (activeRef.current === id) { setTopic(selectedTopic); await refresh(id); } }
  async function openEvidence(evidenceId) { const id = activeId; try { const value = await api('evidence', { sessionId: id, evidenceId }); if (activeRef.current === id) setSource(value); } catch (e) { setError(e.message); } }
  async function readMatch(match) { const id = activeId; const value = await api('read', { sessionId: id, repoId: match.repoId, path: match.path, offset: Math.max(1, (match.line ?? 1) - 8), limit: 100 }); if (activeRef.current === id) { setSource({ ...value, stale: false }); await refresh(id); } }
  async function createProject(request) { const project = await api('create-project', request); const created = await api('create-session', { projectId: project.id }); await refreshList(); setActiveId(created.sessionId); setCreating(false); setTab('lessons'); }
  const latest = snapshot?.state.lessons.at(-1); const topics = [...(snapshot?.state.lessons ?? [])].reverse().find(l => l.topics?.length)?.topics ?? [];
  return <div className="cr-page" data-testid="code-reading-panel"><header className="cr-header"><BookIcon size={24} /><h1>阅读代码</h1><span className="cr-badge">仓库只读</span><span className="cr-badge">多工作区绑定</span><button type="button" disabled={busy} onClick={() => setCreating(true)}>新建阅读项目</button><button type="button" disabled={busy} onClick={() => perform(async () => { await refreshList(); if (activeId) await refresh(); })}>刷新</button></header>
    <div className="cr-body"><aside className="cr-projects" aria-label="阅读项目"><p className="cr-muted">阅读档案独立于当前工作区</p>{listing.projects.map(project => <section className="cr-project" key={project.id}><h3>{project.title}</h3><small>{project.repositories.length} 个仓库</small>{project.sessions.map(session => <button className="cr-session" aria-current={session.id === activeId ? 'true' : undefined} type="button" key={session.id} disabled={busy} onClick={() => { setCreating(false); setActiveId(session.id); }}>{session.topic || STAGE_LABELS[session.stage]}<br /><span className="cr-muted">{new Date(session.createdAt).toLocaleString()}</span></button>)}<button className="cr-session" disabled={busy} type="button" onClick={() => perform(async () => { const value = await api('create-session', { projectId: project.id }); await refreshList(); setCreating(false); setActiveId(value.sessionId); })}>＋ 新阅读会话</button></section>)}<p className="cr-muted">固定产物目录</p><p className="cr-path">{listing.root}</p></aside>
      <main className="cr-content">{error && <div className="cr-banner cr-error" role="alert">{error}</div>}{notice && <div className="cr-banner" role="status">{notice}<button type="button" onClick={() => setNotice('')}>关闭</button></div>}{listing.diagnostics.map((d, i) => <div className="cr-banner cr-error" key={i}>档案加载诊断：{d}</div>)}
        {creating ? <ProjectForm workspaces={workspaces ?? []} pickDirectory={async () => { try { return await pickDirectory(); } catch (e) { setError(e.message); return null; } }} onCreate={request => perform(() => createProject(request))} busy={busy} cancel={() => setCreating(false)} /> : !activeId ? <section className="cr-empty"><h2>从业务开始，逐步看懂代码</h2><p>选择一个或多个仓库，建立有证据的阅读项目。无需修改仓库，切换普通 DSH 工作区不会改变当前阅读目标。</p><div className="cr-grid">{STAGES.map((s, i) => <div className="cr-card" key={s}><strong>{i + 1}. {STAGE_LABELS[s]}</strong></div>)}</div><button className="cr-primary" type="button" onClick={() => setCreating(true)}>创建第一个阅读项目</button><p className="cr-muted">笔记、Mermaid 源码、代码访问审计和对话记录保存在统一阅读目录。每轮一个知识点，你决定下一步。</p></section> : !snapshot ? <p role="status">正在加载阅读档案…</p> : <>
          <h2>{snapshot.project.title}</h2><div className="cr-row">{snapshot.project.repositories.map(repo => <span className="cr-badge" title={`${repo.id}\n${repo.root}`} key={repo.id}>{repo.name}</span>)}</div><p className="cr-muted">绑定不随工作区切换 · {running ? '导师正在阅读…' : '等待你决定下一步'} · 状态版本 {snapshot.revision}</p>
          {snapshot.archiveError && <div className="cr-banner cr-error" role="alert">归档失败：{snapshot.archiveError}。DSH 原会话仍是恢复来源；点击刷新重试，未完成归档时不要宣称已留痕。</div>}
          <nav className="cr-stages" aria-label="阅读阶段">{STAGES.map((stage, i) => <button key={stage} type="button" disabled={busy || running} aria-current={snapshot.stage === stage ? 'step' : undefined} onClick={() => perform(() => chooseStage(stage))}>{i + 1}. {STAGE_LABELS[stage]}</button>)}</nav>
          <div className="cr-row"><input aria-label="当前阅读主题" value={topic} onChange={e => setTopic(e.target.value)} placeholder="当前业务主题，可随时切换" maxLength={300} disabled={running} /><button type="button" disabled={busy || running} onClick={() => perform(() => chooseStage(snapshot.stage))}>应用主题</button><button type="button" disabled={busy} onClick={() => perform(async () => { const exported = await api('export', { sessionId: activeId }); setNotice(`阅读档案已导出到：${exported.path}`); })}>导出档案</button></div>
          <div className="cr-tabs" role="tablist">{[['lessons', '知识点'], ['evidence', '代码与证据'], ['messages', '对话留痕'], ['archive', '产物与规则']].map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}</div>
          <Source source={source} close={() => setSource(null)} repositories={snapshot.project.repositories} />
          {tab === 'lessons' && <>{topics.length > 0 && <section className="cr-card"><h3>选择业务主题</h3>{topics.map((item, i) => <button className="cr-question" key={i} disabled={busy || running} type="button" onClick={() => perform(() => chooseStage('business', item.title))}><strong>{item.title}</strong> — {item.description}</button>)}</section>}{snapshot.state.lessons.length === 0 && <div className="cr-card"><h3>准备就绪</h3><p>点击“开始本阶段阅读”。导师会先有限检索真实代码，展示可选业务主题，不会一次输出全部分析。</p></div>}{[...snapshot.state.lessons].reverse().map(lesson => <article className="cr-lesson" key={lesson.id}><span className="cr-muted">{STAGE_LABELS[lesson.stage]} · {lesson.topic || '发现业务'} · {new Date(lesson.createdAt).toLocaleString()}</span><h2>{lesson.title}</h2><Markdown text={lesson.markdown} openEvidence={openEvidence} />{lesson.mermaid && !lesson.markdown.includes('```mermaid') && <MermaidDiagram source={lesson.mermaid} />}<div className="cr-conclusion"><strong>本轮核心结论</strong><p>{lesson.conclusion}</p></div><details><summary>代码事实、推导与假设</summary>{lesson.claims.map((claim, i) => <div className="cr-claim" key={i}><strong>{{ fact: '代码事实', inference: '代码推导', hypothesis: '待验证假设' }[claim.kind]}</strong>{claim.text}<div className="cr-row">{claim.evidenceIds.map(id => <button type="button" key={id} onClick={() => openEvidence(id)}>{snapshot.state.evidence.find(e => e.id === id)?.path ?? id}</button>)}</div></div>)}</details>{lesson === latest && lesson.nextQuestions.map((question, i) => <button key={i} className="cr-question" disabled={busy || running} type="button" onClick={() => perform(() => send(question))}>深入：{question}</button>)}</article>)}</>}
          {tab === 'evidence' && <section><div className="cr-row"><select aria-label="检索仓库" value={repoId} onChange={e => setRepoId(e.target.value)}>{snapshot.project.repositories.map(r => <option value={r.id} key={r.id}>{r.name}</option>)}</select><input aria-label="检索内容或路径" value={query} onChange={e => setQuery(e.target.value)} placeholder="字面量内容 / 路径子串" /><button type="button" disabled={busy} onClick={() => perform(async () => { const id = activeId; const value = await api('search', { sessionId: id, repoId, query }); if (activeRef.current === id) setResults(value); })}>搜索内容</button><button type="button" disabled={busy} onClick={() => perform(async () => { const id = activeId; const value = await api('files', { sessionId: id, repoId, filter: query }); if (activeRef.current === id) setResults(value); })}>浏览文件</button></div>{results && <div className="cr-card">{results.truncated && <p className="cr-muted">结果或扫描范围已截断，请缩小检索范围。</p>}{(results.matches ?? results.paths.map(p => ({ path: p, repoId: results.repoId }))).map((match, i) => <button className="cr-evidence" key={i} type="button" onClick={() => perform(() => readMatch(match))}>{match.path}{match.line && `:${match.line}`} {match.text && `— ${match.text}`}</button>)}</div>}<h3>本会话证据 · {snapshot.state.evidence.length}</h3><p className="cr-muted">打开时重新核验 SHA256；旧行号不静默绑定到新源码。符号是文本线索，不是 AST 解析结论。</p>{[...snapshot.state.evidence].reverse().map(evidence => <button className="cr-evidence" type="button" key={evidence.id} onClick={() => openEvidence(evidence.id)}>{snapshot.project.repositories.find(r => r.id === evidence.repoId)?.name} · {evidence.path}:{evidence.startLine}–{evidence.endLine} {evidence.symbol}<br /><span className="cr-muted">SHA256 {evidence.hash.slice(0, 16)}…</span></button>)}</section>}
          {tab === 'messages' && <section>{snapshot.hasMoreMessages && <button type="button" onClick={() => perform(async () => { const first = (olderMessages.length ? olderMessages : snapshot.messages)[0]?.seq; const value = await api('snapshot', { sessionId: activeId, beforeSeq: first }); setOlderMessages(messages => [...value.messages, ...messages]); })}>加载更早对话</button>}{[...olderMessages, ...snapshot.messages].map(message => <article className="cr-message" key={message.seq}><header>{message.role === 'user' ? '你' : '阅读导师'} · {new Date(message.time).toLocaleString()} · DSH 序号 {message.seq}</header><Markdown text={message.text} openEvidence={openEvidence} /></article>)}</section>}
          {tab === 'archive' && <section className="cr-card"><h3>固定产物目录</h3><p className="cr-path">{snapshot.outputDirectory}</p><ul><li>state.json：阶段、主题、绑定版本、证据和知识点索引</li><li>audit.jsonl：文件访问位置、行范围与哈希（不保存源码全文或搜索词）</li><li>notes/：每轮知识点 Markdown</li><li>diagrams/：Mermaid 原文</li><li>messages/：用户与导师的最终文本，按 DSH 事件序号留痕</li><li>exports/reading.md：汇总阅读档案</li></ul><p>源码只通过只读文件句柄访问。阅读模型不能调用 shell、写入、网络、代理或插件转调。模式不会执行项目，也不改变目标仓库；不支持链接、UNC、非 UTF-8、大于 1 MiB 的文件。</p><p>读取审计不含源码，但 DSH 工具结果、解释和笔记可能包含代码片段。使用远程模型时阅读内容会发送给所选模型提供方。固定目录不是加密保险库，也不是跨仓原子快照。</p></section>}
          <section className="cr-composer"><label htmlFor="cr-question">提出一个问题，或先回答导师的验证场景</label><textarea id="cr-question" value={draft} onChange={e => setDraft(e.target.value)} maxLength={16000} placeholder="例如：这个订单在支付失败后如何恢复？" disabled={running} /><div className="cr-row"><button className="cr-primary" type="button" disabled={busy || running || !model} onClick={() => perform(() => send(draft.trim() || `请开始“${STAGE_LABELS[snapshot.stage]}”阶段，围绕当前主题只讲一个知识点。先取证，再归档，之后等待我决定。`))}>{draft.trim() ? '发送问题' : '开始本阶段阅读'}</button>{running && <button type="button" onClick={() => perform(async () => { await api('cancel', { sessionId: activeId }); setWaiting(false); await refresh(); })}>停止阅读</button>}<select aria-label="阅读模型" value={model} disabled={busy || running} onChange={e => { const selected = e.target.value; if (!selected) return; const [provider, modelId] = selected.split('\u0000'); perform(async () => { await api('select-model', { sessionId: activeId, provider, model: modelId }); await refresh(); }); }}><option value="">选择模型</option>{model && !models?.groups.some(group => group.models.some(item => `${group.id}\u0000${item.id}` === model)) && <option value={model}>{model.replace('\u0000', ' / ')}（当前会话）</option>}{models?.groups.flatMap(group => group.models.map(item => <option key={`${group.id}/${item.id}`} value={`${group.id}\u0000${item.id}`}>{group.name} · {item.name}</option>))}</select></div><p className="cr-muted">每轮一个知识点 · 阶段不会自动推进 · 内容通过已选择的 DSH 模型生成</p></section>
        </>}
      </main></div>
  </div>;
}
export function apply(ctx) {
  ctx.effect(() => { const style = document.createElement('style'); style.dataset.plugin = 'dsh-code-reading'; style.textContent = css; document.head.appendChild(style); return () => style.remove(); }, 'code-reading: styles');
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'code-reading', order: 10, label: '阅读代码' }, BookIcon));
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'code-reading', inject: () => ({ pickDirectory: () => ctx.uiWorkspace.pickDirectory() }) }, ReadingPanel));
}
