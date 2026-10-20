import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import * as host from '../src/index.mjs';
import { ReadingStore, getRuntime } from '../src/store.mjs';
import { SETTINGS_FILE } from '../src/preferences.mjs';
import { effectiveModelSelection } from '../src/contracts.mjs';
const requireSdk = createRequire(import.meta.resolve('@deepseek-ai/dsh-tools'));
const { Session } = await import(pathToFileURL(requireSdk.resolve('@deepseek-ai/dsh-session')).href);
const { installModelSelection, agentEvents } = await import(pathToFileURL(requireSdk.resolve('@deepseek-ai/dsh-agent')).href);
const base = path.resolve('.test-output');
const dsh = { provider: 'remote', model: 'reader' }, local = { provider: 'local', model: 'private' }, alternate = { provider: 'local', model: 'other' };
const save = (defaultModel, expectedRevision = 0) => ({ expectedRevision, defaultModel });
function context() {
  const listeners = new Map(), live = new Map(), effects = [];
  const ctx = { root: {}, live, effects, calls: [], nativeCalls: [], globalSaves: [], defaultModel: structuredClone(dsh), catalog: { groups: [{ id: 'remote', models: [{ id: 'reader' }] }, { id: 'local', models: [{ id: 'private' }, { id: 'other' }] }], failures: [] },
    logger: { warn() {} }, effect(factory) { const result = factory(); if (result?.then) result.then(dispose => { if (typeof dispose === 'function') effects.push(dispose); }); else if (typeof result === 'function') effects.push(result); return result; },
    on(name, callback) { const rows = listeners.get(name) ?? []; rows.push(callback); listeners.set(name, rows); const dispose = () => { const at = rows.indexOf(callback); if (at >= 0) rows.splice(at, 1); }; effects.push(dispose); return dispose; },
    get(name) { return this[name]; }, agents: { get: id => live.get(id) }, agentPresets: { composedPreset: value => value?.preset, register: async () => () => {} },
    tools: { guard: () => () => {} }, skills: { register: () => () => {} }, connection: { fetch: { register: () => () => {} } },
    agentDefaultModel: { currentSelection: () => structuredClone(ctx.defaultModel) }, sandboxPolicy: { overrideOf: session => session.snapshotEvents().findLast(event => event.type === 'sandbox/mode')?.data.mode }
  };
  ctx.sessionController = {
    async create({ sessionId, cwd, agentPreset }) {
      ctx.nativeCalls.push(['create', sessionId]);
      const session = Session.create(sessionId, undefined, { version: 4, id: sessionId, createdAt: Date.now(), isSeeded: false, cwd });
      const agent = { id: sessionId, session, ctx: { preset: agentPreset }, status: 'idle' }; live.set(sessionId, agent);
      for (const callback of listeners.get('agent/created') ?? []) await callback({ agent });
      return { sessionId };
    },
    async resolveAgent(id) { return live.has(id) ? { agent: live.get(id) } : { error: new Error('not found') }; },
    async inspect(id) { const agent = live.get(id); if (!agent) throw new Error('not found'); return { meta: { ...agent.session.header, title: agent.title }, events: agent.session.snapshotEvents() }; },
    async rename({ sessionId, title }) { live.get(sessionId).title = title; return { title }; },
    async selectModel(args) { ctx.globalSaves.push({ provider: args.provider, model: args.model }); ctx.defaultModel = { provider: args.provider, model: args.model }; live.get(args.sessionId).session.append('model/selection', ctx.defaultModel); return { selected: structuredClone(ctx.defaultModel) }; },
    async modelCatalog() { return structuredClone(ctx.catalog); },
    async prompt(args) { ctx.calls.push(args); return { accepted: true }; },
    async cancel() { return { cancelled: true }; }
  };
  ctx.dispose = async () => { for (const dispose of effects.splice(0).reverse()) await dispose(); };
  return ctx;
}
async function fixture(t) {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'default-model-')); const repo = path.join(root, 'repo'); await fs.mkdir(repo); await fs.writeFile(path.join(repo, 'entry.ts'), 'export const value = 1;\n');
  const ctx = context(); await host.apply(ctx, { dataDir: path.join(root, 'artifacts') }); const runtime = getRuntime(ctx.root), store = runtime.store;
  const project = await runtime.dispatch('create-project', { repositories: [{ path: repo }] });
  t.after(async () => { await ctx.dispose(); for (const pending of store.locks.values()) await pending.catch(() => {}); assert.equal(path.dirname(path.resolve(root)), base); assert.match(path.basename(root), /^default-model-/); await fs.rm(root, { recursive: true, force: true }); });
  return { root, repo, ctx, runtime, store, project, file: path.join(store.root, SETTINGS_FILE) };
}
const create = (f, draft = false) => f.runtime.dispatch('create-session', { projectId: f.project.id, draft });
const prompt = (sessionId, expectedModel) => ({ sessionId, requestId: randomUUID(), text: '解释入口', expectedRevision: 1, expectedModel });
test('设置API/capability：保存只改插件设置，旧会话/DSH默认不变且无模型请求', async t => {
  const f = await fixture(t); const caps = (await f.runtime.dispatch('status', {})).capabilities; assert.ok(caps.includes('remove-project')); assert.ok(caps.includes('default-model'));
  assert.deepEqual(await f.runtime.dispatch('reading-settings', {}), { revision: 0, defaultModel: null }); await assert.rejects(fs.access(f.file), { code: 'ENOENT' });
  const old = await create(f); const stateFile = path.join(f.store.sessionDir(old.sessionId), 'state.json'); const before = await fs.readFile(stateFile); const nativeBefore = f.ctx.live.get(old.sessionId).session.snapshotEvents();
  assert.deepEqual(await f.runtime.dispatch('set-default-model', save(local)), { revision: 1, defaultModel: local });
  assert.equal(f.store.sessions.size, 1); assert.deepEqual(await fs.readFile(stateFile), before); assert.deepEqual(f.ctx.live.get(old.sessionId).session.snapshotEvents(), nativeBefore);
  assert.deepEqual(f.ctx.defaultModel, dsh); assert.deepEqual(f.ctx.globalSaves, []); assert.deepEqual(f.ctx.calls, []);
  await assert.rejects(f.runtime.dispatch('reading-settings', { extra: true })); await assert.rejects(f.runtime.dispatch('set-default-model', save({ ...local, model: 'x\0y' }, 1)));
});
test('新非draft默认写入真实原生model/selection；改默认/清除不覆盖已有选择', async t => {
  const f = await fixture(t); await f.runtime.dispatch('set-default-model', save(local)); const reading = await create(f); const agent = f.ctx.live.get(reading.sessionId);
  assert.equal(f.store.session(reading.sessionId).modelSelectionManaged, true); assert.equal(f.store.session(reading.sessionId).nativePending, undefined);
  assert.deepEqual(effectiveModelSelection(agent.session.snapshotEvents()), local); assert.deepEqual((await f.runtime.dispatch('snapshot', { sessionId: reading.sessionId })).modelSelection, local);
  await f.runtime.dispatch('set-default-model', save(alternate, 1)); assert.deepEqual((await f.runtime.dispatch('snapshot', { sessionId: reading.sessionId })).modelSelection, local);
  await f.runtime.dispatch('set-default-model', save(null, 2)); const following = await create(f); assert.equal(f.store.session(following.sessionId).modelSelectionManaged, undefined);
  assert.deepEqual((await f.runtime.dispatch('snapshot', { sessionId: following.sessionId })).modelSelection, dsh); assert.deepEqual(f.ctx.defaultModel, dsh); assert.deepEqual(f.ctx.globalSaves, []); assert.deepEqual(f.ctx.calls, []);
});
test('draft不创建native；显式改选优先，首次prompt局部真实选中且不save全局', async t => {
  const f = await fixture(t); await f.runtime.dispatch('set-default-model', save(local)); const reading = await create(f, true);
  assert.equal(f.ctx.live.size, 0); assert.deepEqual((await f.runtime.dispatch('snapshot', { sessionId: reading.sessionId })).modelSelection, local);
  await f.runtime.dispatch('select-model', { sessionId: reading.sessionId, ...alternate }); await f.runtime.dispatch('set-default-model', save(null, 1));
  await f.runtime.dispatch('prompt', prompt(reading.sessionId, alternate)); assert.equal(f.ctx.calls.length, 1);
  assert.deepEqual(effectiveModelSelection(f.ctx.live.get(reading.sessionId).session.snapshotEvents()), alternate); assert.equal(f.store.session(reading.sessionId).draft, false);
  assert.deepEqual(f.ctx.globalSaves, []); assert.deepEqual(f.ctx.defaultModel, dsh);
});
test('managed手动改选不写全局；同模型裸选择可清除原生显式effort', async t => {
  const f = await fixture(t); await f.runtime.dispatch('set-default-model', save(local)); const reading = await create(f); const agent = f.ctx.live.get(reading.sessionId);
  agent.session.append('model/selection', { ...local, reasoningEffort: 'high' });
  await f.runtime.dispatch('select-model', { sessionId: reading.sessionId, ...local }); assert.deepEqual(effectiveModelSelection(agent.session.snapshotEvents()), local);
  await f.runtime.dispatch('select-model', { sessionId: reading.sessionId, ...alternate }); assert.deepEqual(effectiveModelSelection(agent.session.snapshotEvents()), alternate); assert.deepEqual(f.ctx.globalSaves, []);
});
test('不可用默认保存/新建/首轮均明确失败且不偷换模型', async t => {
  const f = await fixture(t); await assert.rejects(f.runtime.dispatch('set-default-model', save({ provider: 'missing', model: 'none' })), { code: 'DEFAULT_MODEL_UNAVAILABLE' });
  await assert.rejects(fs.access(f.file), { code: 'ENOENT' }); await f.runtime.dispatch('set-default-model', save(local)); const reading = await create(f, true); f.ctx.catalog.groups = [];
  const count = f.store.sessions.size; for (const draft of [true, false]) await assert.rejects(create(f, draft), { code: 'DEFAULT_MODEL_UNAVAILABLE' });
  await assert.rejects(f.runtime.dispatch('prompt', prompt(reading.sessionId, local)), { code: 'DEFAULT_MODEL_UNAVAILABLE' });
  assert.equal(f.store.sessions.size, count); assert.equal(f.ctx.live.size, 0); assert.equal(f.store.session(reading.sessionId).draft, true); assert.equal(f.ctx.calls.length, 0); assert.deepEqual(f.ctx.globalSaves, []);
  assert.deepEqual(await f.runtime.dispatch('set-default-model', save(null, 1)), { revision: 2, defaultModel: null });
});
test('损坏设置不影响已有list/snapshot；新建与读取报错，明确重置才恢复', async t => {
  const f = await fixture(t); const reading = await create(f); await fs.writeFile(f.file, '{bad');
  assert.equal((await f.runtime.dispatch('list', {})).projects.length, 1); assert.equal((await f.runtime.dispatch('snapshot', { sessionId: reading.sessionId })).sessionId, reading.sessionId);
  await assert.rejects(f.runtime.dispatch('reading-settings', {}), { code: 'READING_SETTINGS_CORRUPT' }); await assert.rejects(create(f), { code: 'READING_SETTINGS_CORRUPT' });
  assert.deepEqual(await f.runtime.dispatch('set-default-model', save(null)), { revision: 1, defaultModel: null }); assert.equal(f.store.sessions.size, 1); assert.deepEqual(f.ctx.calls, []);
});

function nativeRouting(store, nativeSelection = structuredClone(dsh)) {
  assert.equal(typeof host.installReadingModelRouting, 'function');
  const ctx = new Context(); const native = { current: nativeSelection };
  const disposeNative = installModelSelection(ctx, native);
  const disposeReading = host.installReadingModelRouting(ctx, { store }, () => {});
  return {
    native,
    assemble: (agent, tail = async () => ({ tools: [], variables: {} })) => ctx.waterfall('system-prompt/assemble', {}, { agent }, tail),
    request: agent => agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'inherited', model: 'inherited', reasoningEffort: 'inherited' })),
    dispose() { disposeReading(); disposeNative(); }
  };
}
test('真实SDK：提示变量与实际request同选局部模型，保留手动effort，快照不分裂，重启恢复', async t => {
  const f = await fixture(t); await f.runtime.dispatch('set-default-model', save(local)); const reading = await create(f); const agent = f.ctx.live.get(reading.sessionId);
  const routing = nativeRouting(f.store); t.after(() => routing.dispose());
  const first = await routing.assemble(agent); assert.deepEqual({ provider: first.variables.provider, model: first.variables.model }, local);
  assert.deepEqual(await routing.request(agent), local); assert.deepEqual(routing.native.current, dsh, 'plugin must not rewrite native global/default cache');
  const effort = { ...alternate, reasoningEffort: 'high' };
  agent.session.append('model/selection', effort); routing.native.current = effort;
  await routing.assemble(agent); assert.deepEqual(await routing.request(agent), effort);
  const assembling = await routing.assemble(agent, async () => { agent.session.append('model/selection', local); routing.native.current = local; return { tools: [], variables: {} }; });
  assert.deepEqual({ provider: assembling.variables.provider, model: assembling.variables.model }, alternate); assert.deepEqual(await routing.request(agent), effort);
  await routing.assemble(agent); assert.deepEqual(await routing.request(agent), local, 'inherited/native old effort is cleared for bare model choice');
  const old = await f.store.createSession(f.project.id); const legacy = { id: old.id, session: Session.create(old.id), ctx: {} };
  routing.native.current = structuredClone(dsh); await routing.assemble(legacy); assert.deepEqual(await routing.request(legacy), dsh, 'unmanaged sessions remain native/DSH-controlled');
  const log = path.join(f.root, 'native-session-fixture.json');
  await fs.writeFile(log, JSON.stringify({ header: agent.session.header, events: agent.session.snapshotEvents() }));
  const persisted = JSON.parse(await fs.readFile(log, 'utf8')); const restoredSession = Session.create(agent.id, persisted.events, persisted.header);
  assert.deepEqual(effectiveModelSelection(restoredSession.snapshotEvents()), local);
  const restoredStore = await new ReadingStore(f.store.root).init(); assert.equal(restoredStore.session(agent.id).modelSelectionManaged, true);
  const restarted = nativeRouting(restoredStore); t.after(() => restarted.dispose()); const restoredAgent = { ...agent, session: restoredSession }; await restarted.assemble(restoredAgent);
  assert.deepEqual(await restarted.request(restoredAgent), local);
  assert.deepEqual(f.ctx.globalSaves, []); assert.deepEqual(f.ctx.defaultModel, dsh); assert.deepEqual(f.ctx.calls, []);
});
for (const operation of ['save', 'create']) test(`模型目录等待期间停用，${operation}不迟到提交`, async t => {
  const f = await fixture(t); if (operation === 'create') await f.runtime.dispatch('set-default-model', save(local));
  const before = operation === 'create' ? await fs.readFile(f.file) : null;
  let entered, release; const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const catalog = f.ctx.sessionController.modelCatalog; f.ctx.sessionController.modelCatalog = async () => { entered(); await gate; return catalog(); };
  const pending = operation === 'save' ? f.runtime.dispatch('set-default-model', save(local)) : create(f, true);
  const rejected = assert.rejects(pending, { code: 'READING_UNAVAILABLE' }); await started; await f.ctx.dispose(); release(); await rejected;
  assert.equal(f.store.sessions.size, 0); assert.equal(f.ctx.live.size, 0); assert.equal(f.ctx.calls.length, 0); assert.deepEqual(f.ctx.globalSaves, []);
  if (before) assert.deepEqual(await fs.readFile(f.file), before); else await assert.rejects(fs.access(f.file), { code: 'ENOENT' });
});
test('新managed非draft在首轮前默认失效也拒绝，不借用可用的DSH默认', async t => {
  const f = await fixture(t); await f.runtime.dispatch('set-default-model', save(local)); const reading = await create(f);
  f.ctx.catalog.groups = [{ id: 'remote', models: [{ id: 'reader' }] }];
  await assert.rejects(f.runtime.dispatch('prompt', prompt(reading.sessionId, local)), { code: 'DEFAULT_MODEL_UNAVAILABLE' });
  assert.deepEqual(effectiveModelSelection(f.ctx.live.get(reading.sessionId).session.snapshotEvents()), local); assert.equal(f.ctx.calls.length, 0); assert.deepEqual(f.ctx.defaultModel, dsh);
});
test('managed已入队requestId在running和目录失效时仍幂等确认，不再请求模型', async t => {
  const f = await fixture(t); await f.runtime.dispatch('set-default-model', save(local)); const reading = await create(f); const args = prompt(reading.sessionId, local); const agent = f.ctx.live.get(reading.sessionId);
  agent.inbox = { nextTurn: [{ source: { kind: 'user', rpcId: args.requestId } }], nextStep: [] }; agent.status = 'running'; f.ctx.catalog.groups = [];
  assert.deepEqual(await f.runtime.dispatch('prompt', args), { accepted: true, replayed: true, running: true }); assert.equal(f.ctx.calls.length, 0); assert.deepEqual(f.ctx.globalSaves, []);
});
