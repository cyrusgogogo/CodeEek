import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.mjs';
import { EntryIcon } from './entry-icon.jsx';
import { CODE_READING_KINDS } from './code-reading-ranges.mjs';
import { mapFiles, mapModules, mapPage, validateLayerConfiguration, validateStructureFile, validateStructureMap } from './structure-map-state.mjs';

const overview = () => ({ kind: 'overview' });
const frame = (location = overview()) => ({ location, query: '', page: 0, scrollTop: 0, focusKey: '' });
const identity = (project, sessionId, repoId) => JSON.stringify([project.id, project.bindingRevision, sessionId, repoId]);
function Pager({ value, onChange }) {
  if (value.pages < 2) return null;
  return <nav className="cr-map-pages" aria-label="项目地图分页"><button type="button" disabled={value.page === 0} onClick={() => onChange(value.page - 1)}>上一页</button><span role="status">第 {value.page + 1} / {value.pages} 页 · {value.total} 项</span><button type="button" disabled={value.page + 1 === value.pages} onClick={() => onChange(value.page + 1)}>下一页</button></nav>;
}
function LayerEditor({ value, busy, blocked, onSave, onClose }) {
  const [layers, setLayers] = useState(() => structuredClone(value.customLayers));
  const [assignments, setAssignments] = useState(() => structuredClone(value.assignments));
  const [error, setError] = useState(''); const revision = useRef(value.revision);
  const options = [...value.layers.filter(layer => layer.origin === 'heuristic'), ...layers];
  const updateLayer = (index, patch) => setLayers(rows => rows.map((row, i) => index === i ? { ...row, ...patch } : row));
  return <form className="cr-map-config" aria-label="配置架构层" onSubmit={event => { event.preventDefault(); try { const config = validateLayerConfiguration(layers, assignments); setError(''); void onSave({ expectedRevision: revision.current, ...config }); } catch (e) { setError(e.message); } }}>
    <h2>配置架构层</h2><p>建议层来自路径规则，不是语义或调用分析。可新增自定义层、修改名称和说明，再用路径前缀覆盖归属。</p>
    <p>前缀按字面路径匹配文件或目录后代，最长前缀优先；留空代表整个仓库，不支持通配符。保存只更新地图，不改源码或阅读记录。</p>
    {error && <p role="alert" className="cr-error">{error}</p>}
    <fieldset disabled={busy}><legend>自定义架构层（{layers.length}/16）</legend>
      {layers.map((layer, index) => <div className="cr-map-config-layer" key={layer.id} data-custom-layer-id={layer.id}>
        <label>层名称 {index + 1}<input aria-label={`层名称 ${index + 1}`} value={layer.name} maxLength={60} onChange={event => updateLayer(index, { name: event.target.value })} required /></label>
        <label>层说明 {index + 1}<textarea aria-label={`层说明 ${index + 1}`} value={layer.description} maxLength={240} rows={2} onChange={event => updateLayer(index, { description: event.target.value })} /></label>
        <small>{layer.id}</small><button type="button" aria-label={`删除自定义层 ${index + 1}`} onClick={() => { if (assignments.some(rule => rule.layerId === layer.id)) { setError('请先删除或调整使用该层的路径归属。'); return; } setLayers(rows => rows.filter(row => row.id !== layer.id)); }}>删除层</button>
      </div>)}
      <button type="button" disabled={layers.length >= 16} onClick={() => setLayers(rows => [...rows, { id: `custom-${crypto.randomUUID().slice(0, 8)}`, name: '', description: '' }])}>新增自定义层</button>
    </fieldset>
    <fieldset disabled={busy}><legend>路径归属（{assignments.length}/128）</legend>
      {assignments.map((rule, index) => <div className="cr-map-config-rule" key={index}>
        <label>路径前缀 {index + 1}<input aria-label={`路径前缀 ${index + 1}`} maxLength={1024} placeholder="例如 src/client，留空为全仓" value={rule.prefix} onChange={event => setAssignments(rows => rows.map((row, i) => i === index ? { ...row, prefix: event.target.value } : row))} /></label>
        <label>归属架构层 {index + 1}<select aria-label={`归属架构层 ${index + 1}`} value={rule.layerId} onChange={event => setAssignments(rows => rows.map((row, i) => i === index ? { ...row, layerId: event.target.value } : row))}>{options.map(layer => <option key={layer.id} value={layer.id}>{layer.name || '未命名自定义层'}</option>)}</select></label>
        <button type="button" aria-label={`删除路径归属 ${index + 1}`} onClick={() => setAssignments(rows => rows.filter((_row, i) => i !== index))}>删除归属</button>
      </div>)}
      <button type="button" disabled={assignments.length >= 128} onClick={() => setAssignments(rows => [...rows, { prefix: '', layerId: layers.at(-1)?.id ?? 'core' }])}>新增路径归属</button>
    </fieldset>
    <div className="cr-map-actions"><button type="submit" disabled={busy || blocked}>保存架构层配置</button><button type="button" disabled={busy} onClick={onClose}>取消配置</button></div>
    {blocked && <p role="status">保存结果尚未确认。请重新加载地图核对，再取消配置并重新编辑；不会自动重发保存。</p>}
  </form>;
}

// One bounded map for the active project. memory contains navigation metadata only;
// requests, inspected conclusions, and inventories stay in this mounted module.
export function StructureMap({ project, sessionId, enabled, active, memory, onNavigate, onOpenSource, onOpenReading, onReturnDocument, overview: aiOverview }) {
  const [repoId, setRepoId] = useState(() => project.repositories.some(repo => repo.id === memory.repoId) ? memory.repoId : project.repositories[0]?.id ?? '');
  const [view, setView] = useState(() => memory.view ?? frame());
  const [mapMode, setMapMode] = useState(() => memory.mapMode ?? (aiOverview ? 'mindmap' : 'paths'));
  const [history, setHistory] = useState(() => memory.history ?? []);
  const [loaded, setLoaded] = useState(null); const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(''); const [fileLoading, setFileLoading] = useState(false); const [error, setError] = useState(''); const [fileError, setFileError] = useState('');
  const [editing, setEditing] = useState(false); const [blocked, setBlocked] = useState(false);
  const alive = useRef(false); const request = useRef({ controller: null, seq: 0 }); const fileRequest = useRef({ controller: null, seq: 0 }); const locked = useRef(false);
  const root = useRef(null); const heading = useRef(null); const restore = useRef(true); const latest = useRef(null);
  const scope = useRef(null); const scopeKey = identity(project, sessionId, repoId);
  if (!scope.current || scope.current.key !== scopeKey || scope.current.active !== active || scope.current.enabled !== enabled) scope.current = { key: scopeKey, active, enabled };
  const token = scope.current; const data = loaded?.token === token ? loaded.value : null;
  const inspected = detail?.token === token && detail.location === view.location ? detail.value : null;
  const repo = project.repositories.find(item => item.id === repoId);
  const retainedView = latest.current?.view;
  latest.current = { token, view: retainedView?.location === view.location && retainedView.query === view.query && retainedView.page === view.page ? { ...view, scrollTop: retainedView.scrollTop, focusKey: retainedView.focusKey } : view, history, repoId };
  function capture() {
    const current = latest.current; const node = root.current;
    const focusKey = node?.contains(document.activeElement) ? document.activeElement?.getAttribute('data-map-focus') ?? current.view.focusKey : current.view.focusKey;
    return { ...current.view, scrollTop: active && !restore.current && node?.getClientRects().length ? node.scrollTop : current.view.scrollTop, focusKey };
  }
  function saveMemory() { memory.repoId = latest.current.repoId; memory.view = capture(); latest.current.view = memory.view; memory.history = latest.current.history; }
  function invalidateRequests() { request.current.controller?.abort(); request.current.seq++; fileRequest.current.controller?.abort(); fileRequest.current.seq++; locked.current = false; }
  useEffect(() => { alive.current = true; return () => { saveMemory(); alive.current = false; invalidateRequests(); }; }, []);
  async function load(method = 'structure-map', config = {}) {
    if (!token.enabled || !token.active || locked.current || !repo) return;
    locked.current = true; request.current.controller?.abort(); const controller = new AbortController(); const seq = ++request.current.seq; request.current.controller = controller;
    const valid = () => alive.current && scope.current === token && !controller.signal.aborted && request.current.seq === seq;
    setError(''); setLoading(method); if (method !== 'structure-map') onNavigate();
    try {
      const value = validateStructureMap(await api(method, { sessionId, repoId, ...config }, controller.signal), project.id, repoId, project.bindingRevision);
      if (!valid()) return;
      setLoaded({ token, value }); setBlocked(false);
      if (method === 'structure-map-layers') { setEditing(false); restore.current = true; }
    } catch (e) { if (valid()) { setError(e.message + (method === 'structure-map' ? '' : '。请先重新加载地图核对结果，不要连续重复提交。')); if (method !== 'structure-map') setBlocked(true); } }
    finally { if (valid()) { locked.current = false; setLoading(''); } }
  }
  useEffect(() => {
    invalidateRequests(); setLoading(''); setFileLoading(false); setError(''); setFileError(''); setEditing(false); restore.current = true;
    if (token.active && token.enabled) void load();
    return () => { saveMemory(); invalidateRequests(); };
  }, [token]);
  useEffect(() => {
    fileRequest.current.controller?.abort(); const seq = ++fileRequest.current.seq; setDetail(null); setFileError(''); setFileLoading(false);
    if (!data || !active || !enabled || view.location.kind !== 'file' || !data.files.some(file => file.path === view.location.path)) return;
    const location = view.location; const controller = new AbortController(); fileRequest.current.controller = controller;
    const valid = () => alive.current && scope.current === token && latest.current.view.location === location && !controller.signal.aborted && fileRequest.current.seq === seq;
    setFileLoading(true);
    void api('structure-map-file', { sessionId, repoId, path: location.path }, controller.signal).then(value => {
      if (valid()) setDetail({ token, location, value: validateStructureFile(value, project.id, repoId, location.path, project.bindingRevision) });
    }).catch(e => { if (valid()) setFileError(e.message); }).finally(() => { if (valid()) setFileLoading(false); });
    return () => controller.abort();
  }, [token, view.location, data]);
  useEffect(() => {
    if (!active || !data || !restore.current || view.location.kind === 'file' && !inspected && !fileError && data.files.some(file => file.path === view.location.path)) return;
    const id = requestAnimationFrame(() => {
      if (!alive.current || scope.current !== token || !root.current) return;
      const saved = latest.current.view; const focused = document.activeElement;
      // A keyboard/pointer user may already have focused the new route before
      // this frame. Never steal that focus (or scroll) back to the old route.
      const userFocused = root.current.contains(focused) && focused?.hasAttribute('data-map-focus');
      if (!userFocused) {
        root.current.scrollTop = saved.scrollTop;
        const target = [...root.current.querySelectorAll('[data-map-focus]')].find(node => node.dataset.mapFocus === saved.focusKey);
        (target ?? heading.current)?.focus({ preventScroll: true });
      }
      restore.current = false;
    });
    return () => cancelAnimationFrame(id);
  }, [active, token, data, view, inspected, fileError]);
  function change(next, { back = false } = {}) {
    const old = capture(); onNavigate(); fileRequest.current.controller?.abort(); ++fileRequest.current.seq;
    const nextHistory = back ? history.slice(0, -1) : [...history, old].slice(-32);
    setHistory(nextHistory); setView(next); latest.current = { ...latest.current, view: next, history: nextHistory }; memory.view = next; memory.history = nextHistory; restore.current = true;
  }
  function go(location) { change(frame(location)); }
  function changeRepo(value) {
    saveMemory(); onNavigate(); invalidateRequests(); setRepoId(value); setView(frame()); setHistory([]); memory.repoId = value; memory.view = frame(); memory.history = []; restore.current = true;
  }
  function changePage(page) { change({ ...view, page, scrollTop: 0, focusKey: '' }); }
  const location = view.location; const layer = data?.layers.find(item => item.id === location.layerId);
  const selectedFile = location.kind === 'file' ? data?.files.find(item => item.path === location.path) : null;
  const files = mapFiles(data, location, view.query);
  const modules = mapModules(files); const listing = mapPage(location.kind === 'layer' && !view.query.trim() ? modules : files, view.page);
  const detailPage = mapPage(inspected?.codeReadings.items ?? [], view.page);
  const title = location.kind === 'file' ? location.path.split('/').at(-1) : location.kind === 'module' ? location.modulePath || '根目录文件' : location.kind === 'layer' ? layer?.name ?? (data ? '该架构层已不可用' : '架构层') : '项目地图';
  const busy = !!loading; const mutating = !!loading && loading !== 'structure-map';
  const fileButton = file => <button type="button" className="cr-map-row" key={file.path} data-map-path={file.path} data-map-focus={`file:${file.path}`} title={file.path} onClick={() => go({ kind: 'file', layerId: file.layerId, modulePath: file.modulePath, path: file.path })}><EntryIcon path={file.path} /><span><strong>{file.path.split('/').at(-1)}</strong><small>{file.path}</small></span><small>{file.readingCount ? `${file.readingCount} 个历史知识点 · 待核验` : '暂无历史关联'}</small></button>;
  return <section ref={root} hidden={!active} className="cr-structure-map" aria-label="项目地图" data-repo-id={repoId} data-map-kind={location.kind} data-index-revision={data?.revision} onScroll={() => { if (!restore.current && root.current?.getClientRects().length) { const next = { ...latest.current.view, scrollTop: root.current.scrollTop }; latest.current.view = next; memory.view = next; } }}>
    {aiOverview && <div className="cr-map-viewbar"><nav aria-label="地图视图">{[['mindmap', '思维导图'], ['paths', '路径导航']].map(([value, label]) => <button type="button" key={value} aria-pressed={mapMode === value} onClick={() => { saveMemory(); onNavigate(); memory.mapMode = value; setMapMode(value); root.current?.scrollTo({ top: 0 }); }}>{label}</button>)}</nav>{onReturnDocument && <button type="button" className="cr-map-back-document" onClick={() => { saveMemory(); onReturnDocument(); }}>返回上个文档</button>}</div>}
    {aiOverview && mapMode === 'mindmap' && <><h1 ref={heading} tabIndex={-1} className="cr-sr-only">项目地图</h1>{aiOverview}</>}
    <div className="cr-map-paths" hidden={!!aiOverview && mapMode !== 'paths'}>
    <header className="cr-map-header"><div><p className="cr-map-eyebrow">项目结构 · 路径导航</p><h1 ref={!aiOverview || mapMode === 'paths' ? heading : undefined} tabIndex={-1}>{title}</h1></div>{!aiOverview && onReturnDocument && <button type="button" onClick={() => { saveMemory(); onReturnDocument(); }}>返回上个文档</button>}</header>
    <div className="cr-map-toolbar">
      {project.repositories.length > 1 ? <label>地图仓库<select aria-label="地图仓库" value={repoId} disabled={mutating || editing} onChange={event => changeRepo(event.target.value)}>{project.repositories.map(item => <option key={item.id} value={item.id}>{item.name} · {item.root}</option>)}</select></label> : <span className="cr-map-repo" title={repo?.root}>{repo?.name}</span>}
      <button type="button" disabled={!enabled || busy || blocked || !data || editing} onClick={() => void load('structure-map-refresh', { expectedRevision: data.revision })}>{data?.indexedAt ? '刷新结构索引' : '建立结构索引'}</button>
      <button type="button" disabled={!enabled || busy} onClick={() => void load()}>重新加载地图</button>
      <button type="button" disabled={!enabled || busy || !data || editing} onClick={() => { onNavigate(); setEditing(true); }}>配置架构层</button>
    </div>
    <nav className="cr-map-breadcrumbs" aria-label="项目地图路径"><ol>
      <li>{location.kind === 'overview' ? <span aria-current="page">总览</span> : <button type="button" onClick={() => go(overview())}>总览</button>}</li>
      {location.layerId && <li>{location.kind === 'layer' ? <span aria-current="page">{layer?.name ?? '架构层'}</span> : <button type="button" onClick={() => go({ kind: 'layer', layerId: location.layerId })}>{layer?.name ?? '架构层'}</button>}</li>}
      {['module', 'file'].includes(location.kind) && <li>{location.kind === 'module' ? <span aria-current="page">{location.modulePath || '根目录文件'}</span> : <button type="button" onClick={() => go({ kind: 'module', layerId: location.layerId, modulePath: location.modulePath })}>{location.modulePath || '根目录文件'}</button>}</li>}
      {location.kind === 'file' && <li><span aria-current="page">{location.path.split('/').at(-1)}</span></li>}
    </ol></nav>
    <div className="cr-map-actions"><button type="button" disabled={!history.length || editing || mutating} onClick={() => change(history.at(-1), { back: true })}>地图后退</button>{location.kind !== 'overview' && <button type="button" disabled={editing || mutating} onClick={() => go(location.kind === 'file' ? { kind: 'module', layerId: location.layerId, modulePath: location.modulePath } : location.kind === 'module' ? { kind: 'layer', layerId: location.layerId } : overview())}>上一级</button>}</div>
    {loading && <div className="cr-map-actions"><p role="status">{loading === 'structure-map-refresh' ? '正在建立或刷新有界结构索引…' : loading === 'structure-map-layers' ? '正在保存架构层配置…' : '正在加载项目地图…'}</p><button type="button" onClick={() => { onNavigate(); invalidateRequests(); setLoading(''); setFileLoading(false); if (mutating) { setBlocked(true); setError('已取消等待，不能据此确认服务端是否已保存。请重新加载地图核对后再操作。'); } else setError('已取消地图加载；可重新加载。'); }}>取消地图加载</button></div>}
    {error && <p className="cr-error" role="alert">{error}</p>}
    {data && <>
      <p className="cr-map-meta">{data.indexedAt ? `索引 ${data.files.length} 个文件 · ${new Date(data.indexedAt).toLocaleString()} · 修订 ${data.revision}` : '尚未建立结构索引；请显式建立，不会自动扫描或请求模型。'}</p>
      <p className="cr-map-hint">路径规则建议，不是语义架构或调用图。历史关联数量未核验当前源码，不代表方法覆盖或你已理解。地图位置仅在本页面保留。</p>
      {(data.truncated || data.readingTruncated) && <section className="cr-map-warning" role="status"><strong>索引或关联扫描已截断，结果不完整。</strong><p>已访问 {data.visited} 项；未出现的路径或知识点不等于不存在。</p>{data.truncationReasons.length > 0 && <ul>{data.truncationReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}</section>}
      {editing ? <LayerEditor value={data} busy={busy} blocked={blocked} onSave={config => load('structure-map-layers', config)} onClose={() => { setEditing(false); restore.current = true; }} /> : <>
        {location.kind !== 'file' && <label className="cr-map-search">搜索已索引路径<input aria-label="搜索已索引路径" type="search" maxLength={256} value={view.query} placeholder="在当前范围按字面路径筛选" onChange={event => { onNavigate(); const next = { ...view, query: event.target.value, page: 0 }; setView(next); latest.current.view = next; memory.view = next; }} /></label>}
        {location.kind === 'overview' && !view.query.trim() ? <div className="cr-map-layers" aria-label="建议架构层">{data.layers.map(item => <button type="button" className="cr-map-layer" data-map-layer={item.id} data-map-focus={`layer:${item.id}`} key={item.id} onClick={() => go({ kind: 'layer', layerId: item.id })}><strong>{item.name}</strong><span>{item.description || '按文件路径组织的结构分组'}</span><small>{item.origin === 'manual' ? '人工配置' : '路径规则建议'} · {item.fileCount} 个文件 · {item.readingFileCount} 个文件有历史关联</small></button>)}</div> : location.kind === 'file' ? <section className="cr-map-file" aria-label="地图文件详情" data-map-path={location.path}>
          <p className="cr-map-full-path">{repo?.name} / {location.path}</p>
          {!selectedFile && <p role="status">该文件已不在当前索引中。请返回上一级或刷新索引，不会打开同名文件替代。</p>}
          {fileLoading && <p role="status">正在读取当前文件并核验已有阅读版本…</p>}{fileError && <p className="cr-error" role="alert">{fileError}</p>}
          {selectedFile && <button type="button" disabled={fileLoading || !enabled} onClick={() => { saveMemory(); onOpenSource({ repoId, path: location.path, ...(inspected ? { expectedHash: inspected.hash } : {}) }); }}>打开源码</button>}
          {inspected && <>
            <p className="cr-map-meta">已读取当前版本 · {inspected.totalLines} 行 · {inspected.bytes} 字节</p><p className="cr-map-hash">SHA256 {inspected.hash}</p><p className="cr-map-hint">这是定位核验，不新增代码证据。打开源码仍会重新读取；完整代码单元来自已有阅读档案，不是新增解析器识别。</p>
            <h2>当前版本已有知识点</h2>
            {inspected.codeReadings.staleCount > 0 && <p role="status">{inspected.codeReadings.staleCount} 条解读属于其他版本，不提供当前行定位。</p>}
            {inspected.codeReadings.legacyCount > 0 && <p role="status">{inspected.codeReadings.legacyCount} 条旧解读缺少完整代码单元关联，未标记当前范围。</p>}
            {inspected.codeReadings.truncated && <p role="status" className="cr-map-warning">阅读关联扫描已截断，可能还有其他知识点。</p>}
            {!inspected.codeReadings.items.length && <p>当前版本暂无可核验的代码单元阅读关联。可以打开源码，继续按问题或选区阅读。</p>}
            <div className="cr-map-readings">{detailPage.items.map(item => <article className="cr-map-reading" key={item.id} data-map-reading-id={item.id} data-session-id={item.sessionId} data-lesson-id={item.lessonId}>
              <h3>{CODE_READING_KINDS[item.kind]} · {item.name}</h3><p>{item.conclusion}</p><small>{item.lessonTitle} · 第 {item.start.line}:{item.start.column + 1}–{item.end.line}:{item.end.column + 1} 行列（结束不含）</small>
              <div className="cr-map-actions"><button type="button" data-map-focus={`source:${item.id}`} onClick={() => { saveMemory(); onOpenSource({ repoId, path: location.path, line: item.start.line, expectedHash: inspected.hash }); }}>定位源码 {item.name}</button><button type="button" data-map-focus={`reading:${item.id}`} onClick={() => { saveMemory(); onOpenReading(item.sessionId, item.lessonId); }}>打开知识点 {item.lessonTitle}</button></div>
            </article>)}</div><Pager value={detailPage} onChange={changePage} />
          </>}
        </section> : <>
          <p className="cr-map-meta">{location.kind === 'layer' && !view.query.trim() ? `${modules.length} 个目录模块` : `${files.length} 个匹配文件`} · 每页最多 100 项</p>
          <div className="cr-map-list">{location.kind === 'layer' && !view.query.trim() ? listing.items.map(module => <button type="button" className="cr-map-row" key={module.path} data-map-module={module.path} data-map-focus={`module:${module.path}`} onClick={() => go({ kind: 'module', layerId: location.layerId, modulePath: module.path })}><EntryIcon path={module.path} folder /><span><strong>{module.path || '根目录文件'}</strong><small>{module.fileCount} 个文件 · {module.readingFileCount} 个有历史关联</small></span></button>) : listing.items.map(fileButton)}</div>
          {!listing.total && <p role="status">当前已索引范围没有匹配项；未索引或截断部分不在结果中。</p>}<Pager value={listing} onChange={changePage} />
        </>}
      </>}
    </>}
    </div>
  </section>;
}
