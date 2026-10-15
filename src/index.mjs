import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { ReadingStore, setRuntime, peekRuntime } from './store.mjs';
import { PRESET, TOOL_NAMES, promptSchema, changeStageSchema, modelSchema, idSchema, requireObject, fail, effectiveModelSelection } from './contracts.mjs';
import { checkBinding } from './filesystem.mjs';

export const name = 'code-reading';
export const inject = ['agentPresets', 'tools', 'systemPrompt', 'connection', 'sessionController', 'skills', 'agents'];
const configSchema = z.object({ dataDir: z.string().optional() }).strict().default({});
export const Config = configSchema;

export function isReadingAgent(store, presets, agent) { return !!agent && (store.sessions.has(agent.id) || (!!agent.ctx && presets.composedPreset(agent.ctx) === PRESET)); }
export function guardReadingCall(store, presets, execution) {
  if (isReadingAgent(store, presets, execution.agent) && !TOOL_NAMES.has(execution.name)) return '阅读代码模式只允许专用只读取证与归档工具；禁止 shell、通用写入、代理、网络及插件转调。';
}

export async function apply(ctx, rawConfig = {}) {
  const config = configSchema.parse(rawConfig);
  const root = config.dataDir ?? process.env.DSH_CODE_READING_HOME ?? path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'code-reading');
  const previous = peekRuntime(ctx.root);
  if (previous && previous.store.root !== path.resolve(root)) fail('READING_ROOT_CHANGED', '改变固定产物目录需要重启 DSH，以免保留会话写入两个目录');
  const store = previous?.store ?? await new ReadingStore(root).init();
  const skill = await readFile(new URL('../skills/code-tutor/SKILL.md', import.meta.url), 'utf8');
  const runtime = previous ?? { store };
  const activation = Symbol('code-reading activation');
  Object.assign(runtime, { skill, context: ctx, enabled: true, activation });
  runtime.isReading = agent => isReadingAgent(store, runtime.context.agentPresets, agent);
  runtime.busy = id => runtime.context.agents.get(id)?.status === 'running';
  setRuntime(ctx.root, runtime);
  ctx.effect(() => () => { if (runtime.activation === activation) runtime.enabled = false; }, 'code-reading: disable retained revisions');
  ctx.effect(() => ctx.tools.guard(exec => guardReadingCall(store, ctx.agentPresets, exec)), 'code-reading: execution guard');
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    if (runtime.isReading(context.agent ?? context.scope)) return { ...assembly, tools: assembly.tools.filter(tool => TOOL_NAMES.has(tool.name)) };
    return assembly;
  });
  ctx.on('agent/created', async ({ agent }) => {
    if (!runtime.isReading(agent)) return;
    const state = store.session(agent.id);
    if (path.resolve(agent.session.header.cwd ?? '') !== store.sessionDir(state.id)) fail('CWD_MISMATCH', '阅读会话只能在固定阅读目录创建');
    for (const repo of store.project(state.projectId).repositories) await checkBinding(repo);
    // An additional logged sandbox default; the hard tool guard is independent of permission UI changes.
    if (ctx.get('sandboxPolicy')?.overrideOf(agent.session) !== 'read-only') agent.session.append('sandbox/mode', { mode: 'read-only' });
    await store.archiveEvents(agent.id, agent.session.snapshotEvents());
  });
  ctx.on('session/event', (session, event) => {
    if (!store.sessions.has(session.id)) return;
    // Ordered, idempotent archival; snapshot recovery replays the committed DSH log after restart/failure.
    void store.archiveEvents(session.id, session.snapshotEvents()).catch(error => ctx.logger.warn(`code-reading archive failed (${session.id}): ${error.code ?? error.name}`));
  });
  ctx.effect(() => ctx.skills.register({ name: 'code-tutor', description: '交互式代码阅读导师：业务、调用链、精读、理解验证与证据归档', source: 'bundled', content: skill }), 'code-reading: tutor skill');
  await ctx.effect(async () => ctx.agentPresets.register({ id: PRESET, name: '阅读代码', description: '仓库只读 · 多工作区联合阅读 · 证据与阅读产物归档；从阅读代码页面创建', order: 60, plugins: [{ name: 'dsh-code-reading/preset' }] }), 'code-reading: preset');

  async function ensureSession(id) {
    store.session(id);
    const result = await ctx.sessionController.resolveAgent(id);
    if (result.error) throw result.error;
    if (!runtime.isReading(result.agent) || ctx.agentPresets.composedPreset(result.agent.ctx) !== PRESET) fail('NOT_READING_AGENT', '此会话的阅读 preset 已变化，请从阅读代码页面新建会话');
    return result.agent;
  }
  async function archive(id) {
    const inspection = await ctx.sessionController.inspect(id);
    await store.archiveEvents(id, inspection.events);
    return inspection;
  }
  const onlyId = params => z.object({ sessionId: idSchema }).strict().parse(params).sessionId;
  async function dispatch(method, params, signal, admitted = false) {
    signal?.throwIfAborted();
    if (!admitted && ['prompt', 'stage', 'select-model'].includes(method)) {
      const id = idSchema.parse(params.sessionId);
      await ensureSession(id);
      return store.lock(`admission:${id}`, () => dispatch(method, params, signal, true));
    }
    switch (method) {
      case 'list': requireObject(params, []); return store.list();
      case 'create-project': return store.createProject(params);
      case 'create-session': {
        const { projectId } = z.object({ projectId: idSchema }).strict().parse(params);
        const state = await store.createSession(projectId);
        await ctx.sessionController.create({ sessionId: state.id, cwd: store.sessionDir(state.id), agentPreset: PRESET });
        await ctx.sessionController.rename({ sessionId: state.id, title: `阅读 · ${store.project(projectId).title}` });
        return { sessionId: state.id };
      }
      case 'snapshot': {
        const args = z.object({ sessionId: idSchema, beforeSeq: z.number().int().min(0).optional() }).strict().parse(params);
        let inspection;
        try { inspection = await ctx.sessionController.inspect(args.sessionId); await store.archiveEvents(args.sessionId, inspection.events); } catch (error) { store.archiveErrors.set(args.sessionId, error.message); }
        const events = [...(inspection?.events ?? [])].reverse();
        const end = events.find(event => event.type === 'turn/end');
        const selection = inspection ? effectiveModelSelection(inspection.events, ctx.get('agentDefaultModel')?.currentSelection() ?? null) : null;
        return { ...await store.snapshot(args.sessionId, args.beforeSeq), running: runtime.busy(args.sessionId), turnEnd: end ? { seq: end.seq, reason: end.data.reason } : null, modelSelection: selection ?? null };
      }
      case 'prompt': {
        const args = promptSchema.parse(params); const agent = await ensureSession(args.sessionId);
        const inspection = await ctx.sessionController.inspect(args.sessionId);
        const alreadyAccepted = inspection.events.some(event => event.type === 'user/message' && event.data.source?.kind === 'user' && event.data.source.rpcId === args.requestId) || [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])].some(message => message.source?.kind === 'user' && message.source.rpcId === args.requestId);
        if (alreadyAccepted) return { accepted: true, replayed: true, running: runtime.busy(args.sessionId) };
        if (store.session(args.sessionId).revision !== args.expectedRevision) fail('STALE_REVISION', '阅读阶段已变化，请刷新后重新发送');
        if (runtime.busy(args.sessionId)) fail('AGENT_BUSY', '本轮阅读还在进行，请等待或停止后再发送');
        const selected = effectiveModelSelection(inspection.events, ctx.get('agentDefaultModel')?.currentSelection() ?? null);
        if (!selected || selected.provider !== args.expectedModel.provider || selected.model !== args.expectedModel.model) fail('MODEL_CHANGED', '本会话实际模型已变化，请刷新确认提供方后重发');
        return ctx.sessionController.prompt({ sessionId: agent.id, requestId: args.requestId, mode: 'queue', content: [{ type: 'text', text: args.text }] }, signal);
      }
      case 'stage': {
        const args = changeStageSchema.parse(params);
        await ensureSession(args.sessionId);
        if (runtime.busy(args.sessionId)) fail('AGENT_BUSY', '阅读进行中不能改变阶段或主题；请先停止');
        return store.changeStage(args);
      }
      case 'read': {
        const { sessionId, ...args } = requireObject(params, ['sessionId', 'repoId', 'path', 'offset', 'limit', 'symbol']); store.session(sessionId); return store.read(sessionId, args, signal);
      }
      case 'files': {
        const { sessionId, ...args } = requireObject(params, ['sessionId', 'repoId', 'filter', 'limit']); store.session(sessionId); return store.files(sessionId, args, signal);
      }
      case 'search': {
        const { sessionId, ...args } = requireObject(params, ['sessionId', 'repoId', 'query', 'caseSensitive', 'pathFilter', 'limit']); store.session(sessionId); return store.search(sessionId, args, signal);
      }
      case 'evidence': {
        const args = z.object({ sessionId: idSchema, evidenceId: idSchema }).strict().parse(params); return store.openEvidence(args.sessionId, args.evidenceId);
      }
      case 'export': { const id = onlyId(params); await archive(id); return store.exportSession(id); }
      case 'models': requireObject(params, []); return ctx.sessionController.modelCatalog();
      case 'select-model': {
        const args = modelSchema.parse(params); await ensureSession(args.sessionId);
        if (runtime.busy(args.sessionId)) fail('AGENT_BUSY', '阅读进行中不能切换模型');
        return ctx.sessionController.selectModel(args);
      }
      case 'cancel': { const id = onlyId(params); return ctx.sessionController.cancel({ sessionId: id }); }
      default: fail('UNKNOWN_METHOD', '不支持此阅读页面操作');
    }
  }
  runtime.dispatch = dispatch;
  await ctx.effect(() => ctx.connection.fetch.register({ path: '/api/code-reading', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
    try {
      if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: '需要 JSON 请求' }, { status: 415 });
      const text = await request.text(); if (text.length > 131072) fail('REQUEST_LIMIT', '请求超过 128 KiB');
      const body = z.object({ method: z.string().max(40), params: z.record(z.string(), z.unknown()).default({}) }).strict().parse(JSON.parse(text));
      const value = await dispatch(body.method, body.params, request.signal); return Response.json({ ok: true, value });
    } catch (error) { return Response.json({ ok: false, error: { code: error.code ?? 'INVALID_REQUEST', message: error.message } }, { status: 400 }); }
  } }), 'code-reading: authenticated Connection route');
}
