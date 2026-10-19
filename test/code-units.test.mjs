import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReadingStore } from '../src/store.mjs';
import { publishSchema } from '../src/contracts.mjs';
import { readRepository, digest } from '../src/filesystem.mjs';
import { viewFile } from '../src/workspace.mjs';
import { collectCodeReadings, isNonCodePath, CODE_READING_LIMITS } from '../src/code-units.mjs';

const base = path.resolve('.test-output');
const sample = 'function submit(value) {\n  if (value) return 1;\n  return 0;\n}\n';
async function fixture(t, text = sample, relative = 'service.ts') {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'code-units-')); const repo = path.join(root, 'repo'); await fs.mkdir(repo); const file = path.join(repo, relative); await fs.writeFile(file, text);
  const store = await new ReadingStore(path.join(root, 'artifacts')).init(); const project = await store.createProject({ repositories: [{ path: repo }] }); const session = await store.createSession(project.id); const repoId = project.repositories[0].id;
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), base); assert.match(path.basename(root), /^code-units-/); await fs.rm(root, { recursive: true, force: true }); });
  return { root, repo, file, relative, text, store, project, sessionId: session.id, repoId };
}
const position = text => { const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/); return { line: lines.length, column: lines.at(-1).length }; };
const args = (evidence, codeUnits = []) => ({ expectedRevision: 1, title: '完整单元阅读', markdown: '核对完整代码后解释关键分支。', conclusion: '请结合当前源码核对。', claims: evidence ? [{ kind: 'fact', text: '已经读取源码', evidenceIds: [evidence.id] }] : [{ kind: 'hypothesis', text: '需要后续核验', evidenceIds: [] }], nextQuestions: ['还想核对哪个调用方？'], codeUnits });
const unit = (f, evidence, extra = {}) => ({ kind: 'function', name: 'submit', repoId: f.repoId, path: f.relative, fileHash: evidence.hash, start: { line: 1, column: 0 }, end: { line: 4, column: 1 }, conclusion: '根据输入返回 1 或 0。', evidenceIds: [evidence.id], ...extra });
const read = (f, sessionId = f.sessionId, extra = {}) => f.store.read(sessionId, { repoId: f.repoId, path: f.relative, ...extra });
const view = (f, sessionId = f.sessionId, extra = {}) => viewFile(f.store, { sessionId, repoId: f.repoId, path: f.relative, ...extra });

const languages = [
  ['function.ts', sample, 'function', 'submit', 1, 0, 4, 1],
  ['function.py', 'def submit(value):\n    if value:\n        return 1\n    return 0\n', 'function', 'submit', 1, 0, 4, 12],
  ['Orders.java', 'class Orders {\n  int submit(boolean v) {\n    if (v) return 1;\n    return 0;\n  }\n}\n', 'method', 'Orders.submit', 2, 2, 5, 3],
  ['function.go', 'func submit(v bool) int {\n  if v { return 1 }\n  return 0\n}\n', 'function', 'submit', 1, 0, 4, 1],
  ['function.rs', 'fn submit(v: bool) -> i32 {\n  if v { return 1; }\n  0\n}\n', 'function', 'submit', 1, 0, 4, 1],
  ['function.unknown-language', 'routine submit(value)\n  return value\ndone\n', 'function', 'submit', 1, 0, 3, 4]
];
for (const [relative, text, kind, name, startLine, startColumn, endLine, endColumn] of languages) {
  test(`完整语义范围语言无关：${relative} 可归档并用同版本证据定位，不声称 AST`, async t => {
    const f = await fixture(t, text, relative); const evidence = (await read(f)).evidence; const declared = unit(f, evidence, { kind, name, start: { line: startLine, column: startColumn }, end: { line: endLine, column: endColumn } });
    const saved = await f.store.publish(f.sessionId, args(evidence, [declared])); assert.deepEqual(saved.codeUnits, [declared]);
    const readings = (await view(f, f.sessionId, { offset: endLine, limit: 1 })).codeReadings;
    assert.equal(readings.sourceKind, 'code'); assert.equal(readings.items.length, 1); assert.equal(readings.items[0].id, `${saved.id}:0`); assert.equal(readings.items[0].name, name); assert.deepEqual(readings.items[0].start, declared.start); assert.equal(readings.truncated, false);
    const restarted = await new ReadingStore(f.store.root).init(); assert.equal((await viewFile(restarted, { sessionId: f.sessionId, repoId: f.repoId, path: relative })).codeReadings.items[0].id, `${saved.id}:0`);
  });
}

test('新代码发布缺失单元拒绝且没有产物；文档/数据明确豁免，未知扩展不豁免', async t => {
  const f = await fixture(t); const evidence = (await read(f)).evidence; const before = structuredClone(f.store.session(f.sessionId));
  await assert.rejects(f.store.publish(f.sessionId, args(evidence)), { code: 'CODE_UNIT_REQUIRED' }); assert.deepEqual(f.store.session(f.sessionId), before);
  for (const folder of ['notes', 'diagrams']) assert.deepEqual(await fs.readdir(path.join(f.store.sessionDir(f.sessionId), folder)), []);
  for (const relative of ['README.md', 'manual.txt', 'requirements.txt', 'settings.json', 'config.yml', 'schema.xml', 'schema.xsd', 'entity.dtd', 'strings.resx', 'settings.plist', 'app.cfg', 'app.conf', 'app.config']) {
    await fs.writeFile(path.join(f.repo, relative), 'document or data\n'); const result = await f.store.read(f.sessionId, { repoId: f.repoId, path: relative }); await f.store.publish(f.sessionId, args(result.evidence));
    const codeReadings = (await viewFile(f.store, { sessionId: f.sessionId, repoId: f.repoId, path: relative })).codeReadings; assert.equal(codeReadings.sourceKind, 'document'); assert.equal(codeReadings.items.length, 0); assert.equal(codeReadings.legacyCount, 1);
  }
  for (const relative of ['Dockerfile', 'Makefile', 'CMakeLists.txt', 'logic.custom', 'script.sh', 'types.d.ts', 'view.mdx', 'page.html', 'module.jsconfig']) assert.equal(isNonCodePath(relative), false);
});

test('问题阅读的代码结论不能只用完整README单元绕过代码粒度；纯文档及有效代码加辅助上下文仍允许', async t => {
  const f = await fixture(t); const evidence = (await read(f)).evidence; const text = '# README\n模块说明。\n'; await fs.writeFile(path.join(f.repo, 'README.md'), text);
  const document = (await f.store.read(f.sessionId, { repoId: f.repoId, path: 'README.md' })).evidence; const documentUnit = unit(f, document, { kind: 'file', name: 'README', path: 'README.md', end: position(text), conclusion: '完整文档的已有结论。' });
  assert.equal(f.store.catalog(f.sessionId).readingMode, 'question'); assert.equal(f.store.catalog(f.sessionId).readingFocus, null);
  await assert.rejects(f.store.publish(f.sessionId, args(evidence, [documentUnit])), { code: 'CODE_UNIT_REQUIRED' }); assert.equal(f.store.session(f.sessionId).lessons.length, 0);
  for (const folder of ['notes', 'diagrams']) assert.deepEqual(await fs.readdir(path.join(f.store.sessionDir(f.sessionId), folder)), []);
  assert.equal((await f.store.publish(f.sessionId, args(document, [documentUnit]))).codeUnits.length, 1); assert.deepEqual((await f.store.publish(f.sessionId, args(document))).codeUnits, []);
  await fs.writeFile(path.join(f.repo, 'auxiliary.ts'), 'export const status = true;\n'); const auxiliary = (await f.store.read(f.sessionId, { repoId: f.repoId, path: 'auxiliary.ts' })).evidence;
  const saved = await f.store.publish(f.sessionId, args(auxiliary, [documentUnit, unit(f, evidence)])); assert.equal(saved.codeUnits.length, 2); assert.equal(saved.claims[0].evidenceIds[0], auxiliary.id);
});

test('代码关注范围即使未列入 claims 仍要求完整单元包含；单元可大于8k并跨连续读取', async t => {
  const text = ['function huge() {', ...Array.from({ length: 450 }, () => `  step("${'x'.repeat(32)}");`), '}', ''].join('\n'); const f = await fixture(t, text);
  const focus = { repoId: f.repoId, path: f.relative, fileHash: digest(Buffer.from(text)), start: { line: 410, column: 2 }, end: { line: 410, column: 6 } };
  await f.store.updateReadingMode(f.sessionId, 'code', undefined, 'explain', focus); const fragment = (await read(f, f.sessionId, { offset: 410, limit: 1 })).evidence;
  await assert.rejects(f.store.publish(f.sessionId, args(null)), { code: 'CODE_UNIT_REQUIRED' });
  const declared = unit(f, fragment, { name: 'huge', end: { line: 452, column: 1 } }); await assert.rejects(f.store.publish(f.sessionId, args(null, [declared])), { code: 'CODE_UNIT_COVERAGE' });
  const one = (await read(f, f.sessionId, { offset: 1, limit: 400 })).evidence; const two = (await read(f, f.sessionId, { offset: 401, limit: 100 })).evidence;
  declared.evidenceIds = [two.id, one.id]; const saved = await f.store.publish(f.sessionId, args(null, [declared])); assert.equal(saved.readingFocus.end.line, 410); assert.ok(text.length > 8000);
  assert.equal((await view(f, f.sessionId, { offset: 410, limit: 1 })).codeReadings.items[0].start.line, 1);
  const uncovered = { ...declared, start: { line: 1, column: 0 }, end: { line: 400, column: 1 } }; await assert.rejects(f.store.publish(f.sessionId, args(null, [uncovered])), { code: 'CODE_FOCUS_UNCOVERED' });
});

test('同哈希证据有缺口、跨文件/仓库或旧版本引用都不能证明完整范围', async t => {
  const f = await fixture(t); const one = (await read(f, f.sessionId, { offset: 1, limit: 1 })).evidence; const end = (await read(f, f.sessionId, { offset: 3, limit: 2 })).evidence;
  const declared = unit(f, one, { evidenceIds: [one.id, end.id] }); await assert.rejects(f.store.publish(f.sessionId, args(one, [declared])), { code: 'CODE_UNIT_COVERAGE' });
  const middle = (await read(f, f.sessionId, { offset: 2, limit: 1 })).evidence; declared.evidenceIds.push(middle.id); assert.equal((await f.store.publish(f.sessionId, args(one, [declared]))).codeUnits.length, 1);
  await fs.writeFile(path.join(f.repo, 'other.ts'), sample); const other = (await f.store.read(f.sessionId, { repoId: f.repoId, path: 'other.ts' })).evidence;
  await assert.rejects(f.store.publish(f.sessionId, args(one, [unit(f, one, { evidenceIds: [other.id] })])), { code: 'CODE_UNIT_EVIDENCE' });
  await assert.rejects(f.store.publish(f.sessionId, args(one, [unit(f, one, { fileHash: 'a'.repeat(64) })])), { code: 'STALE_CODE_UNIT' });
  const second = await f.store.createSession(f.project.id); await assert.rejects(f.store.publish(second.id, args(one, [declared])), { code: 'EVIDENCE_NOT_FOUND' });
  await fs.writeFile(f.file, sample.replace('return 0', 'return 9')); await assert.rejects(f.store.publish(f.sessionId, args(one, [declared])), { code: 'STALE_EVIDENCE' });
});

test('file 只能整文件，类/构造器/函数范围可重叠但不隐式生成成员方法', async t => {
  const text = 'class Order {\n  constructor() {}\n  submit() { return 1; }\n}\n'; const f = await fixture(t, text); const evidence = (await read(f)).evidence;
  const whole = unit(f, evidence, { kind: 'file', name: 'module', end: position(text) });
  await assert.rejects(f.store.publish(f.sessionId, args(evidence, [{ ...whole, start: { line: 2, column: 2 } }])), { code: 'CODE_UNIT_SCOPE' });
  const cls = { ...whole, kind: 'class', name: 'Order', end: { line: 4, column: 1 } }; const ctor = { ...whole, kind: 'constructor', name: 'Order.constructor', start: { line: 2, column: 2 }, end: { line: 2, column: 18 } };
  const saved = await f.store.publish(f.sessionId, args(evidence, [whole, cls, ctor])); const items = (await view(f)).codeReadings.items;
  assert.equal(items.length, 3); assert.deepEqual(new Set(items.map(item => item.kind)), new Set(['file', 'class', 'constructor'])); assert.equal(items.some(item => item.name === 'Order.submit'), false); assert.deepEqual(new Set(items.map(item => item.id)), new Set([0, 1, 2].map(index => `${saved.id}:${index}`)));
});

test('范围严格校验 UTF16/换行/源码边界，输入与证据均有界且不接受宿主元数据', async t => {
  const text = '\uFEFFfunction emoji() {\r\n  return "😀";\r\n}\r\n'; const f = await fixture(t, text); const evidence = (await read(f)).evidence;
  const declared = unit(f, evidence, { name: 'emoji', end: { line: 3, column: 1 } }); assert.equal((await f.store.publish(f.sessionId, args(evidence, [declared]))).codeUnits[0].end.column, 1);
  for (const bad of [{ start: { line: 0, column: 0 } }, { end: { line: 99, column: 0 } }, { end: { line: 1, column: 0 } }, { end: { line: 2, column: 11 } }, { id: 'caller-id' }, { kind: 'statement' }, { conclusion: 'x'.repeat(2001) }, { evidenceIds: Array.from({ length: 41 }, () => evidence.id) }, { path: '../outside.ts' }, { repoId: `repo-${randomUUID()}` }]) await assert.rejects(f.store.publish(f.sessionId, args(evidence, [{ ...declared, ...bad }])));
  assert.throws(() => publishSchema.parse(args(evidence, Array.from({ length: 13 }, () => declared)))); assert.deepEqual(publishSchema.parse({ ...args(evidence), codeUnits: undefined }).codeUnits, []);
  const before = await fs.readFile(f.file); assert.deepEqual(before, Buffer.from(text));
});

test('跨同项目全部会话展示真实同文件归档，不串仓/项目；只返回已有结论并保持稳定关联', async t => {
  const f = await fixture(t); const first = (await read(f)).evidence; const firstLesson = await f.store.publish(f.sessionId, args(first, [unit(f, first)])); const again = await f.store.publish(f.sessionId, args(first, [unit(f, first, { conclusion: '同范围的另一次已有结论' })]));
  const second = await f.store.createSession(f.project.id); const readTwo = (await read(f, second.id)).evidence; const secondLesson = await f.store.publish(second.id, args(readTwo, [unit(f, readTwo, { conclusion: '另一会话已有结论' })]));
  const otherProject = await f.store.createProject({ repositories: [{ path: f.repo }] }); const otherSession = await f.store.createSession(otherProject.id); const otherRepo = otherProject.repositories[0].id; const otherEvidence = (await f.store.read(otherSession.id, { repoId: otherRepo, path: f.relative })).evidence;
  await f.store.publish(otherSession.id, args(otherEvidence, [unit(f, otherEvidence, { repoId: otherRepo, conclusion: '不应泄漏另一个项目' })]));
  const beforeCount = f.store.session(second.id).evidence.length; const result = (await view(f, second.id, { offset: 3, limit: 1 })).codeReadings;
  assert.equal(result.items.length, 3); assert.deepEqual(new Set(result.items.map(item => item.lessonId)), new Set([firstLesson.id, again.id, secondLesson.id])); assert.equal(result.items.some(item => item.conclusion.includes('不应泄漏')), false); assert.equal(f.store.session(second.id).evidence.length, beforeCount); assert.equal(result.staleCount, 0); assert.equal(result.legacyCount, 0);
  const note = await fs.readFile(path.join(f.store.sessionDir(second.id), 'notes', `${secondLesson.id}.md`), 'utf8'); assert.match(note, /完整代码阅读范围/); assert.match(note, /另一会话已有结论/); assert.ok((await f.store.exportSession(second.id)).markdown.includes('另一会话已有结论'));
});

test('同项目同名同哈希文件也按 repoId 隔离，不把另一个仓库的阅读当成本文件', async t => {
  const f = await fixture(t); const repoB = path.join(f.root, 'repo-b'); await fs.mkdir(repoB); await fs.writeFile(path.join(repoB, f.relative), sample);
  const project = await f.store.createProject({ repositories: [{ path: f.repo }, { path: repoB }] }); const session = await f.store.createSession(project.id);
  for (const [index, repo] of project.repositories.entries()) {
    const evidence = (await f.store.read(session.id, { repoId: repo.id, path: f.relative })).evidence; await f.store.publish(session.id, args(evidence, [unit(f, evidence, { repoId: repo.id, conclusion: `仓库 ${index} 的已有结论` })]));
  }
  for (const [index, repo] of project.repositories.entries()) {
    const readings = (await viewFile(f.store, { sessionId: session.id, repoId: repo.id, path: f.relative })).codeReadings; assert.equal(readings.items.length, 1); assert.equal(readings.items[0].conclusion, `仓库 ${index} 的已有结论`);
  }
});

test('旧哈希只计过期，不重定位猜测；无元数据旧阅读只计legacy，不补出方法', async t => {
  const f = await fixture(t); const evidence = (await read(f)).evidence; await f.store.publish(f.sessionId, args(evidence, [unit(f, evidence)]));
  await fs.writeFile(f.file, '// moved\n' + sample); const stale = (await view(f)).codeReadings; assert.equal(stale.items.length, 0); assert.equal(stale.staleCount, 1);
  const stateFile = path.join(f.store.sessionDir(f.sessionId), 'state.json'); const old = JSON.parse(await fs.readFile(stateFile, 'utf8')); delete old.readingFocus; delete old.lessons[0].codeUnits; const disk = JSON.stringify(old); await fs.writeFile(stateFile, disk); const restored = await new ReadingStore(f.store.root).init();
  const result = (await viewFile(restored, { sessionId: f.sessionId, repoId: f.repoId, path: f.relative })).codeReadings; assert.equal(result.items.length, 0); assert.equal(result.staleCount, 0); assert.equal(result.legacyCount, 1); assert.deepEqual(restored.session(f.sessionId).lessons[0].codeUnits, []); assert.equal(restored.session(f.sessionId).readingFocus, null);
  // view-file may append audit metadata, but it never rewrites the authoritative old state.
  assert.equal(await fs.readFile(stateFile, 'utf8'), disk);
});

test('同项目其他会话的损坏旧归档引用不阻断当前源码和有效标记，也不修写旧档案', async t => {
  const f = await fixture(t); const evidence = (await read(f)).evidence; const saved = await f.store.publish(f.sessionId, args(evidence, [unit(f, evidence)])); const legacy = await f.store.createSession(f.project.id); const legacyEvidence = (await read(f, legacy.id)).evidence;
  const file = path.join(f.store.sessionDir(legacy.id), 'state.json'); const original = JSON.parse(await fs.readFile(file, 'utf8')); const validLegacy = { ...saved, id: `lesson-${randomUUID()}`, claims: [{ kind: 'fact', text: '合法旧证据', evidenceIds: [legacyEvidence.id] }], topics: [] }; delete validLegacy.codeUnits; delete validLegacy.readingFocus;
  for (const malformed of [{ claims: [null] }, { claims: {} }, { claims: [{ evidenceIds: {} }] }, { topics: [null] }, { topics: {} }, { topics: [{ evidenceIds: 42 }] }]) {
    const state = structuredClone(original); state.lessons = [validLegacy, { ...validLegacy, id: `lesson-${randomUUID()}`, title: '损坏旧引用', claims: [], topics: [], ...malformed }]; const disk = JSON.stringify(state); await fs.writeFile(file, disk);
    const restored = await new ReadingStore(f.store.root).init(); assert.equal(restored.diagnostics.length, 0);
    const result = await viewFile(restored, { sessionId: f.sessionId, repoId: f.repoId, path: f.relative, limit: 1 }); assert.equal(result.lines[0].text, sample.split('\n')[0]); assert.equal(result.codeReadings.items.length, 1); assert.equal(result.codeReadings.items[0].lessonId, saved.id); assert.equal(result.codeReadings.legacyCount, 1); assert.equal(result.codeReadings.truncated, true);
    assert.equal(await fs.readFile(file, 'utf8'), disk); assert.equal(await fs.readFile(f.file, 'utf8'), sample);
  }
});

test('大量外项目会话不消耗当前项目索引额度，仍能跨当前项目会话找到完整方法', async t => {
  const f = await fixture(t); const evidence = (await read(f)).evidence; const saved = await f.store.publish(f.sessionId, args(evidence, [unit(f, evidence)])); const current = await f.store.createSession(f.project.id);
  const foreignProjectId = `project-${randomUUID()}`; const foreign = Array.from({ length: 1200 }, () => { const id = `reading-${randomUUID()}`; return [id, { id, projectId: foreignProjectId, get lessons() { throw new Error('foreign project archive must not be inspected'); } }]; });
  f.store.sessions = new Map([...foreign, ...f.store.sessions]); const source = await readRepository(f.store.repo(current.id, f.repoId), f.relative);
  const result = collectCodeReadings(f.store, current.id, f.repoId, f.relative, source); assert.equal(result.items.length, 1); assert.equal(result.items[0].lessonId, saved.id); assert.equal(result.items[0].sessionId, f.sessionId); assert.equal(result.truncated, false);
  const limited = collectCodeReadings(f.store, current.id, f.repoId, f.relative, source, { ...CODE_READING_LIMITS, sessions: 1 }); assert.equal(limited.items.length, 0); assert.equal(limited.truncated, true);
});

test('索引预算与200项上限显式截断，失真范围/证据不会成为标记', async t => {
  const f = await fixture(t); const evidence = (await read(f)).evidence; const saved = await f.store.publish(f.sessionId, args(evidence, [unit(f, evidence)]));
  for (let index = 0; index < 2; index++) {
    const next = await f.store.createSession(f.project.id); const ownEvidence = (await read(f, next.id)).evidence; const state = f.store.session(next.id);
    state.lessons = Array.from({ length: 100 }, (_, i) => ({ ...structuredClone(saved), id: `lesson-${randomUUID()}`, title: `归档 ${i}`, codeUnits: [unit(f, ownEvidence)] }));
  }
  f.store.session(f.sessionId).lessons[0].createdAt = '2099-01-01T00:00:00.000Z';
  const source = await readRepository(f.store.repo(f.sessionId, f.repoId), f.relative); source.lines.join = () => { throw new Error('index must reuse source layout, not join per unit'); }; const result = collectCodeReadings(f.store, f.sessionId, f.repoId, f.relative, source);
  assert.equal(result.items.length, CODE_READING_LIMITS.items); assert.equal(result.items[0].lessonId, saved.id); assert.equal(result.truncated, true);
  for (const limits of [{ sessions: 1, lessons: 5000, items: 200 }, { sessions: 1000, lessons: 1, items: 200 }, { sessions: 1000, lessons: 5000, items: 1 }, { sessions: 1000, lessons: 5000, items: 200, checks: 1 }]) assert.equal(collectCodeReadings(f.store, f.sessionId, f.repoId, f.relative, source, limits).truncated, true);
  f.store.session(f.sessionId).lessons[0].codeUnits[0].end = { line: 99, column: 0 }; const invalid = collectCodeReadings(f.store, f.sessionId, f.repoId, f.relative, source); assert.equal(invalid.items.some(item => item.lessonId === saved.id), false); assert.equal(invalid.truncated, true);
});

test('损坏或越界单元不产生标记，恢复不改写旧档案也不接受额外选文元数据', async t => {
  const f = await fixture(t); const evidence = (await read(f)).evidence; await f.store.publish(f.sessionId, args(evidence, [unit(f, evidence)]));
  const file = path.join(f.store.sessionDir(f.sessionId), 'state.json'); const original = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const broken of [{ kind: 'statement' }, { end: { line: 0, column: 0 } }, { quote: 'SOURCE_SENTINEL_NOT_METADATA' }, { evidenceIds: [`evidence-${randomUUID()}`] }, { end: { line: 99, column: 0 } }]) {
    const changed = structuredClone(original); Object.assign(changed.lessons[0].codeUnits[0], broken); changed.readingFocus = { repoId: f.repoId, path: f.relative, fileHash: evidence.hash, start: { line: 1, column: 0 }, end: { line: 1, column: 1 }, quote: 'SOURCE_SENTINEL_NOT_METADATA' }; changed.lessons[0].readingFocus = changed.readingFocus;
    const disk = JSON.stringify(changed); await fs.writeFile(file, disk); const restored = await new ReadingStore(f.store.root).init(); const codeReadings = (await viewFile(restored, { sessionId: f.sessionId, repoId: f.repoId, path: f.relative })).codeReadings;
    assert.equal(codeReadings.items.length, 0); assert.equal(restored.session(f.sessionId).readingFocus, null); assert.equal(restored.session(f.sessionId).lessons[0].readingFocus, null); assert.equal(await fs.readFile(file, 'utf8'), disk);
  }
});

test('有实际 sections 的旧发布哈希也忽略空 codeUnits，字段次序保持不变', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.repo, 'README.md'), '# 模块说明\n'); const evidence = (await f.store.read(f.sessionId, { repoId: f.repoId, path: 'README.md' })).evidence;
  const raw = { ...args(evidence), sections: [{ dimension: 'business', markdown: '根据文档解释业务。' }] }; const { codeUnits, ...oldParsed } = publishSchema.parse(raw);
  const saved = await f.store.publish(f.sessionId, raw, 'old-sections'); assert.equal(f.store.session(f.sessionId).publishReceipts['old-sections'].payloadHash, digest(JSON.stringify(oldParsed)));
  assert.equal((await f.store.publish(f.sessionId, { ...raw, codeUnits: [] }, 'old-sections')).id, saved.id);
});

test('readingFocus 原子元数据只存范围不存选文，省略helper兼容保留而显式null清除', async t => {
  const f = await fixture(t); const focus = { repoId: f.repoId, path: f.relative, fileHash: digest(Buffer.from(sample)), start: { line: 2, column: 2 }, end: { line: 2, column: 10 } };
  await f.store.updateReadingMode(f.sessionId, 'code', undefined, 'explain', focus); assert.deepEqual(f.store.catalog(f.sessionId).readingFocus, focus); assert.equal(f.store.session(f.sessionId).revision, 1);
  await f.store.updateReadingMode(f.sessionId, undefined); assert.deepEqual(f.store.catalog(f.sessionId).readingFocus, focus); await f.store.updateReadingMode(f.sessionId, undefined, undefined, 'explain', null); assert.equal(f.store.catalog(f.sessionId).readingFocus, null); assert.equal(f.store.catalog(f.sessionId).readingModeRevision, 1);
  await assert.rejects(f.store.updateReadingMode(f.sessionId, undefined, undefined, 'explain', { ...focus, quote: 'SOURCE_MUST_NOT_PERSIST' })); await assert.rejects(f.store.updateReadingMode(f.sessionId, undefined, undefined, 'explain', { ...focus, repoId: `repo-${randomUUID()}` }), { code: 'REPO_NOT_BOUND' });
  const disk = await fs.readFile(path.join(f.store.sessionDir(f.sessionId), 'state.json'), 'utf8'); assert.doesNotMatch(disk, /SOURCE_MUST_NOT_PERSIST/);
});
