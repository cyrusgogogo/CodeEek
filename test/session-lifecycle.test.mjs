import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { apply } from '../src/index.mjs';
import { ReadingStore, getRuntime } from '../src/store.mjs';
import { digest } from '../src/filesystem.mjs';

const base = path.resolve('.test-output');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function hostContext() {
  const listeners = new Map(); const live = new Map(); const effects = [];
  const ctx = { root: {}, live, effects, calls: [], nativeCalls: [], defaultModel: { provider: 'remote', model: 'reader' },
    logger: { warn() {} },
    effect(factory) { const value = factory(); if (value?.then) value.then(dispose => { if (typeof dispose === 'function') effects.push(dispose); }); else if (typeof value === 'function') effects.push(value); return value; },
    on(name, callback) { const rows = listeners.get(name) ?? []; rows.push(callback); listeners.set(name, rows); effects.push(() => { const at = rows.indexOf(callback); if (at >= 0) rows.splice(at, 1); }); },
    get(name) { return ctx[name]; },
    agents: { get: id => live.get(id) },
    agentPresets: { composedPreset: context => context?.preset, register: async () => () => {} },
    tools: { guard: () => () => {} }, skills: { register: () => () => {} }, connection: { fetch: { register: () => () => {} } },
    agentDefaultModel: { currentSelection: () => structuredClone(ctx.defaultModel) },
    sandboxPolicy: { overrideOf: session => session.events.findLast(event => event.type === 'sandbox/mode')?.data.mode }
  };
  ctx.sessionController = {
    async create({ sessionId, cwd, agentPreset }) {
      ctx.nativeCalls.push(['create', sessionId]);
      const session = { id: sessionId, header: { cwd }, events: [], snapshotEvents() { return [...this.events]; }, append(type, data) { const event = { seq: this.events.length, type, data, time: Date.now() }; this.events.push(event); for (const callback of listeners.get('session/event') ?? []) callback(this, event); } };
      const agent = { id: sessionId, session, ctx: { preset: agentPreset }, status: 'idle' }; live.set(sessionId, agent);
      for (const callback of listeners.get('agent/created') ?? []) await callback({ agent });
      return { sessionId };
    },
    async resolveAgent(id) { ctx.nativeCalls.push(['resolve', id]); return live.has(id) ? { agent: live.get(id) } : { error: new Error('not found') }; },
    async inspect(id) { ctx.nativeCalls.push(['inspect', id]); const agent = live.get(id); if (!agent) throw new Error('not found'); return { meta: { ...agent.session.header, title: agent.title }, events: agent.session.snapshotEvents() }; },
    async rename({ sessionId, title }) { ctx.nativeCalls.push(['rename', sessionId]); live.get(sessionId).title = title; return { title }; },
    async selectModel(request) { ctx.nativeCalls.push(['select', request.sessionId]); live.get(request.sessionId).session.append('model/selection', { provider: request.provider, model: request.model }); return { selected: request }; },
    async prompt(request) { ctx.calls.push(request); live.get(request.sessionId).status = 'running'; return { accepted: true }; },
    async cancel({ sessionId }) { ctx.nativeCalls.push(['cancel', sessionId]); live.get(sessionId).status = 'idle'; return { cancelled: true }; },
    async modelCatalog() { return { default: ctx.defaultModel, groups: [], failures: [] }; }
  };
  ctx.dispose = async () => { for (const dispose of effects.splice(0).reverse()) await dispose(); };
  return ctx;
}
async function fixture(t, { draft = true, host = true } = {}) {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'session-lifecycle-')); const repo = path.join(root, 'repo'); await fs.mkdir(repo); await fs.writeFile(path.join(repo, 'entry.ts'), 'export const answer = 42;\n');
  const dataDir = path.join(root, 'artifacts'); const ctx = host ? hostContext() : null;
  let runtime, store;
  if (ctx) { await apply(ctx, { dataDir }); runtime = getRuntime(ctx.root); store = runtime.store; } else store = await new ReadingStore(dataDir).init();
  const project = await store.createProject({ title: '生命周期夹具', repositories: [{ path: repo }] });
  const sessionId = ctx ? (await runtime.dispatch('create-session', { projectId: project.id, draft })).sessionId : (await store.createSession(project.id, { draft })).id;
  const sessionsDir = path.join(store.projectDir(project.id), 'sessions');
  t.after(async () => { if (ctx) await ctx.dispose(); for (const pending of store.locks.values()) await pending.catch(() => {}); assert.equal(path.dirname(path.resolve(root)), base); assert.match(path.basename(root), /^session-lifecycle-/); await fs.rm(root, { recursive: true, force: true }); });
  return { root, repo, dataDir, ctx, runtime, store, project, sessionId, sessionsDir, repoId: project.repositories[0].id };
}
const noArtifacts = async f => { assert.deepEqual(await fs.readdir(f.sessionsDir), []); assert.deepEqual(f.ctx?.nativeCalls ?? [], []); assert.equal(f.ctx?.calls.length ?? 0, 0); };
const prompt = (f, extra = {}) => ({ sessionId: f.sessionId, requestId: randomUUID(), text: '解释当前逻辑', expectedRevision: f.store.session(f.sessionId).revision, expectedModel: f.ctx.defaultModel, ...extra });
const selection = async f => ({ repoId: f.repoId, path: 'entry.ts', fileHash: digest(await fs.readFile(path.join(f.repo, 'entry.ts'))), start: { line: 1, column: 0 }, end: { line: 1, column: 25 }, quote: 'export const answer = 42;' });
const archive = (f, archived, expectedRevision) => f.runtime.dispatch('set-session-archived', { sessionId: f.sessionId, archived, expectedRevision });

test('草稿新建、快照、阶段、模型、位置、所有浏览与取消均无 session 目录或 native 调用', async t => {
  const f = await fixture(t); const initial = await f.runtime.dispatch('snapshot', { sessionId: f.sessionId });
  assert.equal(initial.draft, true); assert.equal(initial.state.draft, true); assert.equal(initial.archivedAt, null); assert.equal(initial.archiveRevision, 0); assert.deepEqual(initial.modelSelection, f.ctx.defaultModel);
  f.ctx.defaultModel = { provider: 'different-default', model: 'not-selected' }; assert.deepEqual((await f.runtime.dispatch('snapshot', { sessionId: f.sessionId })).modelSelection, { provider: 'remote', model: 'reader' });
  await f.runtime.dispatch('stage', { sessionId: f.sessionId, expectedRevision: 1, stage: 'business', topic: '临时主题' });
  const selected = { provider: 'local', model: 'private-reader' }; await f.runtime.dispatch('select-model', { sessionId: f.sessionId, ...selected });
  await f.runtime.dispatch('reader-state', { sessionId: f.sessionId, expectedRevision: 0, patch: { activeDocument: 'source', readerPosition: { repoId: f.repoId, path: 'entry.ts' } } });
  await f.runtime.dispatch('tree', { sessionId: f.sessionId, repoId: f.repoId });
  const viewed = await f.runtime.dispatch('view-file', { sessionId: f.sessionId, repoId: f.repoId, path: 'entry.ts' }); assert.equal(viewed.lines[0].text, 'export const answer = 42;'); assert.deepEqual(viewed.annotations, []);
  const open = fs.open; fs.open = async () => { throw new Error('草稿批注读取不应访问磁盘'); };
  try { assert.deepEqual(await f.runtime.dispatch('annotations', { sessionId: f.sessionId }), { revision: 0, items: [] }); } finally { fs.open = open; }
  await f.runtime.dispatch('files', { sessionId: f.sessionId, repoId: f.repoId }); await f.runtime.dispatch('search', { sessionId: f.sessionId, repoId: f.repoId, query: 'answer' });
  const read = await f.runtime.dispatch('read', { sessionId: f.sessionId, repoId: f.repoId, path: 'entry.ts' }); await f.runtime.dispatch('evidence', { sessionId: f.sessionId, evidenceId: read.evidence.id });
  await f.runtime.dispatch('cancel', { sessionId: f.sessionId }); const snapshot = await f.runtime.dispatch('snapshot', { sessionId: f.sessionId });
  assert.equal(snapshot.revision, 2); assert.equal(snapshot.state.readerState.revision, 1); assert.deepEqual(snapshot.modelSelection, selected); assert.equal((await f.runtime.dispatch('list', {})).projects[0].sessions.length, 0); await noArtifacts(f);
  const restarted = await new ReadingStore(f.dataDir).init(); assert.equal(restarted.sessions.size, 0);
});

test('草稿丢弃无文件操作、重复幂等，持久化记录绝不删除', async t => {
  const f = await fixture(t); const id = f.sessionId;
  const mkdir = fs.mkdir; const rm = fs.rm; const unlink = fs.unlink;
  fs.mkdir = fs.rm = fs.unlink = async () => { throw new Error('丢弃草稿不能执行文件操作'); };
  try { assert.deepEqual(await f.runtime.dispatch('discard-draft', { sessionId: id }), { sessionId: id, discarded: true }); assert.deepEqual(await f.runtime.dispatch('discard-draft', { sessionId: id }), { sessionId: id, discarded: false }); } finally { fs.mkdir = mkdir; fs.rm = rm; fs.unlink = unlink; }
  await assert.rejects(f.runtime.dispatch('snapshot', { sessionId: id }), { code: 'READING_NOT_FOUND' }); await noArtifacts(f);
  const persisted = await f.runtime.dispatch('create-session', { projectId: f.project.id }); const file = path.join(f.store.sessionDir(persisted.sessionId), 'state.json'); const before = await fs.readFile(file, 'utf8');
  await assert.rejects(f.runtime.dispatch('discard-draft', persisted), { code: 'SESSION_NOT_DRAFT' }); assert.equal(await fs.readFile(file, 'utf8'), before); assert.ok(f.ctx.live.has(persisted.sessionId));
});

test('草稿并发创建按 FIFO 有界淘汰为 100 个，不会永久阻止后续新建', async t => {
  const f = await fixture(t, { host: false }); const outcomes = await Promise.allSettled(Array.from({ length: 100 }, () => f.store.createSession(f.project.id, { draft: true })));
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 100); assert.equal(f.store.sessions.size, 100); assert.throws(() => f.store.session(f.sessionId), { code: 'READING_NOT_FOUND' }); await noArtifacts(f);
  await f.store.createSession(f.project.id, { draft: true }); assert.equal(f.store.sessions.size, 100);
});

test('模型、revision、选区或请求格式错误在 promote 前拒绝，不创建任何档案', async t => {
  const f = await fixture(t); const chosen = await selection(f);
  for (const extra of [{ expectedModel: { provider: 'wrong', model: 'wrong' } }, { expectedRevision: 2 }, { selection: { ...chosen, quote: 'forged' } }, { selection: { ...chosen, fileHash: 'a'.repeat(64) } }, { intent: 'logic-graph' }, { text: '' }]) await assert.rejects(f.runtime.dispatch('prompt', prompt(f, extra)));
  assert.equal(f.store.session(f.sessionId).draft, true); assert.equal(f.store.session(f.sessionId).evidence.length, 0); await noArtifacts(f);
  await assert.rejects(f.runtime.dispatch('export', { sessionId: f.sessionId }), { code: 'SESSION_DRAFT' }); await assert.rejects(archive(f, true, 0), { code: 'SESSION_DRAFT' }); await assert.rejects(f.runtime.dispatch('annotation-update', { sessionId: f.sessionId }), { code: 'SESSION_DRAFT' });
  await assert.rejects(f.store.archiveEvents(f.sessionId, []), { code: 'SESSION_DRAFT' }); await assert.rejects(f.store.writable(f.store.sessionDir(f.sessionId)), { code: 'SESSION_DRAFT' }); await noArtifacts(f);
});

test('确认发起才持久化并创建一次 native，保留模型、主题、位置和选区证据', async t => {
  const f = await fixture(t); const selected = { provider: 'local', model: 'private-reader' };
  await f.runtime.dispatch('select-model', { sessionId: f.sessionId, ...selected }); await f.runtime.dispatch('stage', { sessionId: f.sessionId, expectedRevision: 1, stage: 'business', topic: '首次明确主题' }); await f.runtime.dispatch('reader-state', { sessionId: f.sessionId, expectedRevision: 0, patch: { activeDocument: 'source' } }); await noArtifacts(f);
  const result = await f.runtime.dispatch('prompt', prompt(f, { expectedModel: selected, selection: await selection(f), intent: 'logic-graph' })); assert.equal(result.accepted, true);
  const snapshot = await f.runtime.dispatch('snapshot', { sessionId: f.sessionId }); assert.equal(snapshot.draft, false); assert.equal(snapshot.state.draft, false); assert.equal(snapshot.state.nativePending, undefined); assert.equal(snapshot.intent, 'logic-graph'); assert.equal(snapshot.readingMode, 'code'); assert.equal(snapshot.revision, 2); assert.equal(snapshot.state.readerState.activeDocument, 'source'); assert.deepEqual(snapshot.modelSelection, selected); assert.equal(snapshot.state.evidence.length, 1); assert.equal(f.ctx.live.get(f.sessionId).title, '首次明确主题');
  assert.equal(f.ctx.nativeCalls.filter(call => call[0] === 'create').length, 1); assert.equal(f.ctx.calls.length, 1); assert.match(f.ctx.calls[0].content[0].text, /selectedCode/); assert.equal((await f.runtime.dispatch('list', {})).projects[0].sessions[0].id, f.sessionId);
  const saved = JSON.parse(await fs.readFile(path.join(f.store.sessionDir(f.sessionId), 'state.json'), 'utf8')); assert.equal(saved.draft, false); assert.equal(saved.draftModelSelection, undefined); assert.equal(saved.readingFocus.quote, undefined);
  const reads = (await fs.readFile(path.join(f.store.sessionDir(f.sessionId), 'audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.action === 'read'); assert.ok(reads.some(row => row.evidenceId === saved.evidence[0].id && row.hash === saved.evidence[0].hash)); assert.equal(f.store.draftReadAudits.has(f.sessionId), false);
  const agent = f.ctx.live.get(f.sessionId); agent.session.append('user/message', { role: 'user', source: { kind: 'user', rpcId: f.ctx.calls[0].requestId }, content: f.ctx.calls[0].content }); agent.status = 'idle';
  const replay = await f.runtime.dispatch('prompt', { ...prompt(f, { expectedModel: selected }), requestId: f.ctx.calls[0].requestId }); assert.equal(replay.replayed, true); assert.equal(f.ctx.calls.length, 1); assert.equal(f.ctx.nativeCalls.filter(call => call[0] === 'create').length, 1);
});

test('默认 create-session 仍立即落盘和创建 native，旧 API 无需 draft 参数', async t => {
  const f = await fixture(t, { draft: false }); const snapshot = await f.runtime.dispatch('snapshot', { sessionId: f.sessionId }); assert.equal(snapshot.draft, false); assert.equal(snapshot.archivedAt, null); assert.equal(snapshot.archiveRevision, 0); assert.equal(f.ctx.nativeCalls.filter(call => call[0] === 'create').length, 1); await fs.access(path.join(f.store.sessionDir(f.sessionId), 'state.json'));
});

for (const interruption of ['cancel', 'discard', 'disable', 'abort']) test(`草稿 prompt 等待准入期间 ${interruption} 不落盘、不创建 native`, async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred(); const queued = deferred(); const lock = f.store.lock.bind(f.store); const key = `admission:${f.sessionId}`;
  const held = lock(key, async () => { entered.resolve(); await release.promise; }); await entered.promise;
  f.store.lock = (name, operation) => { if (name === key) queued.resolve(); return lock(name, operation); };
  const controller = new AbortController(); const pending = f.runtime.dispatch('prompt', prompt(f), controller.signal); const rejected = assert.rejects(pending, interruption === 'disable' ? { code: 'READING_UNAVAILABLE' } : interruption === 'abort' ? { name: 'AbortError' } : { code: 'PROMPT_CANCELLED' }); await queued.promise;
  let discarded;
  if (interruption === 'cancel') await f.runtime.dispatch('cancel', { sessionId: f.sessionId });
  if (interruption === 'discard') discarded = f.runtime.dispatch('discard-draft', { sessionId: f.sessionId });
  if (interruption === 'disable') await f.ctx.dispose();
  if (interruption === 'abort') controller.abort();
  release.resolve(); await held; await rejected; if (discarded) await discarded; await noArtifacts(f);
});

for (const interruption of ['cancel', 'disable']) test(`草稿完成选区预检但尚未持久化时 ${interruption}，guard 保持纯内存`, async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred(); const persist = f.store.persistDraft.bind(f.store);
  f.store.persistDraft = async (...args) => { entered.resolve(); await release.promise; return persist(...args); };
  const pending = f.runtime.dispatch('prompt', prompt(f, { selection: await selection(f) })); const rejected = assert.rejects(pending, { code: interruption === 'cancel' ? 'PROMPT_CANCELLED' : 'READING_UNAVAILABLE' }); await entered.promise;
  if (interruption === 'cancel') await f.runtime.dispatch('cancel', { sessionId: f.sessionId }); else await f.ctx.dispose(); release.resolve(); await rejected; assert.equal(f.store.session(f.sessionId).draft, true); await noArtifacts(f);
});

test('确认后 native 创建失败保留待初始化档案，后续明确重试可以恢复', async t => {
  const f = await fixture(t); const create = f.ctx.sessionController.create; let once = true;
  f.ctx.sessionController.create = async args => { if (once) { once = false; throw new Error('native unavailable'); } return create(args); };
  await assert.rejects(f.runtime.dispatch('prompt', prompt(f)), /native unavailable/); assert.equal(f.store.session(f.sessionId).draft, false); assert.equal(f.store.session(f.sessionId).nativePending, true); assert.equal(f.ctx.calls.length, 0); await fs.access(path.join(f.store.sessionDir(f.sessionId), 'state.json'));
  const snapshot = await f.runtime.dispatch('snapshot', { sessionId: f.sessionId }); assert.deepEqual(snapshot.modelSelection, f.ctx.defaultModel); assert.equal(snapshot.archiveError, null);
  await f.runtime.dispatch('prompt', prompt(f)); assert.equal(f.ctx.calls.length, 1); assert.equal(f.store.session(f.sessionId).nativePending, undefined); assert.equal(f.ctx.nativeCalls.filter(call => call[0] === 'create').length, 1);
});

test('显式保存人工批注先核验再持久化，但无需 native 或模型调用', async t => {
  const f = await fixture(t); const chosen = await selection(f); const request = { sessionId: f.sessionId, requestId: randomUUID(), body: '人工笔记', selection: chosen };
  await assert.rejects(f.runtime.dispatch('annotation-create', { ...request, selection: { ...chosen, quote: 'forged' } })); await assert.rejects(f.runtime.dispatch('annotation-create', { ...request, body: '' })); await noArtifacts(f);
  const created = await f.runtime.dispatch('annotation-create', request); assert.equal(created.item.body, '人工笔记'); assert.equal(f.store.session(f.sessionId).draft, false); assert.equal(f.store.session(f.sessionId).nativePending, true); assert.deepEqual(f.ctx.nativeCalls, []); assert.equal(f.ctx.calls.length, 0);
  const snapshot = await f.runtime.dispatch('snapshot', { sessionId: f.sessionId }); assert.equal(snapshot.draft, false); assert.equal(snapshot.archiveError, null); assert.equal((await f.runtime.dispatch('list', {})).projects[0].sessions.length, 1);
  assert.match((await f.runtime.dispatch('export', { sessionId: f.sessionId })).markdown, /人工笔记/); assert.deepEqual(f.ctx.nativeCalls, []);
  const replay = await f.runtime.dispatch('annotation-create', request); assert.equal(replay.replayed, true); assert.equal((await f.runtime.dispatch('annotations', { sessionId: f.sessionId })).items.length, 1);
  await f.runtime.dispatch('prompt', prompt(f)); assert.equal(f.ctx.calls.length, 1); assert.equal(f.ctx.nativeCalls.filter(call => call[0] === 'create').length, 1);
});

test('草稿批注的取消 guard 在 promote 前阻止落盘', async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred(); const persist = f.store.persistDraft.bind(f.store);
  f.store.persistDraft = async (...args) => { entered.resolve(); await release.promise; return persist(...args); };
  const pending = f.runtime.dispatch('annotation-create', { sessionId: f.sessionId, requestId: randomUUID(), body: '不能迟到保存', selection: await selection(f) }); const rejected = assert.rejects(pending, { code: 'OPERATION_CANCELLED' }); await entered.promise;
  await f.runtime.dispatch('cancel', { sessionId: f.sessionId }); release.resolve(); await rejected; await noArtifacts(f);
});

test('旧档案生命周期默认 active 且只补内存，保留扩展字段而不改写磁盘', async t => {
  const f = await fixture(t, { host: false, draft: false }); const file = path.join(f.store.sessionDir(f.sessionId), 'state.json'); const state = JSON.parse(await fs.readFile(file, 'utf8')); delete state.draft; delete state.archivedAt; delete state.archiveRevision; state.userExtension = { keep: true }; const before = JSON.stringify(state); await fs.writeFile(file, before);
  const restored = await new ReadingStore(f.dataDir).init(); const snapshot = await restored.snapshot(f.sessionId); assert.equal(snapshot.draft, false); assert.equal(snapshot.state.draft, false); assert.equal(snapshot.archivedAt, null); assert.equal(snapshot.archiveRevision, 0); assert.deepEqual(snapshot.state.userExtension, { keep: true }); assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('归档与恢复独立 CAS、同目标幂等，并在重启后恢复且保留阶段和位置版本', async t => {
  const f = await fixture(t, { draft: false }); const state = f.store.session(f.sessionId); const result = await archive(f, true, 0); assert.equal(typeof result.archivedAt, 'string'); assert.equal(result.archiveRevision, 1);
  assert.deepEqual(await archive(f, true, 0), result); await assert.rejects(archive(f, false, 0), { code: 'STALE_ARCHIVE_REVISION' }); assert.equal(state.revision, f.store.session(f.sessionId).revision); assert.equal(f.store.session(f.sessionId).readerState.revision, 0);
  const list = (await f.runtime.dispatch('list', {})).projects[0].sessions[0]; assert.equal(list.archivedAt, result.archivedAt); assert.equal(list.archiveRevision, 1);
  const restored = await new ReadingStore(f.dataDir).init(); assert.equal(restored.session(f.sessionId).archivedAt, result.archivedAt); assert.equal(restored.session(f.sessionId).archiveRevision, 1);
  const active = await archive(f, false, 1); assert.equal(active.archivedAt, null); assert.equal(active.archiveRevision, 2); assert.deepEqual(await archive(f, false, 1), active);
  await f.runtime.dispatch('prompt', prompt(f)); assert.equal(f.ctx.calls.length, 1);
});

test('运行中禁止归档，归档后禁止发起/阶段/模型但允许浏览、位置与导出', async t => {
  const f = await fixture(t, { draft: false }); f.ctx.live.get(f.sessionId).status = 'running'; await assert.rejects(archive(f, true, 0), { code: 'AGENT_BUSY' }); assert.equal(f.store.session(f.sessionId).archiveRevision, 0); f.ctx.live.get(f.sessionId).status = 'idle'; await archive(f, true, 0);
  for (const [method, params] of [['prompt', prompt(f)], ['stage', { sessionId: f.sessionId, expectedRevision: 1, stage: 'business' }], ['select-model', { sessionId: f.sessionId, provider: 'local', model: 'private' }]]) await assert.rejects(f.runtime.dispatch(method, params), { code: 'SESSION_ARCHIVED' });
  await f.runtime.dispatch('view-file', { sessionId: f.sessionId, repoId: f.repoId, path: 'entry.ts' }); await f.runtime.dispatch('reader-state', { sessionId: f.sessionId, expectedRevision: 0, patch: { activeDocument: 'source' } }); assert.match((await f.runtime.dispatch('export', { sessionId: f.sessionId })).markdown, /阅读档案/); assert.equal(f.ctx.calls.length, 0); assert.equal((await f.runtime.dispatch('snapshot', { sessionId: f.sessionId })).archiveRevision, 1);
  await assert.rejects(f.store.changeStage({ sessionId: f.sessionId, expectedRevision: 1, stage: 'business' }), { code: 'SESSION_ARCHIVED' }); await assert.rejects(f.store.updateReadingMode(f.sessionId, 'code'), { code: 'SESSION_ARCHIVED' });
});

test('归档与 prompt 共用准入锁，归档提交期间旧 prompt 不能越过归档', async t => {
  const f = await fixture(t, { draft: false }); const entered = deferred(); const release = deferred(); const audit = f.store.audit.bind(f.store);
  f.store.audit = async (...args) => { if (args[1] === 'session-archive-attempt') { entered.resolve(); await release.promise; } return audit(...args); };
  const pendingArchive = archive(f, true, 0); await entered.promise; const pendingPrompt = f.runtime.dispatch('prompt', prompt(f)); const rejected = assert.rejects(pendingPrompt, { code: 'SESSION_ARCHIVED' }); const staleRestore = archive(f, false, 0); const stale = assert.rejects(staleRestore, { code: 'STALE_ARCHIVE_REVISION' }); release.resolve(); await pendingArchive; await rejected; await stale; assert.equal(f.ctx.calls.length, 0);
});

for (const point of ['admission', 'audit', 'atomic']) test(`归档在 ${point} 等待期间停用，guard 保留原 state.json 和独立版本`, async t => {
  const f = await fixture(t, { draft: false }); const file = path.join(f.store.sessionDir(f.sessionId), 'state.json'); const before = await fs.readFile(file, 'utf8'); const entered = deferred(); const release = deferred(); let held; const open = fs.open;
  if (point === 'admission') { held = f.store.lock(`admission:${f.sessionId}`, async () => { entered.resolve(); await release.promise; }); await entered.promise; }
  if (point === 'audit') { const audit = f.store.audit.bind(f.store); f.store.audit = async (...args) => { if (args[1] === 'session-archive-attempt') { entered.resolve(); await release.promise; } return audit(...args); }; }
  if (point === 'atomic') fs.open = async (...args) => { const handle = await open(...args); if (String(args[0]).startsWith(file + '.') && String(args[0]).endsWith('.tmp')) { const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); entered.resolve(); await release.promise; }; } return handle; };
  try {
    const pending = archive(f, true, 0); const rejected = assert.rejects(pending, { code: 'READING_UNAVAILABLE' }); if (point !== 'admission') await entered.promise; await f.ctx.dispose(); release.resolve(); if (held) await held; await rejected;
  } finally { fs.open = open; }
  assert.equal(await fs.readFile(file, 'utf8'), before); assert.equal(f.store.session(f.sessionId).archivedAt, null); assert.equal(f.store.session(f.sessionId).archiveRevision, 0);
});

for (const point of ['directory', 'atomic']) test(`promote 在 ${point} 期间取消留下孤立目录，重启仍载入其后的有效会话`, async t => {
  const f = await fixture(t, { host: false }); const persisted = await f.store.createSession(f.project.id); const stateFile = path.join(f.store.sessionDir(f.sessionId), 'state.json'); const open = fs.open; const writable = f.store.writable.bind(f.store); let active = true;
  const guard = () => { if (!active) throw new Error('cancelled promotion'); };
  if (point === 'directory') f.store.writable = async (...args) => { await writable(...args); if (args[1] === f.sessionId) active = false; };
  if (point === 'atomic') fs.open = async (...args) => { const handle = await open(...args); if (String(args[0]).startsWith(stateFile + '.') && String(args[0]).endsWith('.tmp')) { const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); active = false; }; } return handle; };
  try { await assert.rejects(f.store.persistDraft(f.sessionId, guard), /cancelled promotion/); } finally { fs.open = open; f.store.writable = writable; }
  await assert.rejects(fs.access(stateFile), { code: 'ENOENT' }); assert.equal(f.store.session(f.sessionId).draft, true);
  const readdir = fs.readdir; fs.readdir = async (...args) => { const rows = await readdir(...args); return path.resolve(args[0]) === f.sessionsDir ? rows.sort((a, b) => a.name === f.sessionId ? -1 : b.name === f.sessionId ? 1 : 0) : rows; };
  try { const restored = await new ReadingStore(f.dataDir).init(); assert.equal(restored.sessions.size, 1); assert.equal(restored.session(persisted.id).draft, false); assert.ok(restored.diagnostics.some(row => row.includes(f.sessionId))); } finally { fs.readdir = readdir; }
});

test('FIFO 淘汰仅删除草稿内存，永远不影响持久化会话和文件', async t => {
  const f = await fixture(t, { host: false, draft: false }); const file = path.join(f.store.sessionDir(f.sessionId), 'state.json'); const before = await fs.readFile(file, 'utf8');
  for (let index = 0; index < 105; index++) await f.store.createSession(f.project.id, { draft: true });
  assert.equal(f.store.sessions.size, 101); assert.equal(f.store.session(f.sessionId).draft, false); assert.equal(await fs.readFile(file, 'utf8'), before); assert.deepEqual(await fs.readdir(f.sessionsDir), [f.sessionId]);
});
