import test from 'node:test';
import assert from 'node:assert/strict';
import { readCodePointAt } from '../src/client/selection.mjs';
import { codeReadingContains, codeReadingGroups, codeReadingGroupAt, codeReadingLines, newestCodeReadings } from '../src/client/code-reading-ranges.mjs';
const rows = (first = 1, last = 20, text = 'x'.repeat(100)) => Array.from({ length: last - first + 1 }, (_, index) => ({ number: first + index, text }));
const item = (id, start = { line: 2, column: 0 }, end = { line: 5, column: 1 }, extra = {}) => ({ id, kind: 'method', name: 'charge', start, end, conclusion: '已归档结论 <script>plain text only</script>', sessionId: 'session-a', lessonId: 'lesson-a', lessonTitle: '金额校验', stage: 'deep-read', createdAt: '2026-10-19T10:00:00.000Z', ...extra });

test('相同代码范围跨会话解读分组，保留每条精确阅读链接和非固定格式 ID', () => {
  const old = item('lesson-a:0'); const recent = item('lesson-b:3', old.start, old.end, { sessionId: 'session-b', lessonId: 'lesson-b', createdAt: '2026-10-19T11:00:00.000Z' });
  const groups = codeReadingGroups({ sourceKind: 'code', items: [old, recent] }, rows());
  assert.equal(groups.length, 1); assert.equal(groups[0].items.length, 2); assert.equal(groups[0].items[0], recent); assert.equal(groups[0].items[1].sessionId, 'session-a');
  assert.deepEqual(newestCodeReadings([old, recent]), [recent, old]);
});

test('同一行方法按 UTF16 半开区间区分，包括代理对与恰好结束的坐标', () => {
  const first = item('left', { line: 1, column: 0 }, { line: 1, column: 7 }, { name: 'left' }); const second = item('right', { line: 1, column: 8 }, { line: 1, column: 16 }, { name: 'right' });
  const groups = codeReadingGroups({ items: [first, second] }, rows(1, 1, 'a😀bbcc ddeeffgg '));
  assert.equal(groups.length, 2); assert.equal(codeReadingGroupAt(groups, { line: 1, column: 3 }).items[0].name, 'left');
  assert.equal(codeReadingGroupAt(groups, { line: 1, column: 7 }), null); assert.equal(codeReadingGroupAt(groups, { line: 1, column: 8 }).items[0].name, 'right'); assert.equal(codeReadingGroupAt(groups, { line: 1, column: 16 }), null);
  assert.equal(codeReadingContains(first, first.start), true); assert.equal(codeReadingContains(first, first.end), false);
  assert.equal(codeReadingGroups({ items: [item('split', { line: 1, column: 2 }, { line: 1, column: 5 })] }, rows(1, 1, 'a😀bbcc')).length, 0);
});

test('页前开始的方法在第一页可见行留标记，end.column=0 不把下一段首行标为已解读', () => {
  const prior = item('prior', { line: 180, column: 3 }, { line: 205, column: 0 }); const offPage = item('off', { line: 170, column: 0 }, { line: 201, column: 0 });
  const groups = codeReadingGroups({ items: [prior, offPage] }, rows(201, 210)); const lines = codeReadingLines(groups, rows(201, 210));
  assert.equal(groups.length, 1); assert.equal(groups[0].markerLine, 201); assert.equal(lines.get(201).markers.length, 1); assert.equal(lines.has(204), true); assert.equal(lines.has(205), false);
});

test('嵌套时优先最小显式 callable，类和文件不生成成员方法标记', () => {
  const whole = item('file', { line: 1, column: 0 }, { line: 20, column: 1 }, { kind: 'file', name: 'entry.unknown' }); const type = item('class', { line: 2, column: 0 }, { line: 19, column: 1 }, { kind: 'class', name: 'Service' }); const method = item('method', { line: 3, column: 0 }, { line: 10, column: 1 }); const inner = item('inner', { line: 4, column: 0 }, { line: 5, column: 1 }, { kind: 'function', name: 'inner' });
  const groups = codeReadingGroups({ items: [whole, type, method, inner] }, rows());
  assert.equal(codeReadingGroupAt(groups, { line: 4, column: 1 }).items[0].id, 'inner'); assert.equal(codeReadingGroupAt(groups, { line: 7, column: 1 }).items[0].id, 'method');
  const onlyClass = codeReadingGroups({ items: [type] }, rows()); const lines = codeReadingLines(onlyClass, rows()); assert.equal(lines.get(2).markers.length, 1); assert.equal(lines.get(3).markers.length, 0); assert.equal(onlyClass.length, 1);
});

test('同范围文件或类概览不与方法解读合并，最新高层概览也不抢占 callable 悬停', () => {
  const start = { line: 1, column: 0 }; const end = { line: 3, column: 7 };
  const method = item('method', start, end, { kind: 'method', name: 'charge' });
  const alias = item('alias', start, end, { kind: 'function', name: 'charge', createdAt: '2026-10-19T10:30:00.000Z' });
  const file = item('file', start, end, { kind: 'file', name: 'charge.py', createdAt: '2026-10-19T12:00:00.000Z' });
  const type = item('class', start, end, { kind: 'class', name: 'Service', createdAt: '2026-10-19T11:00:00.000Z' });
  const groups = codeReadingGroups({ items: [file, type, method, alias] }, rows());
  assert.equal(groups.length, 3); const selected = codeReadingGroupAt(groups, { line: 2, column: 1 });
  assert.equal(selected.items.length, 2); assert.equal(selected.items[0].kind, 'function'); assert.equal(selected.items[0].name, 'charge');
  assert.deepEqual(selected.items.map(value => value.id), ['alias', 'method']);
});

test('构造方法与未知语言使用相同几何，非代码与旧档案计数不伪造关联', () => {
  const constructor = item('ctor', { line: 1, column: 0 }, { line: 2, column: 1 }, { kind: 'constructor', name: 'Service' });
  assert.equal(codeReadingGroups({ sourceKind: 'code', items: [constructor] }, rows())[0].items[0].kind, 'constructor');
  assert.deepEqual(codeReadingGroups({ sourceKind: 'document', items: [], legacyCount: 5, staleCount: 7 }, rows()), []); assert.deepEqual(codeReadingGroups(undefined, rows()), []);
});

function caretFixture() {
  const row = { dataset: { codeLine: '7' } }; let textNode;
  const textRoot = { closest: selector => selector === '[data-code-text]' ? textRoot : row, contains: node => node === textNode };
  textNode = { nodeType: 3, parentElement: textRoot };
  const doc = { elementFromPoint: () => ({ closest: () => textRoot }), caretPositionFromPoint: () => ({ offsetNode: textNode, offset: 2 }), getSelection: () => { throw new Error('caret hint must not manipulate Selection'); }, createRange: () => { let offset = 0; return { selectNodeContents: root => assert.equal(root, textRoot), setEnd: (node, value) => { assert.equal(node, textNode); offset = value; }, toString: () => 'a😀' + 'hello'.slice(0, offset) }; } };
  return { viewer: { ownerDocument: doc, contains: node => node === textRoot || node === textNode }, doc, textNode, rows: [{ number: 7, text: 'a😀hello' }] };
}

test('token DOM caret 提示以 UTF16 计数，不读取或修改 Selection', () => {
  const fixture = caretFixture(); assert.deepEqual(readCodePointAt(fixture.viewer, 10, 20, fixture.rows), { line: 7, column: 5 });
});

test('caret 标准 API 返回空时可回退，非代码命中与不支持的浏览器拒绝猜测坐标', () => {
  const fixture = caretFixture(); fixture.doc.caretPositionFromPoint = () => null; fixture.doc.caretRangeFromPoint = () => ({ startContainer: fixture.textNode, startOffset: 2 });
  assert.deepEqual(readCodePointAt(fixture.viewer, 10, 20, fixture.rows), { line: 7, column: 5 });
  delete fixture.doc.caretRangeFromPoint; assert.equal(readCodePointAt(fixture.viewer, 10, 20, fixture.rows), null);
  fixture.doc.elementFromPoint = () => ({ closest: () => null }); assert.equal(readCodePointAt(fixture.viewer, 10, 20, fixture.rows), null);
});

test('有界最多 200 条输入，拒绝重复 ID、无效半开范围和伪造可见列', () => {
  const input = Array.from({ length: 205 }, (_, index) => item(`lesson:${index}`)); const groups = codeReadingGroups({ items: input }, rows()); assert.equal(groups[0].items.length, 200);
  assert.equal(codeReadingGroups({ items: [input[0], input[0]] }, rows())[0].items.length, 1);
  assert.deepEqual(codeReadingGroups({ items: [item('empty', { line: 2, column: 0 }, { line: 2, column: 0 }), item('back', { line: 4, column: 0 }, { line: 2, column: 0 }), item('column', { line: 2, column: 101 }), item('bad-kind', undefined, undefined, { kind: 'toString' }), item('missing-link', undefined, undefined, { lessonId: '' })] }, rows()), []);
});
