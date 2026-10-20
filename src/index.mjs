import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Config, resolveDataDirectory } from './config.mjs';
import { PLUGIN_NAME, PLUGIN_VERSION, TARGET_DSH_VERSION, API_VERSION } from './version.mjs';
import { ReadingStore, setRuntime, peekRuntime } from './store.mjs';
import { PRESET, TOOL_NAMES, promptSchema, changeStageSchema, modelSchema, selectionSchema, idSchema, requireObject, fail, effectiveModelSelection } from './contracts.mjs';
import { checkBinding, readRepository } from './filesystem.mjs';
import { canonicalSelection } from './anchors.mjs';
import { browseDirectory, viewFile, listAnnotations, createAnnotation, updateAnnotation, selectionPrompt } from './workspace.mjs';
import { readReadingSettings, setDefaultModel, modelRefSchema } from './preferences.mjs';

export const name = 'code-reading';
export const inject = ['agentPresets', 'tools', 'systemPrompt', 'connection', 'sessionController', 'skills', 'agents'];
export { Config };

export function isReadingAgent(store, presets, agent) { return !!agent && (store.sessions.has(agent.id) || (!!agent.ctx && presets.composedPreset(agent.ctx) === PRESET)); }
export function guardReadingCall(store, presets, execution) {
  if (isReadingAgent(store, presets, execution.agent) && !TOOL_NAMES.has(execution.name)) return '阅读代码模式只允许专用只读取证与归档工具；禁止 shell、通用写入、代理、网络及插件转调。';
}

export function installReadingModelRouting(ctx, runtime, current) {
  const assembled = new WeakMap();
  const selectionFor = agent => {
    if (!agent || !runtime.store.sessions.has(agent.id)) return null;
    const state = runtime.store.session(agent.id);
    if (!state.modelSelectionManaged) return null;
    const selected = effectiveModelSelection(agent.session.snapshotEvents(), state.pendingNativeModel ?? state.draftModelSelection ?? null);
    if (!selected) fail('DEFAULT_MODEL_UNAVAILABLE', '此阅读会话的局部模型选择缺失，请在阅读设置中检查');
    return { ...modelRefSchema.parse({ provider: selected.provider, model: selected.model }), ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) };
  };
  const disposeAssembly = ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent ?? context.scope; const selected = selectionFor(agent);
    if (!selected) return next();
    current(); const result = await next(); current(); assembled.set(agent, selected);
    return { ...result, variables: { ...result.variables, provider: selected.provider, model: selected.model } };
  }, { prepend: true });
  const disposeRequest = ctx.on('agent/request', async ({ agent }, next) => {
    if (!selectionFor(agent)) return next();
    current(); const result = await next(); current(); const selected = assembled.get(agent);
    if (!selected) fail('DEFAULT_MODEL_UNAVAILABLE', '阅读模型尚未完成原生提示组装，未发送模型请求');
    const { reasoningEffort: _inheritedEffort, ...base } = result;
    return { ...base, provider: selected.provider, model: selected.model, ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) };
  }, { prepend: true });
  return () => { disposeAssembly?.(); disposeRequest?.(); };
}

export async function apply(ctx, rawConfig = {}) {
  const config = Config.parse(rawConfig);
  const { directory: root, source: dataSource } = resolveDataDirectory(config);
  const previous = peekRuntime(ctx.root);
  if (previous && previous.store.root !== path.resolve(root)) fail('READING_ROOT_CHANGED', '改变固定产物目录需要重启 DSH，以免保留会话写入两个目录');
  const store = previous?.store ?? await new ReadingStore(root).init();
  const skill = await readFile(new URL('../skills/code-tutor/SKILL.md', import.meta.url), 'utf8');
  const runtime = previous ?? { store };
  runtime.cancelEpochs ??= new Map();
  const activation = Symbol('code-reading activation');
  Object.assign(runtime, { skill, context: ctx, enabled: true, activation });
  runtime.isReading = agent => isReadingAgent(store, runtime.context.agentPresets, agent);
  runtime.busy = id => runtime.context.agents.get(id)?.status === 'running';
  setRuntime(ctx.root, runtime);
  ctx.effect(() => installReadingModelRouting(ctx, runtime, () => assertActive()), 'code-reading: session-local default model routing');
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
  ctx.effect(() => ctx.skills.register({ name: 'code-tutor', description: '按问题或所选代码阅读：业务、必要调用链、关键逻辑与证据归档；按需验证理解', source: 'bundled', content: skill }), 'code-reading: tutor skill');
  await ctx.effect(async () => ctx.agentPresets.register({ id: PRESET, name: '阅读代码', description: '仓库只读 · 多工作区联合阅读 · 证据与阅读产物归档；从阅读代码页面创建', order: 60, plugins: [{ name: 'dsh-code-reading/preset' }] }), 'code-reading: preset');

  async function ensureSession(id) {
    store.session(id);
    const result = await ctx.sessionController.resolveAgent(id);
    if (result.error) throw result.error;
    if (!runtime.isReading(result.agent) || ctx.agentPresets.composedPreset(result.agent.ctx) !== PRESET) fail('NOT_READING_AGENT', '此会话的阅读 preset 已变化，请从阅读代码页面新建会话');
    return result.agent;
  }
  async function availableReadingModel(selection, current) {
    const selected = modelRefSchema.parse({ provider: selection?.provider, model: selection?.model });
    current?.(); let catalog;
    try { catalog = await ctx.sessionController.modelCatalog(); }
    catch { current?.(); fail('DEFAULT_MODEL_UNAVAILABLE', '无法核验默认阅读模型目录；请重新加载设置，不会改用其它模型'); }
    current?.();
    if (!catalog?.groups?.some(group => group.id === selected.provider && group.models?.some(model => model.id === selected.model))) fail('DEFAULT_MODEL_UNAVAILABLE', '默认阅读模型当前不可用，请在阅读设置中更改或清除；不会自动改用DSH默认');
    return selected;
  }
  async function selectLocalReadingModel(agent, selection, current) {
    const selected = await availableReadingModel(selection, current); current?.();
    const latest = effectiveModelSelection(agent.session.snapshotEvents());
    if (!latest || latest.provider !== selected.provider || latest.model !== selected.model || latest.reasoningEffort !== undefined) agent.session.append('model/selection', selected);
    await store.archiveEvents(agent.id, agent.session.snapshotEvents()); current?.();
    return { selected };
  }
  async function ensurePendingNativeSession(id, current) {
    const state = store.session(id);
    if (!state.nativePending) return ensureSession(id);
    current();
    if (state.modelSelectionManaged) await availableReadingModel(state.pendingNativeModel, current);
    const existing = await ctx.sessionController.resolveAgent(id); current();
    if (!existing.agent) {
      await ctx.sessionController.create({ sessionId: id, cwd: store.sessionDir(id), agentPreset: PRESET }); current();
      await ctx.sessionController.rename({ sessionId: id, title: state.topic.trim().slice(0, 120) || '未命名阅读主题' }); current();
    }
    const agent = await ensureSession(id); current();
    const selection = store.session(id).pendingNativeModel;
    if (selection) {
      if (store.session(id).modelSelectionManaged) await selectLocalReadingModel(agent, selection, current);
      else await ctx.sessionController.selectModel({ sessionId: id, provider: selection.provider, model: selection.model });
      current();
    }
    await store.completeNativeSession(id, current); current(); return agent;
  }
  async function ensurePromptSession(id, epoch, signal) {
    const current = () => { assertPromptCurrent(id, epoch, signal); store.assertUnarchived(id); if (runtime.busy(id)) fail('AGENT_BUSY', '本轮阅读还在进行，请等待或停止后再发送'); };
    return ensurePendingNativeSession(id, current);
  }
  async function archive(id) {
    store.assertPersisted(id);
    const inspection = await ctx.sessionController.inspect(id);
    await store.archiveEvents(id, inspection.events);
    return inspection;
  }
  const onlyId = params => z.object({ sessionId: idSchema }).strict().parse(params).sessionId;
  function assertActive(signal) {
    signal?.throwIfAborted();
    if (!runtime.enabled || runtime.activation !== activation) fail('READING_UNAVAILABLE', '阅读 Host 已停用或更新。请检查插件状态，重启或刷新后再操作');
  }
  function assertPromptCurrent(id, epoch, signal) {
    assertActive(signal); store.assertUnarchived(id);
    if (epoch !== (runtime.cancelEpochs.get(id) ?? 0)) fail('PROMPT_CANCELLED', '此提问已在入队前取消，未发送给模型');
  }
  async function dispatch(method, params, signal, admitted = false, promptEpoch) {
    assertActive(signal);
    if (['prompt', 'annotation-create', 'discard-draft'].includes(method)) {
      const id = idSchema.parse(params.sessionId);
      if (!admitted && method === 'discard-draft') runtime.cancelEpochs.set(id, (runtime.cancelEpochs.get(id) ?? 0) + 1);
      promptEpoch ??= runtime.cancelEpochs.get(id) ?? 0;
      if (promptEpoch !== (runtime.cancelEpochs.get(id) ?? 0)) fail(method === 'prompt' ? 'PROMPT_CANCELLED' : 'OPERATION_CANCELLED', '此操作已取消，未提交后续修改');
    }
    if (!admitted && ['prompt', 'stage', 'select-model', 'annotation-create', 'annotation-update', 'reader-state', 'discard-draft', 'set-session-archived'].includes(method)) {
      const id = idSchema.parse(params.sessionId);
      if (method !== 'discard-draft') {
        const state = store.session(id);
        if (['prompt', 'stage', 'select-model'].includes(method)) store.assertUnarchived(id);
        if (method === 'annotation-update') store.assertPersisted(id);
        if (!state.draft && !state.nativePending && method !== 'set-session-archived') await ensureSession(id);
      }
      return store.lock(`admission:${id}`, () => dispatch(method, params, signal, true, promptEpoch));
    }
    switch (method) {
      case 'status': {
        requireObject(params, []);
        return { package: PLUGIN_NAME, version: PLUGIN_VERSION, apiVersion: API_VERSION, targetDshVersion: TARGET_DSH_VERSION, enabled: true, capabilities: ['remove-project', 'default-model'], dataDirectory: store.root, dataSource, tools: [...TOOL_NAMES] };
      }
      case 'reading-settings': requireObject(params, []); return readReadingSettings(store, () => assertActive(signal));
      case 'set-default-model': return setDefaultModel(store, params, () => assertActive(signal), selected => availableReadingModel(selected, () => assertActive(signal)));
      case 'list': requireObject(params, []); return store.list();
      case 'create-project': return store.createProject(params);
      case 'remove-project': return store.removeProject(params, () => assertActive(signal), id => runtime.busy(id));
      case 'create-session': {
        const { projectId, draft } = z.object({ projectId: idSchema, draft: z.boolean().default(false) }).strict().parse(params);
        const current = () => assertActive(signal);
        const settings = await readReadingSettings(store, current); current();
        const selected = settings.defaultModel ? await availableReadingModel(settings.defaultModel, current) : null;
        const state = await store.createSession(projectId, { draft, modelSelection: selected ?? ctx.get('agentDefaultModel')?.currentSelection() ?? null, modelSelectionManaged: !!selected }, current);
        if (!draft) {
          if (selected) await ensurePendingNativeSession(state.id, () => { current(); store.assertUnarchived(state.id); if (runtime.busy(state.id)) fail('AGENT_BUSY', '阅读进行中不能初始化模型'); });
          else {
            current(); await ctx.sessionController.create({ sessionId: state.id, cwd: store.sessionDir(state.id), agentPreset: PRESET });
            current(); await ctx.sessionController.rename({ sessionId: state.id, title: '未命名阅读主题' });
          }
        }
        return { sessionId: state.id };
      }
      case 'snapshot': {
        const args = z.object({ sessionId: idSchema, beforeSeq: z.number().int().min(0).optional() }).strict().parse(params);
        const state = store.session(args.sessionId);
        if (state.draft || (state.nativePending && !ctx.agents.get(args.sessionId))) return { ...await store.snapshot(args.sessionId, args.beforeSeq), running: false, turnEnd: null, modelSelection: structuredClone((state.draft ? state.draftModelSelection : state.pendingNativeModel) ?? null) };
        let inspection;
        try { inspection = await ctx.sessionController.inspect(args.sessionId); await store.archiveEvents(args.sessionId, inspection.events); } catch (error) { store.archiveErrors.set(args.sessionId, error.message); }
        const events = [...(inspection?.events ?? [])].reverse();
        const end = events.find(event => event.type === 'turn/end');
        const selection = state.modelSelectionManaged && state.nativePending ? state.pendingNativeModel : inspection ? effectiveModelSelection(inspection.events, ctx.get('agentDefaultModel')?.currentSelection() ?? null) : null;
        return { ...await store.snapshot(args.sessionId, args.beforeSeq), running: runtime.busy(args.sessionId), turnEnd: end ? { seq: end.seq, reason: end.data.reason } : null, modelSelection: selection ?? null };
      }
      case 'prompt': {
        const args = promptSchema.parse(params); store.assertUnarchived(args.sessionId); let preparedText;
        if (store.session(args.sessionId).draft || store.session(args.sessionId).nativePending) {
          const current = () => {
            assertPromptCurrent(args.sessionId, promptEpoch, signal); const state = store.assertUnarchived(args.sessionId);
            if (state.revision !== args.expectedRevision) fail('STALE_REVISION', '阅读阶段已变化，请刷新后重新发送');
            if (runtime.busy(args.sessionId)) fail('AGENT_BUSY', '本轮阅读还在进行，请等待或停止后再发送');
            const selected = state.draft ? state.draftModelSelection : state.pendingNativeModel;
            if (!selected || selected.provider !== args.expectedModel.provider || selected.model !== args.expectedModel.model) fail('MODEL_CHANGED', '本会话实际模型已变化，请刷新确认提供方后重发');
          };
          current();
          if (store.session(args.sessionId).modelSelectionManaged) {
            const selected = store.session(args.sessionId);
            await availableReadingModel(selected.draft ? selected.draftModelSelection : selected.pendingNativeModel, current);
          }
          preparedText = args.text + (args.selection ? await selectionPrompt(store, args.sessionId, args.selection, signal, args.intent) : '');
          current(); await store.persistDraft(args.sessionId, current); current();
        }
        const agent = await ensurePromptSession(args.sessionId, promptEpoch, signal);
        const inspection = await ctx.sessionController.inspect(args.sessionId);
        assertPromptCurrent(args.sessionId, promptEpoch, signal);
        const alreadyAccepted = inspection.events.some(event => event.type === 'user/message' && event.data.source?.kind === 'user' && event.data.source.rpcId === args.requestId) || [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])].some(message => message.source?.kind === 'user' && message.source.rpcId === args.requestId);
        if (alreadyAccepted) return { accepted: true, replayed: true, running: runtime.busy(args.sessionId) };
        if (store.session(args.sessionId).revision !== args.expectedRevision) fail('STALE_REVISION', '阅读阶段已变化，请刷新后重新发送');
        if (runtime.busy(args.sessionId)) fail('AGENT_BUSY', '本轮阅读还在进行，请等待或停止后再发送');
        const admittedModel = effectiveModelSelection(inspection.events, ctx.get('agentDefaultModel')?.currentSelection() ?? null);
        if (!admittedModel || admittedModel.provider !== args.expectedModel.provider || admittedModel.model !== args.expectedModel.model) fail('MODEL_CHANGED', '本会话实际模型已变化，请刷新确认提供方后重发');
        if (store.session(args.sessionId).modelSelectionManaged) {
          const current = () => {
            assertPromptCurrent(args.sessionId, promptEpoch, signal);
            if (store.session(args.sessionId).revision !== args.expectedRevision) fail('STALE_REVISION', '阅读阶段已变化，请刷新后重新发送');
            if (runtime.busy(args.sessionId)) fail('AGENT_BUSY', '本轮阅读还在进行');
          };
          await availableReadingModel(admittedModel, current);
        }
        const text = preparedText ?? (args.text + (args.selection ? await selectionPrompt(store, args.sessionId, args.selection, signal, args.intent) : ''));
        // selectionPrompt has verified these coordinates against the actual file; never persist its quote here.
        const focus = args.selection ? { repoId: args.selection.repoId, path: args.selection.path, fileHash: args.selection.fileHash, start: { ...args.selection.start }, end: { ...args.selection.end } } : null;
        // Catalog/system-prompt assembly can begin synchronously in native prompt().
        // Commit metadata first; it must never consume the compatibility stage revision.
        await store.updateReadingMode(args.sessionId, args.selection ? 'code' : args.readingMode, () => {
          assertPromptCurrent(args.sessionId, promptEpoch, signal);
          if (store.session(args.sessionId).revision !== args.expectedRevision) fail('STALE_REVISION', '阅读阶段已变化，请刷新后重新发送');
          if (runtime.busy(args.sessionId)) fail('AGENT_BUSY', '本轮阅读还在进行，请等待或停止后再发送');
        }, args.intent, focus);
        const currentInspection = await ctx.sessionController.inspect(args.sessionId);
        // Keep all final checks and enqueue in one synchronous segment after the last await.
        assertPromptCurrent(args.sessionId, promptEpoch, signal);
        if (store.session(args.sessionId).revision !== args.expectedRevision) fail('STALE_REVISION', '阅读阶段已变化，请刷新后重新发送');
        if (runtime.busy(args.sessionId)) fail('AGENT_BUSY', '本轮阅读还在进行，请等待或停止后再发送');
        const selected = effectiveModelSelection(currentInspection.events, ctx.get('agentDefaultModel')?.currentSelection() ?? null);
        if (!selected || selected.provider !== args.expectedModel.provider || selected.model !== args.expectedModel.model) fail('MODEL_CHANGED', '本会话实际模型已变化，请刷新确认提供方后重发');
        return ctx.sessionController.prompt({ sessionId: agent.id, requestId: args.requestId, mode: 'queue', content: [{ type: 'text', text }] }, signal);
      }
      case 'stage': {
        const args = changeStageSchema.parse(params);
        const state = store.assertUnarchived(args.sessionId); const native = !state.draft && !state.nativePending;
        if (native) await ensureSession(args.sessionId);
        const current = () => { assertActive(signal); store.assertUnarchived(args.sessionId); if (runtime.busy(args.sessionId)) fail('AGENT_BUSY', '阅读进行中不能改变阶段或主题；请先停止'); };
        current();
        const firstTopic = !!args.topic.trim() && !state.stageHistory.some(item => item.topic?.trim());
        const defaults = new Set(['未命名阅读主题', `阅读 · ${store.project(state.projectId).title}`]);
        let previousTitle;
        if (firstTopic && native) {
          try { previousTitle = (await ctx.sessionController.inspect(args.sessionId)).meta?.title; }
          catch { /* Unknown title: keep the native session name rather than overwrite user history. */ }
        }
        current();
        const result = await store.changeStage(args, current);
        if (firstTopic && defaults.has(previousTitle)) {
          try {
            const currentTitle = (await ctx.sessionController.inspect(args.sessionId)).meta?.title;
            assertActive(signal);
            if (currentTitle === previousTitle) await ctx.sessionController.rename({ sessionId: args.sessionId, title: args.topic.trim().slice(0, 120) });
          } catch (error) { ctx.logger.warn(`code-reading theme title unchanged (${args.sessionId}): ${error.code ?? error.name}`); }
        }
        return result;
      }
      case 'reader-state': return store.updateReaderState(params, () => assertActive(signal));
      case 'tree': return browseDirectory(store, params, signal);
      case 'view-file': return viewFile(store, params, signal, () => assertActive(signal));
      case 'annotations': { const id = onlyId(params); return store.session(id).draft ? { revision: 0, items: [] } : listAnnotations(store, params); }
      case 'annotation-create': {
        const args = z.object({ sessionId: idSchema, requestId: z.string().uuid(), body: z.string().trim().min(1).max(4000), selection: selectionSchema }).strict().parse(params);
        const current = () => { assertActive(signal); if (promptEpoch !== (runtime.cancelEpochs.get(args.sessionId) ?? 0)) fail('OPERATION_CANCELLED', '此次批注保存已取消，未提交后续修改'); };
        if (store.session(args.sessionId).draft) {
          const source = await readRepository(store.repo(args.sessionId, args.selection.repoId), args.selection.path); canonicalSelection(source, args.selection);
          current(); await store.persistDraft(args.sessionId, current);
        }
        current(); return createAnnotation(store, args, signal, current);
      }
      case 'annotation-update': store.assertPersisted(idSchema.parse(params.sessionId)); return updateAnnotation(store, params, signal, () => assertActive(signal));
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
      case 'export': { const id = onlyId(params); const state = store.assertPersisted(id); if (!state.nativePending || ctx.agents.get(id)) await archive(id); return store.exportSession(id); }
      case 'models': requireObject(params, []); return ctx.sessionController.modelCatalog();
      case 'select-model': {
        const args = modelSchema.parse(params); const state = store.assertUnarchived(args.sessionId);
        const current = () => { assertActive(signal); store.assertUnarchived(args.sessionId); if (runtime.busy(args.sessionId)) fail('AGENT_BUSY', '阅读进行中不能切换模型'); };
        if (state.modelSelectionManaged) {
          const selected = { provider: args.provider, model: args.model };
          if (state.draft || state.nativePending) { await availableReadingModel(selected, current); return store.selectDraftModel(args, current); }
          const agent = await ensureSession(args.sessionId); current(); return selectLocalReadingModel(agent, selected, current);
        }
        if (state.draft || state.nativePending) return store.selectDraftModel(args, current);
        await ensureSession(args.sessionId); current(); return ctx.sessionController.selectModel(args);
      }
      case 'discard-draft': {
        const id = onlyId(params); const result = await store.discardDraft(id, () => assertActive(signal)); runtime.cancelEpochs.delete(id); return result;
      }
      case 'set-session-archived': {
        const id = idSchema.parse(params.sessionId);
        return store.setSessionArchived(params, () => { assertActive(signal); if (runtime.busy(id)) fail('AGENT_BUSY', '阅读进行中不能归档或恢复会话，请先停止'); });
      }
      case 'cancel': {
        const id = onlyId(params); const state = store.session(id);
        runtime.cancelEpochs.set(id, (runtime.cancelEpochs.get(id) ?? 0) + 1);
        if (state.draft || (state.nativePending && !ctx.agents.get(id))) return { cancelled: true, running: false };
        return ctx.sessionController.cancel({ sessionId: id });
      }
      default: fail('UNKNOWN_METHOD', '不支持此阅读页面操作');
    }
  }
  runtime.dispatch = dispatch;
  await ctx.effect(() => ctx.connection.fetch.register({ path: '/api/code-reading', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
    try {
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return Response.json({ ok: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '需要 application/json 请求' } }, { status: 415 });
      const text = await request.text(); if (Buffer.byteLength(text, 'utf8') > 131072) fail('REQUEST_LIMIT', '请求超过 128 KiB');
      const body = z.object({ method: z.string().max(40), params: z.record(z.string(), z.unknown()).default({}) }).strict().parse(JSON.parse(text));
      const value = await dispatch(body.method, body.params, request.signal); return Response.json({ ok: true, value });
    } catch (error) { const status = error.code === 'READING_UNAVAILABLE' ? 503 : error.code === 'REQUEST_LIMIT' ? 413 : 400; return Response.json({ ok: false, error: { code: error.code ?? 'INVALID_REQUEST', message: error.message } }, { status }); }
  } }), 'code-reading: authenticated Connection route');
}
