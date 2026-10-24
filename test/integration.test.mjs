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
import { bindDirectory, listRepository, digest } from '../src/filesystem.mjs';
const base = path.resolve('.test-output');
const entryUnit = evidence => ({ kind: 'file', name: 'entry.ts module', repoId: evidence.repoId, path: evidence.path, fileHash: evidence.hash, start: { line: 1, column: 0 }, end: { line: 2, column: 0 }, conclusion: '完整常量模块导出 answer = 42。', evidenceIds: [evidence.id] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function setup(t) {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'integration-')); const repo = path.join(root, 'repo'); await fs.mkdir(repo); await fs.writeFile(path.join(repo, 'entry.ts'), 'export const answer = 42;\n');
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), base); assert.match(path.basename(root), /^integration-/); await fs.rm(root, { recursive: true, force: true }); });
  return { root, repo, dataDir: path.join(root, 'artifacts') };
}
function hostContext() {
  const listeners = new Map(); const live = new Map(); const effects = []; const definitions = new Map(); const guards = []; let route;
  const ctx = { root: {}, effects, listeners, live, definitions, guards, promptSections: new Map(), defaultModel: { provider: 'remote', model: 'reader' }, calls: [],
    logger: { warn() {} },
    effect(factory) { const result = factory(); if (result?.then) result.then(dispose => { if (typeof dispose === 'function') effects.push(dispose); }); else if (typeof result === 'function') effects.push(result); return result; },
    on(name, callback) { const rows = listeners.get(name) ?? []; rows.push(callback); listeners.set(name, rows); const dispose = () => { const at = rows.indexOf(callback); if (at >= 0) rows.splice(at, 1); }; effects.push(dispose); return dispose; },
    get(name) { return ctx[name]; },
    agents: { get: id => live.get(id) },
    agentPresets: { composedPreset: agentCtx => agentCtx?.preset, register: async () => () => {} },
    tools: { guard(callback) { guards.push(callback); return () => { const at = guards.indexOf(callback); if (at >= 0) guards.splice(at, 1); }; }, presentAs() { return () => {}; }, register(definition) { definitions.set(definition.name, definition); return () => { if (definitions.get(definition.name) === definition) definitions.delete(definition.name); }; } },
    systemPrompt: { section(value) { ctx.promptSections.set(value.name, value); return () => ctx.promptSections.delete(value.name); }, suppressRuntimeContext() { return () => {}; } },
    skills: { register(skill) { assert.equal(typeof skill.content, 'string'); return () => {}; } },
    connection: { fetch: { register(value) { route = value; return () => { if (route === value) route = undefined; }; } } },
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
    async rename({ sessionId, title }) { const agent = live.get(sessionId); agent.title = title; return { title }; },
    async resolveAgent(id) { return live.has(id) ? { agent: live.get(id) } : { error: new Error('not found') }; },
    async inspect(id) { const agent = live.get(id); return { meta: { ...agent.session.header, title: agent.title }, events: agent.session.snapshotEvents() }; },
    async prompt(request) { ctx.calls.push(request); live.get(request.sessionId).status = 'running'; return { accepted: true }; },
    async selectModel(request) { live.get(request.sessionId).session.append('model/selection', { provider: request.provider, model: request.model }); return { selected: request }; },
    async cancel({ sessionId }) { live.get(sessionId).status = 'idle'; return {}; },
    async modelCatalog() { return { default: ctx.defaultModel, groups: [], failures: [], routableProviders: [] }; }
  };
  Object.defineProperty(ctx, 'route', { get: () => route });
  ctx.dispose = async () => { for (const dispose of effects.splice(0).reverse()) await dispose(); };
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
test('安装状态只读返回同源版本与目录来源，不创建项目或请求模型', async t => {
  const f = await nativeFixture(t); const before = f.runtime.store.list(); const status = await f.runtime.dispatch('status', {});
  assert.equal(status.package, 'dsh-code-reading'); assert.equal(status.version, JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.equal(status.apiVersion, 1); assert.deepEqual(status.capabilities, ['remove-project', 'default-model', 'structure-map-v1', 'code-map-v1']); assert.equal(status.targetDshVersion, '0.2.1-rc.3'); assert.equal(status.dataDirectory, path.resolve(f.dataDir)); assert.equal(status.dataSource, 'config.dataDir');
  assert.deepEqual(f.runtime.store.list(), before); assert.equal(f.ctx.calls.length, 0);
});
test('不支持的请求类型也返回统一错误 envelope', async t => {
  const f = await nativeFixture(t); const response = await f.ctx.route.fetch(new Request('http://localhost/api/code-reading', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }));
  assert.equal(response.status, 415); assert.deepEqual(await response.json(), { ok: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '需要 application/json 请求' } });
});
test('中文 JSON 请求按 UTF-8 字节限制 128 KiB', async t => {
  const f = await nativeFixture(t); const body = JSON.stringify({ method: 'status', params: { padding: '中'.repeat(50000) } }); assert.ok(body.length < 131072 && Buffer.byteLength(body) > 131072);
  const response = await f.ctx.route.fetch(new Request('http://localhost/api/code-reading', { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
  assert.equal(response.status, 413); assert.equal((await response.json()).error.code, 'REQUEST_LIMIT');
});

test('Host 停用后捕获的路由和排队 prompt 必须拒绝，不调用模型', async t => {
  const f = await nativeFixture(t); const oldRoute = f.ctx.route; const started = deferred(); const release = deferred(); const queued = deferred();
  const originalLock = f.runtime.store.lock.bind(f.runtime.store); const key = `admission:${f.sessionId}`;
  const held = originalLock(key, async () => { started.resolve(); await release.promise; }); await started.promise;
  f.runtime.store.lock = (name, operation) => { if (name === key) queued.resolve(); return originalLock(name, operation); };
  const pending = f.runtime.dispatch('prompt', { sessionId: f.sessionId, requestId: randomUUID(), expectedRevision: 1, expectedModel: f.ctx.defaultModel, text: '不得发送' });
  const refused = assert.rejects(pending, { code: 'READING_UNAVAILABLE' }); await queued.promise; await f.ctx.dispose();
  assert.equal(f.ctx.route, undefined); assert.equal(f.ctx.guards.length, 0); assert.equal([...f.ctx.listeners.values()].flat().length, 0);
  release.resolve(); await held; await refused;
  const response = await oldRoute.fetch(new Request('http://localhost/api/code-reading', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'list' }) }));
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'READING_UNAVAILABLE'); assert.equal(f.ctx.calls.length, 0);
});
for (const [method, replacement] of [['prompt', false], ['stage', false], ['select-model', false], ['prompt', true]]) {
  test(`${method} 已获准入的异步校验期间${replacement ? '升级' : '停用'}也拒绝真正副作用`, async t => {
    const f = await nativeFixture(t); const entered = deferred(); const release = deferred(); let mutations = 0;
    if (method === 'prompt') {
      const inspect = f.ctx.sessionController.inspect.bind(f.ctx.sessionController);
      f.ctx.sessionController.inspect = async id => { entered.resolve(); await release.promise; return inspect(id); };
    } else {
      const resolve = f.ctx.sessionController.resolveAgent.bind(f.ctx.sessionController); let count = 0;
      f.ctx.sessionController.resolveAgent = async id => { if (++count === 2) { entered.resolve(); await release.promise; } return resolve(id); };
    }
    const target = method === 'stage' ? f.runtime.store : f.ctx.sessionController; const key = method === 'stage' ? 'changeStage' : method === 'select-model' ? 'selectModel' : 'prompt'; const original = target[key].bind(target);
    target[key] = (...args) => { mutations++; return original(...args); };
    const params = method === 'prompt' ? { sessionId: f.sessionId, requestId: randomUUID(), expectedRevision: 1, expectedModel: f.ctx.defaultModel, text: '不能在停用后开始' } : method === 'stage' ? { sessionId: f.sessionId, expectedRevision: 1, stage: 'business', topic: '不得提交' } : { sessionId: f.sessionId, provider: 'local', model: 'private-reader' };
    const pending = f.runtime.dispatch(method, params); const refused = assert.rejects(pending, { code: 'READING_UNAVAILABLE' }); await entered.promise;
    if (replacement) await applyHost(f.ctx, { dataDir: f.dataDir }); else await f.ctx.dispose();
    release.resolve(); await refused; assert.equal(mutations, 0); assert.equal(f.ctx.calls.length, 0); assert.equal(f.runtime.store.session(f.sessionId).revision, 1); await f.ctx.dispose();
  });
}

test('旧 activation 迟到清理不关闭新实例，旧 handler 不借新实例复活', async t => {
  const f = await nativeFixture(t); const oldRoute = f.ctx.route; const cleanup = f.ctx.effects.splice(0); const store = f.runtime.store;
  await applyHost(f.ctx, { dataDir: f.dataDir }); for (const dispose of cleanup.reverse()) await dispose();
  assert.equal(f.runtime.enabled, true); assert.equal(f.runtime.store, store); assert.equal((await f.runtime.dispatch('status', {})).enabled, true);
  const response = await oldRoute.fetch(new Request('http://localhost/api/code-reading', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'list' }) }));
  assert.equal(response.status, 503); await f.ctx.dispose();
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
  const args = { expectedRevision: 1, title: '常量', markdown: '返回 42', conclusion: '常量为 42', claims: [{ kind: 'fact', text: '42', evidenceIds: [read.evidence.id] }], nextQuestions: ['在哪里使用？'], codeUnits: [entryUnit(read.evidence)] };
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
test('选区分析先检查模型和阶段，失配不创建证据或请求模型', async t => {
  const f = await nativeFixture(t); const read = await fs.readFile(path.join(f.repo, 'entry.ts')); const selection = { repoId: f.project.repositories[0].id, path: 'entry.ts', fileHash: digest(read), start: { line: 1, column: 0 }, end: { line: 1, column: 25 }, quote: 'export const answer = 42;' };
  const args = { sessionId: f.sessionId, requestId: randomUUID(), text: '分析选区', expectedRevision: 1, expectedModel: f.ctx.defaultModel, selection };
  await assert.rejects(f.runtime.dispatch('prompt', { ...args, expectedModel: { provider: 'wrong', model: 'wrong' } }), { code: 'MODEL_CHANGED' });
  await assert.rejects(f.runtime.dispatch('prompt', { ...args, expectedRevision: 2 }), { code: 'STALE_REVISION' });
  await assert.rejects(f.runtime.dispatch('prompt', { ...args, selection: { ...selection, quote: 'fake' } }), { code: 'SELECTION_MISMATCH' });
  assert.equal(f.ctx.calls.length, 0); assert.equal(f.runtime.store.session(f.sessionId).evidence.length, 0);
  await f.runtime.dispatch('prompt', args); assert.equal(f.ctx.calls.length, 1); assert.match(f.ctx.calls[0].content[0].text, /selectedCode/); assert.equal(f.runtime.store.session(f.sessionId).evidence.length, 1);
});
test('人工批注端点不新增 Agent 工具，并保留不可变仓库与源码', async t => {
  const f = await nativeFixture(t); applyPreset(f.ctx); const before = await fs.readFile(path.join(f.repo, 'entry.ts')); const selection = { repoId: f.project.repositories[0].id, path: 'entry.ts', fileHash: digest(before), start: { line: 1, column: 0 }, end: { line: 1, column: 25 }, quote: 'export const answer = 42;' };
  const result = await f.runtime.dispatch('annotation-create', { sessionId: f.sessionId, requestId: randomUUID(), body: '常量用于回答', selection }); assert.equal(result.item.revision, 1); assert.equal((await f.runtime.dispatch('annotations', { sessionId: f.sessionId })).items.length, 1);
  assert.equal(f.ctx.definitions.size, 5); assert.equal(f.ctx.calls.length, 0); assert.deepEqual(await fs.readFile(path.join(f.repo, 'entry.ts')), before);
});
test('批注在异步会话校验期间停用后不得迟到提交', async t => {
  const f = await nativeFixture(t); const gate = deferred(); const entered = deferred(); const resolve = f.ctx.sessionController.resolveAgent; f.ctx.sessionController.resolveAgent = async id => { entered.resolve(); await gate.promise; return resolve(id); };
  const selection = { repoId: f.project.repositories[0].id, path: 'entry.ts', fileHash: digest(await fs.readFile(path.join(f.repo, 'entry.ts'))), start: { line: 1, column: 0 }, end: { line: 1, column: 25 }, quote: 'export const answer = 42;' };
  const pending = f.runtime.dispatch('annotation-create', { sessionId: f.sessionId, requestId: randomUUID(), body: '不能迟到写入', selection }); const rejected = assert.rejects(pending, { code: 'READING_UNAVAILABLE' }); await entered.promise; await f.ctx.dispose(); gate.resolve(); await rejected;
  await assert.rejects(fs.access(path.join(f.runtime.store.sessionDir(f.sessionId), 'annotations.json')), { code: 'ENOENT' });
});
test('已处理提问按请求 ID 重放，不重新入队或等待新的一轮', async t => {
  const f = await nativeFixture(t); const request = { sessionId: f.sessionId, requestId: randomUUID(), expectedRevision: 1, expectedModel: f.ctx.defaultModel, text: '解释答案' }; await f.runtime.dispatch('prompt', request);
  const agent = f.ctx.live.get(f.sessionId); agent.session.append('user/message', { role: 'user', source: { kind: 'user', rpcId: request.requestId }, content: [{ type: 'text', text: request.text }] }); agent.status = 'idle';
  const result = await f.runtime.dispatch('prompt', request); assert.equal(result.replayed, true); assert.equal(result.running, false); assert.equal(f.ctx.calls.length, 1); await f.runtime.dispatch('snapshot', { sessionId: f.sessionId });
});

test('位置端点只保存metadata，运行中也可保存且不请求模型或改变阶段', async t => {
  const f = await nativeFixture(t); f.ctx.live.get(f.sessionId).status = 'running';
  const saved = await f.runtime.dispatch('reader-state', { sessionId: f.sessionId, expectedRevision: 0, patch: { lessonScrollTop: 120, readerPosition: { repoId: f.project.repositories[0].id, path: 'entry.ts', hash: 'a'.repeat(64), offset: 1, scrollTop: 45, scrollLeft: 0 } } });
  assert.equal(saved.revision, 1); assert.equal(saved.lessonScrollTop, 120); assert.equal(f.ctx.calls.length, 0); assert.equal(f.runtime.store.session(f.sessionId).revision, 1);
  const snapshot = await f.runtime.dispatch('snapshot', { sessionId: f.sessionId }); assert.deepEqual(snapshot.state.readerState, saved); assert.equal(snapshot.running, true);
  await assert.rejects(f.runtime.dispatch('reader-state', { sessionId: f.sessionId, expectedRevision: 0, patch: { lessonScrollTop: 40 } }), { code: 'STALE_READER_STATE' });
});

for (const title of ['未命名阅读主题', '阅读 · 集成夹具', '用户已经命名', undefined]) {
  test(`首次主题命名仅更新已知系统默认名，兼容原名 ${String(title)}`, async t => {
    const f = await nativeFixture(t); const agent = f.ctx.live.get(f.sessionId); assert.equal(agent.title, '未命名阅读主题'); agent.title = title;
    await f.runtime.dispatch('stage', { sessionId: f.sessionId, expectedRevision: 1, stage: 'business', topic: '订单调用链' });
    const expected = title === '未命名阅读主题' || title === '阅读 · 集成夹具' ? '订单调用链' : title; assert.equal(agent.title, expected);
    await f.runtime.dispatch('stage', { sessionId: f.sessionId, expectedRevision: 2, stage: 'call-chain', topic: '后续探索' }); assert.equal(agent.title, expected); assert.equal(f.ctx.calls.length, 0);
  });
}

test('空主题保存不消耗首次命名机会，重命名失败不伪装阶段保存失败', async t => {
  const f = await nativeFixture(t); await f.runtime.dispatch('stage', { sessionId: f.sessionId, expectedRevision: 1, stage: 'business', topic: '' });
  assert.equal(f.ctx.live.get(f.sessionId).title, '未命名阅读主题'); f.ctx.sessionController.rename = async () => { throw new Error('native rename unavailable'); };
  const result = await f.runtime.dispatch('stage', { sessionId: f.sessionId, expectedRevision: 2, stage: 'business', topic: '第一次真实主题' }); assert.equal(result.topic, '第一次真实主题'); assert.equal(result.revision, 3);
});

for (const point of ['inspect', 'admission']) {
  test(`cancel阻止仍在${point}等待的prompt迟到入队，后续新提问仍可发送`, async t => {
    const f = await nativeFixture(t); const entered = deferred(); const release = deferred(); let held;
    if (point === 'inspect') { const original = f.ctx.sessionController.inspect; f.ctx.sessionController.inspect = async id => { entered.resolve(); await release.promise; return original(id); }; }
    else { held = f.runtime.store.lock(`admission:${f.sessionId}`, async () => { entered.resolve(); await release.promise; }); await entered.promise; }
    const params = { sessionId: f.sessionId, requestId: randomUUID(), expectedRevision: 1, expectedModel: f.ctx.defaultModel, text: '取消前仍在等待' };
    const pending = f.runtime.dispatch('prompt', params); const refused = assert.rejects(pending, { code: 'PROMPT_CANCELLED' }); if (point === 'inspect') await entered.promise;
    await f.runtime.dispatch('cancel', { sessionId: f.sessionId }); release.resolve(); if (held) await held; await refused; assert.equal(f.ctx.calls.length, 0);
    await f.runtime.dispatch('prompt', { ...params, requestId: randomUUID(), text: '取消后明确重发' }); assert.equal(f.ctx.calls.length, 1);
  });
}

test('cancel透传原生异步结果，不擅自将仍running的Agent标为停止', async t => {
  const f = await nativeFixture(t); const native = { requested: true, state: 'cancelling' }; f.ctx.live.get(f.sessionId).status = 'running';
  f.ctx.sessionController.cancel = async () => native;
  assert.equal(await f.runtime.dispatch('cancel', { sessionId: f.sessionId }), native); assert.equal((await f.runtime.dispatch('snapshot', { sessionId: f.sessionId })).running, true);
  await assert.rejects(f.runtime.dispatch('cancel', { sessionId: `reading-${randomUUID()}` }), { code: 'READING_NOT_FOUND' });
});

test('位置保存等待会话锁期间停用Host后不得提交', async t => {
  const f = await nativeFixture(t); const entered = deferred(); const release = deferred(); const queued = deferred(); const lock = f.runtime.store.lock.bind(f.runtime.store);
  const held = lock(f.sessionId, async () => { entered.resolve(); await release.promise; }); await entered.promise;
  f.runtime.store.lock = (key, operation) => { if (key === f.sessionId) queued.resolve(); return lock(key, operation); };
  const pending = f.runtime.dispatch('reader-state', { sessionId: f.sessionId, expectedRevision: 0, patch: { lessonScrollTop: 99 } }); const refused = assert.rejects(pending, { code: 'READING_UNAVAILABLE' }); await queued.promise;
  await f.ctx.dispose(); release.resolve(); await held; await refused; assert.equal(f.runtime.store.session(f.sessionId).readerState.revision, 0); assert.equal(f.ctx.calls.length, 0);
});

const promptRequest = (f, extra = {}) => ({ sessionId: f.sessionId, requestId: randomUUID(), text: '解释当前逻辑', expectedRevision: 1, expectedModel: f.ctx.defaultModel, ...extra });
const entrySelection = async f => ({ repoId: f.project.repositories[0].id, path: 'entry.ts', fileHash: digest(await fs.readFile(path.join(f.repo, 'entry.ts'))), start: { line: 1, column: 0 }, end: { line: 1, column: 25 }, quote: 'export const answer = 42;' });

test('reading_catalog 与 preset 在原生 enqueue 同步入口已看到本轮模式，追问省略时保留', async t => {
  const f = await nativeFixture(t); applyPreset(f.ctx); const agent = f.ctx.live.get(f.sessionId); const native = f.ctx.sessionController.prompt; const observed = [];
  f.ctx.sessionController.prompt = request => {
    observed.push({ catalog: f.runtime.store.catalog(f.sessionId), preset: f.ctx.promptSections.get('code-reading-tutor').text({ agent }) });
    return native(request);
  };
  await f.runtime.dispatch('prompt', promptRequest(f, { readingMode: 'code' }));
  assert.equal(observed[0].catalog.readingMode, 'code'); assert.equal(observed[0].catalog.revision, 1); assert.match(observed[0].preset, /"readingMode": "code"/); assert.match(observed[0].preset, /本轮明确意图优先/);
  const file = path.join(f.runtime.store.sessionDir(f.sessionId), 'state.json'); assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).readingMode, 'code');
  agent.status = 'idle'; await f.runtime.dispatch('prompt', promptRequest(f)); assert.equal(observed[1].catalog.readingMode, 'code'); assert.equal(observed[1].catalog.readingModeRevision, 1);
  agent.status = 'idle'; await f.runtime.dispatch('prompt', promptRequest(f, { readingMode: 'question' })); assert.equal(observed[2].catalog.readingMode, 'question'); assert.equal(observed[2].catalog.readingModeRevision, 2);
  assert.equal(f.runtime.store.session(f.sessionId).stage, 'discover'); assert.equal(f.runtime.store.session(f.sessionId).revision, 1);
  const restored = await new ReadingStore(f.dataDir).init(); assert.equal(restored.session(f.sessionId).readingMode, 'question');
});

for (const readingMode of [undefined, 'question']) {
  test(`选区始终覆盖 ${String(readingMode)} 入口为 code，保留原始选区安全边界`, async t => {
    const f = await nativeFixture(t); const selection = await entrySelection(f); const before = await fs.readFile(path.join(f.repo, 'entry.ts')); let mode;
    const native = f.ctx.sessionController.prompt; f.ctx.sessionController.prompt = request => { mode = f.runtime.store.catalog(f.sessionId).readingMode; return native(request); };
    await f.runtime.dispatch('prompt', promptRequest(f, { selection, ...(readingMode ? { readingMode } : {}) }));
    assert.equal(mode, 'code'); assert.equal(f.runtime.store.session(f.sessionId).readingMode, 'code'); assert.equal(f.runtime.store.session(f.sessionId).evidence.length, 1);
    const text = f.ctx.calls[0].content[0].text; assert.match(text, /不可信仓库内容/); assert.match(text, /调用方\/被调用方/); assert.match(text, /业务上下文与实现逻辑/); assert.match(text, /无关的全仓业务发现/); assert.match(text, /用户明确要求/);
    assert.deepEqual(await fs.readFile(path.join(f.repo, 'entry.ts')), before);
  });
}

test('已接纳 ID 的重试先于模式和选区副作用，即使旧模型/revision 已失配', async t => {
  const f = await nativeFixture(t); const request = promptRequest(f, { readingMode: 'code', selection: await entrySelection(f) }); const agent = f.ctx.live.get(f.sessionId);
  await f.runtime.dispatch('prompt', request); agent.inbox = { nextTurn: [{ source: { kind: 'user', rpcId: request.requestId } }], nextStep: [] };
  await f.runtime.store.updateReadingMode(f.sessionId, 'question'); await f.runtime.store.changeStage({ sessionId: f.sessionId, expectedRevision: 1, stage: 'business' });
  f.ctx.defaultModel = { provider: 'local', model: 'changed' }; await fs.writeFile(path.join(f.repo, 'entry.ts'), 'selection is now stale');
  const state = structuredClone(f.runtime.store.session(f.sessionId)); const response = await f.runtime.dispatch('prompt', request);
  assert.equal(response.replayed, true); assert.equal(f.ctx.calls.length, 1); assert.deepEqual(f.runtime.store.session(f.sessionId), state);
});

test('同时提交不同模式由准入锁串行化，被 busy 拒绝的提问不覆盖已入队模式', async t => {
  const f = await nativeFixture(t); const results = await Promise.allSettled([f.runtime.dispatch('prompt', promptRequest(f, { readingMode: 'code' })), f.runtime.dispatch('prompt', promptRequest(f, { readingMode: 'question' }))]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'AGENT_BUSY'); assert.equal(f.ctx.calls.length, 1); assert.equal(f.runtime.store.session(f.sessionId).readingMode, 'code');
});

for (const change of ['cancel', 'busy', 'model', 'revision', 'disable', 'abort']) {
  test(`模式异步提交后的最终检查仍拒绝 ${change}，不迟到 enqueue`, async t => {
    const f = await nativeFixture(t); const entered = deferred(); const release = deferred(); const original = f.ctx.sessionController.inspect; let inspections = 0;
    f.ctx.sessionController.inspect = async id => { if (++inspections === 2) { entered.resolve(); await release.promise; } return original(id); };
    const controller = new AbortController(); const pending = f.runtime.dispatch('prompt', promptRequest(f, { readingMode: 'code' }), controller.signal);
    const code = { cancel: 'PROMPT_CANCELLED', busy: 'AGENT_BUSY', model: 'MODEL_CHANGED', revision: 'STALE_REVISION', disable: 'READING_UNAVAILABLE' }[change];
    const refused = assert.rejects(pending, code ? { code } : { name: 'AbortError' }); await entered.promise;
    assert.equal(f.runtime.store.catalog(f.sessionId).readingMode, 'code');
    if (change === 'cancel') await f.runtime.dispatch('cancel', { sessionId: f.sessionId });
    if (change === 'busy') f.ctx.live.get(f.sessionId).status = 'running';
    if (change === 'model') f.ctx.defaultModel = { provider: 'local', model: 'changed-after-save' };
    if (change === 'revision') await f.runtime.store.changeStage({ sessionId: f.sessionId, expectedRevision: 1, stage: 'business' });
    if (change === 'disable') await f.ctx.dispose();
    if (change === 'abort') controller.abort();
    release.resolve(); await refused; assert.equal(f.ctx.calls.length, 0);
  });
}

test('mode state 临时文件 fsync 期间 cancel，最终原子提交守卫保留原模式且不入队', async t => {
  const f = await nativeFixture(t); const file = path.join(f.runtime.store.sessionDir(f.sessionId), 'state.json'); const before = await fs.readFile(file, 'utf8'); const open = fs.open; let observed = false;
  fs.open = async (...args) => { const handle = await open(...args); if (String(args[0]).startsWith(file + '.') && String(args[0]).endsWith('.tmp')) { const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); observed = true; await f.runtime.dispatch('cancel', { sessionId: f.sessionId }); }; } return handle; };
  try { await assert.rejects(f.runtime.dispatch('prompt', promptRequest(f, { readingMode: 'code' })), { code: 'PROMPT_CANCELLED' }); } finally { fs.open = open; }
  assert.equal(observed, true); assert.equal(f.ctx.calls.length, 0); assert.equal(f.runtime.store.session(f.sessionId).readingMode, 'question'); assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('逻辑图本轮意图先于原生 enqueue 可见，选区强制 code，下一轮遗漏 intent 恢复 explain', async t => {
  const f = await nativeFixture(t); applyPreset(f.ctx); const agent = f.ctx.live.get(f.sessionId); const native = f.ctx.sessionController.prompt; const seen = [];
  f.ctx.sessionController.prompt = args => { seen.push({ catalog: f.runtime.store.catalog(f.sessionId), preset: f.ctx.promptSections.get('code-reading-tutor').text({ agent }) }); return native(args); };
  await f.runtime.dispatch('prompt', promptRequest(f, { intent: 'logic-graph', readingMode: 'question', selection: await entrySelection(f) }));
  assert.equal(seen[0].catalog.intent, 'logic-graph'); assert.equal(seen[0].catalog.readingMode, 'code'); assert.equal(seen[0].catalog.revision, 1); assert.match(seen[0].preset, /"intent": "logic-graph"/);
  const canonical = await entrySelection(f); const { quote, ...focus } = canonical; assert.deepEqual(seen[0].catalog.readingFocus, focus); assert.equal(Object.hasOwn(seen[0].catalog.readingFocus, 'quote'), false);
  const text = f.ctx.calls[0].content[0].text; assert.match(text, /不可信仓库内容/); assert.match(text, /本轮明确 intent 为 logic-graph/); assert.match(text, /分支、异常与返回/); assert.match(text, /不宣称 AST/);
  const file = path.join(f.runtime.store.sessionDir(f.sessionId), 'state.json'); assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).intent, 'logic-graph');
  agent.status = 'idle'; await f.runtime.dispatch('prompt', promptRequest(f)); assert.equal(seen[1].catalog.intent, 'explain'); assert.equal(seen[1].catalog.readingMode, 'code'); assert.equal(seen[1].catalog.readingModeRevision, 1); assert.equal(seen[1].catalog.readingFocus, null);
  const restored = await new ReadingStore(f.dataDir).init(); assert.equal(restored.session(f.sessionId).intent, 'explain'); assert.equal(restored.session(f.sessionId).revision, 1);
});

test('逻辑图拒绝缺失、伪造、过期与越界选区，不改变意图或创建证据/模型请求', async t => {
  const f = await nativeFixture(t); const selection = await entrySelection(f);
  for (const invalid of [undefined, { ...selection, quote: 'forged selection' }, { ...selection, fileHash: 'a'.repeat(64) }, { ...selection, end: selection.start }]) {
    await assert.rejects(f.runtime.dispatch('prompt', promptRequest(f, { intent: 'logic-graph', ...(invalid ? { selection: invalid } : {}) })));
    assert.equal(f.runtime.store.session(f.sessionId).evidence.length, 0); assert.equal(f.runtime.store.catalog(f.sessionId).intent, 'explain'); assert.equal(f.runtime.store.catalog(f.sessionId).readingMode, 'question'); assert.equal(f.ctx.calls.length, 0);
  }
});

test('已接纳逻辑图 requestId 重试不会重新取证或重置更新后的意图', async t => {
  const f = await nativeFixture(t); const request = promptRequest(f, { intent: 'logic-graph', selection: await entrySelection(f) }); await f.runtime.dispatch('prompt', request);
  f.ctx.live.get(f.sessionId).inbox = { nextTurn: [], nextStep: [{ source: { kind: 'user', rpcId: request.requestId } }] };
  await f.runtime.store.updateReadingMode(f.sessionId, undefined, undefined, 'explain'); await fs.writeFile(path.join(f.repo, 'entry.ts'), 'changed after admission'); const before = structuredClone(f.runtime.store.session(f.sessionId));
  const replay = await f.runtime.dispatch('prompt', request); assert.equal(replay.replayed, true); assert.equal(f.ctx.calls.length, 1); assert.deepEqual(f.runtime.store.session(f.sessionId), before);
});

test('运行中保存 activeDocument 仍只写位置元数据，不调用模型或改变阶段/本轮意图', async t => {
  const f = await nativeFixture(t); f.ctx.live.get(f.sessionId).status = 'running';
  for (const [expectedRevision, activeDocument] of [[0, 'source'], [1, 'reading'], [2, null]]) {
    const saved = await f.runtime.dispatch('reader-state', { sessionId: f.sessionId, expectedRevision, patch: { activeDocument } }); assert.equal(saved.activeDocument, activeDocument); assert.equal(saved.revision, expectedRevision + 1);
  }
  assert.equal(f.ctx.calls.length, 0); assert.equal(f.runtime.store.session(f.sessionId).revision, 1); assert.equal(f.runtime.store.session(f.sessionId).intent, 'explain');
});

for (const change of ['cancel', 'busy', 'model', 'revision', 'disable', 'abort']) {
  test(`逻辑图异步取证与上下文保存后仍检查 ${change}，不迟到入队`, async t => {
    const f = await nativeFixture(t); const selection = await entrySelection(f); const entered = deferred(); const release = deferred(); const inspect = f.ctx.sessionController.inspect; let inspections = 0;
    f.ctx.sessionController.inspect = async id => { if (++inspections === 2) { entered.resolve(); await release.promise; } return inspect(id); };
    const controller = new AbortController(); const pending = f.runtime.dispatch('prompt', promptRequest(f, { intent: 'logic-graph', selection }), controller.signal);
    const code = { cancel: 'PROMPT_CANCELLED', busy: 'AGENT_BUSY', model: 'MODEL_CHANGED', revision: 'STALE_REVISION', disable: 'READING_UNAVAILABLE' }[change]; const refused = assert.rejects(pending, code ? { code } : { name: 'AbortError' }); await entered.promise;
    assert.equal(f.runtime.store.catalog(f.sessionId).intent, 'logic-graph');
    if (change === 'cancel') await f.runtime.dispatch('cancel', { sessionId: f.sessionId });
    if (change === 'busy') f.ctx.live.get(f.sessionId).status = 'running';
    if (change === 'model') f.ctx.defaultModel = { provider: 'local', model: 'changed-after-graph-save' };
    if (change === 'revision') await f.runtime.store.changeStage({ sessionId: f.sessionId, expectedRevision: 1, stage: 'business' });
    if (change === 'disable') await f.ctx.dispose(); if (change === 'abort') controller.abort();
    release.resolve(); await refused; assert.equal(f.ctx.calls.length, 0); assert.equal(f.runtime.store.session(f.sessionId).lessons.length, 0);
  });
}

test('逻辑图元数据临时文件 fsync 期间取消，最终守卫不提交新模式/意图', async t => {
  const f = await nativeFixture(t); const file = path.join(f.runtime.store.sessionDir(f.sessionId), 'state.json'); const open = fs.open; const audit = f.runtime.store.audit.bind(f.runtime.store); let savingContext = false; let observed = false;
  f.runtime.store.audit = async (...args) => { await audit(...args); if (args[1] === 'reading-mode-save-attempt') savingContext = true; };
  fs.open = async (...args) => { const handle = await open(...args); if (savingContext && String(args[0]).startsWith(file + '.') && String(args[0]).endsWith('.tmp')) { const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); observed = true; await f.runtime.dispatch('cancel', { sessionId: f.sessionId }); }; } return handle; };
  try { await assert.rejects(f.runtime.dispatch('prompt', promptRequest(f, { intent: 'logic-graph', selection: await entrySelection(f) })), { code: 'PROMPT_CANCELLED' }); } finally { fs.open = open; }
  const state = f.runtime.store.session(f.sessionId); assert.equal(observed, true); assert.equal(f.ctx.calls.length, 0); assert.equal(state.intent, 'explain'); assert.equal(state.readingMode, 'question'); assert.equal(state.readingModeRevision, 0); assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).intent, 'explain');
});

test('原生 reading_publish 在逻辑图缺失时不结束轮次，补图后归档并结束且工具权限不变', async t => {
  const f = await nativeFixture(t); applyPreset(f.ctx); await f.runtime.dispatch('prompt', promptRequest(f, { intent: 'logic-graph', selection: await entrySelection(f) })); const agent = f.ctx.live.get(f.sessionId);
  const evidence = f.runtime.store.session(f.sessionId).evidence[0]; const evidenceId = evidence.id; const args = { expectedRevision: 1, title: '选区逻辑图', markdown: '以已核验选区解释返回值。', conclusion: '入口返回 42。', claims: [{ kind: 'fact', text: '常量为 42', evidenceIds: [evidenceId] }], nextQuestions: ['需要继续看调用方吗？'], codeUnits: [entryUnit(evidence)] };
  let ended = 0; const exec = { agent, callId: 'graph-publish', concludeTurn() { ended++; } }; const publish = f.ctx.definitions.get('reading_publish');
  await assert.rejects(publish.execute(args, exec), { code: 'GRAPH_REQUIRED' }); assert.equal(ended, 0); assert.equal(f.runtime.store.session(f.sessionId).lessons.length, 0);
  await publish.execute({ ...args, mermaid: 'flowchart TD\n A[entry] --> B[return 42]' }, exec); assert.equal(ended, 1); assert.equal(f.runtime.store.session(f.sessionId).lessons[0].intent, 'logic-graph');
  assert.deepEqual([...f.ctx.definitions.keys()].sort(), ['reading_catalog', 'reading_files', 'reading_publish', 'reading_read', 'reading_search']);
});

test('模式审计或原子保存失败时不调用原生 prompt，后续明确重试可以继续', async t => {
  const f = await nativeFixture(t); const audit = f.runtime.store.audit.bind(f.runtime.store); const args = promptRequest(f, { readingMode: 'code' });
  f.runtime.store.audit = async (...values) => { if (values[1] === 'reading-mode-save-attempt') throw new Error('mode audit unavailable'); return audit(...values); };
  await assert.rejects(f.runtime.dispatch('prompt', args), /mode audit unavailable/); assert.equal(f.ctx.calls.length, 0); assert.equal(f.runtime.store.session(f.sessionId).readingMode, 'question');
  f.runtime.store.audit = audit; const save = f.runtime.store.saveState.bind(f.runtime.store);
  f.runtime.store.saveState = async () => { throw new Error('mode commit unavailable'); };
  await assert.rejects(f.runtime.dispatch('prompt', args), /mode commit unavailable/); assert.equal(f.ctx.calls.length, 0); assert.equal(f.runtime.store.session(f.sessionId).readingMode, 'question');
  f.runtime.store.saveState = save; await f.runtime.dispatch('prompt', args); assert.equal(f.ctx.calls.length, 1); assert.equal(f.runtime.store.session(f.sessionId).readingMode, 'code');
});

test('仓库移除端点只逻辑移除，旧页面与保留工具不能继续取证，也不删除 native 会话', async t => {
  const f = await nativeFixture(t); applyPreset(f.ctx); const file = path.join(f.runtime.store.sessionDir(f.sessionId), 'state.json'); const before = await fs.readFile(file); const source = await fs.readFile(path.join(f.repo, 'entry.ts')); const agent = f.ctx.live.get(f.sessionId);
  const response = await f.ctx.route.fetch(new Request('http://localhost/api/code-reading', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'remove-project', params: { projectId: f.project.id, expectedBindingRevision: 1 } }) }));
  assert.equal(response.status, 200); const envelope = await response.json(); assert.equal(envelope.ok, true); const result = envelope.value; assert.equal(result.projectId, f.project.id); assert.deepEqual((await f.runtime.dispatch('list', {})).projects, []);
  for (const [method, params] of [['snapshot', { sessionId: f.sessionId }], ['view-file', { sessionId: f.sessionId, repoId: f.project.repositories[0].id, path: 'entry.ts' }], ['prompt', promptRequest(f)]]) await assert.rejects(f.runtime.dispatch(method, params), { code: 'PROJECT_REMOVED' });
  await assert.rejects(f.ctx.definitions.get('reading_catalog').execute({}, { agent }), { code: 'PROJECT_REMOVED' }); assert.ok(f.ctx.guards.some(check => check({ agent, name: 'write' })));
  assert.equal(f.ctx.live.get(f.sessionId), agent); assert.equal(f.ctx.calls.length, 0); assert.deepEqual(await fs.readFile(file), before); assert.deepEqual(await fs.readFile(path.join(f.repo, 'entry.ts')), source);
});

test('项目地图通过认证路由复用草稿绑定，索引和文件核验不生成阅读证据或模型请求', async t => {
  const f = await nativeFixture(t); applyPreset(f.ctx); const { sessionId } = await f.runtime.dispatch('create-session', { projectId: f.project.id, draft: true });
  const params = { sessionId, repoId: f.project.repositories[0].id }; const before = f.runtime.store.list();
  const response = await f.ctx.route.fetch(new Request('http://localhost/api/code-reading', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'structure-map', params }) }));
  assert.equal(response.status, 200); const envelope = await response.json(); assert.equal(envelope.ok, true); assert.equal(envelope.value.revision, 0); assert.equal(envelope.value.indexedAt, null); assert.deepEqual(envelope.value.files, []);
  const indexed = await f.runtime.dispatch('structure-map-refresh', { ...params, expectedRevision: 0 });
  assert.equal(indexed.revision, 1); assert.equal(indexed.projectId, f.project.id); assert.equal(indexed.repoId, params.repoId); assert.ok(indexed.files.some(file => file.path === 'entry.ts'));
  const detail = await f.runtime.dispatch('structure-map-file', { ...params, path: 'entry.ts' });
  assert.equal(detail.path, 'entry.ts'); assert.equal(detail.hash, digest(await fs.readFile(path.join(f.repo, 'entry.ts')))); assert.deepEqual(detail.codeReadings.items, []); assert.equal(Object.hasOwn(detail, 'lines'), false);
  assert.equal(f.runtime.store.session(sessionId).draft, true); assert.equal(f.runtime.store.session(sessionId).evidence.length, 0); assert.deepEqual(f.runtime.store.list(), before); assert.equal(f.ctx.calls.length, 0);
  assert.deepEqual([...f.ctx.definitions.keys()].sort(), ['reading_catalog', 'reading_files', 'reading_publish', 'reading_read', 'reading_search']);
  const agent = f.ctx.live.get(f.sessionId); assert.ok(f.ctx.guards.some(check => check({ agent, name: 'structure-map-refresh' })), 'page operations never become Agent tools');
  await assert.rejects(f.runtime.dispatch('structure-map-refresh', { ...params, expectedRevision: 0 }), { code: 'STALE_STRUCTURE_MAP' });
  await assert.rejects(fs.stat(path.join(f.runtime.store.sessionDir(sessionId), 'state.json')), { code: 'ENOENT' });
});

test('项目地图写入等待期间停用 Host 不提交迟到索引，保留方法也拒绝执行', async t => {
  const f = await nativeFixture(t); const params = { sessionId: f.sessionId, repoId: f.project.repositories[0].id }; const entered = deferred(); const release = deferred(); const original = f.runtime.store.writable.bind(f.runtime.store); let held = true;
  f.runtime.store.writable = async (...args) => { if (held) { held = false; entered.resolve(); await release.promise; } return original(...args); };
  const pending = f.runtime.dispatch('structure-map-refresh', { ...params, expectedRevision: 0 }); const rejected = assert.rejects(pending, { code: 'READING_UNAVAILABLE' }); await entered.promise; await f.ctx.dispose(); release.resolve(); await rejected;
  for (const method of ['structure-map', 'structure-map-refresh', 'structure-map-layers', 'structure-map-file']) await assert.rejects(f.runtime.dispatch(method, params), { code: 'READING_UNAVAILABLE' });
  await applyHost(f.ctx, { dataDir: f.dataDir }); assert.equal((await getRuntime(f.ctx.root).dispatch('structure-map', params)).revision, 0); assert.equal(f.ctx.calls.length, 0);
});

test('任一同项目会话运行中拒绝移除，prompt异步准入与移除串行不死锁', async t => {
  const f = await nativeFixture(t); const other = await f.runtime.dispatch('create-session', { projectId: f.project.id }); const params = { projectId: f.project.id, expectedBindingRevision: 1 };
  f.ctx.live.get(other.sessionId).status = 'running'; await assert.rejects(f.runtime.dispatch('remove-project', params), { code: 'AGENT_BUSY' }); f.ctx.live.get(other.sessionId).status = 'idle';
  const entered = deferred(); const release = deferred(); const inspect = f.ctx.sessionController.inspect;
  f.ctx.sessionController.inspect = async id => { entered.resolve(); await release.promise; return inspect(id); };
  const admitted = f.runtime.dispatch('prompt', promptRequest(f)); await entered.promise;
  const removal = f.runtime.dispatch('remove-project', params); const refused = assert.rejects(removal, { code: 'AGENT_BUSY' }); release.resolve(); await admitted; await refused;
  assert.equal(f.ctx.calls.length, 1); assert.equal((await f.runtime.dispatch('list', {})).projects.length, 1);
});

async function mapFixture(t) {
  const f = await nativeFixture(t); applyPreset(f.ctx);
  f.ctx.sessionController.modelCatalog = async () => ({ groups: [{ id: 'private', models: [{ id: 'map-reader' }] }] });
  f.mapModel = { provider: 'private', model: 'map-reader' }; return f;
}
const mapRequest = (f, revision = 0) => ({ projectId: f.project.id, expectedRevision: revision, requestId: randomUUID(), model: f.mapModel, consent: true });
async function publishMap(f, task, title = '仓库代码地图') {
  const agent = f.ctx.live.get(task.sessionId); agent.session.append('turn/start', { turn: 1 }); agent.session.append('step/start', { step: 1 });
  const { evidence } = await f.runtime.store.read(task.sessionId, { repoId: f.project.repositories[0].id, path: 'entry.ts' });
  await f.ctx.definitions.get('reading_publish').execute({ expectedRevision: f.runtime.store.session(task.sessionId).revision, title, markdown: '## 入口\nentry.ts 导出常量；后续先读入口再查引用。', conclusion: '入口是 entry.ts。', claims: [{ kind: 'fact', text: '入口导出常量', evidenceIds: [evidence.id] }], nextQuestions: ['谁读取常量？'], codeUnits: [entryUnit(evidence)] }, { agent, callId: randomUUID(), concludeTurn() {} });
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }); agent.status = 'idle';
  return f.runtime.dispatch('code-map', { projectId: f.project.id });
}

test('首次仓库带引导标记，未授权只检测本地变化不建任务或调用模型', async t => {
  const f = await mapFixture(t); assert.equal(f.project.codeMapOnboarding, true); const before = f.runtime.store.sessions.size;
  const empty = await f.runtime.dispatch('code-map', { projectId: f.project.id }); assert.equal(empty.latest, null); assert.equal(empty.task, null); assert.equal(empty.revision, 0);
  const checked = await f.runtime.dispatch('code-map-check', { projectId: f.project.id }); assert.equal(checked.changes.added[0].path, 'entry.ts'); assert.equal(checked.revision, 0);
  await assert.rejects(f.runtime.dispatch('code-map-generate', { ...mapRequest(f), consent: false }));
  await assert.rejects(f.runtime.dispatch('code-map-generate', { ...mapRequest(f), model: { provider: 'wrong', model: 'unknown' } }), { code: 'DEFAULT_MODEL_UNAVAILABLE' });
  assert.equal(f.runtime.store.sessions.size, before); assert.equal(f.ctx.calls.length, 0);
});

test('授权后自动入队原生地图任务，模型局部固定且同请求不会重复调用', async t => {
  const f = await mapFixture(t); const args = mapRequest(f); const source = await fs.readFile(path.join(f.repo, 'entry.ts'));
  const result = await f.runtime.dispatch('code-map-generate', args); assert.equal(result.task.status, 'running'); assert.equal(result.task.mode, 'initial'); assert.equal(result.latest, null);
  const state = f.runtime.store.session(result.task.sessionId); assert.equal(state.modelSelectionManaged, true); assert.equal(state.codeMapTask.requestId, args.requestId); assert.equal(state.draft, false);
  assert.equal(f.ctx.calls.length, 1); assert.match(f.ctx.calls[0].content[0].text, /代码地图/); assert.match(f.ctx.calls[0].content[0].text, /不可信/);
  assert.deepEqual(f.ctx.defaultModel, { provider: 'remote', model: 'reader' }); assert.deepEqual((await f.runtime.dispatch('snapshot', { sessionId: state.id })).modelSelection, f.mapModel);
  await f.runtime.dispatch('code-map-generate', args); assert.equal(f.ctx.calls.length, 1); assert.equal(f.ctx.definitions.size, 5);
  const ready = await publishMap(f, result.task); assert.equal(ready.task.status, 'completed'); assert.equal(ready.latest.title, '仓库代码地图'); assert.equal(ready.latest.truncated, false);
  await f.runtime.dispatch('code-map-generate', args); assert.equal(f.ctx.calls.length, 1); assert.deepEqual(await fs.readFile(path.join(f.repo, 'entry.ts')), source);
});

test('地图成为后续阅读目录上下文，普通提问重读核验而不复用跨会话证据', async t => {
  const f = await mapFixture(t); const running = await f.runtime.dispatch('code-map-generate', mapRequest(f)); await publishMap(f, running.task);
  await f.runtime.dispatch('prompt', promptRequest(f)); const catalog = await f.ctx.definitions.get('reading_catalog').execute({}, { agent: f.ctx.live.get(f.sessionId) });
  assert.equal(catalog.codeMap.title, '仓库代码地图'); assert.match(catalog.codeMap.note, /不是当前代码证据/); assert.match(catalog.codeMap.note, /不沿用跨会话证据/);
  assert.match(f.ctx.promptSections.get('code-reading-tutor').text({ agent: f.ctx.live.get(f.sessionId) }), /仓库代码地图/);
  const restoredCtx = hostContext(); await applyHost(restoredCtx, { dataDir: f.dataDir });
  const restored = await getRuntime(restoredCtx.root).dispatch('code-map', { projectId: f.project.id }); assert.equal(restored.latest.title, '仓库代码地图'); assert.equal(restoredCtx.calls.length, 0);
});

test('同路径源码变化只提示增量；明确允许后沿旧地图和差异更新，完成前保留旧图', async t => {
  const f = await mapFixture(t); const running = await f.runtime.dispatch('code-map-generate', mapRequest(f)); const original = await publishMap(f, running.task);
  await fs.writeFile(path.join(f.repo, 'entry.ts'), 'export const answer = 43;\n'); await fs.writeFile(path.join(f.repo, 'new.md'), '# 新文档\n');
  const changed = await f.runtime.dispatch('code-map-check', { projectId: f.project.id });
  assert.deepEqual(changed.changes.modified.map(row => row.path), ['entry.ts']); assert.deepEqual(changed.changes.added.map(row => row.path), ['new.md']); assert.equal(f.ctx.calls.length, 1);
  const incremental = await f.runtime.dispatch('code-map-generate', mapRequest(f, changed.revision)); assert.equal(incremental.task.mode, 'incremental'); assert.equal(incremental.latest.lessonId, original.latest.lessonId);
  assert.match(f.ctx.calls[1].content[0].text, /优先只读新增、修改/); assert.match(f.ctx.calls[1].content[0].text, /previousMap/); assert.match(f.ctx.calls[1].content[0].text, /new.md/);
  const updated = await publishMap(f, incremental.task, '更新后的代码地图'); assert.notEqual(updated.latest.lessonId, original.latest.lessonId);
  await fs.unlink(path.join(f.repo, 'new.md')); const deleted = await f.runtime.dispatch('code-map-check', { projectId: f.project.id }); assert.equal(deleted.changes.deleted[0].path, 'new.md');
  assert.equal(f.ctx.calls.length, 2);
});

test('模型失败、取消和重启中断不覆盖已有地图，也不自动重试任务', async t => {
  const f = await mapFixture(t); const running = await f.runtime.dispatch('code-map-generate', mapRequest(f)); const ready = await publishMap(f, running.task);
  const next = await f.runtime.dispatch('code-map-generate', mapRequest(f, ready.revision)); const agent = f.ctx.live.get(next.task.sessionId);
  agent.status = 'idle'; agent.session.append('turn/end', { reason: { kind: 'error' } });
  const failed = await f.runtime.dispatch('code-map', { projectId: f.project.id }); assert.equal(failed.task.status, 'failed'); assert.equal(failed.latest.lessonId, ready.latest.lessonId);
  const retry = await f.runtime.dispatch('code-map-generate', mapRequest(f, failed.revision)); const stopped = await f.runtime.dispatch('code-map-cancel', { projectId: f.project.id, requestId: retry.task.requestId });
  assert.equal(stopped.task.status, 'cancelled'); assert.equal(stopped.latest.lessonId, ready.latest.lessonId);
  await assert.rejects(publishMap(f, retry.task), { code: 'PROMPT_CANCELLED' });
  const last = await f.runtime.dispatch('code-map-generate', mapRequest(f, stopped.revision)); assert.equal(last.task.status, 'running');
  const restarted = hostContext(); await applyHost(restarted, { dataDir: f.dataDir }); const recovered = await getRuntime(restarted.root).dispatch('code-map', { projectId: f.project.id });
  assert.equal(recovered.task.status, 'failed'); assert.equal(recovered.latest.lessonId, ready.latest.lessonId); assert.equal(restarted.calls.length, 0);
});

test('地图网络结果未知时只核对原任务，不盲目重新发送', async t => {
  const f = await mapFixture(t); const original = f.ctx.sessionController.prompt; const args = mapRequest(f);
  f.ctx.sessionController.prompt = async request => { await original(request); throw new Error('模拟确认丢失'); };
  await assert.rejects(f.runtime.dispatch('code-map-generate', args), /确认丢失/); const state = await f.runtime.dispatch('code-map', { projectId: f.project.id }); assert.equal(state.task.status, 'running');
  await f.runtime.dispatch('code-map-generate', args); assert.equal(f.ctx.calls.length, 1);
});

test('同项目并发生成只准入一次，晚到旧revision不能触发新任务', async t => {
  const f = await mapFixture(t); const results = await Promise.allSettled([f.runtime.dispatch('code-map-generate', mapRequest(f)), f.runtime.dispatch('code-map-generate', mapRequest(f))]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.find(row => row.status === 'rejected').reason.code, 'STALE_CODE_MAP'); assert.equal(f.ctx.calls.length, 1);
});

for (const action of ['cancel', 'disable', 'abort']) test(`地图等待模型目录期间${action}不会迟到发送源码`, async t => {
  const f = await mapFixture(t); const args = mapRequest(f); const entered = deferred(); const release = deferred(); const catalog = f.ctx.sessionController.modelCatalog;
  f.ctx.sessionController.modelCatalog = async () => { entered.resolve(); await release.promise; return catalog(); };
  const controller = new AbortController(); const generating = f.runtime.dispatch('code-map-generate', args, controller.signal);
  const rejected = assert.rejects(generating, action === 'abort' ? { name: 'AbortError' } : { code: action === 'disable' ? 'READING_UNAVAILABLE' : 'PROMPT_CANCELLED' }); await entered.promise;
  let cancelling;
  if (action === 'cancel') cancelling = f.runtime.dispatch('code-map-cancel', { projectId: f.project.id, requestId: args.requestId }).catch(error => { assert.equal(error.code, 'CODE_MAP_TASK_CHANGED'); });
  if (action === 'disable') await f.ctx.dispose();
  if (action === 'abort') controller.abort();
  release.resolve(); await rejected; await cancelling; assert.equal(f.ctx.calls.length, 0);
});

test('地图取消按项目隔离，相同requestId不会阻止另一个项目生成', async t => {
  const f = await mapFixture(t); const second = await f.runtime.dispatch('create-project', { repositories: [{ path: f.repo }] }); const requestId = randomUUID();
  const first = await f.runtime.dispatch('code-map-generate', { ...mapRequest(f), requestId });
  await f.runtime.dispatch('code-map-cancel', { projectId: f.project.id, requestId });
  const other = await f.runtime.dispatch('code-map-generate', { ...mapRequest(f), projectId: second.id, requestId });
  assert.equal(other.task.status, 'running'); assert.notEqual(other.task.sessionId, first.task.sessionId); assert.equal(f.ctx.calls.length, 2);
});

test('地图首轮只能由内部授权任务入队，同UUID伪造普通prompt也不能抢占', async t => {
  const f = await mapFixture(t); const args = mapRequest(f); const entered = deferred(); const release = deferred(); const create = f.ctx.sessionController.create;
  f.ctx.sessionController.create = async value => { const result = await create(value); entered.resolve(value.sessionId); await release.promise; return result; };
  const generating = f.runtime.dispatch('code-map-generate', args); const sessionId = await entered.promise;
  for (const requestId of [randomUUID(), args.requestId]) await assert.rejects(f.runtime.dispatch('prompt', { sessionId, requestId, text: '普通问题不能冒充代码地图', expectedRevision: 2, expectedModel: f.mapModel }), { code: 'CODE_MAP_TASK_RESERVED' });
  assert.equal(f.ctx.calls.length, 0); release.resolve(); const running = await generating; const ready = await publishMap(f, running.task);
  await f.runtime.dispatch('prompt', { sessionId, requestId: randomUUID(), text: '地图完成后正常追问', expectedRevision: 2, expectedModel: f.mapModel });
  assert.equal(ready.task.status, 'completed'); assert.equal(f.ctx.calls.length, 2);
});

test('只有待核对的变化将地图上下文标为未知且部分扫描，而不是无变化', async t => {
  const f = await mapFixture(t); const running = await f.runtime.dispatch('code-map-generate', mapRequest(f)); await publishMap(f, running.task);
  await fs.writeFile(path.join(f.repo, 'entry.ts'), Buffer.from([0, 1, 2])); const checked = await f.runtime.dispatch('code-map-check', { projectId: f.project.id });
  assert.equal(checked.changes.changed, false); assert.equal(checked.changes.uncertain.length, 1);
  const catalog = await f.ctx.definitions.get('reading_catalog').execute({}, { agent: f.ctx.live.get(f.sessionId) }); assert.equal(catalog.codeMap.stale, null); assert.equal(catalog.codeMap.partial, true);
});

test('已停止地图任务在发布原子提交期间取消也不能写入完成状态', async t => {
  const f = await mapFixture(t); const running = await f.runtime.dispatch('code-map-generate', mapRequest(f)); const entered = deferred(); const release = deferred(); const original = f.runtime.store.audit.bind(f.runtime.store);
  f.runtime.store.audit = async (...args) => { if (args[1] === 'lesson-published') { entered.resolve(); await release.promise; } return original(...args); };
  const publishing = publishMap(f, running.task); const refused = assert.rejects(publishing, { code: 'PROMPT_CANCELLED' }); await entered.promise;
  const stopping = f.runtime.dispatch('code-map-cancel', { projectId: f.project.id, requestId: running.task.requestId });
  // Cancellation increments the native epoch without waiting for the store publication lock.
  const cancelledNative = deferred(); const nativeCancel = f.ctx.sessionController.cancel;
  f.ctx.sessionController.cancel = async args => { const result = await nativeCancel(args); cancelledNative.resolve(); return result; };
  await cancelledNative.promise; release.resolve(); await refused; const stopped = await stopping;
  assert.equal(stopped.latest, null); assert.equal(f.runtime.store.session(running.task.sessionId).lessons.length, 0);
});
