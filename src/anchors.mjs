import { fail } from './contracts.mjs';

export const ANCHOR_NORMALIZER = 'utf8-textdecoder-lf-v1';
export const SELECTION_LIMIT = 8000;
const CONTEXT = 64;
const splitSurrogate = (text, offset) => offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]);
export function offsetOf(lines, point) {
  if (!Number.isSafeInteger(point?.line) || point.line < 1 || point.line > lines.length || !Number.isSafeInteger(point.column) || point.column < 0 || point.column > lines[point.line - 1].length || splitSurrogate(lines[point.line - 1], point.column)) fail('INVALID_SELECTION', '选区行列越界或切开 Unicode 字符，请重新选择');
  let offset = point.column; for (let i = 0; i < point.line - 1; i++) offset += lines[i].length + 1; return offset;
}
export function pointOf(lines, offset) {
  for (let i = 0; i < lines.length; i++) { if (offset <= lines[i].length) return { line: i + 1, column: offset }; offset -= lines[i].length + 1; }
  fail('INVALID_SELECTION', '选区偏移超出文件');
}
export function canonicalSelection(source, selection) {
  if (source.hash !== selection.fileHash) fail('STALE_SELECTION', '源码已变化，请重新加载文件后再分析或批注');
  const text = source.lines.join('\n'); const start = offsetOf(source.lines, selection.start); const end = offsetOf(source.lines, selection.end);
  if (end <= start || selection.end.line - selection.start.line >= 400 || end - start > SELECTION_LIMIT) fail('SELECTION_LIMIT', '请选择非空且不超过 8,000 字符、400 行的代码');
  const quote = text.slice(start, end); if (quote !== selection.quote) fail('SELECTION_MISMATCH', '选中文字与当前源码不一致，请重新选择');
  let before = Math.max(0, start - CONTEXT); let after = Math.min(text.length, end + CONTEXT);
  if (splitSurrogate(text, before)) before--; if (splitSurrogate(text, after)) after++;
  return { normalizer: ANCHOR_NORMALIZER, repoId: selection.repoId, path: selection.path, fileHash: source.hash, start: { ...selection.start }, end: { ...selection.end }, quote, prefix: text.slice(before, start), suffix: text.slice(end, after), prefixBOF: before === 0, suffixEOF: after === text.length };
}
export function locateAnchor(anchor, source, needsReview = false) {
  if (!source) return { status: 'missing', needsReview: true };
  const text = source.lines.join('\n');
  if (source.hash === anchor.fileHash) {
    let valid = false; try { valid = text.slice(offsetOf(source.lines, anchor.start), offsetOf(source.lines, anchor.end)) === anchor.quote; } catch { /* corrupt coordinates */ }
    if (!valid) return { status: 'inconsistent', needsReview: true };
    return { status: needsReview ? 'review' : 'current', needsReview, candidate: { start: anchor.start, end: anchor.end } };
  }
  const hits = []; let next = 0; let saturated = false;
  while (next <= text.length) { const found = text.indexOf(anchor.quote, next); if (found < 0) break; hits.push(found); next = found + 1; if (hits.length >= 1024) { saturated = true; break; } }
  if (!hits.length) return { status: 'changed', needsReview: true };
  if (saturated) return { status: 'ambiguous', needsReview: true };
  const reliable = hits.filter(start => {
    const end = start + anchor.quote.length; const before = start - anchor.prefix.length; const after = end + anchor.suffix.length;
    return before >= 0 && text.slice(before, start) === anchor.prefix && text.slice(end, after) === anchor.suffix && (!anchor.prefixBOF || before === 0) && (!anchor.suffixEOF || after === text.length);
  });
  if (reliable.length !== 1) return { status: hits.length > 1 ? 'ambiguous' : 'context-changed', needsReview: true };
  const start = reliable[0]; return { status: 'relocated', needsReview: true, candidate: { start: pointOf(source.lines, start), end: pointOf(source.lines, start + anchor.quote.length) } };
}
export const ANNOTATION_LABELS = { current: '本版本已确认', review: '待复核（曾观察到变化）', relocated: '找到候选 · 待复核', 'context-changed': '上下文变化 · 待重绑', changed: '选区已变化 · 待重绑', ambiguous: '多个匹配 · 待重绑', missing: '文件已移除或改名', unreadable: '文件暂不可读', inconsistent: '锚点不一致', unchecked: '尚未核验当前版本' };
export function annotationMarkdown(items) {
  if (!items.length) return '\n## 代码批注\n\n暂无批注。\n';
  return '\n## 代码批注\n\n> 以下引用锚定版本，不承诺当前源码仍相同；完整重绑历史保存在 annotations.json。\n\n' + items.map(item => {
    const anchor = item.history.at(-1).anchor; const runs = anchor.quote.match(/`+/g) ?? []; const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
    return `### ${item.id}\n\n${item.body}\n\n${anchor.repoId}:${anchor.path}:${anchor.start.line}:${anchor.start.column + 1}–${anchor.end.line}:${anchor.end.column + 1} · SHA256 ${anchor.fileHash}\n\n${fence}\n${anchor.quote}\n${fence}\n\n批注版本 ${item.revision} · ${item.needsReview ? '曾观察到变化，需人工复核' : '仅对锚定版本确认'}\n`;
  }).join('\n');
}
