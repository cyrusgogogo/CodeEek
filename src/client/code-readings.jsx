import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { readCodePointAt } from './selection.mjs';
import { CODE_READING_KINDS, codeReadingGroupAt, codeReadingGroups, codeReadingLines, newestCodeReadings } from './code-reading-ranges.mjs';

const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
const inNode = (parent, target) => !!parent && !!target && typeof target.nodeType === 'number' && parent.contains(target);
const groupKey = groups => groups.map(group => group.key).join('|');

function ReadingPreview({ state, popup, id, descriptionId, keep, leave, open, dismiss }) {
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    const rect = popup.current?.getBoundingClientRect(); if (!rect) return;
    const left = Math.max(8, Math.min(state.anchor.left, window.innerWidth - rect.width - 8));
    const below = state.anchor.bottom + 8; const top = below + rect.height <= window.innerHeight - 8 ? below : Math.max(8, state.anchor.top - rect.height - 8);
    setPosition({ left, top });
  }, [state.key, state.anchor, popup]);
  return <section ref={popup} id={id} className="cr-code-reading-preview" role="region" aria-label="已有 AI 解读" style={position} onPointerEnter={keep} onPointerLeave={leave} onFocusCapture={keep}>
    <header><strong>已有 AI 解读</strong><button type="button" className="cr-code-reading-close" aria-label="关闭解读预览" onClick={() => dismiss(true)}>×</button></header>
    <p id={descriptionId} className="cr-code-reading-preview-hint">已归档的 AI 结论 · 不会重新请求模型；按下箭头选择具体阅读</p>
    <div className="cr-code-reading-preview-body">{state.groups.map(group => <section className="cr-code-reading-unit" data-unit-kind={group.items[0].kind} data-unit-name={group.items[0].name} key={group.key}>
      <h4>{CODE_READING_KINDS[group.items[0].kind]} · {group.items[0].name}</h4><small>第 {group.start.line}:{group.start.column + 1}–{group.end.line}:{group.end.column + 1} 行列 · 结束位置不含</small>
      {group.items.map(item => <article className="cr-code-reading-entry" data-reading-id={item.id} key={item.id}>
        <p className="cr-code-reading-conclusion">{item.conclusion}</p><div className="cr-code-reading-entry-meta"><span>{item.lessonTitle}</span><time dateTime={item.createdAt}>{item.createdAt.slice(0, 10)}</time></div>
        <button type="button" className="cr-code-reading-open" aria-label={`打开阅读 ${item.lessonTitle}`} data-session-id={item.sessionId} data-lesson-id={item.lessonId} onClick={() => open(item)}>打开阅读</button>
      </article>)}
    </section>)}</div>
    <footer>↓ 选择其他阅读 · Esc 关闭 · 代码范围由模型给出，Host 核验版本与坐标，非 AST 识别</footer>
  </section>;
}

// A source-only display layer. It never fetches, changes Selection, or persists code.
export function useCodeReadings({ value, rows, identity, enabled, onOpenReading, root }) {
  const groups = useMemo(() => codeReadingGroups(value, rows), [value, rows]);
  const lineInfo = useMemo(() => codeReadingLines(groups, rows), [groups, rows]);
  const [state, setState] = useState(null); const active = useRef(null); const popup = useRef(null); const timers = useRef({ open: null, close: null }); const blocked = useRef(''); const suppressFocus = useRef(false); const popupId = useId(); const descriptionId = `${popupId}-description`;
  const latest = useRef(null); latest.current = { enabled, identity, onOpenReading, groups, rows };
  function clearTimers() { clearTimeout(timers.current.open); clearTimeout(timers.current.close); timers.current = { open: null, close: null }; }
  function hasSelection() { const selection = root.current?.ownerDocument.getSelection(); return selection && !selection.isCollapsed && (root.current.contains(selection.anchorNode) || root.current.contains(selection.focusNode)); }
  function dismiss(restore = false, block = true) {
    clearTimers(); const previous = active.current; if (block && previous) blocked.current = previous.key; active.current = null; setState(null);
    if (restore && previous?.identity === latest.current.identity && previous.origin?.isConnected) { suppressFocus.current = true; previous.origin.focus({ preventScroll: true }); requestAnimationFrame(() => { suppressFocus.current = false; }); }
  }
  function keep() { clearTimeout(timers.current.close); timers.current.close = null; }
  function leave() {
    clearTimeout(timers.current.open); clearTimeout(timers.current.close);
    if (active.current?.pinned || active.current?.origin === document.activeElement || inNode(popup.current, document.activeElement)) return;
    timers.current.close = setTimeout(() => dismiss(false, false), 220);
  }
  function show(nextGroups, anchor, origin, mode = 'hover') {
    clearTimers(); const now = latest.current; const key = groupKey(nextGroups);
    if (!now.enabled || !key || !root.current?.getClientRects().length || getComputedStyle(root.current).visibility === 'hidden' || (mode === 'hover' && (blocked.current === key || hasSelection()))) return;
    const next = { groups: nextGroups, anchor, origin, key, identity: now.identity, pinned: mode === 'pin' };
    active.current = next; setState(next);
  }
  function hover(nextGroups, anchor, origin) {
    keep(); clearTimeout(timers.current.open); if (active.current?.pinned) return; const key = groupKey(nextGroups); if (active.current?.key === key && active.current.identity === latest.current.identity) return;
    timers.current.open = setTimeout(() => show(nextGroups, anchor, origin), 180);
  }
  function open(item) { const valid = latest.current.enabled && latest.current.groups.some(group => group.items.some(candidate => candidate.id === item.id && candidate.sessionId === item.sessionId && candidate.lessonId === item.lessonId)); dismiss(); if (valid) void latest.current.onOpenReading?.(structuredClone(item)); }
  function markerProps(line, markedGroups) {
    const items = newestCodeReadings(markedGroups.flatMap(group => group.items)); const current = items[0]; const expanded = enabled && state?.identity === identity && state.groups.some(group => markedGroups.some(marked => marked.key === group.key));
    return {
      'data-reading-line': line, 'data-reading-count': markedGroups.length, 'aria-expanded': !!expanded, 'aria-controls': popupId, 'aria-describedby': expanded ? descriptionId : undefined,
      'aria-label': `第 ${line} 行有 ${markedGroups.length} 个代码单元已有 AI 解读；查看归档结论`,
      title: `已有 AI 解读 · 悬停或聚焦查看归档结论，↓ 选择阅读；最近归档：${current.lessonTitle}`,
      onFocus: event => { if (suppressFocus.current) return; blocked.current = ''; show(markedGroups, event.currentTarget.getBoundingClientRect(), event.currentTarget, 'focus'); },
      onPointerEnter: event => { if (event.pointerType === 'mouse') hover(markedGroups, event.currentTarget.getBoundingClientRect(), event.currentTarget); },
      onPointerLeave: event => { if (!inNode(popup.current, event.relatedTarget)) leave(); },
      onClick: event => { event.stopPropagation(); show(markedGroups, event.currentTarget.getBoundingClientRect(), event.currentTarget, 'pin'); },
      onKeyDown: event => { if (event.key !== 'ArrowDown') return; event.preventDefault(); event.stopPropagation(); show(markedGroups, event.currentTarget.getBoundingClientRect(), event.currentTarget, 'focus'); requestAnimationFrame(() => popup.current?.querySelector('.cr-code-reading-open')?.focus()); }
    };
  }
  function pointerMove(event) {
    if (!enabled || event.pointerType !== 'mouse' || inNode(popup.current, event.target) || event.target.closest('.cr-code-reading-marker')) return;
    if (event.buttons || hasSelection()) { dismiss(false, false); return; }
    const point = readCodePointAt(root.current, event.clientX, event.clientY, rows); const group = point && codeReadingGroupAt(groups, point);
    if (!group) { blocked.current = ''; leave(); return; }
    if (blocked.current && blocked.current !== group.key) blocked.current = '';
    const origin = root.current?.querySelector(`.cr-code-reading-marker[data-reading-line="${group.markerLine}"]`);
    hover([group], { left: event.clientX, top: event.clientY, bottom: event.clientY + 1 }, origin);
  }
  useEffect(() => { dismiss(false, false); blocked.current = ''; }, [identity, enabled, value]);
  useEffect(() => () => clearTimers(), []);
  useEffect(() => {
    if (!enabled) return;
    const doc = root.current?.ownerDocument ?? document;
    const scroll = event => { if (!inNode(popup.current, event.target)) dismiss(); };
    const context = () => dismiss();
    const pointer = event => { if (!inNode(popup.current, event.target) && !event.target.closest?.('.cr-code-reading-marker')) dismiss(); };
    const focus = event => { if (active.current && !event.target.closest?.('.cr-code-reading-marker') && !inNode(popup.current, event.target)) dismiss(); };
    const selected = () => { if (hasSelection()) dismiss(false, false); };
    const key = event => {
      if (!active.current) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(inNode(popup.current, doc.activeElement)); }
      else if (event.key === 'Tab') {
        if (inNode(popup.current, doc.activeElement)) {
          event.preventDefault(); const origin = active.current.origin;
          const controls = [...(root.current?.closest('.cr-page') ?? doc).querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(node => !node.disabled && !inNode(popup.current, node) && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
          const index = controls.indexOf(origin); const next = controls[index + (event.shiftKey ? -1 : 1)]; dismiss(); (next ?? origin)?.focus({ preventScroll: true });
        } else dismiss();
      } else if (inNode(popup.current, doc.activeElement) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const buttons = [...popup.current.querySelectorAll('.cr-code-reading-open')]; const index = buttons.indexOf(doc.activeElement); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
        event.preventDefault(); buttons[next]?.focus();
      }
    };
    doc.addEventListener('pointerdown', pointer, true); doc.addEventListener('focusin', focus); doc.addEventListener('keydown', key, true); doc.addEventListener('contextmenu', context, true); doc.addEventListener('scroll', scroll, true); doc.addEventListener('selectionchange', selected); window.addEventListener('wheel', scroll, true); window.addEventListener('touchmove', scroll, true); window.addEventListener('resize', scroll);
    return () => { doc.removeEventListener('pointerdown', pointer, true); doc.removeEventListener('focusin', focus); doc.removeEventListener('keydown', key, true); doc.removeEventListener('contextmenu', context, true); doc.removeEventListener('scroll', scroll, true); doc.removeEventListener('selectionchange', selected); window.removeEventListener('wheel', scroll, true); window.removeEventListener('touchmove', scroll, true); window.removeEventListener('resize', scroll); };
  }, [enabled, root]);
  const visible = enabled && state?.identity === identity; const portal = root.current?.closest('.cr-page');
  const summary = value && (groups.length || value.sourceKind === 'code' || count(value.staleCount) || value.truncated) ? <div className="cr-code-reading-summary" aria-label="源码阅读关联"><span>{groups.length ? `当前页 ${groups.length} 个代码单元已有 AI 解读` : value.sourceKind === 'code' ? '当前页暂无已关联的代码单元解读' : '阅读关联'}</span>{count(value.staleCount) > 0 && <span>{value.staleCount} 条解读属于其他版本，未标记</span>}{value.sourceKind === 'code' && count(value.legacyCount) > 0 && <span>{value.legacyCount} 条旧解读缺少完整代码单元关联，未标记</span>}{value.truncated && <span>关联扫描已截断，可能还有其他解读</span>}</div> : null;
  return { lineInfo, groups, markerProps, bind: { onPointerMove: pointerMove, onPointerLeave: event => { if (!inNode(popup.current, event.relatedTarget)) { blocked.current = ''; leave(); } } }, summary, preview: visible && portal ? createPortal(<ReadingPreview state={state} popup={popup} id={popupId} descriptionId={descriptionId} keep={keep} leave={leave} open={open} dismiss={dismiss} />, portal) : null };
}
