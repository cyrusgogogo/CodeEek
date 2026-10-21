import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MermaidDiagram, renderDiagramDocument } from './mermaid.jsx';
import { api, validateHostStatus, ReadingApiError } from './api.mjs';
import { turnEndNotice } from './turn-status.mjs';
import { InstallationHelp } from './setup.jsx';
import { ReadingSettings } from './settings.jsx';
import { SourceConsent } from './consent.jsx';
import { CodeFence } from './code.jsx';
import { FileWorkspace, FileRail, FileViewer, DocumentTabs } from './reader.jsx';
import { topicTitle, ReadingRoute, LessonArticle, ReadingDialog, Transcript } from './workbench.jsx';
import { UiIcon } from './icons/ui-icons.jsx';
import { ModelSelect } from './model-select.jsx';
import { StructureMap } from './structure-map.jsx';
import { mapProjectKey, readerDocumentKind } from './structure-map-state.mjs';
import structureMapCss from './structure-map.css';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from './ui/select.jsx';
import baseCss from './style.css';
import workbenchCss from './workbench.css';
import selectCss from './ui/select.css';
import ideCss from './ide.css';
import codeReadingsCss from './code-readings.css';
const css = baseCss + '\n' + workbenchCss + '\n' + selectCss + '\n' + ideCss + '\n' + codeReadingsCss + '\n' + structureMapCss;

export { renderDiagramDocument, api };
export const inject = ['slots', 'uiWorkspace'];
const uuid = () => crypto.randomUUID();
function BookIcon({ size = 18 }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1m0-15c3-2 7-2 10-1v15c-3-1-7-1-10 1V5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>; }
function MarkdownPre({ children }) {
  const element = React.Children.toArray(children).find(React.isValidElement);
  const language = /(?:^|\s)language-([^\s]+)/i.exec(element?.props.className ?? '')?.[1]?.toLowerCase();
  if (language === 'mermaid') return <MermaidDiagram source={String(element.props.children).trim()} />;
  return <CodeFence>{children}</CodeFence>;
}
export function Markdown({ text, openEvidence }) {
  return <div className="cr-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => url.startsWith('evidence://') || /^https?:\/\//.test(url) ? url : ''} components={{
    img: ({ alt }) => <span className="cr-muted">[图片未自动加载：{alt || '外部媒体'}]</span>,
    a: ({ href, children }) => href?.startsWith('evidence://') ? <button className="cr-link" type="button" onClick={() => openEvidence(href.slice(11))}>{children}</button> : href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    pre: MarkdownPre
  }}>{text}</ReactMarkdown></div>;
}
function ProjectForm({ workspaces, pickDirectory, onCreate, busy, cancel }) {
  const [repos, setRepos] = useState([{ path: '' }]);
  const update = (index, value) => setRepos(rows => rows.map((repo, i) => i === index ? { ...repo, path: value } : repo));
  return <section className="cr-empty cr-card cr-open-repository">
    <span className="cr-start-symbol"><UiIcon name="folder-tree" size={24} /></span>
    <h2>打开本地仓库</h2><p className="cr-muted">选择目录就可以开始，自动使用仓库名称。源码始终只读。</p>
    <form className="cr-form" onSubmit={event => { event.preventDefault(); onCreate({ repositories: repos }); }}>
      {workspaces.length > 0 && <label>从 DSH 工作区添加<select value="" onChange={event => { const ws = workspaces.find(item => item.workspaceId === event.target.value); if (ws) setRepos(rows => [...rows.filter(repo => repo.path.trim()), { path: ws.path, workspaceId: ws.workspaceId }]); }}><option value="">选择工作区…</option>{workspaces.map(ws => <option key={ws.workspaceId} value={ws.workspaceId}>{ws.title} — {ws.path}</option>)}</select></label>}
      {repos.map((repo, index) => <div className="cr-repo" key={index}><input aria-label={`仓库 ${index + 1} 目录`} required value={repo.path} onChange={event => update(index, event.target.value)} placeholder="本地仓库绝对路径" /><div className="cr-row"><button type="button" onClick={async () => { const path = await pickDirectory(); if (path) update(index, path); }}>选择目录</button>{repos.length > 1 && <button type="button" aria-label={`移除仓库 ${index + 1}`} onClick={() => setRepos(rows => rows.filter((_, i) => i !== index))}>移除</button>}</div></div>)}
      <div className="cr-row"><button type="button" disabled={repos.length >= 12} onClick={() => setRepos(rows => [...rows, { path: '' }])}>添加仓库</button><button className="cr-primary" disabled={busy} type="submit">打开仓库</button><button type="button" disabled={busy} onClick={cancel}>取消</button></div>
      <p className="cr-form-note">打开仓库不会调用模型；发送阅读问题前会请你确认源码范围。</p>
    </form>
  </section>;
}
function savedSession() { try { return localStorage.getItem('dsh-code-reading:active') ?? ''; } catch { return ''; } }
function checkedModels(value) {
  if (!value || !Array.isArray(value.groups) || value.groups.some(group => typeof group.id !== 'string' || !Array.isArray(group.models) || group.models.some(model => typeof model.id !== 'string'))) throw new ReadingApiError('PROTOCOL_ERROR', '模型目录格式不正确，请在 DSH 设置中检查模型配置后重试');
  return value;
}
const emptyReaderState = () => ({ version: 1, revision: 0, activeDocument: null, selectedLessonId: null, viewedLessonIds: [], understoodLessonIds: [], readerPosition: null, lessonScrollTop: 0 });
function positionMetadata(position) {
  if (!position?.repoId || !position?.path) return null;
  return { repoId: position.repoId, path: position.path, hash: position.hash ?? null, offset: position.offset ?? 1, scrollTop: position.scrollTop ?? 0, scrollLeft: position.scrollLeft ?? 0 };
}
export function ReadingPanel({ useWorkspaces, pickDirectory }) {
  const workspaces = useWorkspaces ? useWorkspaces(state => state.items) : [];
  const [listing, setListing] = useState({ projects: [], root: '', diagnostics: [] });
  const [activeId, setActiveId] = useState(savedSession);
  const [loadedSnapshot, setSnapshot] = useState(null); const snapshot = loadedSnapshot?.sessionId === activeId ? loadedSnapshot : null;
  const [creating, setCreating] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState(''); const [entryMode, setEntryMode] = useState('question'); const [activeDocument, setActiveDocument] = useState('empty'); const [readingDocuments, setReadingDocuments] = useState([]); const [composerOpen, setComposerOpen] = useState(false); const [models, setModels] = useState(null); const [model, setModel] = useState('');
  const [repoId, setRepoId] = useState(''); const [waiting, setWaiting] = useState(false); const [accepting, setAccepting] = useState(false); const [cancelPending, setCancelPending] = useState(false); const [history, setHistory] = useState({ sessionId: '', epoch: -1, rows: [] });
  const [connection, setConnection] = useState({ state: 'loading', status: null, error: null }); const [listState, setListState] = useState('loading'); const [snapshotState, setSnapshotState] = useState('idle'); const [modelsState, setModelsState] = useState('loading');
  const [projectOpen, setProjectOpen] = useState(false); const [removingProject, setRemovingProject] = useState(null); const pendingProjectDialog = useRef(false);
  const [dialog, setDialog] = useState(''); const [menuOpen, setMenuOpen] = useState(false); const [routeOpen, setRouteOpen] = useState(true); const [sessionFilter, setSessionFilter] = useState('active'); const [viewStage, setViewStage] = useState('discover'); const [selectedId, setSelectedId] = useState(null);
  const [viewed, setViewed] = useState([]); const [understood, setUnderstood] = useState([]); const [questionSelection, setQuestionSelection] = useState(null); const [returnPoint, setReturnPoint] = useState(null); const [confirmation, setConfirmation] = useState(null); const [lastFailed, setLastFailed] = useState(null);
  const activeRef = useRef(activeId); activeRef.current = activeId; const viewEpoch = useRef(0); const initializedView = useRef(null); const pendingOperations = useRef(0); const snapshotAbort = useRef(null); const setupAbort = useRef(null); const mounted = useRef(true); const waitingBaseline = useRef(-1); const pendingPrompt = useRef(null);
  const reader = useRef(null); const restorePending = useRef(null); const content = useRef(null); const readerStates = useRef(new Map()); const saveChains = useRef(new Map()); const consent = useRef(null); const navigation = useRef(0); const followResult = useRef(null); const lastAttempt = useRef(null); const submitting = useRef(null); const evidenceSequence = useRef(0); const listSequence = useRef(0); const cancelAcknowledged = useRef(false);
  const draftSessions = useRef(new Set()); const sessionFilters = useRef(null);
  const [mapTabs, setMapTabs] = useState([]); const [mapReturn, setMapReturn] = useState('');
  const mapViews = useRef(new Map()); const mapOrigins = useRef(new Map()); const nonMapPositions = useRef(new Map());
  const selectedLesson = snapshot?.state.lessons.find(lesson => lesson.id === selectedId) ?? null;
  const archived = !!snapshot?.archivedAt;
  const olderMessages = history.sessionId === activeId && history.epoch === viewEpoch.current ? history.rows : [];
  const ready = connection.state === 'ready' && listState === 'ready'; const running = !!snapshot?.running || waiting;
  const hasStarted = !!snapshot && (snapshot.state.lessons.length > 0 || snapshot.messages.length > 0 || !!snapshot.turnEnd || running);
  const currentProject = snapshot?.project ?? listing.projects.find(project => project.sessions.some(session => session.id === activeId));
  const mapKey = mapProjectKey(currentProject); const mapIsOpen = mapTabs.includes(mapKey);
  const mapAvailable = !!connection.status?.capabilities?.includes('structure-map-v1');
  const scope = snapshot ? JSON.stringify({ sessionId: activeId, model, bindingRevision: snapshot.project.bindingRevision, repos: snapshot.project.repositories.map(repo => [repo.id, repo.root]) }) : '';
  const requestedDocument = useRef(null);
  const handleController = useCallback(controller => { reader.current = controller; if (controller && restorePending.current) { controller.restorePosition(restorePending.current, { activate: false }); restorePending.current = null; } }, []);
  function rememberReadingDocument(id, title, projectId = currentProject?.id) { if (!id || !projectId) return; const document = { sessionId: id, title: topicTitle(title), projectId }; setReadingDocuments(rows => (rows.some(row => row.sessionId === id) ? rows.map(row => row.sessionId === id ? document : row) : [...rows, document]).slice(-20)); }
  function openReading(id = activeId, lessonId = null) {
    const knownProject = listing.projects.find(item => item.sessions.some(session => session.id === id));
    const project = knownProject ?? (id === activeId || lessonId ? currentProject : null);
    const lesson = lessonId && id === activeId ? snapshot?.state.lessons.find(item => item.id === lessonId) : null;
    if (lessonId && ((!project || project.id !== currentProject?.id) || (id === activeId && !lesson))) { setNotice('该方法关联的阅读记录不可用，请刷新文件后重试。'); return; }
    const session = project?.sessions?.find(item => item.id === id);
    rememberReadingDocument(id, id === snapshot?.sessionId ? snapshot.topic : session?.topic, project?.id);
    navigation.current++; setComposerOpen(false);
    if (id === activeId) {
      requestedDocument.current = null; setCreating(false);
      if (lesson) { void savePosition(); selectLesson(lesson); }
      else { setActiveDocument('reading'); void persistReading({ activeDocument: 'reading' }); }
    } else { requestedDocument.current = { id, kind: 'reading', ...(lessonId ? { lessonId, projectId: project.id } : {}) }; switchSession(id); }
    if (window.matchMedia('(max-width:1100px)').matches) setRouteOpen(false);
    if (window.matchMedia('(max-width:900px)').matches) reader.current?.close();
  }
  function mapNavigation() { navigation.current++; evidenceSequence.current++; followResult.current = null; }
  function openMap() {
    if (!snapshot || !ready || !mapAvailable) return;
    if (activeDocument !== 'map') {
      mapOrigins.current.set(mapKey, { sessionId: activeId, kind: activeDocument, position: reader.current?.capturePosition() ?? null, selectedId, stage: viewStage, scrollTop: content.current?.scrollTop ?? 0 });
      void savePosition();
    }
    if (!mapViews.current.has(mapKey)) mapViews.current.set(mapKey, { projectId: snapshot.project.id });
    const nextTabs = [...mapTabs.filter(key => key !== mapKey), mapKey].slice(-12); setMapTabs(nextTabs);
    // Metadata-only navigation is bounded to twelve recently opened projects.
    for (const key of mapViews.current.keys()) if (!nextTabs.includes(key)) { mapViews.current.delete(key); mapOrigins.current.delete(key); }
    mapNavigation(); setCreating(false); setActiveDocument('map'); setMenuOpen(false);
    const nav = navigation.current; const id = activeId;
    requestAnimationFrame(() => { if (mounted.current && activeRef.current === id && navigation.current === nav) content.current?.closest('main')?.querySelector('.cr-document-tab-button[data-document-kind="map"]')?.focus({ preventScroll: true }); });
    if (window.matchMedia('(max-width:1100px)').matches) setRouteOpen(false);
    if (window.matchMedia('(max-width:900px)').matches) reader.current?.close();
  }
  function returnFromMap() {
    mapNavigation(); const origin = mapOrigins.current.get(mapKey); const nav = navigation.current;
    if (origin?.sessionId === activeId) {
      if (origin.position) reader.current?.restorePosition(origin.position, { activate: false, focusViewer: origin.kind === 'source' });
      setSelectedId(origin.selectedId); setViewStage(origin.stage); setActiveDocument(origin.kind === 'map' ? 'empty' : origin.kind);
      requestAnimationFrame(() => {
        if (!mounted.current || navigation.current !== nav || activeRef.current !== origin.sessionId) return;
        if (content.current && origin.kind === 'reading') content.current.scrollTop = origin.scrollTop;
        const main = content.current?.closest('main');
        (origin.kind === 'source' ? main?.querySelector('.cr-file-viewer .cr-code-body') : origin.kind === 'reading' ? content.current?.querySelector('h1') : main?.querySelector('.cr-document-tabs'))?.focus({ preventScroll: true });
      });
    } else if (reader.current?.capturePosition()) reader.current.showSource();
    else if (visibleReadingDocuments.some(item => item.sessionId === activeId)) openReading();
    else setActiveDocument('empty');
  }
  function closeMap() {
    if (activeDocument === 'map') returnFromMap();
    setMapTabs(rows => rows.filter(key => key !== mapKey)); if (mapReturn === mapKey) setMapReturn('');
  }
  function openMapSource(location) { mapNavigation(); setMapReturn(mapKey); reader.current?.openLocation(location); }
  function openMapReading(sessionId, lessonId) { mapNavigation(); setMapReturn(mapKey); openReading(sessionId, lessonId); }
  function closeReadingDocument(document) {
    setReadingDocuments(rows => rows.filter(row => row.sessionId !== document.sessionId));
    if (document.sessionId === activeId && draftSessions.current.has(document.sessionId)) { setDraft(''); setQuestionSelection(null); setConfirmation(null); setLastFailed(null); }
    if (document.sessionId !== activeId || activeDocument !== 'reading') return;
    const other = readingDocuments.filter(row => row.projectId === currentProject?.id && row.sessionId !== document.sessionId).at(-1);
    if (reader.current?.capturePosition()) reader.current.showSource(); else if (other) openReading(other.sessionId); else if (mapIsOpen) openMap(); else setActiveDocument('empty');
  }
  const visibleReadingDocuments = readingDocuments.filter(document => document.projectId === currentProject?.id).map(document => ({ ...document, title: topicTitle(document.sessionId === snapshot?.sessionId ? snapshot.topic : currentProject?.sessions?.find(session => session.id === document.sessionId)?.topic, document.title) }));

  async function refreshList(signal) { const sequence = ++listSequence.current; const startedId = activeRef.current; const result = await api('list', {}, signal); if (mounted.current && !signal?.aborted && sequence === listSequence.current) { if (activeRef.current && !draftSessions.current.has(activeRef.current) && activeRef.current === startedId && !result.projects.some(p => p.sessions.some(s => s.id === activeRef.current))) setActiveId(''); setListing(result); setListState('ready'); } return result; }
  const modelsSequence = useRef(0);
  async function refreshModels(signal) {
    const sequence = ++modelsSequence.current; setModelsState('loading');
    try { const value = checkedModels(await api('models', {}, signal)); if (mounted.current && !signal?.aborted && sequence === modelsSequence.current) { setModels(value); setModelsState('ready'); setNotice(previous => previous.startsWith('模型目录暂不可用：') ? '' : previous); } return value; }
    catch (e) { if (e.name !== 'AbortError' && !signal?.aborted && mounted.current && sequence === modelsSequence.current) { setModelsState('error'); setNotice(`模型目录暂不可用：${e.message}`); } throw e; }
  }
  async function loadSetup() {
    setupAbort.current?.abort(); const controller = new AbortController(); setupAbort.current = controller;
    setConnection({ state: 'loading', status: null, error: null }); setListState('loading'); setModelsState('loading');
    try {
      const status = validateHostStatus(await api('status', {}, controller.signal));
      if (!mounted.current || controller.signal.aborted) return;
      setConnection({ state: 'ready', status, error: null });
      setError(previous => previous.endsWith('(VERSION_MISMATCH)') ? '' : previous);
      const [listResult] = await Promise.allSettled([refreshList(controller.signal), refreshModels(controller.signal)]);
      if (!mounted.current || controller.signal.aborted) return;
      if (listResult.status === 'rejected') { setListState('error'); setError(listResult.reason.message); }
    } catch (e) {
      if (e.name === 'AbortError' || controller.signal.aborted || !mounted.current) return;
      setConnection({ state: 'error', status: null, error: e }); setListState('error'); setModelsState('error');
    }
  }
  async function refresh(id = activeRef.current) {
    if (!id) return null;
    const epoch = viewEpoch.current; snapshotAbort.current?.abort(); const controller = new AbortController(); snapshotAbort.current = controller; setSnapshotState('loading');
    try {
      const value = await api('snapshot', { sessionId: id }, controller.signal);
      if (!mounted.current || controller.signal.aborted || activeRef.current !== id || viewEpoch.current !== epoch) return null;
      if (value.draft) draftSessions.current.add(id);
      else { draftSessions.current.delete(id); try { localStorage.setItem('dsh-code-reading:active', id); } catch { /* Session identity only. */ } }
      const state = value.state.readerState ?? emptyReaderState(); const known = readerStates.current.get(id);
      if (!known || state.revision >= known.revision) readerStates.current.set(id, state);
      if (initializedView.current?.id !== id || initializedView.current.epoch !== epoch) {
        const requested = requestedDocument.current?.id === id ? requestedDocument.current : null;
        const linkedLesson = requested?.lessonId ? value.state.lessons.find(item => item.id === requested.lessonId) : null;
        if (requested?.lessonId && (requested.projectId !== value.project.id || !linkedLesson)) throw new Error('该方法关联的阅读记录已不可用，请刷新文件后重试；不会自动改开其他知识点。');
        initializedView.current = { id, epoch }; setEntryMode(value.readingMode ?? 'question'); setRepoId(value.project.repositories[0]?.id ?? '');
        const storedLesson = value.state.lessons.find(item => item.id === state.selectedLessonId);
        const lesson = linkedLesson ?? storedLesson ?? value.state.lessons.at(-1) ?? null;
        const viewedIds = [...new Set([...state.viewedLessonIds, ...(lesson ? [lesson.id] : [])])];
        setSelectedId(lesson?.id ?? null); setViewStage(lesson?.stage ?? value.stage); setViewed(viewedIds); setUnderstood(state.understoodLessonIds);
        restorePending.current = state.readerPosition;
        const requestedKind = requested?.kind ?? null;
        const kind = requestedKind ?? state.activeDocument ?? (state.readerPosition ? 'source' : lesson ? 'reading' : 'empty');
        requestedDocument.current = null; setActiveDocument(kind); if (kind === 'reading') rememberReadingDocument(id, value.topic, value.project.id);
        if (requestedKind) void persistReading({ activeDocument: requestedKind, ...(linkedLesson ? { viewStage: linkedLesson.stage, selectedLessonId: linkedLesson.id, viewedLessonIds: viewedIds, lessonScrollTop: 0 } : {}) }, id);
        if (!value.state.lessons.length && !value.messages.length) setDraft(value.topic || '');
        requestAnimationFrame(() => { if (content.current && activeRef.current === id && viewEpoch.current === epoch) content.current.scrollTop = linkedLesson ? 0 : state.lessonScrollTop ?? 0; });
      } else if (followResult.current?.id === id && followResult.current.navigation === navigation.current) {
        const newest = value.state.lessons.at(-1);
        if (newest && newest.id !== followResult.current.lastLessonId) { setSelectedId(newest.id); setViewStage(newest.stage); setViewed(previous => [...new Set([...previous, newest.id])]); setActiveDocument('reading'); rememberReadingDocument(id, value.topic, value.project.id); void persistReading({ activeDocument: 'reading', selectedLessonId: newest.id, viewedLessonIds: [...new Set([...viewed, newest.id])] }, id); setComposerOpen(false); followResult.current = null; }
      }
      setSnapshot(value); setSnapshotState('ready'); setModel(value.modelSelection ? `${value.modelSelection.provider}\u0000${value.modelSelection.model}` : '');
      if (!value.running && cancelAcknowledged.current && (!submitting.current || submitting.current.settled)) {
        setWaiting(false); setAccepting(false); setCancelPending(false); cancelAcknowledged.current = false;
        setNotice(value.turnEnd?.reason.kind === 'cancelled' ? '本轮已取消，已完成内容保留。' : '停止请求已确认，后端当前空闲。未提供新的结束原因；已完成内容保留。');
      }
      if (!value.running && (value.turnEnd?.seq ?? -1) > waitingBaseline.current) {
        setWaiting(false); setAccepting(false); setCancelPending(false);
        if (value.turnEnd?.reason.kind !== 'completed') { setNotice(turnEndNotice(value.turnEnd.reason)); if (lastAttempt.current?.sessionId === id) setLastFailed(lastAttempt.current); }
      }
      return value;
    } catch (e) {
      if (e.name === 'AbortError' || controller.signal.aborted || activeRef.current !== id || viewEpoch.current !== epoch || !mounted.current) return null;
      setSnapshotState('error'); throw e;
    }
  }
  async function loadOlderMessages() {
    const id = activeRef.current; const epoch = viewEpoch.current; const beforeSeq = (olderMessages.length ? olderMessages : snapshot.messages)[0]?.seq;
    const value = await api('snapshot', { sessionId: id, beforeSeq });
    if (!mounted.current || activeRef.current !== id || viewEpoch.current !== epoch) return;
    setHistory(previous => {
      if (!mounted.current || activeRef.current !== id || viewEpoch.current !== epoch) return previous;
      const existing = previous.sessionId === id && previous.epoch === epoch ? previous.rows : [];
      return { sessionId: id, epoch, rows: [...new Map([...value.messages, ...existing].map(message => [message.seq, message])).values()].sort((a, b) => a.seq - b.seq) };
    });
  }
  async function perform(operation) { const id = activeRef.current; const epoch = viewEpoch.current; pendingOperations.current++; setBusy(true); setError(''); try { await operation(); } catch (e) { if (mounted.current && e.name !== 'AbortError' && activeRef.current === id && viewEpoch.current === epoch) setError(e.message); } finally { pendingOperations.current--; if (mounted.current) setBusy(pendingOperations.current > 0); } }
  function persistReading(patch, id = activeRef.current) {
    if (!id || draftSessions.current.has(id) || !readerStates.current.has(id)) return Promise.resolve(); const epoch = viewEpoch.current;
    const previous = saveChains.current.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => { const state = readerStates.current.get(id); const saved = await api('reader-state', { sessionId: id, expectedRevision: state.revision, patch }); readerStates.current.set(id, saved); return saved; });
    saveChains.current.set(id, pending);
    return pending.catch(e => { if (mounted.current && activeRef.current === id && viewEpoch.current === epoch) setNotice(`阅读位置尚未保存：${e.message}。当前内容仍保留，可再次保存。`); });
  }
  function savePosition(announce = false) {
    if (!snapshot) return Promise.resolve();
    const previous = activeDocument === 'map' ? nonMapPositions.current.get(snapshot.sessionId) ?? readerStates.current.get(snapshot.sessionId) ?? emptyReaderState() : null;
    const patch = previous ? { activeDocument: readerDocumentKind('map', previous.activeDocument), viewStage: previous.viewStage, selectedLessonId: previous.selectedLessonId, viewedLessonIds: previous.viewedLessonIds, understoodLessonIds: previous.understoodLessonIds, readerPosition: previous.readerPosition, lessonScrollTop: previous.lessonScrollTop } : { activeDocument: readerDocumentKind(activeDocument), viewStage, selectedLessonId: selectedId, viewedLessonIds: viewed, understoodLessonIds: understood, readerPosition: positionMetadata(reader.current?.capturePosition()), lessonScrollTop: content.current?.scrollTop ?? 0 };
    if (activeDocument !== 'map') nonMapPositions.current.set(snapshot.sessionId, patch);
    return persistReading(patch).then(saved => { if (announce && saved && activeRef.current === snapshot.sessionId) setNotice(activeDocument === 'map' ? '已保存原源码与阅读位置；项目地图位置仅在本页面保留，不新增浏览器内容存储。' : '阅读位置已保存；仅保存位置元数据，不将源码或对话新增到浏览器存储。'); });
  }
  function discardDraft(id) {
    if (!draftSessions.current.delete(id)) return;
    readerStates.current.delete(id); saveChains.current.delete(id); nonMapPositions.current.delete(id); if (mounted.current) setReadingDocuments(rows => rows.filter(row => row.sessionId !== id));
    // A prompt whose carrier result was lost may already have promoted this id.
    // The Host only discards memory drafts, never persisted reading archives.
    void api('discard-draft', { sessionId: id }).catch(() => {});
  }
  function switchSession(id) { if (id === activeId) { setCreating(false); return; } navigation.current++; void savePosition(); discardDraft(activeId); setCreating(false); setActiveId(id); }
  useEffect(() => { mounted.current = true; void loadSetup(); const media = window.matchMedia('(max-width:1100px)'); const collapse = () => { if (media.matches) setRouteOpen(false); }; collapse(); media.addEventListener('change', collapse); return () => { mounted.current = false; setupAbort.current?.abort(); snapshotAbort.current?.abort(); for (const id of draftSessions.current) void api('discard-draft', { sessionId: id }).catch(() => {}); media.removeEventListener('change', collapse); }; }, []);
  useEffect(() => {
    if (!draftSessions.current.has(activeId)) { try { localStorage.setItem('dsh-code-reading:active', activeId); } catch { /* Existing preference only; content belongs to Host archives. */ } }
    viewEpoch.current++; initializedView.current = null; navigation.current++; followResult.current = null; consent.current = null; restorePending.current = null; cancelAcknowledged.current = false; lastAttempt.current = null; submitting.current = null; setAccepting(false);
    setSnapshot(null); setSnapshotState('idle'); setHistory({ sessionId: activeId, epoch: viewEpoch.current, rows: [] }); setRepoId(''); setWaiting(false); setCancelPending(false); setEntryMode('question'); setDraft(''); setModel(''); pendingPrompt.current = null;
    setSelectedId(null); setActiveDocument('empty'); setComposerOpen(false); setViewStage('discover'); setViewed([]); setUnderstood([]); setQuestionSelection(null); setReturnPoint(null); setConfirmation(null); setDialog(''); setError(''); setNotice(''); setLastFailed(null);
  }, [activeId]);
  useEffect(() => { setProjectOpen(false); }, [busy, ready, activeId, listing.projects.length]);
  useEffect(() => { if (activeId && ready) void refresh(activeId).catch(e => { if (mounted.current) setError(e.message); }); else snapshotAbort.current?.abort(); }, [activeId, ready]);
  useEffect(() => { if (snapshot && restorePending.current && reader.current) { const position = restorePending.current; restorePending.current = null; reader.current.restorePosition(position, { activate: false }); } }, [snapshot?.sessionId]);
  useEffect(() => {
    if (!ready || snapshotState === 'error' || !activeId || !(snapshot?.running || waiting)) return;
    const timer = setTimeout(() => refresh(activeId).catch(e => { setError(e.message); }), 1200);
    return () => clearTimeout(timer);
  }, [activeId, snapshot, waiting, ready, snapshotState]);
  // A change of actual provider/model or binding always invalidates consent, including A → B → A.
  useEffect(() => { consent.current = null; setConfirmation(null); }, [scope]);

  function markViewed(id, stage = viewStage) { const next = [...new Set([...viewed, id])]; setViewed(next); void persistReading({ viewStage: stage, selectedLessonId: id, viewedLessonIds: next, lessonScrollTop: 0 }); }
  function selectLesson(lesson) { navigation.current++; setActiveDocument('reading'); rememberReadingDocument(activeId, snapshot?.topic); setSelectedId(lesson.id); setViewStage(lesson.stage); markViewed(lesson.id, lesson.stage); void persistReading({ activeDocument: 'reading' }); if (window.matchMedia('(max-width:1100px)').matches) setRouteOpen(false); if (content.current) content.current.scrollTop = 0; }
  function toggleUnderstanding() { if (!selectedLesson) return; const next = understood.includes(selectedLesson.id) ? understood.filter(id => id !== selectedLesson.id) : [...understood, selectedLesson.id]; setUnderstood(next); void persistReading({ understoodLessonIds: next }); }
  async function openEvidence(evidenceId) {
    const id = activeId; const epoch = viewEpoch.current; const sequence = ++evidenceSequence.current; const route = navigation.current;
    try { const value = await api('evidence', { sessionId: id, evidenceId }); if (activeRef.current === id && viewEpoch.current === epoch && sequence === evidenceSequence.current && route === navigation.current) reader.current?.openEvidence(value); }
    catch (e) { if (activeRef.current === id && viewEpoch.current === epoch && sequence === evidenceSequence.current && route === navigation.current) setError(`引用无法定位：${e.message}。不会打开同名或近似文件。`); }
  }
  function rememberRoute() { if (returnPoint) return; setReturnPoint({ sessionId: activeId, activeDocument, selectedId, stage: viewStage, entryMode, position: reader.current?.capturePosition() ?? null, scrollTop: content.current?.scrollTop ?? 0, selection: questionSelection }); }
  function attachSelection(selection) { rememberRoute(); setQuestionSelection(structuredClone(selection)); openReading(); setComposerOpen(true); setNotice('选区已固定到本次追问上下文；临时浏览其他文件不会替换它。'); }
  function returnToRoute() {
    if (!returnPoint || returnPoint.sessionId !== activeId) return;
    navigation.current++; setSelectedId(returnPoint.selectedId); setViewStage(returnPoint.stage); setEntryMode(returnPoint.entryMode ?? 'question'); setQuestionSelection(returnPoint.selection); if (returnPoint.position) reader.current?.restorePosition(returnPoint.position, { activate: false }); else reader.current?.close(); setActiveDocument(returnPoint.activeDocument ?? 'reading'); setComposerOpen(false);
    const top = returnPoint.scrollTop; requestAnimationFrame(() => { if (content.current) content.current.scrollTop = top; }); setReturnPoint(null); setDraft(''); setNotice('已返回原知识点和源码位置；源码版本会重新核验。');
  }
  async function dispatchPrompt(text, selection, initial = false, requestedStage = viewStage, retryAttempt = null, intent = 'explain') {
    const id = activeId; const epoch = viewEpoch.current; let current = snapshot; const chosenStage = requestedStage;
    if (!current || !text.trim() || !model) throw new Error('请填写阅读目标并选择本会话模型');
    const [provider, modelId] = model.split('\u0000');
    const attempt = retryAttempt ?? { sessionId: id, text, selection, initial, stage: selection ? 'deep-read' : chosenStage, readingMode: selection ? 'code' : entryMode, ...(intent === 'logic-graph' ? { intent } : {}), contextText: selectedLesson ? `\n\n本次追问的阅读上下文：主题「${topicTitle(current.topic)}」；父知识点「${selectedLesson.title}」（${selectedLesson.id}）。保留阅读主线，只处理这一轮问题。` : '' };
    lastAttempt.current = attempt;
    const submission = { id, epoch, cancelled: false, sent: false }; submitting.current = submission;
    const isCurrent = () => activeRef.current === id && viewEpoch.current === epoch;
    const cancelledBeforeSend = () => {
      if (!submission.cancelled && isCurrent()) return false;
      if (isCurrent()) { setWaiting(false); setAccepting(false); setCancelPending(false); setNotice('本次待提交分析已取消，尚未发送给模型。'); }
      return true;
    };
    setNotice(''); setWaiting(true); setAccepting(true); waitingBaseline.current = current.turnEnd?.seq ?? -1;
    try {
      let request;
      if (attempt.uncertain && attempt.request) {
        // An unconfirmed carrier result must replay the exact original admission, not a newly composed prompt.
        request = attempt.request;
        if (request.expectedModel.provider !== provider || request.expectedModel.model !== modelId) throw new Error('原请求的模型已变化，请先恢复原提供方与模型并刷新核对，不要重复创建分析。');
      } else {
        const desiredTopic = initial || !current.topic ? selection ? `${selection.path}:${selection.start.line}–${selection.end.line}` : text.trim().slice(0, 300) : current.topic;
        if (current.stage !== attempt.stage || current.topic !== desiredTopic) {
          const changed = await api('stage', { sessionId: id, expectedRevision: current.revision, stage: attempt.stage, topic: desiredTopic });
          if (cancelledBeforeSend()) return;
          current = { ...current, ...changed, state: { ...current.state, stage: changed.stage, topic: changed.topic, revision: changed.revision } };
          setSnapshot(current); void refreshList().catch(() => {});
        }
        const payload = text + attempt.contextText;
        const old = pendingPrompt.current;
        request = old?.text === payload && old.readingMode === attempt.readingMode && old.intent === attempt.intent && JSON.stringify(old.selection) === JSON.stringify(selection) && old.sessionId === id && old.expectedRevision === current.revision && old.expectedModel.provider === provider && old.expectedModel.model === modelId ? old : { sessionId: id, requestId: uuid(), text: payload, readingMode: attempt.readingMode, ...(attempt.intent ? { intent: attempt.intent } : {}), expectedRevision: current.revision, expectedModel: { provider, model: modelId }, ...(selection ? { selection } : {}) };
      }
      if (cancelledBeforeSend()) return;
      attempt.request = request; attempt.uncertain = false; pendingPrompt.current = request;
      followResult.current = { id, navigation: navigation.current, lastLessonId: current.state.lessons.at(-1)?.id };
      submission.sent = true;
      let accepted;
      try { accepted = await api('prompt', request); submission.settled = true; }
      catch (e) {
        submission.settled = true;
        if (isCurrent()) {
          setAccepting(false); setWaiting(false);
          if (e.code === 'PROMPT_CANCELLED') { setCancelPending(false); setNotice('本次提问已在入队前取消，未发送给模型。'); setLastFailed(null); pendingPrompt.current = null; return; }
          attempt.uncertain = e.code === 'NETWORK_ERROR'; setLastFailed({ ...attempt });
        }
        throw e;
      }
      pendingPrompt.current = null;
      if (isCurrent()) {
        setAccepting(false); setWaiting(accepted.replayed ? !!accepted.running : true); setDraft(''); setLastFailed(null);
        if (accepted.replayed && !accepted.running) setNotice('此请求已经接纳并处理，保留原结果，不会重复阅读。');
        // Snapshot failure is not a failed admission and must not enable a second prompt with a fresh ID.
        await refresh(id); void refreshList().catch(() => {});
      }
    } catch (e) {
      if (isCurrent() && !submission.sent) { setWaiting(false); setAccepting(false); setCancelPending(false); setLastFailed({ ...attempt }); }
      throw e;
    } finally { if (submitting.current === submission) submitting.current = null; }
  }
  function requestPrompt(text, selection = questionSelection, initial = false, stage = viewStage, retryAttempt = null, intent = 'explain') {
    if (!text.trim() || !model || running || busy || archived) return;
    if (consent.current !== scope) { setConfirmation({ text, selection: selection ? structuredClone(selection) : null, initial, stage, retryAttempt, intent, scope, sessionId: activeId }); return; }
    void perform(() => dispatchPrompt(text, selection, initial, stage, retryAttempt, intent));
  }
  function deepen(question) { rememberRoute(); openReading(); setComposerOpen(true); setDraft(question); setNotice('已将深入问题放入追问框。可修改后发送，或返回原阅读路线。'); }
  async function stopAnalysis() {
    const id = activeId; const epoch = viewEpoch.current; setCancelPending(true);
    if (submitting.current?.id === id) submitting.current.cancelled = true;
    try { await api('cancel', { sessionId: id }); if (activeRef.current === id && viewEpoch.current === epoch) { cancelAcknowledged.current = true; setNotice('停止请求已提交，等待后端结束；已完成内容保留。'); await refresh(id); } }
    catch (e) { if (activeRef.current === id && viewEpoch.current === epoch) setCancelPending(false); throw e; }
  }
  function creationGuard() {
    const id = activeRef.current; const epoch = viewEpoch.current; const nav = navigation.current;
    return () => mounted.current && activeRef.current === id && viewEpoch.current === epoch && navigation.current === nav;
  }
  async function createProject(request) {
    const current = creationGuard(); const project = await api('create-project', request);
    if (!current()) { await refreshList(); return; }
    setCreating(false); let created;
    try {
      created = await api('create-session', { projectId: project.id, draft: true }); draftSessions.current.add(created.sessionId);
      if (!current()) { discardDraft(created.sessionId); return; }
      await refreshList();
      if (!current()) { discardDraft(created.sessionId); return; }
      switchSession(created.sessionId);
    } catch (e) { if (created) discardDraft(created.sessionId); await refreshList().catch(() => { if (current()) setListState('error'); }); throw new ReadingApiError(e.code ?? 'SESSION_SETUP_FAILED', `项目已保存，后续会话步骤未完成或结果未确认。请先刷新检查阅读历史，使用“新阅读会话”继续，不要重复新建项目。${e.message}`); }
  }
  const topics = [...(snapshot?.state.lessons ?? [])].reverse().find(lesson => lesson.topics?.length)?.topics ?? [];
  const followText = draft.trim() || `围绕阅读主题「${topicTitle(snapshot?.topic)}」${selectedLesson ? `，接着「${selectedLesson.title}」` : ''}解释下一个相关知识点。按当前问题选择需要的业务背景、调用链或实现逻辑，不要求按固定阶段推进。先取证，发布后等待我决定。`;
  const codeGoal = '请从我选中的代码开始，先识别并完整读取其所属方法或函数，再解释实现逻辑、项目内必要的上下游调用链和相关业务用途。代码解读的最小单元是完整方法、函数或构造器，不能把局部语句冒充完整方法；类或文件问题可按完整的更大代码单元阅读。为每个实际解读的完整代码单元归档可关联源码的结论，区分事实、推断与待确认。非代码文件不受方法粒度约束。';
  function newReading(project = currentProject) {
    if (!project) { setCreating(true); return; }
    if (window.matchMedia('(max-width:1100px)').matches) setRouteOpen(false);
    if (window.matchMedia('(max-width:900px)').matches) reader.current?.close();
    if (snapshot?.draft && snapshot.project.id === project.id) { setCreating(false); openReading(); return; }
    const current = creationGuard();
    void perform(async () => {
      await savePosition(); if (!current()) return;
      const value = await api('create-session', { projectId: project.id, draft: true }); draftSessions.current.add(value.sessionId);
      if (!current()) { discardDraft(value.sessionId); return; }
      try { await refreshList(); } catch (error) { discardDraft(value.sessionId); throw error; }
      if (!current()) { discardDraft(value.sessionId); return; }
      rememberReadingDocument(value.sessionId, '临时阅读', project.id); requestedDocument.current = { id: value.sessionId, kind: 'reading' }; switchSession(value.sessionId); setSessionFilter('active');
    });
  }
  async function setSessionArchived(session, shouldArchive) {
    const id = session.id ?? session.sessionId; const current = creationGuard();
    if (id === activeRef.current) await savePosition();
    await api('set-session-archived', { sessionId: id, archived: shouldArchive, expectedRevision: session.archiveRevision ?? 0 });
    await refreshList();
    if (activeRef.current === id && current()) {
      await refresh(id);
      if (current()) { setConfirmation(null); setNotice(shouldArchive ? '阅读已归档，内容与位置保留，可在“已归档”中查看或恢复。' : '阅读已恢复，可继续提问。'); }
    }
    requestAnimationFrame(() => {
      if (!current()) return;
      const root = content.current?.closest('.cr-page');
      [sessionFilters.current?.querySelector(`[data-filter="${sessionFilter}"]`), content.current?.querySelector('h1'), root?.querySelector('.cr-document-tab[data-active="true"] .cr-document-tab-button'), root?.querySelector('.cr-route-toolbar button')].find(element => element?.getClientRects().length)?.focus({ preventScroll: true });
    });
  }
  async function removeProject(project) {
    const current = creationGuard();
    if (!ready) return;
    try { await api('remove-project', { projectId: project.id, expectedBindingRevision: project.bindingRevision }); }
    catch (error) { if (mounted.current && error.code === 'VERSION_MISMATCH') setConnection({ state: 'error', status: null, error }); throw error; }
    if (!mounted.current) return;
    const ids = new Set([...(project.sessions ?? []).map(session => session.id), ...(currentProject?.id === project.id ? [activeId] : [])]);
    const affected = ids.has(activeRef.current);
    for (const id of ids) { draftSessions.current.delete(id); readerStates.current.delete(id); saveChains.current.delete(id); nonMapPositions.current.delete(id); }
    const removedMapKeys = new Set([...mapViews.current].filter(([, memory]) => memory.projectId === project.id).map(([key]) => key));
    for (const key of removedMapKeys) { mapViews.current.delete(key); mapOrigins.current.delete(key); }
    setMapTabs(rows => rows.filter(key => !removedMapKeys.has(key))); if (removedMapKeys.has(mapReturn)) setMapReturn('');
    setReadingDocuments(rows => rows.filter(row => row.projectId !== project.id));
    setListing(previous => ({ ...previous, projects: previous.projects.filter(row => row.id !== project.id) }));
    if (affected) {
      snapshotAbort.current?.abort(); viewEpoch.current++; navigation.current++; consent.current = null;
      requestedDocument.current = null; setConfirmation(null); setSnapshot(null); setActiveId(''); setCreating(false);
      try { localStorage.removeItem('dsh-code-reading:active'); } catch { /* Identity preference only. */ }
    }
    setRemovingProject(null); setDialog('');
    await refreshList();
    if (mounted.current && (affected ? !activeRef.current : current())) setNotice(`已移除仓库「${project.title}」，磁盘源码和原阅读档案均保留。`);
  }
  const graphGoal = '请为我选中的方法或类生成逻辑图。若选区只是方法或函数的一部分，先识别并完整读取所属可调用单元，不能把局部语句当成完整方法。先读取并核验完整代码单元和必要上下文：方法优先用 Mermaid flowchart 展示入口、关键判断、分支、调用、异常与返回；类按真实职责和协作选择类图或流程图。图必须基于源码证据，区分无法确认的调用，不要臆造。将安全 Mermaid 保存到 mermaid 字段，按实际解读的完整代码单元归档结论与证据，不把类的概览等同所有方法已读；非代码文件不受方法粒度约束。不修改代码。';
  function analyzeSelection(selection, intent = 'explain') { rememberRoute(); setQuestionSelection(structuredClone(selection)); setEntryMode('code'); requestPrompt(intent === 'logic-graph' ? graphGoal : codeGoal, selection, !hasStarted, 'deep-read', null, intent); }
  function chooseCode() { setEntryMode('code'); setActiveDocument('source'); reader.current?.browseFiles(); }
  const modelPicker = <ModelSelect key={activeId} value={model} groups={models?.groups} loading={modelsState === 'loading'} disabled={busy || running || archived || modelsState === 'loading'} onValueChange={selected => {
    if (!selected) return;
    const [provider, modelId] = selected.split('\u0000'); const id = activeId; const epoch = viewEpoch.current; consent.current = null;
    void perform(async () => { await api('select-model', { sessionId: id, provider, model: modelId }); if (activeRef.current === id && viewEpoch.current === epoch) await refresh(id); });
  }} />;
  const modelHint = model ? `会话所选模型：${model.replace('\u0000', ' / ')}。实际接收方是该提供方配置的服务端点，并非模型显示名；首次发送前请核对。` : modelsState === 'loading' ? '正在加载模型目录，请稍候。' : modelsState === 'error' ? '模型目录加载失败。请在阅读设置中重新加载。' : models?.groups.some(group => group.models.length) ? '选择本会话的提供方与模型。' : '暂无可用模型。请先在 DSH“设置 → 模型”配置提供方，再在阅读设置中重新加载。';
  const selectionContext = questionSelection && <span className="cr-context-selection" title={`SHA256 ${questionSelection.fileHash}`}>已固定选区：{snapshot?.project.repositories.find(repo => repo.id === questionSelection.repoId)?.name} / {questionSelection.path}:{questionSelection.start.line}–{questionSelection.end.line}<button type="button" aria-label="移除提问选区" onClick={() => setQuestionSelection(null)}>×</button></span>;
  return <div className={`cr-page cr-workbench cr-ide${routeOpen ? '' : ' cr-route-collapsed'}`} data-testid="code-reading-panel" data-has-project={!!currentProject}>
    <header className="cr-header">
      <span className="cr-brand-icon"><BookIcon size={20} /></span><span className="cr-app-title">阅读代码</span>
      <div className="cr-project-switch"><Select value={currentProject?.id ?? ''} disabled={busy || !ready || !listing.projects.length} open={projectOpen && !busy && ready && !!listing.projects.length} onOpenChange={setProjectOpen} onValueChange={id => { if (id === 'manage-repositories') { pendingProjectDialog.current = true; return; } const project = listing.projects.find(item => item.id === id); const session = project?.sessions.find(item => !item.archivedAt) ?? project?.sessions[0]; if (session) switchSession(session.id); else { setCreating(false); pendingProjectDialog.current = true; } }}>
        <SelectTrigger aria-label="阅读项目切换" title={currentProject?.title}><SelectValue placeholder="选择仓库" /></SelectTrigger>
        <SelectContent aria-label="阅读项目切换" className="cr-project-options" onCloseAutoFocus={event => { if (pendingProjectDialog.current) { pendingProjectDialog.current = false; event.preventDefault(); setDialog('projects'); } }}>{listing.projects.map(project => <SelectItem key={project.id} value={project.id}>{project.title}</SelectItem>)}<SelectSeparator /><SelectItem value="manage-repositories">管理仓库…</SelectItem></SelectContent>
      </Select></div>
      {currentProject?.repositories.length > 1 && <span className="cr-header-repos" title={currentProject.repositories.map(repo => repo.root).join(' / ')}>{currentProject.repositories.length} 个关联仓库</span>}
      <span className="cr-badge cr-badge-safe">仓库只读</span>
      <div className="cr-project-menu"><button type="button" aria-label="阅读菜单" aria-expanded={menuOpen} aria-controls="cr-project-actions" onClick={() => setMenuOpen(value => !value)}>更多 <span aria-hidden="true">···</span></button>{menuOpen && <div id="cr-project-actions" className="cr-menu">
        <button type="button" disabled={busy || !ready} onClick={() => { setMenuOpen(false); newReading(); }}>新建阅读</button>
        <button type="button" disabled={!snapshot || !ready || !mapAvailable} title={mapAvailable ? '查看项目结构，不会请求模型' : '当前 Host 尚不支持项目地图，请核对插件版本'} onClick={openMap}>项目地图</button>
        <button type="button" disabled={busy || !ready} onClick={() => { void savePosition(); setCreating(true); setMenuOpen(false); }}>打开其他仓库</button>
        <button type="button" onClick={() => { setDialog('settings'); setMenuOpen(false); }}>阅读设置</button>
        <button type="button" disabled={busy} onClick={() => { setMenuOpen(false); void perform(async () => { await loadSetup(); if (activeRef.current) await refresh(); }); }}>刷新</button>
        <button type="button" onClick={() => { setDialog('help'); setMenuOpen(false); }}>安装与使用</button>
      </div>}</div>
    </header>
    <div className="cr-body">

      <FileWorkspace key={currentProject?.id || 'empty'} sessionId={activeId} sessionDraft={!!snapshot?.draft} onMutation={async id => { try { if (activeRef.current === id) await refresh(id); await refreshList(); } catch (e) { if (activeRef.current === id) setNotice(`批注已保存，会话状态尚未刷新：${e.message}`); } }} repositories={snapshot?.project.repositories ?? []} repoId={repoId} onRepoChange={setRepoId} enabled={!!(ready && snapshot && !creating)} activeDocument={activeDocument} onOpen={() => { evidenceSequence.current++; navigation.current++; setActiveDocument('source'); void persistReading({ activeDocument: 'source' }); }} onController={handleController} onContextSelection={selection => { attachSelection(selection); setEntryMode('code'); }} analyzeDisabled={archived ? '请先恢复已归档的阅读会话' : busy || running ? '请等待本轮结束或停止后分析' : !model ? '请先选择本会话模型' : ''} onAnalyze={selection => analyzeSelection(selection)} onGraph={selection => analyzeSelection(selection, 'logic-graph')} onReading={openReading}>
        <FileRail />
        <main className="cr-content cr-reading-main cr-editor-main" aria-label="文档工作区">
          {snapshot && !creating && <DocumentTabs activeDocument={activeDocument} readingDocuments={visibleReadingDocuments} activeSessionId={activeId} onReading={document => openReading(document.sessionId)} onCloseReading={closeReadingDocument} mapOpen={mapIsOpen} onMap={openMap} onCloseMap={closeMap} onEmpty={() => { const document = visibleReadingDocuments.at(-1); if (document) openReading(document.sessionId); else if (mapIsOpen) openMap(); else setActiveDocument('empty'); }} />}
          <div className="cr-editor-notices">
            {snapshot && connection.state === 'error' && <div className="cr-banner cr-error" role="alert">{connection.error?.message}<button type="button" disabled={busy} onClick={() => void perform(loadSetup)}>重试连接与加载</button></div>}
            {error && error !== connection.error?.message && <div className="cr-banner cr-error" role="alert">{error}{snapshot && <button type="button" disabled={busy} onClick={() => void perform(() => refresh())}>刷新核对状态</button>}</div>}
            {notice && <div className="cr-banner" role="status">{notice}<button type="button" onClick={() => setNotice('')}>关闭</button></div>}
            {listing.diagnostics.map((diagnostic, index) => <div className="cr-banner cr-error" key={index}>档案加载诊断：{diagnostic}</div>)}
            {archived && <div className="cr-banner cr-archived-notice" role="status">这条阅读已归档。内容、证据和位置均保留，恢复后可继续提问。<button type="button" disabled={busy || running} onClick={() => void perform(() => setSessionArchived(snapshot, false))}>恢复阅读</button></div>}
            {snapshot?.archiveError && <div className="cr-banner cr-error" role="alert">归档失败：{snapshot.archiveError}。DSH 原会话仍是恢复来源，请刷新重试。</div>}
            {snapshot && snapshotState === 'error' && <div className="cr-banner cr-error" role="alert">状态刷新失败，已完成内容保留。运行是否结束尚未确认。<button type="button" disabled={busy} onClick={() => void perform(() => refresh())}>重新加载档案</button></div>}
            {running && snapshot && <section className="cr-editor-task" role="status"><span className="cr-indeterminate" aria-hidden="true" /><span>{cancelPending ? '停止请求已提交，等待后端结束' : accepting ? '等待后端接纳本轮问题' : '正在分析本轮问题'}<small>代码与已有阅读内容仍可浏览</small></span><button type="button" disabled={cancelPending} onClick={() => void perform(stopAnalysis)}>{cancelPending ? '等待停止确认' : '停止分析'}</button></section>}
          </div>
          {snapshot && !creating && mapIsOpen && mapReturn === mapKey && activeDocument !== 'map' && <div className="cr-map-return"><span>项目地图位置已保留</span><button type="button" onClick={openMap}>返回项目地图</button></div>}
          {snapshot && !creating && mapIsOpen && mapViews.current.has(mapKey) && <StructureMap key={mapKey} project={snapshot.project} sessionId={activeId} enabled={ready && mapAvailable} active={activeDocument === 'map'} memory={mapViews.current.get(mapKey)} onNavigate={mapNavigation} onOpenSource={openMapSource} onOpenReading={openMapReading} onReturnDocument={returnFromMap} />}
          <div className="cr-editor-source cr-source-document" hidden={!snapshot || creating || activeDocument !== 'source'}><FileViewer /></div>
          {snapshot && !creating && activeDocument === 'empty' && <section className="cr-editor-empty" aria-label="代码工作区空态"><span className="cr-editor-empty-symbol"><UiIcon name="file-code-2" size={38} /></span><h1>选择文件，开始阅读</h1></section>}
          <div className="cr-reading-scroll" ref={content} hidden={!!(snapshot && !creating && activeDocument !== 'reading')}>
            {connection.state !== 'ready' && <InstallationHelp connection={connection} modelsState={modelsState} models={models} />}
            {!ready ? <section className="cr-empty"><h2>{connection.state === 'loading' || listState === 'loading' ? '正在连接阅读插件' : '阅读项目暂不可用'}</h2><p role="status">{connection.state === 'loading' || listState === 'loading' ? '正在检查连接与仓库，不会请求模型。' : '请检查安装与连接后重试。已有记录不会因此删除。'}</p><button type="button" disabled={busy} onClick={() => void perform(loadSetup)}>重试连接与加载</button></section>
              : creating ? <ProjectForm workspaces={workspaces ?? []} pickDirectory={async () => { try { return await pickDirectory(); } catch (e) { setError(e.message); return null; } }} onCreate={request => void perform(() => createProject(request))} busy={busy} cancel={() => setCreating(false)} />
                : !activeId ? <section className="cr-empty cr-welcome"><span className="cr-start-symbol"><BookIcon size={28} /></span><h1>从一个问题，<br />或一段代码开始</h1><p>理解业务，追踪调用，读懂实现。<br />不必走固定流程，只专注你这次想弄明白的事。</p><button className="cr-primary" type="button" onClick={() => setCreating(true)}><UiIcon name="folder-tree" size={16} />打开本地仓库</button><div className="cr-welcome-notes"><span><UiIcon name="shield-check" size={15} />源码只读</span><span><UiIcon name="files" size={15} />阅读记录随时回看</span></div></section>
                  : !snapshot && snapshotState === 'error' ? <section className="cr-empty"><h2>阅读档案加载失败</h2><p>档案没有被删除；重试只读取状态，不会重新发送问题。</p><button type="button" disabled={busy} onClick={() => void perform(() => refresh())}>重新加载档案</button></section>
                    : !snapshot ? <p role="status">正在加载阅读档案…</p> : <>
                      <header className="cr-topic-header"><div className="cr-breadcrumb"><UiIcon name="folder-tree" size={13} />{snapshot.project.repositories.map(repo => repo.name).join(' / ')}<span>/</span>{hasStarted ? '阅读记录' : '开始探索'}</div><div className="cr-topic-title"><h1 tabIndex={-1}>{topicTitle(snapshot.topic, snapshot.project.title)}</h1>{hasStarted && <button type="button" aria-label="浏览源码" onClick={() => reader.current?.browseFiles()}><UiIcon name="file-code-2" size={15} />源码</button>}</div>{hasStarted && <p className="cr-reading-meta">{snapshot.readingMode === 'code' ? '聚焦代码与上下游' : '围绕你的问题'}<span>·</span>{snapshot.state.lessons.length} 个知识点</p>}</header>

                      {returnPoint && <div className="cr-return-bar"><span>原阅读位置已保留</span><button type="button" onClick={returnToRoute}>返回原阅读路线</button></div>}
                      {!hasStarted && !archived ? <section className="cr-start">
                        <div className="cr-entry-modes" aria-label="阅读方式"><button type="button" aria-pressed={entryMode === 'question'} onClick={() => { setEntryMode('question'); setQuestionSelection(null); }}><UiIcon name="message-square-text" size={16} />从问题出发</button><button type="button" aria-pressed={entryMode === 'code'} onClick={() => setEntryMode('code')}><UiIcon name="file-code-2" size={16} />从代码出发</button></div>
                        <h2>{entryMode === 'code' ? '从你关心的那段代码读起' : '你想了解什么？'}</h2><p>{entryMode === 'code' ? '选择一个文件，框选代码。先读逻辑，再看它在项目中的调用链和业务作用。' : '说说业务问题、功能或困惑，阅读会围绕你的目标展开。'}</p>
                        {entryMode === 'code' && !questionSelection ? <div className="cr-code-entry"><span className="cr-code-entry-icon"><UiIcon name="text-select" size={29} /></span><strong>把代码作为起点，而不是整个仓库</strong><p>在源码中选择代码后，使用“让 AI 分析选中代码”。</p><button type="button" className="cr-primary" onClick={chooseCode}><UiIcon name="folder-tree" size={16} />选择代码</button></div> : <form onSubmit={event => { event.preventDefault(); if (!busy && model && (draft.trim() || questionSelection)) lastFailed ? requestPrompt(lastFailed.text, lastFailed.selection, lastFailed.initial, lastFailed.stage, lastFailed) : requestPrompt(draft.trim() || codeGoal, questionSelection, true, questionSelection ? 'deep-read' : 'business'); }}>
                          {questionSelection && <div className="cr-context">{selectionContext}</div>}
                          <label htmlFor="cr-reading-goal" className="cr-sr-only">阅读目标</label><textarea id="cr-reading-goal" aria-label="阅读目标" maxLength={16000} rows={4} value={draft} onChange={event => { setDraft(event.target.value); setLastFailed(null); }} placeholder={questionSelection ? '你想特别了解这段代码的什么？（可选）' : '例如：用户提交订单后，系统是怎样完成支付的？'} />
                          {!questionSelection && <div className="cr-start-shortcuts">{[['了解整体业务', '这个仓库解决什么业务问题？请从核心功能和真实入口开始解释。'], ['寻找功能入口', '我想找到主要功能的真实代码入口，并理解它们分别解决什么问题。']].map(([label, text]) => <button type="button" key={label} onClick={() => { setDraft(text); setLastFailed(null); }}>{label}<span aria-hidden="true"> ↗</span></button>)}</div>}
                          <div className="cr-start-actions"><div className="cr-model-compact">{activeDocument === 'reading' && modelPicker}</div><button className="cr-primary" type="submit" disabled={busy || !model || (!draft.trim() && !questionSelection)}>{lastFailed ? '重试本次分析' : '开始阅读'}<UiIcon name="chevron-right" size={15} /></button></div>
                        </form>}
                        {activeDocument === 'reading' && entryMode === 'code' && !questionSelection && <div className="cr-code-model">{modelPicker}</div>}
                        <p id="cr-model-hint" className={model ? 'cr-sr-only' : 'cr-muted'} role="status">{modelHint}</p><div className="cr-start-footnote"><span id="cr-privacy"><UiIcon name="shield-check" size={13} />源码只读，发送前确认范围</span><button className="cr-text-button" type="button" onClick={() => setDialog('settings')}>阅读设置</button></div>
                      </section> : selectedLesson ? <LessonArticle key={selectedLesson.id} lesson={selectedLesson} evidence={snapshot.state.evidence} repositories={snapshot.project.repositories} Markdown={Markdown} openEvidence={openEvidence} understood={understood.includes(selectedLesson.id)} onUnderstand={toggleUnderstanding} onDeepen={deepen} disabled={busy || running || archived} /> : !running && <section className="cr-result-empty"><UiIcon name="message-square-text" size={24} /><h2>还没有生成阅读内容</h2><p className="cr-muted">{archived ? '这是已归档的空阅读记录。需要继续时可先恢复。' : '可以调整下面的问题后重试。原问题和已保存的位置都还在。'}</p></section>}
                      {hasStarted && topics.length > 0 && <details className="cr-topic-candidates"><summary>还可以了解 · {topics.length}</summary>{topics.map((item, index) => <button className="cr-question" type="button" key={index} disabled={busy || running || archived} onClick={() => deepen(item.title)}><strong>{item.title}</strong><small>{item.description}</small></button>)}</details>}
                      {hasStarted && <details className="cr-inline-transcript"><summary>历史追问与对话记录</summary><p className="cr-muted">{selectedLesson?.turn !== undefined ? '以下仅展示与此知识点同一轮的归档消息。' : '旧记录没有可靠的父知识点关联，保留为会话记录，不推断关联。'}</p><Transcript messages={[...olderMessages, ...snapshot.messages].filter(message => selectedLesson?.turn === undefined || message.turn === selectedLesson.turn)} Markdown={Markdown} openEvidence={openEvidence} /><button type="button" onClick={() => setDialog('messages')}>对话记录</button></details>}
                    </>}
          </div>
          {snapshot && !creating && hasStarted && !archived && activeDocument === 'reading' && <section className="cr-composer">
            <button className="cr-composer-toggle" type="button" aria-expanded={composerOpen} onClick={() => setComposerOpen(value => !value)}><UiIcon name="message-square-text" size={15} />追问当前知识点<span aria-hidden="true">{composerOpen ? '−' : '+'}</span></button>
            <div className="cr-composer-input" hidden={!composerOpen}>
            {questionSelection && <div className="cr-context" aria-label="本次提问上下文">{selectionContext}</div>}
            <label htmlFor="cr-question">追问当前知识点</label><textarea id="cr-question" aria-label="追问当前知识点" value={draft} onChange={event => setDraft(event.target.value)} maxLength={15000} rows={2} placeholder="继续追问，或选择一段代码深入…" disabled={running} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); requestPrompt(followText); } }} />
            </div>
            <div className="cr-composer-actions"><div className="cr-model-compact">{modelPicker}<button type="button" aria-label="阅读设置" onClick={() => setDialog('settings')}>设置</button></div>{!running && <button className="cr-primary" type="button" disabled={busy || !model || snapshotState === 'error'} onClick={() => requestPrompt(followText)}>{draft.trim() ? '发送问题' : '继续阅读'}<UiIcon name="chevron-right" size={14} /></button>}</div>
            <p id="cr-model-hint" className="cr-sr-only">{modelHint}</p><p id="cr-privacy" className="cr-sr-only">源码与问题可能发送至所选提供方配置的服务端点，首次调用或范围变化需确认。</p>{lastFailed && !running && <button type="button" className="cr-retry" disabled={busy} onClick={() => requestPrompt(lastFailed.text, lastFailed.selection, lastFailed.initial, lastFailed.stage, lastFailed)}>重试本次分析</button>}
          </section>}
          {snapshot && !creating && (activeDocument !== 'reading' || snapshot.draft) && <footer className="cr-editor-statusbar" aria-label="阅读状态栏">{activeDocument !== 'reading' && activeDocument !== 'map' && <><span className="cr-editor-readonly"><UiIcon name="shield-check" size={13} />只读</span><div className="cr-editor-model">{modelPicker}</div></>}{snapshot.draft && <span className="cr-draft-notice" role="status">临时阅读，开始前不会保存到阅读列表。关闭或离开不会留下空记录；确认发起分析或保存人工批注时才保留。</span>}{activeDocument !== 'reading' && <>{!mapIsOpen && <button type="button" className="cr-text-button" disabled={!ready || !mapAvailable} onClick={openMap}>项目地图</button>}<button type="button" className="cr-text-button" onClick={() => setDialog('settings')}>阅读设置</button><button type="button" className="cr-text-button" onClick={() => openReading()}>问题阅读</button></>}</footer>}
        </main>
      <aside className="cr-projects cr-route cr-reading-sidebar" aria-label="阅读列表">
        <div className="cr-route-toolbar"><strong>阅读列表</strong><button type="button" aria-label={routeOpen ? '收起列表' : '展开列表'} title={routeOpen ? '收起列表' : '展开列表'} aria-expanded={routeOpen} onClick={() => setRouteOpen(value => !value)}><UiIcon name={routeOpen ? 'chevron-right' : 'chevron-left'} /></button></div>
        <div className="cr-route-inner">
          <button className="cr-new-reading" type="button" disabled={busy || !ready} onClick={() => newReading()}><span aria-hidden="true">＋</span> 新建阅读</button>
          <div className="cr-session-filters" ref={sessionFilters} role="group" aria-label="阅读会话筛选">{[['active', '阅读中'], ['archived', '已归档']].map(([value, label]) => <button type="button" key={value} data-filter={value} aria-pressed={sessionFilter === value} onClick={() => setSessionFilter(value)}>{label}</button>)}</div>
          <div className="cr-history">
            {!listing.projects.length && <p className="cr-list-empty">还没有阅读记录。<br />打开一个仓库，从感兴趣的地方开始。</p>}
            {listing.projects.map(project => {
              const sessions = project.sessions.filter(session => !!session.archivedAt === (sessionFilter === 'archived'));
              return <section className="cr-project" key={project.id}>
                <h3><UiIcon name="folder-tree" size={14} /><span title={project.repositories.map(repo => repo.root).join(' / ')}>{project.title}</span></h3>
                {sessions.map(session => <React.Fragment key={session.id}>
                  <div className="cr-session-row">
                    <button className="cr-session" aria-current={session.id === activeId && !creating ? 'true' : undefined} type="button" disabled={busy} onClick={() => openReading(session.id)}><span className="cr-session-title">{topicTitle(session.topic, '新的阅读')}</span><small>{(session.id === snapshot?.sessionId ? snapshot.readingMode : session.readingMode) === 'code' ? '代码阅读' : '问题阅读'}<span aria-hidden="true"> · </span>{new Date(session.createdAt).toLocaleDateString()}</small></button>
                    <button className="cr-session-archive" type="button" aria-label={`${session.archivedAt ? '恢复' : '归档'}阅读：${topicTitle(session.topic)}`} title={session.archivedAt ? '恢复到阅读中' : '归档，不删除内容'} disabled={busy || (session.id === activeId && running)} onClick={() => void perform(() => setSessionArchived(session.id === snapshot?.sessionId ? snapshot : session, !session.archivedAt))}>{session.archivedAt ? '恢复' : '归档'}</button>
                  </div>
                  {snapshot?.sessionId === session.id && !creating && <ReadingRoute snapshot={snapshot} selectedId={selectedId} viewed={viewed} understood={understood} onLesson={selectLesson} />}
                </React.Fragment>)}
                {!sessions.length && <p className="cr-list-empty">{sessionFilter === 'archived' ? '暂无已归档阅读' : '暂无阅读中的会话'}</p>}
                {sessionFilter === 'active' && !sessions.length && <button className="cr-new-session" disabled={busy || !ready} type="button" onClick={() => newReading(project)}>＋ 新阅读会话</button>}
              </section>;
            })}
          </div>
        </div>
        {snapshot && !snapshot.draft && !creating && <div className="cr-route-footer"><button type="button" onClick={() => setDialog('artifacts')}><UiIcon name="files" size={14} />阅读产物</button><button type="button" title="保存阅读位置" aria-label="保存阅读位置" disabled={busy} onClick={() => void savePosition(true)}><UiIcon name="text-select" size={15} /></button></div>}
      </aside>
      </FileWorkspace>
    </div>
    {confirmation && <SourceConsent model={model} repositories={snapshot?.project.repositories ?? []} selection={confirmation.selection} onClose={() => setConfirmation(null)} onConfirm={() => { const request = confirmation; setConfirmation(null); if (request.scope !== scope || request.sessionId !== activeRef.current) { setError('模型或主题已经变化，请重新确认。'); return; } consent.current = scope; void perform(() => dispatchPrompt(request.text, request.selection, request.initial, request.stage, request.retryAttempt, request.intent)); }} />}
    {dialog && <ReadingDialog key={dialog} className={dialog === 'settings' ? 'cr-settings-dialog' : ''} title={{ settings: '阅读设置', artifacts: '阅读产物', messages: '对话记录', help: '安装与使用', projects: '阅读仓库', 'remove-project': '删除仓库' }[dialog]} onClose={() => { if (dialog !== 'remove-project' || !busy) { setRemovingProject(null); setDialog(''); } }}>
      {dialog === 'help' && <InstallationHelp connection={connection} modelsState={modelsState} models={models} />}
      {dialog === 'settings' && <ReadingSettings dataDirectory={connection.status?.dataDirectory || listing.root} models={models} modelsState={modelsState} refreshModels={refreshModels} connected={connection.state === 'ready'} onVersionMismatch={error => { if (mounted.current) setConnection({ state: 'error', status: null, error }); }} />}
      {dialog === 'artifacts' && <><p>已归档的知识点、调用图、对话与人工批注保留在阅读目录，不写回源码仓库。</p><ul><li>{snapshot?.state.lessons.length ?? 0} 个知识点 · Markdown</li><li>{snapshot?.state.evidence.length ?? 0} 条源码证据 · 路径、行号与 SHA256</li><li>Mermaid 图源码、问答、访问审计与人工批注</li></ul><button type="button" className="cr-primary" disabled={busy} onClick={() => void perform(async () => { const id = activeId; const epoch = viewEpoch.current; const exported = await api('export', { sessionId: id }); if (activeRef.current === id && viewEpoch.current === epoch) setNotice(`阅读档案已导出到：${exported.path}`); })}>导出档案</button><p className="cr-muted">导出仅写入阅读档案目录。记录可能含代码片段，请按项目敏感级别管理。</p><details><summary>产物目录与格式</summary><p className="cr-path">{snapshot?.outputDirectory}</p><ul><li>state.json：阅读状态与证据索引</li><li>notes/ 与 diagrams/：知识点与图源码</li><li>messages/ 与 audit.jsonl：问答与访问审计</li><li>annotations.json：人工批注与版本历史</li><li>exports/reading.md：汇总导出</li></ul></details></>}
      {dialog === 'messages' && <>{snapshot?.hasMoreMessages && <button type="button" disabled={busy} onClick={() => void perform(loadOlderMessages)}>加载更早对话</button>}<Transcript messages={[...olderMessages, ...(snapshot?.messages ?? [])]} Markdown={Markdown} openEvidence={id => { setDialog(''); void openEvidence(id); }} /></>}
      {dialog === 'projects' && listing.projects.map(project => <section className="cr-managed-project" key={project.id}><h3>{project.title}</h3>{project.repositories.map(repo => <p className="cr-path" key={repo.id}>{repo.root}</p>)}<div className="cr-row"><button type="button" disabled={busy || !ready} onClick={() => { setDialog(''); newReading(project); }}>＋ 新阅读会话</button><button type="button" className="cr-remove-project" aria-label={`删除仓库：${project.title}`} disabled={busy || !ready || (project.id === currentProject?.id && running)} onClick={() => { setError(''); setRemovingProject(project); setDialog('remove-project'); }}>删除仓库</button></div></section>)}
      {dialog === 'remove-project' && removingProject && <><p>从仓库选择和阅读列表移除 <strong>{removingProject.title}</strong>？</p>{removingProject.repositories.map(repo => <p className="cr-path" key={repo.id}>{repo.root}</p>)}<p>不会删除磁盘上的源码目录，已有知识点、证据、对话和批注仍保留在原阅读档案目录。此操作移除整个阅读项目，不改变其中的仓库绑定；重新打开同一目录会新建项目。</p>{error && <p className="cr-error" role="alert">{error}</p>}<div className="cr-row"><button type="button" disabled={busy} onClick={() => { setRemovingProject(null); setDialog('projects'); }}>取消</button><button type="button" className="cr-remove-project" disabled={busy || !ready || (removingProject.id === currentProject?.id && running)} onClick={() => void perform(() => removeProject(removingProject))}>{busy ? '正在移除…' : '确认移除'}</button></div></>}
    </ReadingDialog>}
  </div>;
}
export function apply(ctx) {
  ctx.effect(() => { const style = document.createElement('style'); style.dataset.plugin = 'dsh-code-reading'; style.textContent = css; document.head.appendChild(style); return () => style.remove(); }, 'code-reading: styles');
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'code-reading', order: 10, label: '阅读代码' }, BookIcon));
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'code-reading', inject: () => ({ pickDirectory: () => ctx.uiWorkspace.pickDirectory() }) }, ReadingPanel));
}
