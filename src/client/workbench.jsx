import React, { useEffect, useRef, useState } from 'react';
import { MermaidDiagram } from './mermaid.jsx';
import { UiIcon } from './icons/ui-icons.jsx';
import { MindMap } from './mind-map.jsx';

// A display hint only: old notes did not carry codeMapTask. Never use title
// matching to authorize tools, writes, repository access, or evidence validity.
export function isMapLesson(lesson, snapshot, latest) {
  if (!lesson) return false;
  const first = snapshot?.state.lessons[0]?.id === lesson.id;
  return !!(first && snapshot?.codeMapTask
    || latest?.sessionId === snapshot?.sessionId && latest?.lessonId === lesson.id
    || /(?:代码|项目|架构)\s*地图|\b(?:code|project)\s*map\b/i.test(lesson.title)
    || first && /(?:代码|项目|架构)\s*地图|\b(?:code|project)\s*map\b/i.test(snapshot?.topic ?? ''));
}

export const topicTitle = (value, fallback = '新的阅读') => value?.trim() || fallback;
const DIMENSION_LABELS = { discover: '业务概览', business: '业务解释', 'call-chain': '调用链', 'deep-read': '代码逻辑', verify: '理解自查' };

// The list represents actual reading output, never a fixed curriculum.
export function ReadingRoute({ snapshot, selectedId, viewed, understood, onLesson }) {
  const lessons = snapshot?.state.lessons ?? [];
  if (!lessons.length) return null;
  return <nav aria-label="本次阅读内容" className="cr-route-list">{lessons.map(lesson => <button type="button" className="cr-route-node" key={lesson.id} aria-current={selectedId === lesson.id ? 'true' : undefined} title={understood.includes(lesson.id) ? '你已标记理解' : viewed.includes(lesson.id) ? '已查看，未标记理解' : '尚未查看'} onClick={() => onLesson(lesson)}><span className="cr-lesson-marker" aria-hidden="true">{understood.includes(lesson.id) ? '✓' : '·'}</span><span className="cr-route-node-title">{lesson.title}</span>{selectedId === lesson.id && <span className="cr-sr-only">当前位置</span>}</button>)}</nav>;
}

export function LessonArticle({ lesson, evidence, repositories, Markdown, openEvidence, understood, onUnderstand, onDeepen, disabled, mapFirst = false }) {
  const [dimension, setDimension] = useState(null); const [showDiagram, setShowDiagram] = useState(false);
  const claims = lesson.claims ?? [];
  const hypotheses = claims.filter(claim => claim.kind === 'hypothesis');
  const ids = [...new Set(claims.flatMap(claim => claim.evidenceIds ?? []))];
  const codeOrder = ['deep-read', 'call-chain', 'business', 'discover', 'verify'];
  const sections = (lesson.sections ?? []).filter(section => DIMENSION_LABELS[section.dimension] && section.markdown?.trim());
  if (lesson.readingMode === 'code') sections.sort((a, b) => codeOrder.indexOf(a.dimension) - codeOrder.indexOf(b.dimension));
  const selectedSection = sections.find(section => section.dimension === dimension) ?? sections[0];
  const graphFirst = lesson.intent === 'logic-graph' && !!lesson.mermaid;
  const rawText = selectedSection?.markdown ?? lesson.markdown;
  const text = graphFirst ? rawText.replace(/```mermaid\s*\n([\s\S]*?)```/g, (block, source) => source.trim() === lesson.mermaid.trim() ? '' : block).trim() : rawText;
  const contentId = `cr-lesson-content-${lesson.id}`;
  const evidenceContent = <>
    <section className="cr-lesson-evidence"><h3><UiIcon name="file-code-2" size={15} />代码证据 <span>{ids.length}</span></h3>
      {ids.length ? <div className="cr-citation-list">{ids.map(id => {
        const ref = evidence.find(item => item.id === id); const repo = repositories.find(item => item.id === ref?.repoId);
        return <button type="button" className="cr-citation" key={id} onClick={() => openEvidence(id)}><span>{ref ? `${repo?.name ?? ref.repoId} / ${ref.path}:${ref.startLine}–${ref.endLine}` : '引用尚未定位'}</span><small>{ref ? `${ref.symbol || '源码范围'} · SHA256 ${ref.hash.slice(0, 10)}… · 点击核验` : id}</small></button>;
      })}</div> : <p className="cr-muted">此知识点没有结构化代码引用；不能据此确认实现。</p>}
      <details><summary>核对事实与推断</summary>{claims.filter(claim => claim.kind !== 'hypothesis').map((claim, index) => <div className="cr-claim" data-kind={claim.kind} key={index}><strong>{claim.kind === 'fact' ? 'AI 标注 · 代码事实' : 'AI 标注 · 推断'}</strong>{claim.text}<div className="cr-row">{claim.evidenceIds?.map(id => <button type="button" key={id} onClick={() => openEvidence(id)}>{evidence.find(item => item.id === id)?.path ?? '未定位引用'}</button>)}</div></div>)}</details>
    </section>
    {hypotheses.length > 0 && <section className="cr-open-questions"><h3>尚未确认</h3>{hypotheses.map((claim, index) => <p key={index}><span className="cr-status-dot" />{claim.text}</p>)}</section>}
  </>;
  return <article className={`cr-lesson${mapFirst ? ' cr-lesson-map' : ''}`} data-lesson-id={lesson.id}>
    {mapFirst ? <>
      <MindMap title={lesson.title} markdown={lesson.markdown} conclusion={lesson.conclusion} sections={sections} Markdown={Markdown} openEvidence={openEvidence} />
      {lesson.mermaid && !lesson.markdown.includes('```mermaid') && <details className="cr-map-supplement" onToggle={event => setShowDiagram(event.currentTarget.open)}><summary>查看原始关系图</summary>{showDiagram && <MermaidDiagram source={lesson.mermaid} />}</details>}
      <details className="cr-map-evidence"><summary>代码证据与核验 · {ids.length} 条引用{hypotheses.length ? ` · ${hypotheses.length} 项尚未确认` : ''}</summary>{evidenceContent}</details>
    </> : <>
      <header className="cr-lesson-heading"><span className="cr-eyebrow"><UiIcon name="sparkles" size={13} />阅读笔记</span><span className="cr-ai-label">AI 讲解 · 结合源码核对</span></header>
      <h2>{lesson.title}</h2>
      {graphFirst && <section className="cr-logic-graph" aria-label="AI 逻辑图"><header><UiIcon name="sparkles" size={15} />代码逻辑图<span>· 基于选区与源码证据</span></header><MermaidDiagram source={lesson.mermaid} /><p>AI 基于本轮读到的源码生成；分支、调用和异常路径请结合下方证据核对。</p></section>}
      {lesson.conclusion && <section className="cr-conclusion"><strong>核心结论</strong><p>{lesson.conclusion}</p></section>}
      {sections.length > 0 && <nav className="cr-section-tabs" aria-label="内容维度">{sections.map(section => <button type="button" key={section.dimension} aria-pressed={selectedSection.dimension === section.dimension} aria-controls={contentId} onClick={() => setDimension(section.dimension)}>{DIMENSION_LABELS[section.dimension]}</button>)}</nav>}
      <section id={contentId} className={`cr-key-explanation${text.length > 14000 ? ' cr-long-explanation' : ''}`} aria-label={selectedSection ? DIMENSION_LABELS[selectedSection.dimension] : '关键解释'}>
        {text.length > 14000 ? <details><summary>展开完整讲解（较长内容）</summary><Markdown text={text} openEvidence={openEvidence} /></details> : <Markdown text={text} openEvidence={openEvidence} />}
        {!graphFirst && lesson.mermaid && (!selectedSection || selectedSection.dimension === 'call-chain') && !text.includes('```mermaid') && <MermaidDiagram source={lesson.mermaid} />}
      </section>
      {evidenceContent}
    </>}
    {lesson.nextQuestions?.length > 0 && <section className="cr-next-questions"><h3>继续探索</h3>{lesson.nextQuestions.map((question, index) => <button type="button" className="cr-question" key={index} disabled={disabled} onClick={() => onDeepen(question)}>深入：{question}<span aria-hidden="true">↗</span></button>)}</section>}
    <footer className="cr-lesson-footer"><button type="button" aria-pressed={understood} onClick={onUnderstand}>{understood ? '✓ 已理解，撤销标记' : '标记已理解'}</button><small>仅记录你的主动标记</small><time>{new Date(lesson.createdAt).toLocaleString()}</time></footer>
  </article>;
}

export function ReadingDialog({ title, onClose, children, className = '' }) {
  const root = useRef(null);
  useEffect(() => {
    const previous = document.activeElement; root.current?.showModal(); root.current?.querySelector('button,input,textarea,select')?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={root} className={`cr-dialog ${className}`} aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === root.current) { const rect = root.current.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}><header className="cr-dialog-header"><h2>{title}</h2><button type="button" aria-label={`关闭${title}`} onClick={onClose}>关闭</button></header><div className="cr-dialog-body">{children}</div></dialog>;
}
export function Transcript({ messages, Markdown, openEvidence }) {
  const groups = [];
  for (const message of messages) { if (message.role === 'user' || !groups.length) groups.push([]); groups.at(-1).push(message); }
  if (!groups.length) return <p className="cr-muted">尚无已归档问答。分析中的文本会在后端报告结束并归档后显示。</p>;
  return groups.map(group => <details className="cr-transcript-group" key={group[0].seq}><summary>{group.find(item => item.role === 'user')?.text.slice(0, 100) || '阅读导师的解释'}<small>{group.length} 条记录 · {new Date(group[0].time).toLocaleString()}</small></summary>{group.map(message => <article className="cr-message" key={message.seq}><header>{message.role === 'user' ? '你' : '阅读导师'} · {new Date(message.time).toLocaleString()}</header><Markdown text={message.text} openEvidence={openEvidence} /></article>)}</details>);
}
