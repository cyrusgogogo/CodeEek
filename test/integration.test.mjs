import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const installed = process.env.DSH_TEST_INSTALLED_PACKAGE;
const { apply: applyHost, Config } = await import(installed ? pathToFileURL(path.join(installed, 'lib/index.js')).href : '../src/index.mjs');
test('原生 Loader 省略配置时使用空对象默认值', () => { assert.deepEqual(Config.parse(undefined), {}); });
const { apply: applyPreset } = await import(installed ? pathToFileURL(path.join(installed, 'lib/preset.js')).href : '../src/preset.mjs');
import { ReadingStore, getRuntime } from '../src/store.mjs';
import { validateMermaid, effectiveModelSelection } from '../src/contracts.mjs';
import { bindDirectory, listRepository } from '../src/filesystem.mjs';
const base = path.resolve('.test-output');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function setup(t) {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'integration-')); const repo = path.join(root, 'repo'); await fs.mkdir(repo); await fs.writeFile(path.join(repo, 'entry.ts'), 'export const answer = 42;\n');
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), base); assert.match(path.basename(root), /^integration-/); await fs.rm(root, { recursive: true, force: true }); });
  return { root, repo, dataDir: path.join(root, 'artifacts') };
}
function hostContext() {
  const listeners = new Map(); const live = new Map(); const effects = []; const definitions = new Map(); const guards = []; let route;
  const ctx = { root: {}, effects, listeners, live, definitions, guards, defaultModel: { provider: 'remote', model: 'reader' }, calls: [],
    logger: { warn() {} },
    effect(factory) { const result = factory(); if (result?.then) result.then(dispose => { if (typeof dispose === 'function') effects.push(dispose); }); else if (typeof result === 'function') effects.push(result); return result; },
    on(name, callback) { const rows = listeners.get(name) ?? []; rows.push(callback); listeners.set(name, rows); return () => {}; },
    get(name) { return ctx[name]; },
    agents: { get: id => live.get(id) },
    agentPresets: { composedPreset: agentCtx => agentCtx?.preset, register: async () => () => {} },
    tools: { guard(callback) { guards.push(callback); return () => {}; }, presentAs() { return () => {}; }, register(definition) { definitions.set(definition.name, definition); return () => {}; } },
    systemPrompt: { section() { return () => {}; }, suppressRuntimeContext() { return () => {}; } },
    skills: { register(skill) { assert.equal(typeof skill.content, 'string'); return () => {}; } },
    connection: { fetch: { register(value) { route = value; return () => {}; } } },
    agentDefaultModel: { currentSelection: () => ({ ...ctx.defaultModel }) },
    sandboxPolicy: { overrideOf: session => [...session.events].reverse().find(e => e.type === 'sandbox/mode')?.data.mode }
  };
  ctx.sessionController = {
    async create({ sessionId, cwd, agentPreset }) {
      const session = { id: sessionId, header: { cwd }, events: [], snapshotEvents() { return [...this.events]; }, append(type, data) { const event = { seq: this.events.length, type, data, time: Date.now() }; this.events.push(event); for (const callback of listeners.get('session/event') ?? []) callback(this, event); } };
      const agent = { id: sessionId, session, ctx: { root: ctx.root, preset: agentPreset }, status: 'idle' }; live.set(sessionId, agent);
      for (const callback of listeners.get('agent/created') ?? []) await callback({ agent, source: 'startup' });
      return { sessionId, agentPreset };
    },
    async rename() { return {}; },
    async resolveAgent(id) { return live.has(id) ? { agent: live.get(id) } : { error: new Error('not found') }; },
    async inspect(id) { const agent = live.get(id); return { meta: agent.session.header, events: agent.session.snapshotEvents() }; },
    async prompt(request) { ctx.calls.push(request); live.get(request.sessionId).status = 'running'; return { accepted: true }; },
    async selectModel(request) { live.get(request.sessionId).session.append('model/selection', { provider: request.provider, model: request.model }); return { selected: request }; },
    async cancel({ sessionId }) { live.get(sessionId).status = 'idle'; return {}; },
    async modelCatalog() { return { default: ctx.defaultModel, groups: [], failures: [], routableProviders: [] }; }
  };
  Object.defineProperty(ctx, 'route', { get: () => route });
  return ctx;
}
async function nativeFixture(t) {
  const files = await setup(t); const ctx = hostContext(); await applyHost(ctx, { dataDir: files.dataDir }); const runtime = getRuntime(ctx.root);
  const project = await runtime.dispatch('create-project', { title: '集成夹具', repositories: [{ name: 'repo', path: files.repo }] });
  const { sessionId } = await runtime.dispatch('create-session', { projectId: project.id });
  return { ...files, ctx, runtime, project, sessionId };
}
test('Host 与 scoped preset 接线：只读模式、五个专用工具和私有连接路由', async t => {
  const f = await nativeFixture(t); applyPreset(f.ctx);
  assert.equal(f.ctx.route.path, '/api/code-reading'); assert.deepEqual([...f.ctx.definitions.keys()].sort(), ['reading_catalog', 'reading_files', 'reading_publish', 'reading_read', 'reading_search']);
  const agent = f.ctx.live.get(f.sessionId); assert.equal(f.ctx.sandboxPolicy.overrideOf(agent.session), 'read-only');
  const catalog = await f.ctx.definitions.get('reading_catalog').execute({}, { agent }); assert.equal(catalog.project.id, f.project.id);
  const denied = f.ctx.guards.map(check => check({ agent, name: 'write' })).filter(Boolean); assert.ok(denied.length >= 2);
  await assert.rejects(f.ctx.definitions.get('reading_catalog').execute({ extra: true }, { agent }));
});
test('阶段提交与 prompt 共用准入门控，不会在提交期间接纳旧 revision', async t => {
  const f = await nativeFixture(t); const entered = deferred(); const release = deferred(); const original = f.runtime.store.audit.bind(f.runtime.store);
  f.runtime.store.audit = async (...args) => { if (args[1] === 'human-stage-selected') { entered.resolve(); await release.promise; } return original(...args); };
  const stage = f.runtime.dispatch('stage', { sessionId: f.sessionId, stage: 'business', topic: '答案', expectedRevision: 1 }); await entered.promise;
  const prompt = f.runtime.dispatch('prompt', { sessionId: f.sessionId, requestId: randomUUID(), expectedRevision: 1, expectedModel: f.ctx.defaultModel, text: '解释答案' });
  release.resolve(); await stage; await assert.rejects(prompt, { code: 'STALE_REVISION' }); assert.equal(f.ctx.calls.length, 0);
});
test('实际会话模型优先于全局默认，旧模型标签不能发送源码', async t => {
  const f = await nativeFixture(t); const agent = f.ctx.live.get(f.sessionId);
  agent.session.append('request/header', { header: { config: { provider: 'local', model: 'private-reader' } } });
  const snapshot = await f.runtime.dispatch('snapshot', { sessionId: f.sessionId }); assert.equal(snapshot.modelSelection.provider, 'local');
  await assert.rejects(f.runtime.dispatch('prompt', { sessionId: f.sessionId, requestId: randomUUID(), expectedRevision: 1, expectedModel: f.ctx.defaultModel, text: '不能发到远程' }), { code: 'MODEL_CHANGED' }); assert.equal(f.ctx.calls.length, 0);
});
test('重新应用 Host 复用同一 store 与锁，停用时遗留工具 fail closed', async t => {
  const f = await nativeFixture(t); applyPreset(f.ctx); const oldTool = f.ctx.definitions.get('reading_catalog'); const oldStore = f.runtime.store;
  f.runtime.enabled = false; await assert.rejects(oldTool.execute({}, { agent: f.ctx.live.get(f.sessionId) }), { code: 'NOT_READING_AGENT' });
  await applyHost(f.ctx, { dataDir: f.dataDir }); assert.equal(getRuntime(f.ctx.root).store, oldStore); assert.equal((await oldTool.execute({}, { agent: f.ctx.live.get(f.sessionId) })).sessionId, f.sessionId);
});
test('完整前缀重放恢复故障消息；后继碎片不能清除缺口错误', async t => {
  const f = await setup(t); const store = await new ReadingStore(f.dataDir).init(); const p = await store.createProject({ title: '恢复', repositories: [{ name: 'repo', path: f.repo }] }); const s = await store.createSession(p.id);
  const events = [{ seq: 0, type: 'user/message', time: Date.now(), data: { role: 'user', content: [{ type: 'text', text: '需恢复的消息' }] } }, { seq: 1, type: 'turn/start', data: { turn: 1 } }];
  const original = store.saveState.bind(store); let once = true; store.saveState = async state => { if (once) { once = false; throw new Error('模拟提交失败'); } return original(state); };
  await assert.rejects(store.archiveEvents(s.id, [events[0]])); await assert.rejects(store.archiveEvents(s.id, [events[1]]), { code: 'ARCHIVE_GAP' });
  assert.ok(store.archiveErrors.has(s.id)); await store.archiveEvents(s.id, events); const snapshot = await store.snapshot(s.id); assert.equal(snapshot.messages.length, 1); assert.equal(snapshot.messages[0].text, '需恢复的消息'); assert.equal(snapshot.archiveError, null);
});
test('审计硬链接拒绝追加，仓库文件字节不变', async t => {
  const f = await setup(t); const store = await new ReadingStore(f.dataDir).init(); const p = await store.createProject({ title: '链接', repositories: [{ name: 'repo', path: f.repo }] }); const s = await store.createSession(p.id);
  const audit = path.join(store.sessionDir(s.id), 'audit.jsonl'); const source = path.join(f.repo, 'entry.ts'); const before = await fs.readFile(source);
  assert.equal(path.dirname(audit), store.sessionDir(s.id)); await fs.unlink(audit); await fs.link(source, audit);
  await assert.rejects(store.files(s.id, { repoId: p.repositories[0].id }), { code: 'OUTPUT_ALIAS' }); assert.deepEqual(await fs.readFile(source), before);
  await assert.rejects(store.read(s.id, { repoId: p.repositories[0].id, path: 'entry.ts' }), { code: 'FILE_ALIAS' });
});
test('发布凭据包含本轮作用域且参数冲突不能伪装为重试', async t => {
  const f = await setup(t); const store = await new ReadingStore(f.dataDir).init(); const p = await store.createProject({ title: '凭据', repositories: [{ name: 'repo', path: f.repo }] }); const s = await store.createSession(p.id); const read = await store.read(s.id, { repoId: p.repositories[0].id, path: 'entry.ts' });
  const args = { expectedRevision: 1, title: '常量', markdown: '返回 42', conclusion: '常量为 42', claims: [{ kind: 'fact', text: '42', evidenceIds: [read.evidence.id] }], nextQuestions: ['在哪里使用？'] };
  await store.publish(s.id, args, '1:1:call_0', 1); await assert.rejects(store.publish(s.id, { ...args, title: '另一内容' }, '1:1:call_0', 1), { code: 'RECEIPT_CONFLICT' }); await store.publish(s.id, args, '2:1:call_0', 2); assert.equal(store.session(s.id).lessons.length, 2);
});
test('Mermaid 拒绝渲染前资产加载语法，模型选择还原待使用与已使用状态', () => {
  for (const text of ['flowchart TD\nA@{ img: "//attacker.invalid/leak", label: "x" }', 'flowchart TD\nA@{ icon: "remote:foo" }', 'flowchart TD\nA["`![x](//attacker.invalid/x)`"]', 'flowchart TD\nA["&lt;img src=x&gt;"]']) assert.throws(() => validateMermaid(text));
  const events = [{ type: 'model/selection', data: { provider: 'local', model: 'a' } }, { type: 'request/header', data: { header: { config: { provider: 'local', model: 'a' } } } }, { type: 'model/selection', data: { provider: 'private', model: 'b' } }];
  assert.deepEqual(effectiveModelSelection(events, { provider: 'remote', model: 'wrong' }), { provider: 'private', model: 'b' }); assert.deepEqual(effectiveModelSelection(events.slice(0, 2)), { provider: 'local', model: 'a' });
});
test('全是排除文件的宽目录也在 8000 条目预算处关闭', async t => {
  const f = await setup(t); const binding = await bindDirectory(f.repo); const original = fs.opendir; let enumerated = 0; let closed = false;
  fs.opendir = async directory => directory === f.repo ? (async function* () { try { for (let i = 0; i < 100000; i++) { enumerated++; yield { name: `.env.${i}`, isSymbolicLink: () => false }; } } finally { closed = true; } })() : original(directory);
  try { const result = await listRepository(binding); assert.equal(result.visited, 8000); assert.equal(result.truncated, true); assert.equal(result.files.length, 0); assert.ok(enumerated <= 8001); assert.equal(closed, true); } finally { fs.opendir = original; }
});
test('审计出现半行后 fail closed，不继续返回未可解析留痕的读取内容', async t => {
  const f = await nativeFixture(t); const audit = path.join(f.runtime.store.sessionDir(f.sessionId), 'audit.jsonl'); await fs.appendFile(audit, '{"partial":');
  await assert.rejects(f.runtime.store.read(f.sessionId, { repoId: f.project.repositories[0].id, path: 'entry.ts' }), { code: 'AUDIT_CORRUPT' }); assert.equal(f.runtime.store.session(f.sessionId).evidence.length, 0);
});
test('已处理提问按请求 ID 重放，不重新入队或等待新的一轮', async t => {
  const f = await nativeFixture(t); const request = { sessionId: f.sessionId, requestId: randomUUID(), expectedRevision: 1, expectedModel: f.ctx.defaultModel, text: '解释答案' }; await f.runtime.dispatch('prompt', request);
  const agent = f.ctx.live.get(f.sessionId); agent.session.append('user/message', { role: 'user', source: { kind: 'user', rpcId: request.requestId }, content: [{ type: 'text', text: request.text }] }); agent.status = 'idle';
  const result = await f.runtime.dispatch('prompt', request); assert.equal(result.replayed, true); assert.equal(result.running, false); assert.equal(f.ctx.calls.length, 1); await f.runtime.dispatch('snapshot', { sessionId: f.sessionId });
});
