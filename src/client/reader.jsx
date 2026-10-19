import React, { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { EntryIcon } from './entry-icon.jsx';
import { UiIcon } from './icons/ui-icons.jsx';
import { api } from './api.mjs';
import { CodeBlock } from './code.jsx';
import { readCodeSelection } from './selection.mjs';
import { mergeAnnotations } from './annotation-state.mjs';
import { ANNOTATION_LABELS } from '../anchors.mjs';

const ReaderContext = createContext(null);
const MAX_OPEN_FILES = 12;
const fileKey = file => JSON.stringify([file.repoId, file.path]);
const sameFile = (left, right) => !!left && !!right && left.repoId === right.repoId && left.path === right.path;
const emptyViewport = () => ({ scrollTop: 0, scrollLeft: 0, panelScrollTop: 0 });
const titleOf = anchor => `${anchor.path}:${anchor.start.line}:${anchor.start.column + 1}–${anchor.end.line}:${anchor.end.column + 1}`;
export function FileWorkspace({ sessionId, repositories, repoId, onRepoChange, enabled, activeDocument = 'source', onOpen, onAnalyze, onGraph, onReading, analyzeDisabled, onController, onContextSelection, children }) {
  const [target, setTarget] = useState(null); const [document, setDocument] = useState(null); const [loadState, setLoadState] = useState('idle'); const [error, setError] = useState(''); const [nonce, setNonce] = useState(0); const [openFiles, setOpenFiles] = useState([]);
  const [allNotes, setAllNotes] = useState([]); const [noteRevision, setNoteRevision] = useState(0); const [selected, setSelected] = useState(null); const [draft, setDraft] = useState(null); const [activeNote, setActiveNote] = useState(''); const [rail, setRail] = useState('files'); const [expanded, setExpanded] = useState(() => typeof window !== 'undefined' && !window.matchMedia('(max-width:900px)').matches); const [maximized, setMaximized] = useState(false); const [width, setWidth] = useState(256); const [mutating, setMutating] = useState(false);
  const alive = useRef(false); const viewSeq = useRef(0); const noteSeq = useRef(0); const viewAbort = useRef(null); const noteAbort = useRef(null); const requests = useRef(new Map()); const mutationLock = useRef(false); const current = useRef(null); const methods = useRef(null); const controllerCallback = useRef(onController); const viewerNodes = useRef(new Set()); const pendingScroll = useRef(null); const queuedRestore = useRef(null); const previousSession = useRef(sessionId); const lastScroll = useRef(emptyViewport()); const filePositions = useRef(new Map()); const filesRef = useRef(openFiles); const sessionScope = useRef({ sessionId, epoch: 0 });
  if (sessionScope.current.sessionId !== sessionId) sessionScope.current = { sessionId, epoch: sessionScope.current.epoch + 1 };
  const currentSession = previousSession.current === sessionId;
  const visibleTarget = currentSession ? target : null; const visibleDocument = currentSession && enabled && document?.repoId === repoId ? document : null;
  controllerCallback.current = onController; filesRef.current = openFiles;
  current.current = { sessionId, repoId, target: visibleTarget, enabled, document: visibleDocument, rail, expanded, maximized, width, activeDocument };
  useEffect(() => { alive.current = true; return () => { alive.current = false; viewAbort.current?.abort(); noteAbort.current?.abort(); }; }, []);
  useEffect(() => { const media = window.matchMedia('(max-width:900px)'); const collapse = () => { if (media.matches) { setExpanded(false); setMaximized(false); } }; collapse(); media.addEventListener('change', collapse); return () => media.removeEventListener('change', collapse); }, []);
  function valid(sequence, controller) { const now = current.current; return alive.current && !controller.signal.aborted && sequence === viewSeq.current && now.enabled && now.sessionId === sessionId && now.repoId === target?.repoId && now.target?.repoId === target?.repoId && now.target?.path === target?.path && now.target?.offset === target?.offset; }
  async function reloadNotes() {
    noteAbort.current?.abort(); const controller = new AbortController(); noteAbort.current = controller; const seq = ++noteSeq.current;
    try { const result = await api('annotations', { sessionId }, controller.signal); if (alive.current && !controller.signal.aborted && noteSeq.current === seq && current.current.enabled && current.current.sessionId === sessionId) { setAllNotes(result.items); setNoteRevision(result.revision); } }
    catch (e) { if (alive.current && !controller.signal.aborted && noteSeq.current === seq && current.current.enabled && current.current.sessionId === sessionId) setError(e.message); }
  }
  useEffect(() => {
    const sessionChanged = previousSession.current !== sessionId; previousSession.current = sessionId;
    setSelected(null); setDocument(null); setLoadState('idle'); setError(''); viewAbort.current?.abort(); ++viewSeq.current; setTarget(previous => !sessionChanged && previous?.repoId === repoId ? previous : null);
    if (sessionChanged) { noteAbort.current?.abort(); ++noteSeq.current; setAllNotes([]); setNoteRevision(0); setDraft(null); setActiveNote(''); requests.current.clear(); pendingScroll.current = null; queuedRestore.current = null; lastScroll.current = emptyViewport(); setMaximized(false); }
    // Open tabs and their position-only metadata belong to this mounted project,
    // not to the transient repoId='' while another session snapshot is loading.
  }, [repoId, enabled, sessionId]);
  useEffect(() => { if (enabled) void reloadNotes(); else noteAbort.current?.abort(); }, [enabled, sessionId]);
  useEffect(() => {
    viewAbort.current?.abort(); const seq = ++viewSeq.current; const controller = new AbortController(); viewAbort.current = controller; setSelected(null); setDocument(null);
    if (!enabled || !visibleTarget || target.repoId !== repoId) { setLoadState('idle'); return () => controller.abort(); }
    setLoadState('loading'); setError('');
    void api('view-file', { sessionId, repoId: target.repoId, path: target.path, offset: target.offset, limit: target.limit ?? 200 }, controller.signal).then(value => {
      if (!valid(seq, controller)) return;
      if (value.repoId !== target.repoId || value.path !== target.path || value.offset !== target.offset || typeof value.hash !== 'string' || !Array.isArray(value.lines)) throw new Error('源码响应与请求的位置不一致，请重新加载');
      setDocument(value); setLoadState('ready');
    }).catch(e => {
      if (!valid(seq, controller)) return;
      if (e.code === 'LINE_RANGE' && target.expectedHash && target.offset > 1 && !target.unavailableOffset) {
        pendingScroll.current = { repoId: target.repoId, path: target.path, offset: 1, scrollTop: 0, scrollLeft: 0 };
        setTarget(previous => previous?.repoId === target.repoId && previous?.path === target.path && previous?.offset === target.offset ? { ...previous, offset: 1, unavailableOffset: target.offset } : previous); return;
      }
      setError(e.message); setLoadState('error'); void reloadNotes();
    });
    return () => controller.abort();
  }, [sessionId, repoId, target?.repoId, target?.path, target?.offset, target?.limit, enabled, nonce]);
  useEffect(() => {
    if (activeDocument !== 'source') { const saved = capturePosition(); if (saved && !pendingScroll.current) pendingScroll.current = positionOnly(saved); }
  }, [activeDocument]);
  useEffect(() => {
    if (!visibleDocument || activeDocument !== 'source') return;
    const frame = requestAnimationFrame(() => {
      const pending = pendingScroll.current;
      if (!pending || pending.repoId !== visibleDocument.repoId || pending.path !== visibleDocument.path || pending.offset !== visibleDocument.offset) return;
      let applied = false;
      for (const node of viewerNodes.current) {
        const pre = node.querySelector('.cr-code-body'); if (!pre || !node.getClientRects().length) continue;
        const panel = node.closest('.cr-source-document') ?? node;
        if (pending.focusLine) { const row = node.querySelector(`[data-code-line="${pending.focusLine}"]`); if (row) pre.scrollTop = Math.max(0, row.getBoundingClientRect().top - pre.getBoundingClientRect().top + pre.scrollTop - 48); }
        else pre.scrollTop = pending.scrollTop ?? 0;
        pre.scrollLeft = pending.scrollLeft ?? 0; panel.scrollTop = pending.panelScrollTop ?? 0;
        if (pending.focusViewer) pre.focus({ preventScroll: true }); applied = true;
      }
      if (applied) { lastScroll.current = { scrollTop: pending.scrollTop ?? 0, scrollLeft: pending.scrollLeft ?? 0, panelScrollTop: pending.panelScrollTop ?? 0 }; pendingScroll.current = null; }
    });
    return () => cancelAnimationFrame(frame);
  }, [visibleDocument, activeDocument]);
  useEffect(() => { const pending = queuedRestore.current; if (enabled && pending?.sessionId === sessionId) { queuedRestore.current = null; restorePosition(pending.position, { activate: pending.activate }); } }, [enabled, sessionId, repositories]);
  function showSource(nextTarget = current.current.target) {
    onOpen?.(nextTarget);
    if (window.matchMedia('(max-width:900px)').matches) setExpanded(false);
  }
  function browseFiles() { capturePosition(); setRail('files'); setExpanded(true); setMaximized(false); }
  function close() { capturePosition(); setExpanded(false); setMaximized(false); }
  function positionOnly(position) {
    return { repoId: position.repoId, path: position.path, hash: position.hash ?? null, offset: position.offset, limit: Number.isSafeInteger(position.limit) ? Math.max(1, Math.min(400, position.limit)) : 200, scrollTop: position.scrollTop ?? 0, scrollLeft: position.scrollLeft ?? 0, panelScrollTop: position.panelScrollTop ?? 0 };
  }
  function rememberPosition(position) {
    if (position && filesRef.current.some(file => sameFile(file, position))) filePositions.current.set(fileKey(position), positionOnly(position));
  }
  function upsertFile(next) {
    const files = filesRef.current; if (files.some(file => sameFile(file, next))) return;
    const updated = [...files, { repoId: next.repoId, path: next.path }].slice(-MAX_OPEN_FILES);
    const retained = new Set(updated.map(fileKey)); for (const key of filePositions.current.keys()) if (!retained.has(key)) filePositions.current.delete(key);
    filesRef.current = updated; setOpenFiles(updated);
  }
  function openTarget(next, viewport = {}, { activate = true } = {}) {
    if (!enabled || !repositories.some(repo => repo.id === next.repoId)) return false;
    capturePosition(); upsertFile(next);
    viewAbort.current?.abort(); ++viewSeq.current; setSelected(null); setDocument(null); setLoadState('loading'); setError('');
    const focusViewer = activate && window.matchMedia('(max-width:900px)').matches && !!window.document.activeElement?.closest('.cr-file-sidebar');
    pendingScroll.current = { repoId: next.repoId, path: next.path, offset: next.offset, focusViewer, ...viewport }; lastScroll.current = { scrollTop: viewport.scrollTop ?? 0, scrollLeft: viewport.scrollLeft ?? 0, panelScrollTop: viewport.panelScrollTop ?? 0 };
    if (next.repoId !== repoId) onRepoChange?.(next.repoId);
    setTarget(next); setNonce(value => value + 1); if (activate) showSource(next); return true;
  }
  function activateFile(file, { activate = true } = {}) {
    if (!file || !filesRef.current.some(item => sameFile(item, file))) return false;
    if (sameFile(current.current.target, file)) capturePosition();
    const saved = filePositions.current.get(fileKey(file));
    return openTarget({ repoId: file.repoId, path: file.path, offset: saved?.offset ?? 1, limit: saved?.limit ?? 200, ...(saved?.hash ? { expectedHash: saved.hash } : {}) }, saved ?? {}, { activate });
  }
  // True means the visible source document was closed without a replacement.
  function closeFile(file) {
    const files = filesRef.current; const index = files.findIndex(item => sameFile(item, file)); if (index < 0) return false;
    const active = sameFile(current.current.target, file); const sourceVisible = current.current.activeDocument === 'source'; if (active) capturePosition();
    const remaining = files.filter(item => !sameFile(item, file)); filesRef.current = remaining; setOpenFiles(remaining); filePositions.current.delete(fileKey(file));
    if (!active) return false;
    const adjacent = remaining[Math.min(index, remaining.length - 1)];
    if (adjacent && activateFile(adjacent, { activate: sourceVisible })) return false;
    viewAbort.current?.abort(); ++viewSeq.current; setTarget(null); setDocument(null); setSelected(null); setLoadState('idle'); setError(''); pendingScroll.current = null; lastScroll.current = emptyViewport(); setMaximized(false);
    return sourceVisible;
  }
  function openFile(path, fileRepo = repoId, line = 1) {
    if (typeof path !== 'string' || !path || !Number.isSafeInteger(Number(line)) || Number(line) < 1) return false;
    return openTarget({ repoId: fileRepo, path, offset: Number(line) });
  }
  function openEvidence(source) {
    const evidence = source?.evidence;
    if (!evidence || (evidence.sessionId && evidence.sessionId !== sessionId) || typeof evidence.path !== 'string' || !/^[a-f\d]{64}$/i.test(evidence.hash ?? '') || !Number.isSafeInteger(evidence.startLine) || !Number.isSafeInteger(evidence.endLine) || evidence.startLine < 1 || evidence.endLine < evidence.startLine || !repositories.some(repo => repo.id === evidence.repoId)) { setError('证据位置无效或不属于当前阅读会话'); return false; }
    const range = evidence.endLine - evidence.startLine + 1; const offset = Math.max(1, evidence.startLine - (range < 390 ? 5 : 0));
    // API excerpts are not a file snapshot. Re-read the actual file and compare SHA256 before highlighting.
    return openTarget({ repoId: evidence.repoId, path: evidence.path, offset, limit: Math.min(400, Math.max(200, range + 10)), expectedHash: evidence.hash, evidence: { id: evidence.id, sessionId, repoId: evidence.repoId, path: evidence.path, hash: evidence.hash, startLine: evidence.startLine, endLine: evidence.endLine, symbol: evidence.symbol ?? '', stale: source.stale === true, reason: source.reason ?? '' } }, { focusLine: evidence.startLine });
  }
  function rememberViewport(node) {
    const pre = node?.querySelector('.cr-code-body'); const now = current.current;
    if (pre && now.document && now.activeDocument === 'source' && node.getClientRects().length) { lastScroll.current = { scrollTop: pre.scrollTop, scrollLeft: pre.scrollLeft, panelScrollTop: (node.closest('.cr-source-document') ?? node).scrollTop }; rememberPosition({ ...now.target, hash: now.document.hash, ...lastScroll.current }); }
  }
  function capturePosition() {
    const now = current.current; if (!now.target) return null;
    for (const node of viewerNodes.current) { const pre = node.querySelector('.cr-code-body'); if (pre && node.getClientRects().length) { lastScroll.current = { scrollTop: pre.scrollTop, scrollLeft: pre.scrollLeft, panelScrollTop: (node.closest('.cr-source-document') ?? node).scrollTop }; break; } }
    const matching = sameFile(now.document, now.target) && now.document.offset === now.target.offset;
    const position = { repoId: now.target.repoId, path: now.target.path, hash: matching ? now.document.hash : now.target.expectedHash ?? null, offset: now.target.offset, limit: now.target.limit ?? 200, ...lastScroll.current, rail: now.rail, expanded: now.expanded, maximized: now.maximized, width: now.width, ...(now.target.evidence ? { evidence: { ...now.target.evidence } } : {}) };
    rememberPosition(position); return position;
  }
  function restorePosition(position, { activate = true } = {}) {
    if (!position || typeof position.repoId !== 'string' || typeof position.path !== 'string' || !position.path || !Number.isSafeInteger(position.offset) || position.offset < 1 || (position.hash != null && !/^[a-f\d]{64}$/i.test(position.hash))) return false;
    if (!enabled) { queuedRestore.current = { sessionId, position: structuredClone(position), activate }; return true; }
    const viewport = {}; for (const key of ['scrollTop', 'scrollLeft', 'panelScrollTop']) viewport[key] = Number.isFinite(position[key]) && position[key] >= 0 ? position[key] : 0;
    const evidence = position.evidence?.sessionId === sessionId && position.evidence.repoId === position.repoId && position.evidence.path === position.path ? { ...position.evidence } : undefined;
    if (!openTarget({ repoId: position.repoId, path: position.path, offset: position.offset, limit: evidence ? Math.min(400, Math.max(200, evidence.endLine - position.offset + 1)) : 200, expectedHash: evidence?.hash ?? position.hash ?? undefined, ...(evidence ? { evidence } : {}) }, viewport, { activate })) return false;
    if (['files', 'notes'].includes(position.rail)) setRail(position.rail);
    if (typeof position.expanded === 'boolean' && (!activate || !window.matchMedia('(max-width:900px)').matches)) setExpanded(position.expanded);
    setMaximized(position.maximized === true); if (Number.isFinite(position.width)) setWidth(Math.max(200, Math.min(420, position.width))); return true;
  }
  function reloadFile() { const saved = capturePosition(); if (saved) pendingScroll.current = positionOnly(saved); setSelected(null); setNonce(value => value + 1); }
  const controller = useMemo(() => Object.fromEntries(['openEvidence', 'capturePosition', 'restorePosition', 'browseFiles', 'showSource', 'openFile', 'close', 'activateFile', 'closeFile'].map(name => [name, (...args) => methods.current[name](...args)])), []);
  methods.current = { openEvidence, capturePosition, restorePosition, browseFiles, showSource, openFile, close, activateFile, closeFile };
  useEffect(() => { const callback = controllerCallback.current; callback?.(controller); return () => callback?.(null); }, [controller]);
  const notes = useMemo(() => mergeAnnotations(currentSession ? allNotes : [], visibleDocument, currentSession ? noteRevision : 0), [allNotes, visibleDocument, noteRevision, currentSession]);
  async function mutate(method, params) {
    if (mutationLock.current || !enabled) return; mutationLock.current = true; setMutating(true); setError(''); const epoch = sessionScope.current.epoch;
    const key = JSON.stringify({ method, ...params }); const requestId = requests.current.get(key) ?? crypto.randomUUID(); requests.current.set(key, requestId);
    const validMutation = () => alive.current && current.current.enabled && current.current.sessionId === sessionId && sessionScope.current.epoch === epoch;
    try {
      const result = await api(method, { sessionId, requestId, ...params });
      if (!validMutation()) return; requests.current.delete(key); setDraft(null); setActiveNote(result.item.id); setAllNotes(previous => [...previous.filter(item => item.id !== result.item.id), { ...result.item, location: { status: 'unchecked', needsReview: result.item.needsReview } }]); await reloadNotes(); if (validMutation()) reloadFile();
    } catch (e) { if (validMutation()) setError(e.message + '。结果不确定时，先刷新批注；相同操作重试会沿用请求凭据。'); }
    finally { mutationLock.current = false; if (alive.current) setMutating(false); }
  }
  function annotate(selection) { if (mutationLock.current || !enabled) return; setDraft({ selection: structuredClone(selection), body: '' }); setRail('notes'); setExpanded(true); setMaximized(false); }
  function reveal(note) { setActiveNote(note.id); const point = note.location?.candidate?.start ?? note.anchor.start; openFile(note.anchor.path, note.anchor.repoId, Math.max(1, point.line - 5)); }
  function pinContext(selection) { if (selection && enabled) onContextSelection?.(structuredClone(selection)); }
  const value = { enabled, sessionId, repositories, repoId, onRepoChange, activeDocument, target: visibleTarget, document: visibleDocument, loadState: currentSession ? loadState : 'idle', error: currentSession ? error : '', setError, selected: currentSession ? selected : null, setSelected, draft: currentSession ? draft : null, setDraft, activeNote: currentSession ? activeNote : '', setActiveNote, rail, setRail, expanded, setExpanded, maximized, setMaximized, width, setWidth, mutating, notes, openFiles, activateFile, closeFile, openFile, reloadFile, reloadNotes, annotate, reveal, mutate, onAnalyze, onGraph, onReading, analyzeDisabled, pinContext, browseFiles, showSource, viewerNodes, rememberViewport };
  return <ReaderContext.Provider value={value}>{children}</ReaderContext.Provider>;
}
export function DocumentTabs({ activeDocument, readingDocuments = [], activeSessionId, onReading, onCloseReading, onEmpty }) {
  const r = useContext(ReaderContext); const nav = useRef(null); const activeReadingTitle = readingDocuments.find(document => document.sessionId === activeSessionId)?.title;
  function revealActive() { nav.current?.querySelector('.cr-document-tab[data-active="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  useEffect(revealActive, [activeDocument, activeSessionId, activeReadingTitle, r.target?.repoId, r.target?.path, r.openFiles.length, readingDocuments.length]);
  useEffect(() => { if (!nav.current || typeof ResizeObserver === 'undefined') return; const observer = new ResizeObserver(revealActive); observer.observe(nav.current); return () => observer.disconnect(); }, []);
  function navigate(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const button = event.target.closest('.cr-document-tab-button'); if (!button) return;
    const buttons = [...event.currentTarget.querySelectorAll('.cr-document-tab-button:not(:disabled)')]; const index = buttons.indexOf(button); let next;
    if (event.key === 'ArrowLeft') next = buttons[Math.max(0, index - 1)];
    else if (event.key === 'ArrowRight') next = buttons[Math.min(buttons.length - 1, index + 1)];
    else if (event.key === 'Home') next = buttons[0]; else if (event.key === 'End') next = buttons.at(-1); else return;
    event.preventDefault(); next?.focus({ preventScroll: true }); next?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function refocus(index) {
    requestAnimationFrame(() => { const buttons = [...(nav.current?.querySelectorAll('.cr-document-tab-button:not(:disabled)') ?? [])]; const button = buttons[Math.min(index, buttons.length - 1)]; (button ?? nav.current)?.focus({ preventScroll: true }); });
  }
  return <nav ref={nav} className="cr-document-tabs" aria-label="打开的文档" tabIndex={-1} onKeyDown={navigate}>
    {r.openFiles.map((file, index) => <div className="cr-document-tab" data-active={activeDocument === 'source' && sameFile(r.target, file) ? 'true' : 'false'} key={fileKey(file)}>
      <button type="button" className="cr-document-tab-button" data-document-kind="source" title={file.path} aria-pressed={activeDocument === 'source' && sameFile(r.target, file)} disabled={!r.enabled} onClick={() => r.activateFile(file)}><EntryIcon path={file.path} /><span>{file.path.split('/').at(-1)}</span></button>
      <button type="button" className="cr-document-tab-close" aria-label={`关闭文件 ${file.path}`} title={`关闭文件 ${file.path}`} onClick={() => { if (r.closeFile(file)) onEmpty?.(); refocus(index); }}><span aria-hidden="true">×</span></button>
    </div>)}
    {readingDocuments.map((doc, index) => <div className="cr-document-tab" data-active={activeDocument === 'reading' && doc.sessionId === activeSessionId ? 'true' : 'false'} key={`reading:${doc.sessionId}`}>
      <button type="button" className="cr-document-tab-button" data-document-kind="reading" title={doc.title} aria-pressed={activeDocument === 'reading' && doc.sessionId === activeSessionId} onClick={() => onReading?.(doc)}><svg className="cr-document-book-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1m0-15c3-2 7-2 10-1v15c-3-1-7-1-10 1V5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg><span>{doc.title}</span></button>
      <button type="button" className="cr-document-tab-close" aria-label={`关闭阅读 ${doc.title}`} title={`关闭阅读 ${doc.title}`} onClick={() => { onCloseReading?.(doc); refocus(r.openFiles.length + index); }}><span aria-hidden="true">×</span></button>
    </div>)}
  </nav>;
}
function Directory({ path = '', label = '仓库根目录', depth = 0, collapseVersion = 0 }) {
  const reader = useContext(ReaderContext);
  const [open, setOpen] = useState(path === '');
  const [entries, setEntries] = useState([]); const [next, setNext] = useState(null); const [budget, setBudget] = useState(false);
  const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const groupId = useId();
  const alive = useRef(false); const sequence = useRef(0); const abort = useRef(null); const locked = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; abort.current?.abort(); ++sequence.current; }; }, []);
  useEffect(() => { if (path) setOpen(false); }, [collapseVersion]);
  async function load(offset = 0) {
    if (locked.current) return; locked.current = true; const seq = ++sequence.current; abort.current?.abort(); const controller = new AbortController(); abort.current = controller; setLoading(true); setError('');
    try { const result = await api('tree', { sessionId: reader.sessionId, repoId: reader.repoId, directory: path, offset }, controller.signal); if (!alive.current || controller.signal.aborted || seq !== sequence.current) return; setEntries(previous => offset ? [...previous, ...result.entries] : result.entries); setNext(result.nextOffset); setBudget(result.budgetTruncated); }
    catch (e) { if (alive.current && !controller.signal.aborted && seq === sequence.current) setError(e.message); }
    finally { if (seq === sequence.current) { locked.current = false; if (alive.current) setLoading(false); } }
  }
  useEffect(() => { if (open) void load(); else { abort.current?.abort(); ++sequence.current; locked.current = false; setLoading(false); } }, [open]);
  return <div className="cr-directory" data-directory-path={path}>
    <button type="button" className={`cr-tree-folder${path ? '' : ' cr-tree-root'}`} title={path || '仓库根目录'} aria-expanded={open} aria-controls={groupId} onClick={() => setOpen(value => !value)}>
      <UiIcon name="chevron-right" size={14} className={`cr-tree-chevron${open ? ' cr-tree-chevron-open' : ''}`} />
      <EntryIcon path={path} folder open={open} root={!path} />
      <span className="cr-tree-name">{label}</span>{!path && <span className="cr-tree-root-tag">根目录</span>}
    </button>

    {open && <div className="cr-tree-children" id={groupId}>
      {loading && <p className="cr-tree-feedback" role="status">正在加载目录…</p>}
      {error && <div role="alert" className="cr-tree-feedback cr-error">{error}<button type="button" onClick={() => load()}>重试目录</button>
</div>}
      {entries.map(entry => entry.kind === 'directory'
        ? depth < 32 ? <Directory key={entry.path} path={entry.path} label={entry.name} depth={depth + 1} collapseVersion={collapseVersion} /> : <p className="cr-tree-feedback" key={entry.path}>目录层级过深，请用路径检索。</p>
        : <button type="button" className="cr-tree-file" key={entry.path} title={entry.path} aria-current={reader.target?.path === entry.path && reader.target?.repoId === reader.repoId ? 'true' : undefined} onClick={() => reader.openFile(entry.path)}>
          <span className="cr-tree-spacer" aria-hidden="true" /><EntryIcon path={entry.path} /><span className="cr-tree-name">{entry.name}</span>
        </button>
)}
      {!loading && !error && !entries.length && <p className="cr-muted cr-tree-feedback">无可浏览文件（敏感项和链接不显示）。</p>}
      {next !== null && <button className="cr-tree-more" type="button" disabled={loading} onClick={() => load(next)}>加载更多目录项</button>
}
      {budget && <p className="cr-muted cr-tree-feedback">目录扫描达到上限，列表不完整，请缩小路径范围。</p>}
    </div>}
  </div>;
}

// Keep native button/Tab semantics, with optional IDE-like arrow navigation.
// This is deliberately not an ARIA tree: it does not impose a roving-tabindex contract.
function navigateDirectory(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const row = event.target.closest('.cr-tree-folder,.cr-tree-file');
  if (!row || !event.currentTarget.contains(row)) return;
  const rows = [...event.currentTarget.querySelectorAll('.cr-tree-folder,.cr-tree-file')];
  const index = rows.indexOf(row); let target;
  if (event.key === 'ArrowDown') target = rows[Math.min(index + 1, rows.length - 1)];
  else if (event.key === 'ArrowUp') target = rows[Math.max(0, index - 1)];
  else if (event.key === 'Home') target = rows[0];
  else if (event.key === 'End') target = rows.at(-1);
  else if (event.key === 'ArrowRight' && row.classList.contains('cr-tree-folder')) {
    if (row.getAttribute('aria-expanded') === 'false') row.click();
    // Anchor to this directory: an unscoped descendant selector can match the
    // current folder through a .cr-tree-children ancestor outside this subtree.
    else target = row.parentElement.querySelector(':scope > .cr-tree-children > .cr-directory > .cr-tree-folder,:scope > .cr-tree-children > .cr-tree-file');
  } else if (event.key === 'ArrowLeft') {
    if (row.getAttribute('aria-expanded') === 'true') row.click();
    else {
      const directory = row.closest('.cr-directory');
      const parent = row.classList.contains('cr-tree-folder') ? directory?.parentElement.closest('.cr-directory') : directory;
      target = parent?.querySelector(':scope > .cr-tree-folder');
    }
  } else return;
  event.preventDefault(); event.stopPropagation();
  target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function FileSearch() {
  const r = useContext(ReaderContext); const [query, setQuery] = useState(''); const [results, setResults] = useState(null); const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const sequence = useRef(0); const abort = useRef(null); const current = useRef(null); const alive = useRef(false);
  current.current = { sessionId: r.sessionId, repoId: r.repoId, enabled: r.enabled };
  useEffect(() => { alive.current = true; return () => { alive.current = false; abort.current?.abort(); ++sequence.current; }; }, []);
  useEffect(() => { abort.current?.abort(); ++sequence.current; setResults(null); setLoading(false); setError(''); }, [r.sessionId, r.repoId, r.enabled]);
  async function search(method) {
    if (!r.enabled || !r.repoId || !query.trim()) return;
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller; const seq = ++sequence.current; const sessionId = r.sessionId; const repoId = r.repoId; setLoading(true); setError(''); setResults(null);
    const valid = () => alive.current && !controller.signal.aborted && seq === sequence.current && current.current.enabled && current.current.sessionId === sessionId && current.current.repoId === repoId;
    try {
      const value = await api(method, { sessionId, repoId, ...(method === 'search' ? { query: query.trim() } : { filter: query.trim() }) }, controller.signal);
      if (!valid()) return;
      const items = method === 'search' ? value.matches : value.paths.map(path => ({ path, repoId: value.repoId }));
      setResults({ items, truncated: value.truncated });
    } catch (e) { if (valid()) setError(e.message); }
    finally { if (valid()) setLoading(false); }
  }
  return <section className="cr-file-search" aria-label="仓库源码检索"><form onSubmit={event => { event.preventDefault(); void search('search'); }}><input aria-label="检索内容或路径" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} placeholder="查找代码内容或文件路径" /><div className="cr-file-search-actions"><button type="submit" disabled={loading || !query.trim()}>搜索内容</button><button type="button" disabled={loading || !query.trim()} onClick={() => void search('files')}>按路径查找</button></div></form>{loading && <p role="status">正在检索…</p>}{error && <p className="cr-error" role="alert">{error}</p>}{results && <div className="cr-file-search-results">{results.truncated && <p className="cr-muted">结果或扫描范围已截断，请缩小检索范围。</p>}{!results.items.length && <p className="cr-muted">没有匹配项。</p>}{results.items.map((item, index) => <button type="button" className="cr-evidence" key={`${item.repoId}:${item.path}:${item.line ?? index}`} title={item.path} onClick={() => r.openFile(item.path, item.repoId, item.line ?? 1)}>{item.path}{item.line ? `:${item.line}` : ''}{item.text && <small>{item.text}</small>}</button>)}</div>}</section>;
}
export function FileRail() {
  const r = useContext(ReaderContext); const [all, setAll] = useState(false);
  const [treeVersion, setTreeVersion] = useState(0); const [collapseVersion, setCollapseVersion] = useState(0); const [filesOpened, setFilesOpened] = useState(false); const drag = useRef(null); const contentId = useId();
  useEffect(() => { if (r.rail === 'files') setFilesOpened(true); }, [r.rail]);
  function resize(value) { r.setWidth(Math.max(200, Math.min(420, value))); }
  function stopResize(event) { if (drag.current?.pointerId !== event.pointerId) return; drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }
  function resizeKey(event) {
    const next = event.key === 'ArrowLeft' ? r.width - 32 : event.key === 'ArrowRight' ? r.width + 32 : event.key === 'Home' ? 200 : event.key === 'End' ? 420 : null;
    if (next !== null) { event.preventDefault(); resize(next); }
  }
  if (!r.enabled) return null;
  const filtered = all ? r.notes : r.notes.filter(item => item.anchor.repoId === r.repoId && item.anchor.path === r.target?.path); const active = r.notes.find(item => item.id === r.activeNote);
  return <aside className={`cr-extension cr-file-sidebar${r.expanded ? '' : ' cr-extension-collapsed'}`} style={{ '--cr-file-sidebar-width': `${r.width}px`, '--cr-source-width': `${r.width}px` }} aria-label="文件目录">
    {r.expanded && <div className="cr-file-sidebar-resize cr-source-resize" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="调整文件目录宽度" aria-valuemin={200} aria-valuemax={420} aria-valuenow={Math.round(r.width)} aria-valuetext={`${Math.round(r.width)} 像素`} aria-controls={contentId} title="拖动调整宽度；方向键调整，Home 最窄，End 最宽" onKeyDown={resizeKey} onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = { pointerId: event.pointerId, x: event.clientX, width: r.width }; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus({ preventScroll: true }); }} onPointerMove={event => { if (drag.current?.pointerId === event.pointerId) resize(drag.current.width + event.clientX - drag.current.x); }} onPointerUp={stopResize} onPointerCancel={stopResize} onLostPointerCapture={() => { drag.current = null; }} />}
    <header className="cr-extension-header"><span className="cr-extension-title"><UiIcon name="folder-tree" size={17} /><strong>文件目录</strong></span><button type="button" className="cr-icon-button" title={r.expanded ? '收起文件目录' : '展开文件目录'} aria-label={r.expanded ? '收起文件目录' : '展开文件目录'} aria-expanded={r.expanded} aria-controls={contentId} onClick={() => { r.setExpanded(value => !value); r.setMaximized(false); }}><UiIcon name={r.expanded ? 'chevron-left' : 'chevron-right'} /></button></header>
    <div id={contentId} className="cr-file-sidebar-body cr-source-rail-body" hidden={!r.expanded}><nav className="cr-extension-tabs" aria-label="源码工作台内容"><button type="button" aria-pressed={r.rail === 'files'} onClick={r.browseFiles}><UiIcon name="files" />文件目录</button>
<button type="button" aria-pressed={r.rail === 'notes'} onClick={() => r.setRail('notes')}><UiIcon name="message-square-text" />批注 <span className="cr-tab-count">{r.notes.length}</span></button>
</nav>
    <div className="cr-extension-content">{r.error && <p role="alert" className="cr-banner cr-error">{r.error}</p>}
      <div className="cr-explorer-panel" hidden={r.rail !== 'files'}>
        <label className="cr-repo-picker"><span>当前仓库</span><select aria-label="文件目录仓库" value={r.repoId} onChange={e => r.onRepoChange(e.target.value)}>{r.repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></label>
        <FileSearch />
        <div className="cr-explorer-toolbar"><span>仓库文件</span><div><button type="button" className="cr-icon-button" aria-label="刷新文件目录" title="刷新文件目录" onClick={() => setTreeVersion(value => value + 1)}><UiIcon name="refresh-cw" size={15} /></button>
<button type="button" className="cr-icon-button" aria-label="收起子目录" title="收起子目录" onClick={() => setCollapseVersion(value => value + 1)}><UiIcon name="chevrons-down-up" size={15} /></button>
</div></div>
        <div className="cr-file-tree" role="group" aria-label="仓库文件目录" onKeyDown={navigateDirectory}>{filesOpened && r.repoId && <Directory key={`${r.sessionId}:${r.repoId}:${treeVersion}`} label={r.repositories.find(repo => repo.id === r.repoId)?.name ?? '仓库根目录'} collapseVersion={collapseVersion} />}</div>
        <footer className="cr-explorer-footer"><span><UiIcon name="shield-check" size={14} />只读浏览，不修改源码</span><span><kbd>↑</kbd><kbd>↓</kbd> 导航 <span className="cr-key-separator">·</span> 单击文件打开</span></footer>
      </div><div className="cr-notes-panel" hidden={r.rail !== 'notes'}><div className="cr-row"><label><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> 本会话全部</label><button type="button" disabled={r.mutating} onClick={async () => { await r.reloadNotes(); r.reloadFile(); }}>刷新批注</button>
</div><p className="cr-muted">批注只写阅读工作区。哈希变化后须人工复核，不把候选位置当作已确认。</p>{r.draft && <section className="cr-annotation-editor"><strong>新批注</strong><p className="cr-path">{titleOf(r.draft.selection)}</p><textarea aria-label="批注内容" disabled={r.mutating} maxLength={4000} rows={6} value={r.draft.body} onChange={e => r.setDraft({ ...r.draft, body: e.target.value })} placeholder="记录解释、疑问或边界条件；不会修改源码" /><small>保存选区及附近上下文快照（包含代码）。不自动发给模型。</small><div className="cr-row"><button type="button" className="cr-primary" disabled={r.mutating || !r.draft.body.trim()} onClick={() => r.mutate('annotation-create', { body: r.draft.body, selection: r.draft.selection })}>保存批注</button>
<button type="button" disabled={r.mutating} onClick={() => r.setDraft(null)}>取消批注</button>
</div></section>}{!filtered.length && <p className="cr-muted">{r.target ? '当前范围没有批注。选择代码后右键添加，或查看本会话全部。' : '先打开一个文件，选择代码后右键添加。'}</p>}{filtered.map(item => <button type="button" className="cr-annotation-card" aria-pressed={r.activeNote === item.id} key={item.id} onClick={() => r.setActiveNote(item.id)}><span className={`cr-annotation-state ${item.location?.status === 'current' ? 'cr-annotation-current' : ''}`}>{ANNOTATION_LABELS[item.location?.status] ?? ANNOTATION_LABELS.unchecked}</span><strong>{item.body.slice(0, 140)}</strong><small>{titleOf(item.anchor)}</small></button>
)}{active && <section className="cr-annotation-detail"><h3>批注详情 · v{active.revision}</h3><p className="cr-annotation-body">{active.body}</p><p className="cr-path">{titleOf(active.anchor)}<br />SHA256 {active.anchor.fileHash}</p><p className="cr-muted">{ANNOTATION_LABELS[active.location?.status] ?? ANNOTATION_LABELS.unchecked}</p><button type="button" onClick={() => r.reveal(active)}>打开锚定文件 / 候选位置</button>
{active.location?.candidate && active.location.status !== 'current' && r.document?.hash && active.anchor.repoId === r.document.repoId && active.anchor.path === r.document.path && <button type="button" disabled={r.mutating} onClick={() => r.mutate('annotation-update', { annotationId: active.id, expectedRevision: active.revision, operation: 'confirm', expectedFileHash: r.document.hash })}>我已复核，确认本版本</button>
}<button type="button" disabled={r.mutating || !r.selected} onClick={() => r.mutate('annotation-update', { annotationId: active.id, expectedRevision: active.revision, operation: 'rebind', selection: r.selected })}>重新绑定到当前选区</button>
<p className="cr-muted">重新绑定前，请先在目标文件选中代码；旧版本仍保留。</p><details><summary>历史选区与绑定记录（{active.history.length}）</summary>{[...active.history].reverse().map((version, index) => <section className="cr-annotation-version" key={version.requestId}><small>v{active.history.length - index} · {version.operation} · {new Date(version.time).toLocaleString()}</small><p className="cr-path">{titleOf(version.anchor)} · {version.anchor.fileHash.slice(0, 16)}…</p><CodeBlock text={version.anchor.quote} pathHint={version.anchor.path} startLine={version.anchor.start.line} title="历史选区快照（非当前完整行）" /></section>)}</details></section>}</div></div><footer className="cr-file-sidebar-size-controls cr-source-size-controls"><span>只读 · 不执行仓库脚本</span><button type="button" aria-label="缩窄文件目录" disabled={r.width <= 200} onClick={() => resize(r.width - 32)}>缩窄</button>
<button type="button" aria-label="加宽文件目录" disabled={r.width >= 420} onClick={() => resize(r.width + 32)}>加宽</button>
</footer></div></aside>;
}
export function FileViewer({ embedded = false }) {
  const r = useContext(ReaderContext); const frame = useRef(null); const viewer = useRef(null); const menuRoot = useRef(null); const [menu, setMenu] = useState(null); const [jump, setJump] = useState('1'); const [fontSize, setFontSize] = useState(13);
  const identity = `${r.sessionId}:${r.repoId}:${r.target?.repoId}:${r.target?.path}:${r.target?.offset}:${r.document?.repoId}:${r.document?.path}:${r.document?.hash}:${r.document?.offset}`;
  useEffect(() => { setMenu(null); setJump(String(r.document?.offset ?? 1)); }, [identity]);
  useEffect(() => {
    if (r.activeDocument !== 'source') {
      setMenu(null);
      const main = frame.current?.closest('main');
      if (frame.current?.contains(document.activeElement)) (main?.querySelector('.cr-document-tab-button[aria-pressed="true"]') ?? main?.querySelector('.cr-document-tabs'))?.focus({ preventScroll: true });
    }
  }, [r.activeDocument]);
  useEffect(() => { if (r.maximized && r.activeDocument === 'source' && frame.current && !frame.current.contains(document.activeElement)) (frame.current.querySelector('.cr-code-body') ?? frame.current)?.focus({ preventScroll: true }); }, [r.maximized, r.activeDocument, identity]);
  useEffect(() => { const focused = document.activeElement; if (r.activeDocument === 'source' && !r.expanded && focused?.closest('.cr-file-sidebar') && !focused.getClientRects().length) (frame.current?.querySelector('.cr-code-body') ?? frame.current)?.focus({ preventScroll: true }); }, [r.activeDocument, r.expanded, identity]);
  useEffect(() => { const node = frame.current; if (node) r.viewerNodes.current.add(node); return () => { if (node) r.viewerNodes.current.delete(node); }; }, [r.viewerNodes, identity]);
  useEffect(() => { if (!menu || r.activeDocument !== 'source') return; const close = event => { if (!menuRoot.current?.contains(event.target)) setMenu(null); }; const scroll = event => { if (!menuRoot.current?.contains(event.target)) setMenu(null); }; document.addEventListener('pointerdown', close); window.addEventListener('wheel', scroll, true); window.addEventListener('touchmove', scroll, true); menuRoot.current?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true }); return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('wheel', scroll, true); window.removeEventListener('touchmove', scroll, true); }; }, [menu, r.activeDocument]);
  useEffect(() => () => r.setSelected(null), []);
  function capture() {
    if (!r.enabled || r.activeDocument !== 'source' || !r.document || !viewer.current || r.document.repoId !== r.repoId || r.document.path !== r.target?.path || r.document.offset !== r.target?.offset) return null; const selection = window.getSelection(); if (selection?.rangeCount !== 1) return null;
    const value = readCodeSelection(viewer.current, selection.getRangeAt(0), r.document.lines, { repoId: r.document.repoId, path: r.document.path, fileHash: r.document.hash }); r.setSelected(value); return value;
  }
  function contextMenu(event) {
    try { const selection = capture(); if (!selection) return; event.preventDefault(); const rect = viewer.current.getBoundingClientRect(); const x = event.clientX || rect.left + 70; const y = event.clientY || Math.max(10, window.getSelection()?.getRangeAt(0).getBoundingClientRect().bottom ?? rect.top); setMenu({ selection, x: Math.max(8, Math.min(x, window.innerWidth - 268)), y: Math.max(8, Math.min(y, window.innerHeight - 300)), identity }); }
    catch (e) { r.setError(e.message); }
  }
  function closeMenu() { setMenu(null); if (r.activeDocument === 'source' && frame.current?.getClientRects().length) viewer.current?.querySelector('pre')?.focus({ preventScroll: true }); }
  function menuKey(event) {
    if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); closeMenu(); return; }
    if (event.key === 'PageDown' || event.key === 'PageUp') { closeMenu(); return; }
    const buttons = [...menuRoot.current.querySelectorAll('button:not(:disabled)')]; const index = buttons.indexOf(document.activeElement); let next;
    if (event.key === 'ArrowDown') next = (index + 1) % buttons.length; if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length; if (event.key === 'Home') next = 0; if (event.key === 'End') next = buttons.length - 1; if (next !== undefined) { event.preventDefault(); buttons[next]?.focus(); }
  }
  if (!r.target) return <section ref={frame} className="cr-file-viewer cr-file-empty cr-source-empty" aria-label="文件阅读器" data-focus="false" tabIndex={-1}><div className="cr-file-empty-icon"><UiIcon name="file-code-2" size={25} /></div><h3>引用源码将显示在这里</h3><p>点击知识点中的证据，定位真实文件和行号。</p><button type="button" onClick={r.browseFiles}><UiIcon name="folder-tree" />浏览文件</button><small>只读浏览，不执行脚本，也不修改源码。</small>{r.error && <p className="cr-banner cr-error" role="alert">{r.error}</p>}</section>;
  const filename = r.target.path.split('/').at(-1);
  const parentPath = r.target.path.includes('/') ? r.target.path.slice(0, -(filename.length + 1)) : '仓库根目录';
  const doc = r.document; const evidence = r.target.evidence; const hashMismatch = !!(doc && r.target.expectedHash && doc.hash !== r.target.expectedHash); const stale = evidence?.stale === true || hashMismatch || !!(doc && evidence && doc.hash !== evidence.hash) || !!r.target.unavailableOffset; const repo = r.repositories.find(item => item.id === r.target.repoId);
  const markers = {}; if (doc) for (const item of r.notes) if (item.location?.status === 'current' && item.anchor.repoId === doc.repoId && item.anchor.path === doc.path && item.anchor.fileHash === doc.hash) (markers[item.anchor.start.line] ??= []).push(item.id);
  const selected = r.selected?.repoId === doc?.repoId && r.selected?.path === doc?.path && r.selected?.fileHash === doc?.hash ? r.selected : null;
  const onSelection = () => { try { if (!menu) capture(); } catch { r.setSelected(null); } };
  const highlight = doc && evidence && !stale && doc.hash === evidence.hash ? { startLine: evidence.startLine, endLine: evidence.endLine } : null;
  return <section ref={frame} className={`cr-file-viewer${embedded ? ' cr-file-viewer-embedded' : ''}`} aria-label="文件阅读器" data-focus={r.maximized && r.activeDocument === 'source' ? 'true' : 'false'} tabIndex={-1} data-file-path={r.target.path} data-repo-id={r.target.repoId} data-source-status={stale ? 'stale' : doc ? 'current' : r.loadState} onScrollCapture={() => r.rememberViewport(frame.current)} onKeyDown={event => { if (!event.defaultPrevented && event.key === 'Escape' && r.maximized && !menu) { event.preventDefault(); r.setMaximized(false); } }}>
    <div className="cr-file-heading"><div className="cr-file-identity"><EntryIcon path={r.target.path} /><div><h3 title={filename}>{filename}</h3><p className="cr-file-parent" title={`${repo?.name ?? r.target.repoId} / ${parentPath}`}>{repo?.name ?? r.target.repoId} / {parentPath}</p></div></div><div className="cr-file-heading-actions"><span className="cr-file-status"><UiIcon name="shield-check" size={14} />只读</span><button type="button" disabled={r.loadState === 'loading'} onClick={r.reloadFile} aria-label="重新加载文件"><UiIcon name="refresh-cw" size={14} />重载</button><button type="button" aria-label={r.maximized ? '还原代码区域' : '最大化代码区域'} aria-pressed={r.maximized} title={r.maximized ? '还原代码区域（Esc）' : '最大化代码区域'} onClick={() => r.setMaximized(value => !value)}>{r.maximized ? '还原' : '最大化'}</button></div></div>
    {evidence && <section className="cr-source-evidence" aria-label="证据定位" data-evidence-id={evidence.id}><strong>{stale ? '历史证据 · 已失效' : doc ? '已核验的源码证据' : '正在核验证据版本'}</strong><span>证据范围 {evidence.startLine}–{evidence.endLine} 行</span><span>{evidence.symbol ? `符号线索：${evidence.symbol}` : '未指定符号线索'} · 文本线索，非 AST 结论</span><span className="cr-path" title={`取证时 SHA256：${evidence.hash}`}>取证版本 SHA256 {evidence.hash.slice(0, 12)}…</span></section>}
    {stale && <p className="cr-banner cr-source-stale" role="alert">{evidence ? '此证据已失效：源码版本变化或无法核验。旧行号不再代表有效引用；下方若可读取，仅为当前源码对照，不高亮为已核验证据。' : '保存的阅读位置属于旧版本：当前源码 SHA256 已变化。保留原行号仅供对照，请重新确认位置。'}{r.target.unavailableOffset && <span> 原第 {r.target.unavailableOffset} 行已超出当前文件，已从第 1 行打开供对照。</span>}{evidence?.reason && <span> 原因：{evidence.reason}</span>}{hashMismatch && <span className="cr-path">原版本 SHA256：{r.target.expectedHash}</span>}</p>}
    {r.loadState === 'loading' && <p role="status">正在读取真实源码…</p>}
    {r.loadState === 'error' && <p className="cr-banner cr-error" role="alert">{r.error}<br />仅支持普通 UTF-8 文本／代码；不执行 HTML、脚本，不预览二进制文件。历史批注仍可在“批注”查看。</p>}
    {r.error && r.loadState !== 'error' && <p className="cr-banner cr-error" role="alert">{r.error}</p>}
    {doc && <>
      <div className="cr-source-location"><details><summary title={`当前 SHA256：${doc.hash}`}>当前文件 SHA256 {doc.hash.slice(0, 12)}… · 版本详情</summary><strong title={doc.repoId}>{repo?.name ?? doc.repoId} / <span className="cr-path" title={doc.path}>{doc.path}</span></strong><span className="cr-path">仓库：{doc.repoId}<br />当前 SHA256：{doc.hash}</span>{evidence && <span className="cr-path">取证 SHA256：{evidence.hash}</span>}<span>UTF-8 · {doc.bytes.toLocaleString()} 字节 · {doc.totalLines.toLocaleString()} 行</span></details></div>
      <div className="cr-file-navigation"><button type="button" disabled={doc.offset <= 1} onClick={() => r.openFile(doc.path, doc.repoId, Math.max(1, doc.offset - 200))}>上一段</button><span>第 {doc.offset}–{doc.lines.at(-1)?.number} 行</span><button type="button" disabled={!doc.lines.length || doc.lines.at(-1)?.number >= doc.totalLines} onClick={() => r.openFile(doc.path, doc.repoId, doc.lines.at(-1).number + 1)}>下一段</button><label>跳到行<input aria-label="跳转文件行号" type="number" min="1" max={doc.totalLines} value={jump} onChange={event => setJump(event.target.value)} /></label><button type="button" onClick={() => { const line = Number(jump); if (Number.isInteger(line) && line >= 1 && line <= doc.totalLines) r.openFile(doc.path, doc.repoId, line); }}>跳转</button></div>
      <p className="cr-muted cr-source-selection-help" title="界面只记录所选文字范围；分析代码时模型会补读所属完整方法／函数，按源码版本、行列与完整证据核验，非 AST。浏览其他文件不会替换已固定的提问上下文。">选中代码，右键生成逻辑图；悬停已有 AI 解读的范围查看结论。</p>
      {selected && <div className="cr-selection-actions"><span className="cr-selected-hint" role="status">已选择 {selected.start.line}–{selected.end.line} 行 · {selected.quote.length} 字符</span><button type="button" onClick={() => r.pinContext(selected)}>用于追问</button><button type="button" disabled={!!r.analyzeDisabled || !r.onAnalyze} title={r.analyzeDisabled || '发送选区与上下文给当前已确认模型'} onClick={() => void r.onAnalyze?.(structuredClone(selected))}>解释这段</button><button type="button" onClick={() => r.annotate(selected)}>添加批注</button></div>}
      <div ref={viewer} className="cr-source-scroll" onMouseUp={onSelection} onKeyUp={onSelection} onContextMenu={contextMenu} onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) contextMenu(event); }}><CodeBlock text={doc.lines.map(row => row.text).join('\n')} pathHint={doc.path} title={doc.path} startLine={doc.offset} markers={markers} evidenceRange={highlight} fontSize={fontSize} onFontSizeChange={setFontSize} codeReadings={doc.codeReadings} readingIdentity={identity} readingsEnabled={r.enabled && r.activeDocument === 'source' && !menu} onOpenReading={item => r.onReading?.(item.sessionId, item.lessonId)} onMarker={id => { r.setActiveNote(id); r.setRail('notes'); r.setExpanded(true); r.setMaximized(false); }} /></div>
      {menu && menu.identity === identity && r.activeDocument === 'source' && <div className="cr-code-menu" role="menu" aria-label="代码选区操作" ref={menuRoot} style={{ left: menu.x, top: menu.y }} onKeyDown={menuKey}>
        <small>{menu.selection.start.line}–{menu.selection.end.line} 行 · {menu.selection.quote.length} 字符</small>
        <button role="menuitem" type="button" onClick={() => { if (menu.identity !== identity) return; const selection = structuredClone(menu.selection); closeMenu(); r.pinContext(selection); }}>用于追问</button>
        <button role="menuitem" type="button" disabled={!!r.analyzeDisabled || !r.onAnalyze} title={r.analyzeDisabled || '发送选区与上下文给当前已确认模型'} onClick={() => { if (menu.identity !== identity || r.analyzeDisabled || !r.onAnalyze) return; const selection = structuredClone(menu.selection); closeMenu(); void r.onAnalyze(selection); }}>让 AI 分析选中代码</button>
        <button role="menuitem" type="button" disabled={!!r.analyzeDisabled || !r.onGraph} title={r.analyzeDisabled || '根据选中文字范围生成逻辑图；不会自动识别方法或类'} onClick={() => { if (menu.identity !== identity || r.analyzeDisabled || !r.onGraph) return; const selection = structuredClone(menu.selection); closeMenu(); void r.onGraph(selection); }}>AI 生成逻辑图</button>
        <button role="menuitem" type="button" onClick={() => { if (menu.identity !== identity) return; const selection = structuredClone(menu.selection); closeMenu(); r.annotate(selection); }}>添加代码批注</button>
        {r.analyzeDisabled && <small>{r.analyzeDisabled}</small>}<small>选中文字范围 · 非 AST 方法或类识别</small><small>源码只读 · Esc 关闭</small>
      </div>}
    </>}
  </section>;
}
