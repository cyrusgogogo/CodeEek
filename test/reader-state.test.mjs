import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReadingStore } from '../src/store.mjs';
import { readerStateSchema, readerStatePatchSchema } from '../src/contracts.mjs';

const base = path.resolve('.test-output');
const defaults = () => ({ version: 1, revision: 0, viewStage: null, selectedLessonId: null, viewedLessonIds: [], understoodLessonIds: [], readerPosition: null, activeDocument: null, lessonScrollTop: 0 });
const lesson = title => ({ expectedRevision: 1, title, markdown: '仅供隔离状态回归使用的假设。', conclusion: '没有读取真实仓库。', claims: [{ kind: 'hypothesis', text: '需要后续验证', evidenceIds: [] }], nextQuestions: ['要验证什么？'] });
async function fixture(t) {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'reader-state-'));
  const a = path.join(root, 'repo-a'); const b = path.join(root, 'repo-b'); await fs.mkdir(a); await fs.mkdir(b);
  await fs.writeFile(path.join(a, 'entry.ts'), 'SOURCE_SENTINEL_DO_NOT_PERSIST\n'); await fs.writeFile(path.join(a, '.env'), 'KEY_SENTINEL_DO_NOT_PERSIST');
  const store = await new ReadingStore(path.join(root, 'artifacts')).init();
  const project = await store.createProject({ title: '位置夹具', repositories: [{ name: 'A', path: a }, { name: 'B', path: b }] });
  const session = await store.createSession(project.id); const second = await store.createSession(project.id);
  const one = await store.publish(session.id, lesson('知识点一')); const two = await store.publish(session.id, lesson('知识点二')); const other = await store.publish(second.id, lesson('另一主题'));
  t.after(async () => { const absolute = path.resolve(root); assert.equal(path.dirname(absolute), base); assert.match(path.basename(absolute), /^reader-state-/); await fs.rm(absolute, { recursive: true, force: true }); });
  return { root, a, b, store, project, session, second, one, two, other, repoId: project.repositories[0].id };
}
const update = (f, patch, expectedRevision = 0, sessionId = f.session.id) => f.store.updateReaderState({ sessionId, expectedRevision, patch });

test('位置合同默认完整，部分patch不隐式填充或重置其它字段', () => {
  assert.deepEqual(readerStateSchema.parse({}), defaults());
  assert.deepEqual(readerStatePatchSchema.parse({ lessonScrollTop: 25 }), { lessonScrollTop: 25 });
  assert.deepEqual(readerStatePatchSchema.parse({}), {});
});

test('按会话保存并在重启后恢复知识点、独立理解标记及跨仓位置', async t => {
  const f = await fixture(t); const result = await update(f, { selectedLessonId: f.one.id, viewedLessonIds: [f.one.id, f.one.id, f.two.id], understoodLessonIds: [f.two.id], readerPosition: { repoId: f.repoId, path: 'entry.ts', hash: 'a'.repeat(64), offset: 21, scrollTop: 240.5, scrollLeft: 60 }, lessonScrollTop: 321 });
  assert.equal(result.revision, 1); assert.deepEqual(result.viewedLessonIds, [f.one.id, f.two.id]); assert.deepEqual(result.understoodLessonIds, [f.two.id]);
  const changed = await update(f, { lessonScrollTop: 700 }, 1); assert.equal(changed.selectedLessonId, f.one.id); assert.equal(changed.readerPosition.repoId, f.repoId); assert.deepEqual(changed.understoodLessonIds, [f.two.id]);
  assert.equal(f.store.session(f.session.id).revision, 1); assert.deepEqual((await f.store.snapshot(f.second.id)).state.readerState, defaults());
  const restored = await new ReadingStore(f.store.root).init(); assert.equal(restored.diagnostics.length, 0); assert.deepEqual((await restored.snapshot(f.session.id)).state.readerState, changed);
  const otherPosition = { repoId: f.project.repositories[1].id, path: 'entry.ts' }; const moved = await update(f, { readerPosition: otherPosition }, 2);
  assert.deepEqual(moved.readerPosition, { ...otherPosition, hash: null, offset: 1, scrollTop: 0, scrollLeft: 0 });
});

test('浏览空阶段独立恢复，不改变分析阶段或隐式理解标记', async t => {
  const f = await fixture(t); const saved = await update(f, { viewStage: 'verify', selectedLessonId: null, lessonScrollTop: 75 });
  assert.equal(saved.viewStage, 'verify'); assert.equal(saved.selectedLessonId, null); assert.deepEqual(saved.understoodLessonIds, []);
  assert.equal(f.store.session(f.session.id).stage, 'discover'); assert.equal(f.store.session(f.session.id).revision, 1);
  const restored = await new ReadingStore(f.store.root).init(); assert.equal((await restored.snapshot(f.session.id)).state.readerState.viewStage, 'verify');
  await assert.rejects(update(f, { viewStage: 'not-a-stage' }, 1)); assert.equal((await update(f, { viewStage: null }, 1)).viewStage, null);
});

test('旧会话缺失位置仅补内存默认，不改写磁盘或其它用户字段', async t => {
  const f = await fixture(t); const file = path.join(f.store.sessionDir(f.session.id), 'state.json'); const state = JSON.parse(await fs.readFile(file, 'utf8'));
  delete state.readerState; state.userExtension = { note: '保留用户既有字段' }; const before = JSON.stringify(state, null, 2) + '\n'; await fs.writeFile(file, before);
  const restored = await new ReadingStore(f.store.root).init(); const snapshot = await restored.snapshot(f.session.id);
  assert.deepEqual(snapshot.state.readerState, defaults()); assert.deepEqual(snapshot.state.userExtension, state.userExtension); assert.equal(await fs.readFile(file, 'utf8'), before);
  await restored.updateReaderState({ sessionId: f.session.id, expectedRevision: 0, patch: { lessonScrollTop: 15 } });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).userExtension, state.userExtension);
});

test('无效或未来位置格式不会导致历史主题丢失或泄漏任意附加内容', async t => {
  const f = await fixture(t); const file = path.join(f.store.sessionDir(f.session.id), 'state.json'); const state = JSON.parse(await fs.readFile(file, 'utf8'));
  state.readerState = { version: 999, source: 'KEY_SENTINEL_DO_NOT_PERSIST' }; await fs.writeFile(file, JSON.stringify(state));
  const restored = await new ReadingStore(f.store.root).init(); assert.equal(restored.sessions.size, 2); assert.deepEqual((await restored.snapshot(f.session.id)).state.readerState, defaults()); assert.ok(restored.diagnostics.some(item => item.includes('阅读位置')));
});

test('CAS隔离并发页面，空patch及重复位置不推进版本，不修改阶段revision', async t => {
  const f = await fixture(t); const noChange = await update(f, {}); assert.equal(noChange.revision, 0);
  const results = await Promise.allSettled([update(f, { lessonScrollTop: 10 }), update(f, { lessonScrollTop: 20 })]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1); assert.equal(results.find(item => item.status === 'rejected').reason.code, 'STALE_READER_STATE');
  const saved = results.find(item => item.status === 'fulfilled').value; assert.equal((await update(f, { lessonScrollTop: saved.lessonScrollTop }, 1)).revision, 1);
  assert.equal(f.store.session(f.session.id).revision, 1); assert.equal(f.store.session(f.second.id).readerState.revision, 0);
});

test('阅读不隐含理解，取消标记不会改变已选择知识点或位置', async t => {
  const f = await fixture(t); const seen = await update(f, { selectedLessonId: f.one.id, viewedLessonIds: [f.one.id] }); assert.deepEqual(seen.understoodLessonIds, []);
  const understood = await update(f, { understoodLessonIds: [f.one.id] }, 1); assert.deepEqual(understood.viewedLessonIds, [f.one.id]);
  const cleared = await update(f, { understoodLessonIds: [] }, 2); assert.equal(cleared.selectedLessonId, f.one.id); assert.deepEqual(cleared.viewedLessonIds, [f.one.id]); assert.deepEqual(cleared.understoodLessonIds, []);
});

test('拒绝跨会话知识点、未绑定仓库、非法路径以及源码/密钥/对话字段', async t => {
  const f = await fixture(t);
  for (const patch of [{ selectedLessonId: f.other.id }, { viewedLessonIds: [f.other.id] }, { understoodLessonIds: [f.other.id] }]) await assert.rejects(update(f, patch), { code: 'LESSON_NOT_FOUND' });
  await assert.rejects(update(f, { readerPosition: { repoId: `repo-${randomUUID()}`, path: 'entry.ts' } }), { code: 'REPO_NOT_BOUND' });
  for (const relative of ['../escape.ts', 'C:/outside.ts', '.env', 'a\\b.ts']) await assert.rejects(update(f, { readerPosition: { repoId: f.repoId, path: relative } }));
  for (const patch of [{ source: 'SOURCE_SENTINEL_DO_NOT_PERSIST' }, { messages: ['private'] }, { apiKey: 'KEY_SENTINEL_DO_NOT_PERSIST' }, { readerPosition: { repoId: f.repoId, path: 'entry.ts', text: 'source' } }, { lessonScrollTop: -1 }, { lessonScrollTop: Infinity }, { readerPosition: { repoId: f.repoId, path: 'entry.ts', hash: 'not-a-hash' } }]) await assert.rejects(update(f, patch));
  assert.deepEqual(f.store.session(f.session.id).readerState, defaults());
});

test('保存位置不读取源码，不修改仓库，不调用模型，审计仅记录字段名', async t => {
  const f = await fixture(t); const before = await fs.readFile(path.join(f.a, 'entry.ts')); const original = fs.open; let sourceOpens = 0;
  fs.open = async (filename, ...args) => { if (path.resolve(filename).startsWith(path.resolve(f.a) + path.sep) || path.resolve(filename).startsWith(path.resolve(f.b) + path.sep)) { sourceOpens++; throw new Error('位置保存不得读取仓库文件'); } return original(filename, ...args); };
  try { await update(f, { readerPosition: { repoId: f.repoId, path: 'not-read-or-required-to-exist.ts', offset: 8 }, selectedLessonId: f.one.id }); } finally { fs.open = original; }
  assert.equal(sourceOpens, 0); assert.deepEqual(await fs.readFile(path.join(f.a, 'entry.ts')), before);
  const file = path.join(f.store.sessionDir(f.session.id), 'state.json'); const text = await fs.readFile(file, 'utf8'); const audit = await fs.readFile(path.join(f.store.sessionDir(f.session.id), 'audit.jsonl'), 'utf8');
  assert.doesNotMatch(text + audit, /SOURCE_SENTINEL_DO_NOT_PERSIST|KEY_SENTINEL_DO_NOT_PERSIST/); assert.doesNotMatch(audit, /not-read-or-required-to-exist/);
});

test('source/reading/null 编辑区元数据可单独持久化，CAS独立且不隐式切换知识点', async t => {
  const f = await fixture(t); const selected = await update(f, { selectedLessonId: f.one.id, activeDocument: 'source', lessonScrollTop: 55 });
  assert.equal(selected.activeDocument, 'source'); assert.equal(selected.selectedLessonId, f.one.id); assert.equal(selected.revision, 1);
  const switched = await update(f, { activeDocument: 'reading' }, 1); assert.equal(switched.selectedLessonId, f.one.id); assert.equal(switched.lessonScrollTop, 55); assert.equal(switched.activeDocument, 'reading');
  assert.equal((await update(f, { activeDocument: 'reading' }, 2)).revision, 2); await assert.rejects(update(f, { activeDocument: 'source' }, 1), { code: 'STALE_READER_STATE' });
  const restored = await new ReadingStore(f.store.root).init(); assert.equal(restored.session(f.session.id).readerState.activeDocument, 'reading'); assert.equal(restored.session(f.session.id).revision, 1);
  assert.equal((await restored.updateReaderState({ sessionId: f.session.id, expectedRevision: 2, patch: { activeDocument: null } })).activeDocument, null);
  for (const activeDocument of ['', 'chat', 1, { source: 'SOURCE_SENTINEL_DO_NOT_PERSIST' }]) await assert.rejects(update(f, { activeDocument }, 2));
  assert.deepEqual(readerStatePatchSchema.parse({ lessonScrollTop: 20 }), { lessonScrollTop: 20 });
});

test('旧 activeDocument 缺失或无效时仅过滤该字段，保留有效阅读位置且不改写磁盘', async t => {
  const f = await fixture(t); await update(f, { selectedLessonId: f.one.id, activeDocument: 'reading', lessonScrollTop: 77 });
  const file = path.join(f.store.sessionDir(f.session.id), 'state.json'); const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const value of [undefined, 'unknown', { source: 'KEY_SENTINEL_DO_NOT_PERSIST' }]) {
    const old = structuredClone(saved); if (value === undefined) delete old.readerState.activeDocument; else old.readerState.activeDocument = value;
    const before = JSON.stringify(old); await fs.writeFile(file, before); const restored = await new ReadingStore(f.store.root).init(); const reader = restored.session(f.session.id).readerState;
    assert.equal(reader.activeDocument, null); assert.equal(reader.selectedLessonId, f.one.id); assert.equal(reader.lessonScrollTop, 77); assert.equal(reader.revision, 1); assert.equal(await fs.readFile(file, 'utf8'), before);
  }
});

test('异步审计期间取消保存后守卫拒绝提交，旧位置保持完整', async t => {
  const f = await fixture(t); let active = true; const original = f.store.audit.bind(f.store);
  f.store.audit = async (...args) => { await original(...args); active = false; };
  await assert.rejects(f.store.updateReaderState({ sessionId: f.session.id, expectedRevision: 0, patch: { lessonScrollTop: 60 } }, () => { if (!active) throw new Error('已取消保存'); }), /已取消保存/);
  assert.deepEqual(f.store.session(f.session.id).readerState, defaults());
  const restored = await new ReadingStore(f.store.root).init(); assert.deepEqual(restored.session(f.session.id).readerState, defaults());
});
