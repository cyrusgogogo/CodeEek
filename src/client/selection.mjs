// DOM selection is only a coordinate hint; the Host rereads/hash-checks every action.
function boundary(viewer, node, offset, rows) {
  const element = node.nodeType === 1 ? node : node.parentElement;
  const textRoot = element?.closest('[data-code-text]');
  if (textRoot && viewer.contains(textRoot)) {
    const row = textRoot.closest('[data-code-line]'); const line = Number(row.dataset.codeLine); const model = rows.find(value => value.number === line);
    if (!model || !textRoot.contains(node)) throw new Error('请选择同一个文件中的代码文本');
    const prefix = viewer.ownerDocument.createRange(); prefix.selectNodeContents(textRoot); prefix.setEnd(node, offset);
    const column = prefix.toString().length; if (column > model.text.length) throw new Error('选区列超出当前代码行'); return { line, column };
  }
  if (node.nodeType === 1 && viewer.contains(node)) {
    if (node.matches('[data-code-line]')) {
      const code = node.querySelector('[data-code-text]'); const line = Number(node.dataset.codeLine); const model = rows.find(value => value.number === line); const index = [...node.childNodes].indexOf(code);
      if (model && index >= 0) return { line, column: offset <= index ? 0 : model.text.length };
    }
    if (node.matches('.cr-code-lines')) {
      const children = [...node.children]; if (offset < children.length) return { line: Number(children[offset].dataset.codeLine), column: 0 };
      const last = rows.at(-1); if (last) return { line: last.number, column: last.text.length };
    }
  }
  throw new Error('行号和工具栏不属于代码选区');
}
export function readCodeSelection(viewer, range, rows, context) {
  if (!range || range.collapsed || !viewer.contains(range.startContainer) || !viewer.contains(range.endContainer)) return null;
  const start = boundary(viewer, range.startContainer, range.startOffset, rows); const end = boundary(viewer, range.endContainer, range.endOffset, rows);
  const first = rows.findIndex(row => row.number === start.line); const last = rows.findIndex(row => row.number === end.line); if (first < 0 || last < first) return null;
  const parts = rows.slice(first, last + 1).map((row, index, selected) => row.text.slice(index === 0 ? start.column : 0, index === selected.length - 1 ? end.column : row.text.length)); const quote = parts.join('\n');
  if (!quote) return null; if (quote.length > 8000 || last - first >= 400) throw new Error('选区最多 8,000 字符、400 行，请缩小范围');
  for (const point of [start, end]) { const text = rows.find(row => row.number === point.line).text; if (point.column > 0 && /[\uD800-\uDBFF]/.test(text[point.column - 1]) && /[\uDC00-\uDFFF]/.test(text[point.column] ?? '')) throw new Error('请完整选择 Unicode 字符'); }
  return { ...context, start, end, quote };
}

// A caret lookup is a read-only coordinate hint, not Selection manipulation or parsing.
export function readCodePointAt(viewer, x, y, rows) {
  if (!viewer || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const doc = viewer.ownerDocument; const hit = doc.elementFromPoint(x, y); const textRoot = hit?.closest('[data-code-text]');
  if (!textRoot || !viewer.contains(textRoot)) return null;
  let node; let offset;
  if (typeof doc.caretPositionFromPoint === 'function') { const point = doc.caretPositionFromPoint(x, y); node = point?.offsetNode; offset = point?.offset; }
  if (!node && typeof doc.caretRangeFromPoint === 'function') { const range = doc.caretRangeFromPoint(x, y); node = range?.startContainer; offset = range?.startOffset; }
  if (!node || !textRoot.contains(node)) return null;
  try { return boundary(viewer, node, offset, rows); } catch { return null; }
}
