import React, { useEffect, useRef, useState } from 'react';
import { api, ReadingApiError } from './api.mjs';
import { ReadingDialog } from './workbench.jsx';
import { ModelSelect } from './model-select.jsx';
import { MermaidDiagram } from './mermaid.jsx';
import { UiIcon } from './icons/ui-icons.jsx';
import { MindMap } from './mind-map.jsx';

const statuses = { running: '正在生成', completed: '已完成', failed: '生成失败', cancelled: '已停止' };
const identity = project => project ? JSON.stringify([project.id, project.bindingRevision, project.repositories.map(repo => [repo.id, repo.root])]) : '';
const modelValid = model => model && typeof model.provider === 'string' && !!model.provider && typeof model.model === 'string' && !!model.model;
function validateMap(value, projectId) {
  const latest = value?.latest; const task = value?.task; const changes = value?.changes;
  const valid = value?.projectId === projectId && Number.isSafeInteger(value.revision) && value.revision >= 0
    && (latest === null || latest && ['sessionId', 'lessonId', 'generatedAt', 'title', 'markdown', 'conclusion'].every(key => typeof latest[key] === 'string') && modelValid(latest.model) && typeof latest.truncated === 'boolean' && (latest.mermaid === undefined || typeof latest.mermaid === 'string'))
    && (task === null || task && typeof task.requestId === 'string' && typeof task.sessionId === 'string' && Object.hasOwn(statuses, task.status) && ['initial', 'incremental'].includes(task.mode) && typeof task.startedAt === 'string' && modelValid(task.model))
    && (changes === null || changes && typeof changes.checkedAt === 'string' && typeof changes.fingerprint === 'string' && typeof changes.changed === 'boolean' && typeof changes.truncated === 'boolean' && ['added', 'modified', 'deleted', 'uncertain'].every(key => Array.isArray(changes[key]) && changes[key].every(row => typeof row.repoId === 'string' && typeof row.path === 'string')));
  if (!valid) throw new ReadingApiError('PROTOCOL_ERROR', 'AI 代码地图状态无效，请先核对状态；不会自动重发生成请求');
  return value;
}
const formatTime = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '时间未提供';
const errorText = value => typeof value === 'string' ? value : value?.message || '本次任务没有成功完成。';

// Independent from reading-session polling and consent. Every render transition
// creates a new object token (including A → B → A); late results cannot regain it.
// Only confirmed button actions send mutations. Timers and focus only read/check.
export function useCodeMap({ project, sessionId, enabled, pageRef, allowOnboarding, onOnboard, onSettled }) {
  const [record, setRecord] = useState(null); const [activity, setActivity] = useState(null); const [issue, setIssue] = useState(null); const [confirmation, setConfirmation] = useState(null);
  const alive = useRef(false); const scope = useRef(null); const readRequest = useRef({ seq: 0, controller: null }); const writeRequest = useRef(null); const currentData = useRef(null); const currentIssue = useRef(null); const dismissed = useRef(new Set());
  const callbacks = useRef(null); callbacks.current = { onOnboard, onSettled };
  const key = JSON.stringify([identity(project), sessionId]);
  if (!scope.current || scope.current.key !== key || scope.current.enabled !== enabled) scope.current = { key, enabled, projectId: project?.id };
  const token = scope.current;
  const data = record?.token === token ? record.value : null;
  const operation = activity?.token === token ? activity.kind : '';
  const problem = issue?.token === token ? issue : null;
  const dialog = confirmation?.token === token ? confirmation : null;
  const valid = () => alive.current && scope.current === token && token.enabled;
  const visible = () => document.visibilityState !== 'hidden' && !!pageRef.current?.getClientRects().length;
  const invalidateRead = () => { readRequest.current.controller?.abort(); readRequest.current.seq++; };
  function report(message, uncertain = false) { const next = { token, message, uncertain }; currentIssue.current = next; setIssue(next); }
  function accept(value) {
    const old = currentData.current?.token === token ? currentData.current.value : null;
    currentData.current = { token, value }; setRecord({ token, value }); currentIssue.current = null; setIssue(null);
    if (old?.task?.status === 'running' && value.task?.status !== 'running') callbacks.current.onSettled?.();
  }
  async function read(method = 'code-map') {
    if (!valid() || !visible() || writeRequest.current?.token === token) return null;
    invalidateRead(); const controller = new AbortController(); const seq = readRequest.current.seq; readRequest.current.controller = controller;
    const current = () => valid() && !controller.signal.aborted && readRequest.current.seq === seq;
    setActivity({ token, kind: method });
    try {
      const value = validateMap(await api(method, { projectId: token.projectId }, controller.signal), token.projectId);
      if (!current()) return null;
      accept(value); return value;
    } catch (e) { if (current()) report(e.message, currentIssue.current?.token === token && currentIssue.current.uncertain); return null; }
    finally { if (current()) setActivity(null); }
  }
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; invalidateRead(); writeRequest.current?.controller.abort(); };
  }, []);
  useEffect(() => {
    invalidateRead(); writeRequest.current?.controller.abort(); writeRequest.current = null; currentIssue.current = null;
    setActivity(null); setConfirmation(null);
    if (!token.enabled) return;
    const check = () => {
      if (!valid() || !visible() || writeRequest.current?.token === token || currentIssue.current?.token === token && currentIssue.current.uncertain) return;
      void read('code-map-check');
    };
    // Load the independent map first. A late load can never chain a check or write
    // after a project switch, cancellation, or a newer read/mutation.
    const initial = async () => { const value = await read(); if (value && valid() && visible() && !writeRequest.current && !currentIssue.current) check(); };
    void initial(); const timer = setInterval(check, 30000);
    window.addEventListener('focus', check); document.addEventListener('visibilitychange', check);
    let wasVisible = visible();
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => { const shown = entries.some(entry => entry.isIntersecting); if (shown && !wasVisible) check(); wasVisible = shown; }) : null;
    if (pageRef.current) observer?.observe(pageRef.current);
    return () => { clearInterval(timer); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); observer?.disconnect(); invalidateRead(); writeRequest.current?.controller.abort(); };
  }, [token]);
  useEffect(() => {
    if (!valid() || !allowOnboarding || !visible() || !project?.codeMapOnboarding || !data || data.latest || data.task || dismissed.current.has(project.id) || dialog) return;
    dismissed.current.add(project.id); callbacks.current.onOnboard?.(); setConfirmation({ token, revision: data.revision });
  }, [token, data, allowOnboarding]);
  useEffect(() => {
    if (dialog && (data?.revision !== dialog.revision || data?.task?.status === 'running')) setConfirmation(null);
  }, [dialog, data]);
  useEffect(() => {
    if (!data || data.task?.status !== 'running' || problem || operation || !token.enabled) return;
    const timer = setTimeout(() => { if (valid() && visible()) void read(); }, 1200);
    return () => clearTimeout(timer);
  }, [token, data, operation, problem]);
  function dismiss() { if (project) dismissed.current.add(project.id); setConfirmation(null); }
  function request() {
    if (!valid() || !data || writeRequest.current || problem?.uncertain || data.task?.status === 'running') return;
    dismissed.current.add(project.id); setConfirmation({ token, revision: data.revision });
  }
  async function generate(model) {
    const approval = confirmation;
    if (!approval || approval.token !== token || !valid() || !visible() || !modelValid(model) || writeRequest.current || currentIssue.current?.uncertain || currentData.current?.token !== token || currentData.current.value.revision !== approval.revision || currentData.current.value.task?.status === 'running') return;
    setConfirmation(null); invalidateRead(); const controller = new AbortController();
    const request = { token, controller, requestId: crypto.randomUUID(), kind: 'generate' }; writeRequest.current = request; setActivity({ token, kind: 'generate' }); currentIssue.current = null; setIssue(null);
    const current = () => valid() && writeRequest.current === request && !controller.signal.aborted;
    try {
      const value = validateMap(await api('code-map-generate', { projectId: token.projectId, expectedRevision: approval.revision, requestId: request.requestId, model, consent: true }, controller.signal), token.projectId);
      if (!current()) return;
      accept(value); callbacks.current.onSettled?.();
    } catch (e) { if (current()) report(`${e.message}。旧地图保留；请先核对地图任务状态，再明确选择是否重试。`, true); }
    finally { if (current()) { writeRequest.current = null; setActivity(null); } }
  }
  async function cancel() {
    if (!valid() || problem?.uncertain || writeRequest.current?.kind === 'cancel') return;
    const requestId = writeRequest.current?.token === token ? writeRequest.current.requestId : data?.task?.status === 'running' ? data.task.requestId : null;
    if (!requestId) return;
    invalidateRead(); writeRequest.current?.controller.abort(); const controller = new AbortController();
    const request = { token, controller, requestId, kind: 'cancel' }; writeRequest.current = request; setActivity({ token, kind: 'cancel' }); setConfirmation(null);
    const current = () => valid() && writeRequest.current === request && !controller.signal.aborted;
    try {
      const value = validateMap(await api('code-map-cancel', { projectId: token.projectId, requestId }, controller.signal), token.projectId);
      if (!current()) return;
      accept(value); callbacks.current.onSettled?.();
    } catch (e) { if (current()) report(`${e.message}。停止结果尚未确认，请先核对地图任务状态。`, true); }
    finally { if (current()) { writeRequest.current = null; setActivity(null); } }
  }
  return { data, operation, problem, dialog, request, dismiss, generate, cancel, reload: () => read(), check: () => read('code-map-check') };
}

export function CodeMapConsent({ map, project, models, modelsState, refreshModels }) {
  const [model, setModel] = useState('');
  const available = models?.groups.some(group => group.models.length);
  const incremental = !!map.data?.latest;
  return <ReadingDialog title={incremental ? '确认增量更新代码地图' : '选择模型并生成代码地图'} className="cr-consent-dialog cr-code-map-consent" onClose={map.dismiss}>
    <p>{incremental ? '根据检测到的本地变化更新地图，成功前保留当前地图。' : '无需填写问题。确认后，AI 将阅读绑定仓库中的必要源码，生成整体业务、主要模块和阅读入口的代码地图。'}</p>
    <label className="cr-code-map-model-label">本次地图使用的模型</label>
    <ModelSelect value={model} groups={models?.groups} loading={modelsState === 'loading'} disabled={modelsState === 'loading'} onValueChange={setModel} label="代码地图模型" hintId="cr-code-map-model-hint" />
    <p id="cr-code-map-model-hint" className="cr-muted">仅用于本次地图任务，不修改 DSH 全局模型或默认阅读模型。{modelsState === 'loading' ? '正在加载模型目录。' : modelsState === 'error' ? '模型目录加载失败，请重新加载。' : !available ? '暂无可用模型，请先在 DSH 模型设置中配置提供方。' : ''}</p>
    {(modelsState === 'error' || !available) && <button type="button" disabled={modelsState === 'loading'} onClick={() => void refreshModels().catch(() => {})}>重新加载地图模型</button>}
    <dl className="cr-consent-summary"><div><dt>源码发送范围</dt><dd><strong>{incremental ? '变更文件与必要的关联上下文' : '绑定仓库中的必要源码与目录结构'}</strong><small>由模型按任务有界读取，不代表完整扫描或全部方法覆盖。</small></dd></div></dl>
    <ul className="cr-code-map-repositories">{project.repositories.map(repo => <li key={repo.id}><strong>{repo.name}</strong><small className="cr-path">{repo.root}</small></li>)}</ul>
    <p className="cr-muted">所选模型服务可能接收读到的源码、路径、已有地图与阅读上下文。接收端点与部署位置以该提供方的 DSH 配置为准，不能仅凭模型名称判断是否本地。只读源码，不执行被阅读项目。</p>
    <div className="cr-row"><button type="button" onClick={map.dismiss}>{incremental ? '暂不更新' : '暂不生成'}</button><button type="button" className="cr-primary" disabled={!model || modelsState !== 'ready'} onClick={() => { const [provider, selected] = model.split('\u0000'); void map.generate({ provider, model: selected }); }}>{incremental ? '允许并更新地图' : '确认并生成地图'}</button></div>
  </ReadingDialog>;
}

export function CodeMapOverview({ map, Markdown, onOpenReading, onOpenEvidence }) {
  const { data, operation, problem } = map; const latest = data?.latest; const task = data?.task; const changes = data?.changes;
  const [showDiagram, setShowDiagram] = useState(false);
  const running = task?.status === 'running' || operation === 'generate'; const busy = !!operation;
  const incomplete = !!(changes?.truncated || changes?.uncertain.length);
  const changeCount = changes ? changes.added.length + changes.modified.length + changes.deleted.length : 0;
  return <section className="cr-code-map" aria-label="AI 代码地图" data-map-task-status={task?.status ?? 'empty'}>
    <header className="cr-code-map-heading"><div><p className="cr-map-eyebrow"><UiIcon name="folder-tree" size={14} /> 项目全貌</p><h2>{latest?.title || '先看全貌，再深入源码'}</h2></div><div className="cr-map-primary-actions">
      {task && <span className="cr-map-task-state" role="status">{operation === 'generate' ? '正在提交地图任务' : operation === 'cancel' ? '正在停止' : statuses[task.status]}</span>}
      {!running && <button type="button" className={latest ? '' : 'cr-primary'} disabled={!data || busy || problem?.uncertain} onClick={map.request}>{task?.status === 'failed' || task?.status === 'cancelled' ? '重试代码地图' : latest ? '选择模型更新地图' : '生成 AI 代码地图'}</button>}
      {running && <button type="button" disabled={operation === 'cancel' || problem?.uncertain} onClick={() => void map.cancel()}>停止地图任务</button>}
    </div></header>
    {problem && <p role="alert" className="cr-map-warning cr-error">{problem.message}</p>}
    {task?.status === 'failed' && <p role="alert" className="cr-map-warning cr-error">地图生成失败：{errorText(task.error)} {latest ? '上一版地图仍保留。' : '尚无成功生成的地图。'}重试需要重新确认模型和源码范围。</p>}
    {running && <p role="status" className="cr-map-meta">{latest ? '正在增量更新，成功后才替换当前地图。' : '正在生成首份地图，可继续浏览源码。'}</p>}
    {!latest && <div className="cr-code-map-empty"><UiIcon name="folder-tree" size={36} /><h3>把项目展开成一张地图</h3><p>先看入口与模块，再点开你关心的分支。<br />选择模型并确认源码范围后生成，也可以切换到路径导航直接浏览。</p></div>}
    {latest && <article className="cr-code-map-article" data-map-lesson-id={latest.lessonId}>
      <MindMap key={latest.lessonId} title={latest.title} markdown={latest.markdown} conclusion={latest.conclusion} Markdown={Markdown} openEvidence={id => onOpenEvidence(latest.sessionId, id)} />
      {latest.mermaid && !latest.markdown.includes('```mermaid') && <details className="cr-map-supplement" onToggle={event => setShowDiagram(event.currentTarget.open)}><summary>查看原始关系图</summary>{showDiagram && <MermaidDiagram source={latest.mermaid} />}</details>}
    </article>}
    <footer className="cr-map-statusline" aria-label="地图范围与状态">
      <span role="status">{changes?.changed ? `发现本地变化 · ${changeCount} 个路径，未自动更新地图` : incomplete ? '检测不完整，存在待复核路径；未自动更新地图' : latest ? 'AI 整理 · 结论请结合源码证据核对' : '只读源码 · 生成前确认'}</span>
      {incomplete && changes?.changed && <span>检测不完整 · 仍有待复核范围</span>}
      {latest?.truncated && <span title="此地图基于部分扫描与有界取证，不代表完整仓库或全部调用关系。">部分扫描</span>}
    </footer>
    <details className="cr-map-maintenance" open={problem?.uncertain || undefined}><summary>地图管理<span>{latest ? `更新于 ${formatTime(latest.generatedAt)}` : '任务状态与本地检测'}</span></summary>
      <div className="cr-map-actions">
        <button type="button" disabled={busy} onClick={() => void map.reload()}>核对地图任务状态</button>
        <button type="button" disabled={busy || problem?.uncertain} onClick={() => void map.check()}>检测本地变化</button>
        {latest && <button type="button" onClick={() => onOpenReading(latest.sessionId, latest.lessonId)}>打开地图对应阅读</button>}
      </div>
      {operation === 'code-map' && <p role="status" className="cr-map-meta">正在核对地图状态，不会请求模型…</p>}
      {operation === 'code-map-check' && <p role="status" className="cr-map-meta">正在检测本地文件变化，不会请求模型…</p>}
      {task && <p className="cr-map-meta">{task.mode === 'incremental' ? '增量任务' : '首次任务'} · {formatTime(task.startedAt)} · {task.model.provider} / {task.model.model}</p>}
      {latest?.truncated && <p className="cr-map-meta">此地图基于部分扫描与有界取证，不代表完整仓库或全部调用关系。</p>}
      {changes && <section className="cr-code-map-changes" aria-label="本地变化检测"><p className="cr-map-meta">最近检测：{formatTime(changes.checkedAt)} · 页面可见时每 30 秒及重新聚焦自动检测，不调用模型。</p>{changes.changed || incomplete ? <><p>新增 {changes.added.length} · 修改 {changes.modified.length} · 删除 {changes.deleted.length} · 待核对 {changes.uncertain.length}</p><details><summary>查看变化路径</summary><ul>{[['added', '新增'], ['modified', '修改'], ['deleted', '删除'], ['uncertain', '待核对']].flatMap(([key, title]) => changes[key].slice(0, 40).map((row, index) => <li key={`${key}:${row.repoId}:${index}`}><span>{title}</span><code>{row.path}</code></li>))}</ul>{['added', 'modified', 'deleted', 'uncertain'].some(key => changes[key].length > 40) && <p>每类仅显示前 40 条，请结合对应阅读核对。</p>}</details></> : <p className="cr-map-meta">{latest ? '已扫描范围内未发现新的文件变化。' : '已完成本地检查；尚无已发布地图作为对照。'}</p>}{changes.truncated && <p className="cr-map-meta">本地变化检测为部分扫描，结果不完整；未列出的文件不代表未变化。</p>}</section>}
    </details>
  </section>;
}
