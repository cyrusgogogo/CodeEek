import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { buildMindMap, defaultMindMapCollapsed, layoutMindMap, mindMapFocusTarget, mindMapPlainText, mindMapSectionSignature, shortenMindMapLabel, MIND_MAP_LIMITS } from './mind-map-model.mjs';

function LazyDetails({ summary, className = '', identity, children }) {
  const [state, setState] = useState({ identity, open: false });
  const open = state.identity === identity && state.open;
  return <details className={`cr-mind-map-disclosure ${className}`} open={open} onToggle={event => setState({ identity, open: event.currentTarget.open })}><summary>{summary}</summary>{open && <div className="cr-mind-map-disclosure-body">{children}</div>}</details>;
}

function NoteText({ text, Markdown, openEvidence }) {
  if (!text) return null;
  // Rendering is opt-in. Very large legacy records keep a plain, exact-text route
  // rather than asking Markdown/Mermaid to parse an unbounded document.
  return <>{Markdown && openEvidence && text.length <= 60000 ? <><Markdown text={text} openEvidence={openEvidence} /><LazyDetails summary="查看原始 Markdown 文本"><pre className="cr-mind-map-source">{text}</pre></LazyDetails></> : <pre className="cr-mind-map-source">{text}</pre>}</>;
}

function NodeDetail({ node, model, Markdown, openEvidence, onClose, detailId, detailRef }) {
  const preview = mindMapPlainText(node.markdown); const shortened = preview.length > MIND_MAP_LIMITS.preview;
  const firstEvidence = node.evidence.slice(0, 8); const remainingEvidence = node.evidence.slice(8);
  const evidenceButton = ref => <button className="cr-mind-map-evidence" type="button" key={ref.id} disabled={!openEvidence} aria-label={`核验引用：${ref.id}`} onClick={() => openEvidence?.(ref.id)}><span>{ref.id}</span><small>待核验</small></button>;
  return <section className="cr-mind-map-detail" id={detailId} aria-label="节点说明">
    <header><div><small>节点说明{node.sourceId ? ` · ${model.sources.find(source => source.id === node.sourceId)?.title ?? '阅读笔记'}` : ''}</small><h3 tabIndex={-1} ref={detailRef}>{node.kind === 'paragraph' ? node.label : node.fullLabel}</h3></div><button type="button" onClick={onClose}>收起说明</button></header>
    {preview ? <p className="cr-mind-map-excerpt">{shortenMindMapLabel(preview, MIND_MAP_LIMITS.preview)}</p> : <p className="cr-mind-map-muted">{node.children.length ? '选择下级节点，查看对应说明与引用。' : '本节点没有单独的说明；可在完整阅读笔记中核对上下文。'}</p>}
    {node.children.length > 0 && <p className="cr-mind-map-muted">包含 {node.children.length} 个下级节点。{node.omitted > 0 ? `另有 ${node.omitted} 个层级项未绘入导图。` : ''}</p>}
    {(shortened || node.labelTruncated) && <p className="cr-mind-map-muted">节点标题或说明已缩略，完整内容可在下方按需展开。</p>}
    {node.markdown && (shortened || node.labelTruncated) && <LazyDetails summary="展开此节点完整说明"><NoteText text={node.markdown} Markdown={Markdown} openEvidence={openEvidence} /></LazyDetails>}
    {node.evidence.length ? <div className="cr-mind-map-evidence-list"><p>笔记引用 · 打开时核验，不能仅凭引用确认实现。</p><div>{firstEvidence.map(evidenceButton)}</div>{remainingEvidence.length > 0 && <LazyDetails summary={`其余 ${remainingEvidence.length} 条引用`}><div>{remainingEvidence.map(evidenceButton)}</div></LazyDetails>}</div> : <p className="cr-mind-map-muted">本节点未提取到证据引用；不能据此确认实现，请结合完整笔记核对。</p>}
  </section>;
}

/**
 * Note hierarchy only; callers keep their evidence authorization/freshness checks.
 * CSS is intentionally not imported: the native Client entry concatenates it.
 */
export function MindMap({ title, markdown, conclusion, sections, Markdown, openEvidence }) {
  const sectionSignature = mindMapSectionSignature(sections);
  const model = useMemo(() => buildMindMap({ title, markdown, conclusion, sections }), [title, markdown, conclusion, sectionSignature]);
  const [collapsed, setCollapsed] = useState(() => defaultMindMapCollapsed(model));
  const [selectedId, setSelectedId] = useState(null); const [zoom, setZoom] = useState(null); const [issue, setIssue] = useState('');
  const [viewportSize, setViewportSize] = useState({ width: 920, height: 400 });
  const viewport = useRef(null); const buttons = useRef(new Map()); const detailHeading = useRef(null); const nextFocus = useRef(null); const nextCenter = useRef(null); const currentModel = useRef(model);
  const uniqueId = useId(); const detailId = `${uniqueId}-detail`; const helpId = `${uniqueId}-help`; const relationId = `${uniqueId}-relation`;
  const layout = useMemo(() => layoutMindMap(model, collapsed, { width: viewportSize.width }), [model, collapsed, viewportSize.width]);
  const selected = model.nodes.find(node => node.id === selectedId);
  const fitScale = Math.max(.08, Math.min(1, (viewportSize.width - 24) / layout.width, layout.compact ? 1 : (viewportSize.height - 24) / layout.height));
  const scale = zoom ?? fitScale;
  const stageWidth = Math.max(viewportSize.width, layout.width * scale); const stageHeight = Math.max(viewportSize.height, layout.height * scale);
  const insetX = (stageWidth - layout.width * scale) / 2; const insetY = (stageHeight - layout.height * scale) / 2;
  const canCollapse = model.nodes.some(node => node.depth > 0 && node.children.length && !collapsed.includes(node.id));
  const canExpand = collapsed.length > 0;

  useEffect(() => {
    currentModel.current = model; setCollapsed(defaultMindMapCollapsed(model)); setSelectedId(null); setZoom(null); setIssue(''); nextFocus.current = null; nextCenter.current = null;
  }, [model]);
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const measure = () => {
      if (!element.clientWidth || !element.clientHeight) return;
      setViewportSize(previous => previous.width === element.clientWidth && previous.height === element.clientHeight ? previous : { width: element.clientWidth, height: element.clientHeight });
    };
    measure(); const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(element); window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  useEffect(() => {
    if (!viewport.current) return;
    if (zoom === null) { viewport.current.scrollLeft = 0; viewport.current.scrollTop = 0; }
    else if (nextCenter.current) {
      viewport.current.scrollLeft = nextCenter.current.x * scale + insetX - viewportSize.width / 2;
      viewport.current.scrollTop = nextCenter.current.y * scale + insetY - viewportSize.height / 2;
    }
    nextCenter.current = null;
  }, [scale, insetX, insetY, viewportSize.width, viewportSize.height, zoom]);
  useEffect(() => {
    if (nextFocus.current) { buttons.current.get(nextFocus.current)?.focus(); nextFocus.current = null; }
  }, [layout]);

  function changeZoom(factor) {
    const element = viewport.current;
    nextCenter.current = { x: ((element?.scrollLeft ?? 0) + viewportSize.width / 2 - insetX) / scale, y: ((element?.scrollTop ?? 0) + viewportSize.height / 2 - insetY) / scale };
    setZoom(Math.max(.08, Math.min(2, scale * factor)));
  }
  function fit() { nextCenter.current = null; setZoom(null); if (viewport.current) { viewport.current.scrollLeft = 0; viewport.current.scrollTop = 0; } }
  function toggle(node) {
    const closing = !collapsed.includes(node.id);
    if (closing && selectedId && selectedId !== node.id) {
      let ancestor = model.nodes.find(item => item.id === selectedId);
      while (ancestor?.parentId) { if (ancestor.parentId === node.id) { setSelectedId(node.id); break; } ancestor = model.nodes.find(item => item.id === ancestor.parentId); }
    }
    setCollapsed(previous => closing ? [...previous, node.id] : previous.filter(id => id !== node.id));
  }
  function focusNode(id) { buttons.current.get(id)?.focus(); }
  function keyDown(event, node) {
    if (event.key === 'Escape') { setSelectedId(null); event.preventDefault(); return; }
    const outward = event.key === 'ArrowLeft' && node.side < 0 || event.key === 'ArrowRight' && node.side >= 0;
    if (outward && collapsed.includes(node.id) && node.children.length) { nextFocus.current = node.children[0]; toggle(node); event.preventDefault(); return; }
    const id = mindMapFocusTarget(layout, node.id, event.key);
    if (id) { event.preventDefault(); focusNode(id); }
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) event.preventDefault();
  }
  const verifyEvidence = typeof openEvidence === 'function' ? async id => {
    const token = model; setIssue('');
    try { await openEvidence(id); }
    catch { if (currentModel.current === token) setIssue('该引用尚未定位或核验失败。不会猜测对应源码；请在完整阅读笔记中核对。'); }
  } : undefined;

  return <section className="cr-mind-map" aria-label="笔记思维导图">
    <div className="cr-mind-map-toolbar">
      <p id={relationId}>{model.relationNote}</p>
      <div className="cr-mind-map-tools" role="group" aria-label="导图视图控制">
        <button type="button" aria-label="缩小导图" title="缩小导图" disabled={scale <= .08} onClick={() => changeZoom(1 / 1.2)}>−</button><output aria-label="缩放比例">{Math.round(scale * 100)}%</output><button type="button" aria-label="放大导图" title="放大导图" disabled={scale >= 2} onClick={() => changeZoom(1.2)}>+</button>
        <button type="button" onClick={fit}>适应视图</button>
        <button type="button" disabled={!canCollapse} onClick={() => { setCollapsed(model.nodes.filter(node => node.depth > 0 && node.children.length).map(node => node.id)); setSelectedId(null); }}>收起分支</button>
        <button type="button" disabled={!canExpand} onClick={() => setCollapsed([])}>展开分支</button>
      </div>
    </div>
    <div className="cr-mind-map-viewport" ref={viewport} role="region" aria-label="思维导图画布" aria-describedby={`${relationId} ${helpId}`} tabIndex={0} data-mind-map-scale={scale} data-layout={layout.compact ? 'compact' : 'wide'}>
      <div className="cr-mind-map-stage" style={{ width: stageWidth, height: stageHeight }}>
        <div className="cr-mind-map-surface" style={{ width: layout.width, height: layout.height, left: insetX, top: insetY, transform: `scale(${scale})` }}>
          <svg className="cr-mind-map-lines" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true" focusable="false">{layout.edges.map(edge => <path key={edge.to} d={edge.path} data-side={edge.side} />)}</svg>
          {layout.nodes.map(node => <div className="cr-mind-map-node-wrap" key={node.id} data-side={node.side} data-root={node.id === model.rootId} style={{ left: node.x, top: node.y, width: node.width, height: node.height }}>
            <button type="button" className="cr-mind-map-node" ref={element => { if (element) buttons.current.set(node.id, element); else buttons.current.delete(node.id); }} aria-label={`查看节点：${node.fullLabel}`} aria-pressed={selectedId === node.id} aria-controls={selected ? detailId : undefined} title={node.fullLabel} onClick={() => { setSelectedId(node.id); setIssue(''); }} onKeyDown={event => keyDown(event, node)}>
              <span className="cr-mind-map-node-label">{node.label}</span>{(node.evidence.length > 0 || node.omitted > 0) && <span className="cr-mind-map-node-meta">{node.evidence.length ? `${node.evidence.length} 条引用` : ''}{node.omitted ? `${node.evidence.length ? ' · ' : ''}部分层级` : ''}</span>}
            </button>
            {node.children.length > 0 && <button className="cr-mind-map-toggle" type="button" aria-label={`${collapsed.includes(node.id) ? '展开' : '折叠'}分支：${node.fullLabel}`} aria-expanded={!collapsed.includes(node.id)} title={`${collapsed.includes(node.id) ? '展开' : '折叠'} ${node.children.length} 个下级节点`} onClick={() => toggle(node)}>{collapsed.includes(node.id) ? '+' : '−'}</button>}
          </div>)}
        </div>
      </div>
    </div>
    <div className="cr-mind-map-caption"><p id={helpId}>{layout.compact ? '窄屏按层级纵向排列，可滚动查看 · ' : ''}选择节点查看说明与证据 · 方向键移动，Home 返回根节点 · 长标题已缩略</p><span>{layout.nodes.length} / {model.nodes.length} 个节点</span>{selected && <button type="button" onClick={() => detailHeading.current?.focus()}>阅读节点说明</button>}</div>
    {model.truncated && <p className="cr-mind-map-warning" role="status">导图仅显示有限层级（最多 {MIND_MAP_LIMITS.nodes} 个节点、{MIND_MAP_LIMITS.depth} 层分支）。{model.omittedNodes ? `已省略 ${model.omittedNodes} 个层级项；` : ''}{model.truncationReasons.some(reason => reason.startsWith('scan-') || reason === 'sections') ? '较长笔记仅整理了部分内容；' : ''}未展示不代表不存在，完整原文保留在下方。</p>}
    {model.nodes.length === 1 && <p className="cr-mind-map-muted cr-mind-map-empty">尚无可展开的笔记层级；可选择根节点或展开完整阅读笔记。</p>}
    <span className="cr-mind-map-sr-only" role="status">{selected ? `已选择：${selected.label}。下方可阅读节点说明。` : '选择导图节点查看说明。'}</span>
    {selected && <NodeDetail key={selected.id} node={selected} model={model} Markdown={Markdown} openEvidence={verifyEvidence} detailId={detailId} detailRef={detailHeading} onClose={() => { setSelectedId(null); focusNode(selected.id); }} />}
    {issue && <p role="alert" className="cr-mind-map-warning">{issue}</p>}
    {!openEvidence && model.nodes.some(node => node.evidence.length) && <p className="cr-mind-map-muted">当前入口未提供引用核验，请在对应阅读中打开证据。</p>}
    <LazyDetails identity={model} summary="完整阅读笔记" className="cr-mind-map-original">
      <p className="cr-mind-map-muted">保留原始笔记与全部分节；导图的缩略和折叠不会删除原文。</p>
      {model.conclusion && <section className="cr-mind-map-original-part"><h3>原始结论</h3><p className="cr-mind-map-excerpt">{model.conclusion}</p></section>}
      {model.sources.map(source => <section className="cr-mind-map-original-part" key={source.id}><h3>{source.title}</h3><NoteText text={source.markdown} Markdown={Markdown} openEvidence={verifyEvidence} /></section>)}
      {!model.sources.length && !model.conclusion && <p className="cr-mind-map-muted">尚无笔记正文。</p>}
    </LazyDetails>
  </section>;
}
