import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createProjectSchema, readSchema, filesSchema, searchSchema, publishSchema, changeStageSchema, readerStateSchema, updateReaderStateSchema, readingModeSchema, promptIntentSchema, modelSchema, idSchema, STAGE_LABELS, validateMermaid, fail } from './contracts.mjs';
import { bindDirectory, checkBinding, checkPlain, assertDisjoint, contains, safeRelative, readRepository, listRepository, ensurePlainDirectory, atomicText, appendAudit, digest } from './filesystem.mjs';

import { loadAnnotations } from './workspace.mjs';
import { annotationMarkdown } from './anchors.mjs';
import { parseReadingFocus, restoredCodeUnits, verifyCodeUnits, codeUnitsMarkdown } from './code-units.mjs';
import { modelRefSchema } from './preferences.mjs';
const mapTaskSchema = z.object({ requestId: z.string().uuid() }).strict();
const makeId = prefix => `${prefix}-${randomUUID()}`;
const clone = value => structuredClone(value);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const directoryName = (root, max) => (path.basename(root).trim() || path.parse(root).root || 'repository').slice(0, max);
const sectionMarkdown = (lesson, depth) => lesson.sections?.length ? `\n\n${'#'.repeat(depth)} 内容维度归档\n${lesson.sections.map(section => `\n${'#'.repeat(depth + 1)} ${STAGE_LABELS[section.dimension]}\n\n${section.markdown}\n`).join('')}` : '';
const RUNTIME_KEY = Symbol.for('dsh-code-reading.runtime.v1');
const RUNTIMES = globalThis[RUNTIME_KEY] ??= new WeakMap();
export function peekRuntime(root) { return RUNTIMES.get(root); }
export function setRuntime(root, runtime) { RUNTIMES.set(root, runtime); }
export function getRuntime(root) { const runtime = RUNTIMES.get(root); if (!runtime) fail('READING_UNAVAILABLE', '阅读模式 Host 未启动'); return runtime; }

export class ReadingStore {
  constructor(root) { this.root = path.resolve(root); this.projects = new Map(); this.sessions = new Map(); this.locks = new Map(); this.diagnostics = []; this.archiveErrors = new Map(); this.draftReadAudits = new Map(); }
  async init() {
    await ensurePlainDirectory(this.root); this.storageBinding = await bindDirectory(this.root);
    await ensurePlainDirectory(path.join(this.root, 'projects'));
    for (const entry of await fs.readdir(path.join(this.root, 'projects'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('project-')) continue;
      try {
        idSchema.parse(entry.name);
        const file = path.join(this.root, 'projects', entry.name, 'project.json'); await checkPlain(file);
        const project = JSON.parse(await fs.readFile(file, 'utf8'));
        if (project.id !== entry.name || project.bindingRevision !== 1 || !Array.isArray(project.repositories) || project.repositories.length > 12) fail('CORRUPT_PROJECT', '阅读项目档案无效');
        for (const repo of project.repositories) { idSchema.parse(repo.id); assertDisjoint(this.root, repo.root); }
        if (project.removedAt != null && (typeof project.removedAt !== 'string' || !Number.isFinite(Date.parse(project.removedAt)))) fail('CORRUPT_PROJECT', '仓库移除状态无效');
        this.projects.set(project.id, project);
        if (project.removedAt) continue; // Keep archives on disk; removed bindings cannot be reopened by stale sessions.
        const dir = path.join(this.projectDir(project.id), 'sessions'); await checkPlain(dir);
        for (const folder of await fs.readdir(dir, { withFileTypes: true })) {
          if (!folder.isDirectory() || !folder.name.startsWith('reading-')) continue;
          idSchema.parse(folder.name);
          const stateFile = path.join(dir, folder.name, 'state.json');
          try { await checkPlain(stateFile); } catch (error) { if (error.code !== 'ENOENT') throw error; this.diagnostics.push(`${folder.name}: 阅读会话尚未提交，已跳过孤立目录`); continue; }
          const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
          if (state.id !== folder.name || state.projectId !== project.id || !Number.isSafeInteger(state.revision) || !Array.isArray(state.evidence) || !Array.isArray(state.lessons) || !Array.isArray(state.messageRefs)) fail('CORRUPT_SESSION', '阅读会话档案无效');
          state.draft = false;
          if (state.codeMapTask !== undefined) state.codeMapTask = mapTaskSchema.parse(state.codeMapTask);
          state.archivedAt = typeof state.archivedAt === 'string' && Number.isFinite(Date.parse(state.archivedAt)) ? state.archivedAt : null;
          state.archiveRevision = Number.isSafeInteger(state.archiveRevision) && state.archiveRevision >= 0 ? state.archiveRevision : 0;
          state.readerState = this.restoredReaderState(state);
          state.readingMode = readingModeSchema.safeParse(state.readingMode).data ?? 'question';
          state.intent = promptIntentSchema.safeParse(state.intent).data ?? 'explain';
          try { state.readingFocus = parseReadingFocus(state.readingFocus ?? null, project); } catch { state.readingFocus = null; }
          state.readingModeRevision = Number.isSafeInteger(state.readingModeRevision) && state.readingModeRevision >= 0 ? state.readingModeRevision : 0;
          for (const lesson of state.lessons) {
            lesson.sections ??= []; lesson.codeUnits = restoredCodeUnits(lesson.codeUnits); lesson.intent = promptIntentSchema.safeParse(lesson.intent).data ?? 'explain';
            try { lesson.readingFocus = parseReadingFocus(lesson.readingFocus ?? null, project); } catch { lesson.readingFocus = null; }
          }
          this.sessions.set(state.id, state);
        }
      } catch (error) { this.diagnostics.push(`${entry.name}: ${error.message}`); }
    }
    return this;
  }
  projectDir(id) { idSchema.parse(id); return path.join(this.root, 'projects', id); }
  sessionDir(id) { const state = this.session(id); return path.join(this.projectDir(state.projectId), 'sessions', id); }
  session(id) { idSchema.parse(id); const state = this.sessions.get(id); if (!state) fail('READING_NOT_FOUND', '没有此阅读会话，请从阅读代码页面新建'); this.project(state.projectId); return state; }
  project(id) { idSchema.parse(id); const project = this.projects.get(id); if (!project) fail('PROJECT_NOT_FOUND', '阅读项目不存在'); if (project.removedAt) fail('PROJECT_REMOVED', '仓库已从阅读列表移除，源码与原阅读档案仍保留'); return project; }
  repo(sessionId, repoId) { const project = this.project(this.session(sessionId).projectId); const repo = project.repositories.find(r => r.id === repoId); if (!repo) fail('REPO_NOT_BOUND', '此仓库未绑定到当前阅读项目'); return repo; }
  async lock(key, operation) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation); this.locks.set(key, next);
    try { return await next; } finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }
  assertPersisted(id) { const state = this.session(id); if (state.draft) fail('SESSION_DRAFT', '请先确认发起阅读，再保存批注、归档或导出'); return state; }
  assertUnarchived(id) { const state = this.session(id); if (state.archivedAt) fail('SESSION_ARCHIVED', '此阅读会话已归档，请先恢复后再继续阅读'); return state; }
  async writable(directory, draftId) {
    for (const state of this.sessions.values()) if (state.draft && !this.projects.get(state.projectId)?.removedAt && state.id !== draftId && contains(this.sessionDir(state.id), directory)) fail('SESSION_DRAFT', '未发起的阅读草稿不能写入档案');
    await checkBinding(this.storageBinding);
    for (const project of this.projects.values()) for (const repo of project.repositories) assertDisjoint(this.root, repo.root);
    if (!contains(this.root, directory)) fail('OUTPUT_DENIED', '产物路径超出固定阅读目录');
    await ensurePlainDirectory(directory); await checkBinding(this.storageBinding);
  }
  restoredReaderState(state) {
    const saved = state.readerState ?? {};
    const candidate = saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...saved, activeDocument: ['source', 'reading'].includes(saved.activeDocument) ? saved.activeDocument : null } : saved;
    const parsed = readerStateSchema.safeParse(candidate);
    if (!parsed.success) { this.diagnostics.push(`${state.id}: 阅读位置元数据无效，已使用默认位置`); return readerStateSchema.parse({}); }
    const value = parsed.data; const lessons = new Set(state.lessons.map(lesson => lesson.id));
    value.selectedLessonId = lessons.has(value.selectedLessonId) ? value.selectedLessonId : null;
    value.viewedLessonIds = [...new Set(value.viewedLessonIds)].filter(id => lessons.has(id));
    value.understoodLessonIds = [...new Set(value.understoodLessonIds)].filter(id => lessons.has(id));
    if (value.readerPosition) {
      try { if (!this.project(state.projectId).repositories.some(repo => repo.id === value.readerPosition.repoId)) fail('REPO_NOT_BOUND', '仓库未绑定'); safeRelative(value.readerPosition.path); }
      catch { value.readerPosition = null; }
    }
    return value;
  }
  async updateReaderState(raw, guard) {
    const args = updateReaderStateSchema.parse(raw);
    return this.lock(args.sessionId, async () => {
      guard?.(); const state = clone(this.session(args.sessionId)); const previous = this.restoredReaderState(state);
      if (previous.revision !== args.expectedRevision) fail('STALE_READER_STATE', '阅读位置已由另一页面更新，请刷新后再保存');
      const next = readerStateSchema.parse({ ...previous, ...args.patch });
      const lessons = new Set(state.lessons.map(lesson => lesson.id));
      for (const id of [next.selectedLessonId, ...next.viewedLessonIds, ...next.understoodLessonIds].filter(Boolean)) if (!lessons.has(id)) fail('LESSON_NOT_FOUND', '知识点不属于当前阅读会话');
      next.viewedLessonIds = [...new Set(next.viewedLessonIds)]; next.understoodLessonIds = [...new Set(next.understoodLessonIds)];
      if (next.readerPosition) { this.repo(state.id, next.readerPosition.repoId); safeRelative(next.readerPosition.path); }
      if (JSON.stringify(next) === JSON.stringify(previous)) return clone(previous);
      if (previous.revision >= Number.MAX_SAFE_INTEGER) fail('READER_STATE_LIMIT', '阅读位置版本达到上限，请新建会话');
      next.revision++; state.readerState = next;
      await this.audit(state.id, 'reader-state-save-attempt', { revision: next.revision, fields: Object.keys(args.patch) });
      guard?.(); await this.saveState(state, guard); return clone(next);
    });
  }
  async updateReadingMode(id, mode, guard, intent, focus) {
    if (mode !== undefined) readingModeSchema.parse(mode);
    if (intent !== undefined) promptIntentSchema.parse(intent);
    return this.lock(id, async () => {
      guard?.(); const state = clone(this.assertUnarchived(id)); const next = mode ?? state.readingMode ?? 'question'; const nextIntent = intent ?? state.intent ?? 'explain';
      const nextFocus = focus === undefined ? state.readingFocus ?? null : parseReadingFocus(focus, this.project(state.projectId));
      const changedMode = state.readingMode !== next;
      if (!changedMode && state.intent === nextIntent && JSON.stringify(state.readingFocus ?? null) === JSON.stringify(nextFocus)) return next;
      if (changedMode && state.readingModeRevision >= Number.MAX_SAFE_INTEGER) fail('READING_MODE_LIMIT', '阅读模式版本达到上限，请新建会话');
      state.readingMode = next; state.intent = nextIntent; state.readingFocus = nextFocus; state.readingModeRevision = (state.readingModeRevision ?? 0) + Number(changedMode);
      await this.audit(id, 'reading-mode-save-attempt', { readingMode: next, readingModeRevision: state.readingModeRevision, intent: nextIntent, hasReadingFocus: !!nextFocus });
      await this.saveState(state, guard); return next;
    });
  }
  async saveState(state, guard, promoting = false) {
    if (this.session(state.id).draft && !state.draft && !promoting) fail('SESSION_DRAFT', '草稿只能由明确发起阅读操作持久化');
    if (state.draft) { guard?.(); this.session(state.id); this.sessions.set(state.id, clone(state)); return; }
    const dir = this.sessionDir(state.id); await this.writable(dir, promoting ? state.id : undefined); guard?.();
    await atomicText(path.join(dir, 'state.json'), json(state), undefined, guard); this.sessions.set(state.id, clone(state));
  }
  async audit(id, action, fields = {}) {
    // Draft browsing is ephemeral. Retain only bounded evidence-read metadata for promotion.
    const state = this.session(id);
    if (state.draft) {
      if (action === 'read') { const rows = this.draftReadAudits.get(id) ?? new Map(); if (rows.size >= 500 && !rows.has(fields.evidenceId)) fail('EVIDENCE_LIMIT', '此阅读草稿的证据审计已达上限'); rows.set(fields.evidenceId, { time: new Date().toISOString(), ...clone(fields) }); this.draftReadAudits.set(id, rows); }
      return;
    }
    const dir = this.sessionDir(id); await this.writable(dir); await appendAudit(path.join(dir, 'audit.jsonl'), { time: new Date().toISOString(), projectId: state.projectId, sessionId: id, action, ...fields });
  }
  async flushDraftReads(id, guard) {
    const rows = this.draftReadAudits.get(id); if (!rows) return;
    for (const [key, fields] of rows) { guard?.(); await this.audit(id, 'read', fields); rows.delete(key); }
    if (!rows.size) this.draftReadAudits.delete(id);
  }
  async createProject(raw) {
    const request = createProjectSchema.parse(raw);
    return this.lock('projects', async () => {
      const repositories = [];
      for (const input of request.repositories) {
        const binding = await bindDirectory(input.path); assertDisjoint(this.root, binding.root);
        for (const previous of repositories) if (contains(previous.root, binding.root) || contains(binding.root, previous.root)) fail('DUPLICATE_REPOSITORY', '同一个阅读项目中的仓库必须互不嵌套且不能重复');
        repositories.push({ id: makeId('repo'), name: input.name || directoryName(binding.root, 60), ...binding, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) });
      }
      const project = { id: makeId('project'), title: request.title || directoryName(repositories[0].root, 120), createdAt: new Date().toISOString(), bindingRevision: 1, codeMapOnboarding: true, repositories };
      const dir = this.projectDir(project.id); await this.writable(dir);
      await ensurePlainDirectory(path.join(dir, 'sessions')); await atomicText(path.join(dir, 'project.json'), json(project));
      this.projects.set(project.id, project); return clone(project);
    });
  }
  async removeProject(raw, guard, busy = () => false) {
    const args = z.object({ projectId: idSchema, expectedBindingRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict().parse(raw);
    return this.lock('projects', () => this.lock('sessions', async () => {
      guard?.(); const project = this.projects.get(args.projectId);
      if (!project) fail('PROJECT_NOT_FOUND', '阅读项目不存在');
      if (project.bindingRevision !== args.expectedBindingRevision) fail('STALE_BINDING_REVISION', '仓库绑定已变化，请刷新后再移除');
      const result = value => ({ projectId: value.id, removedAt: value.removedAt });
      if (project.removedAt) return result(project);
      const ids = [...this.sessions.values()].filter(state => state.projectId === project.id).map(state => state.id).sort();
      const current = () => { guard?.(); if (ids.some(id => busy(id))) fail('AGENT_BUSY', '此仓库仍有阅读正在进行，请先停止或等待结束后再移除'); };
      current();
      // Serialize with session creation, prompt admission, and all in-flight store writes.
      const keys = [...ids.map(id => `admission:${id}`), ...ids, `code-map:${project.id}`];
      const locked = index => index === keys.length ? commit() : this.lock(keys[index], () => locked(index + 1));
      const commit = async () => {
        current(); const next = { ...clone(project), removedAt: new Date().toISOString() }; const dir = this.projectDir(project.id);
        await this.writable(dir); current();
        // Only the fixed metadata file changes. Source roots and archive directories are never deleted or moved.
        await atomicText(path.join(dir, 'project.json'), json(next), undefined, current);
        this.projects.set(project.id, next);
        for (const id of ids) { this.draftReadAudits.delete(id); this.archiveErrors.delete(id); }
        return result(next);
      };
      return locked(0);
    }));
  }
  async createSession(projectId, { draft = false, modelSelection = null, modelSelectionManaged = false, codeMapTask = null } = {}, guard) {
    z.boolean().parse(draft); z.boolean().parse(modelSelectionManaged);
    if (codeMapTask) codeMapTask = mapTaskSchema.parse(codeMapTask);
    if (modelSelectionManaged) modelSelection = modelRefSchema.parse(modelSelection);
    return this.lock('sessions', async () => {
      guard?.(); const project = this.project(projectId); for (const repo of project.repositories) { await checkBinding(repo); guard?.(); }
      const drafts = [...this.sessions.values()].filter(state => state.draft);
      if (draft && drafts.length >= 100) { const oldest = drafts[0].id; this.sessions.delete(oldest); this.draftReadAudits.delete(oldest); this.archiveErrors.delete(oldest); }
      const state = { id: makeId('reading'), projectId, ...(codeMapTask ? { codeMapTask: clone(codeMapTask) } : {}), draft, archivedAt: null, archiveRevision: 0, ...(draft ? { draftModelSelection: clone(modelSelection) } : {}), ...(modelSelectionManaged ? { modelSelectionManaged: true, ...(!draft ? { nativePending: true, pendingNativeModel: clone(modelSelection) } : {}) } : {}), revision: 1, stage: 'discover', topic: '', readingMode: 'question', readingModeRevision: 0, intent: 'explain', readingFocus: null, readerState: readerStateSchema.parse({}), createdAt: new Date().toISOString(), evidence: [], lessons: [], messageRefs: [], archiveSeq: -1, stageHistory: [{ revision: 1, stage: 'discover', topic: '', time: new Date().toISOString() }], publishReceipts: {} };
      guard?.(); this.sessions.set(state.id, state);
      if (draft) return clone(state);
      try { for (const dir of ['', 'notes', 'diagrams', 'messages', 'exports']) { guard?.(); await this.writable(path.join(this.sessionDir(state.id), dir)); } await this.saveState(state, guard); await this.audit(state.id, 'session-created', { bindingRevision: project.bindingRevision }); return clone(state); } catch (error) { this.sessions.delete(state.id); throw error; }
    });
  }
  async persistDraft(id, guard) {
    return this.lock(id, async () => {
      guard?.(); const state = clone(this.assertUnarchived(id)); if (!state.draft) { await this.flushDraftReads(id, guard); return state; }
      const project = this.project(state.projectId); for (const repo of project.repositories) { await checkBinding(repo); guard?.(); }
      state.draft = false; state.nativePending = true; state.pendingNativeModel = clone(state.draftModelSelection); delete state.draftModelSelection;
      for (const dir of ['', 'notes', 'diagrams', 'messages', 'exports']) { guard?.(); await this.writable(path.join(this.sessionDir(id), dir), id); }
      await this.saveState(state, guard, true); await this.audit(id, 'session-created', { bindingRevision: project.bindingRevision }); await this.flushDraftReads(id, guard); return clone(state);
    });
  }
  async completeNativeSession(id, guard) {
    return this.lock(id, async () => { guard?.(); const state = clone(this.session(id)); if (!state.nativePending) return; delete state.nativePending; delete state.pendingNativeModel; await this.saveState(state, guard); });
  }
  async selectDraftModel(raw, guard) {
    const args = modelSchema.parse(raw);
    return this.lock(args.sessionId, async () => {
      guard?.(); const state = clone(this.assertUnarchived(args.sessionId)); if (!state.draft && !state.nativePending) fail('SESSION_NOT_DRAFT', '此阅读会话已经发起');
      state[state.draft ? 'draftModelSelection' : 'pendingNativeModel'] = { provider: args.provider, model: args.model };
      await this.saveState(state, guard); return { selected: args };
    });
  }
  async discardDraft(id, guard) {
    idSchema.parse(id);
    return this.lock(id, async () => {
      guard?.(); const state = this.sessions.get(id); if (!state) return { sessionId: id, discarded: false };
      if (!state.draft) fail('SESSION_NOT_DRAFT', '已发起的阅读会话不能作为草稿丢弃，请改为归档');
      this.sessions.delete(id); this.archiveErrors.delete(id); this.draftReadAudits.delete(id); return { sessionId: id, discarded: true };
    });
  }
  async setSessionArchived(raw, guard) {
    const args = z.object({ sessionId: idSchema, archived: z.boolean(), expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict().parse(raw);
    return this.lock(args.sessionId, async () => {
      guard?.(); const state = clone(this.assertPersisted(args.sessionId));
      const result = () => ({ sessionId: state.id, archivedAt: state.archivedAt ?? null, archiveRevision: state.archiveRevision ?? 0 });
      if (!!state.archivedAt === args.archived) return result();
      if ((state.archiveRevision ?? 0) !== args.expectedRevision) fail('STALE_ARCHIVE_REVISION', '阅读会话归档状态已变化，请刷新后重试');
      if (state.archiveRevision >= Number.MAX_SAFE_INTEGER) fail('ARCHIVE_REVISION_LIMIT', '阅读会话归档版本已达上限');
      state.archivedAt = args.archived ? new Date().toISOString() : null; state.archiveRevision = (state.archiveRevision ?? 0) + 1;
      await this.audit(state.id, 'session-archive-attempt', { archived: args.archived, archiveRevision: state.archiveRevision });
      await this.saveState(state, guard); return result();
    });
  }
  list() { return { root: this.root, diagnostics: [...this.diagnostics], projects: [...this.projects.values()].filter(p => !p.removedAt).map(p => ({ ...clone(p), sessions: [...this.sessions.values()].filter(s => s.projectId === p.id && !s.draft).map(s => ({ id: s.id, draft: false, archivedAt: s.archivedAt ?? null, archiveRevision: s.archiveRevision ?? 0, stage: s.stage, topic: s.topic, readingMode: s.readingMode ?? 'question', intent: s.intent ?? 'explain', createdAt: s.createdAt, revision: s.revision })) })) }; }
  catalog(id) { const state = this.session(id); return { sessionId: id, ...(this.codeMapContexts?.has(state.projectId) ? { codeMap: clone(this.codeMapContexts.get(state.projectId)) } : {}), ...(state.codeMapTask ? { codeMapTask: clone(state.codeMapTask) } : {}), draft: !!state.draft, archivedAt: state.archivedAt ?? null, archiveRevision: state.archiveRevision ?? 0, project: clone(this.project(state.projectId)), stage: state.stage, topic: state.topic, revision: state.revision, readingMode: state.readingMode ?? 'question', readingModeRevision: state.readingModeRevision ?? 0, intent: state.intent ?? 'explain', readingFocus: clone(state.readingFocus ?? null), outputDirectory: this.sessionDir(id), limits: { fileBytes: 1048576, evidence: 500, lessons: 100 }, instructions: '每次显式指定 repoId。readingMode 是阅读起点，本轮明确意图优先；选区始终从 code 阅读开始。intent 仅标识本轮：logic-graph 必须围绕当前已核验选区生成有证据的逻辑图，explain 不强制绘图。代码归档 codeUnits 最少完整方法/函数，必要时完整类或整文件；先连续读取完整范围，保留 UTF16 start/end 排他坐标、哈希、结论和覆盖证据。本轮 readingFocus 若为代码须被单元完整包含，不可因 claims 漏写选区而跳过。语义边界由 AI 据语言识别，Host 只核验字节/坐标/证据覆盖，非通用 AST。明确文档/数据路径可豁免；未知扩展仍按代码。stage 仅保留兼容状态；五个维度按问题需要组合，没有固定顺序。discover 仅用于模糊宽泛目标，verify 仅用户明确要求时使用；发布一个知识点后等待用户。' }; }
  async read(id, raw, signal) {
    const args = readSchema.parse(raw);
    return this.lock(id, async () => {
      signal?.throwIfAborted(); const repo = this.repo(id, args.repoId); const result = await readRepository(repo, args.path);
      if (args.offset > result.lines.length) fail('LINE_RANGE', '起始行超出文件范围');
      const excerpt = result.lines.slice(args.offset - 1, args.offset - 1 + args.limit);
      if (excerpt.join('\n').length > 100000) fail('EXCERPT_LIMIT', '选定范围过大，请减少读取行数');
      if (args.symbol && !excerpt.join('\n').includes(args.symbol)) fail('SYMBOL_NOT_FOUND', '指定符号未出现在此行范围中；请调整范围或不填 symbol');
      const state = clone(this.session(id));
      let evidence = state.evidence.find(e => e.repoId === repo.id && e.path === args.path && e.hash === result.hash && e.startLine === args.offset && e.endLine === args.offset + excerpt.length - 1 && e.symbol === (args.symbol ?? ''));
      if (!evidence) {
        if (state.evidence.length >= 500) fail('EVIDENCE_LIMIT', '此阅读会话已有 500 条证据，请新建阅读会话');
        evidence = { id: makeId('evidence'), sessionId: id, projectId: state.projectId, bindingRevision: 1, repoId: repo.id, path: args.path, hash: result.hash, startLine: args.offset, endLine: args.offset + excerpt.length - 1, symbol: args.symbol ?? '', bytes: result.bytes, readAt: new Date().toISOString() };
        state.evidence.push(evidence);
      }
      signal?.throwIfAborted(); await this.audit(id, 'read', { repoId: repo.id, path: args.path, hash: result.hash, startLine: evidence.startLine, endLine: evidence.endLine, bytes: result.bytes, evidenceId: evidence.id });
      await this.saveState(state);
      return { evidence, repoName: repo.name, totalLines: result.lines.length, lines: excerpt.map((text, i) => ({ number: args.offset + i, text })), citation: `[${repo.name}:${args.path}:${evidence.startLine}–${evidence.endLine}](evidence://${evidence.id})` };
    });
  }
  async files(id, raw, signal) {
    const args = filesSchema.parse(raw);
    return this.lock(id, async () => {
      const repo = this.repo(id, args.repoId); const result = await listRepository(repo, signal); const matches = result.files.filter(p => p.toLowerCase().includes(args.filter.toLowerCase()));
      await this.audit(id, 'files', { repoId: repo.id, visited: result.visited, returned: Math.min(matches.length, args.limit), filterHash: digest(args.filter) });
      return { repoId: repo.id, paths: matches.slice(0, args.limit), truncated: result.truncated || matches.length > args.limit, totalInScan: matches.length, note: '默认排除依赖、构建目录、链接和敏感配置；扫描不是完整仓库快照' };
    });
  }
  async search(id, raw, signal) {
    const args = searchSchema.parse(raw);
    return this.lock(id, async () => {
      const repo = this.repo(id, args.repoId); const inventory = await listRepository(repo, signal);
      const candidates = inventory.files.filter(p => p.toLowerCase().includes(args.pathFilter.toLowerCase()));
      const query = args.caseSensitive ? args.query : args.query.toLowerCase(); const matches = []; const scanned = []; let bytes = 0; let truncated = inventory.truncated;
      for (const file of candidates) {
        signal?.throwIfAborted();
        if (scanned.length >= 2000 || bytes >= 16777216 || matches.length >= args.limit) { truncated = true; break; }
        let result;
        try { result = await readRepository(repo, file, { maxBytes: 16777216 - bytes }); } catch (error) { if (error.code === 'SEARCH_BUDGET') { scanned.push({ path: file, skipped: error.code }); truncated = true; break; } if (['FILE_LIMIT', 'FILE_ALIAS', 'BINARY_FILE', 'ENCODING', 'ENOENT'].includes(error.code)) { scanned.push({ path: file, skipped: error.code }); continue; } throw error; }
        bytes += result.bytes; scanned.push({ path: file, hash: result.hash, bytes: result.bytes });
        for (let i = 0; i < result.lines.length; i++) if ((args.caseSensitive ? result.lines[i] : result.lines[i].toLowerCase()).includes(query)) {
          matches.push({ repoId: repo.id, path: file, line: i + 1, text: result.lines[i].slice(0, 1000), truncatedLine: result.lines[i].length > 1000 });
          if (matches.length >= args.limit) { truncated = true; break; }
        }
      }
      await this.audit(id, 'search', { repoId: repo.id, queryHash: digest(args.query), files: scanned, scannedBytes: bytes, returned: matches.length, truncated });
      return { matches, truncated, scannedFiles: scanned.length, note: '字面量检索，不执行正则；搜索命中还不是证据，请 reading_read 核验' };
    });
  }
  async evidenceStatus(id, evidenceId) {
    const evidence = this.session(id).evidence.find(e => e.id === evidenceId);
    if (!evidence) fail('EVIDENCE_NOT_FOUND', '证据不属于当前阅读会话');
    try { const result = await readRepository(this.repo(id, evidence.repoId), evidence.path); return { evidence: clone(evidence), stale: result.hash !== evidence.hash, currentHash: result.hash, lines: result.lines.slice(evidence.startLine - 1, evidence.endLine).map((text, i) => ({ number: evidence.startLine + i, text })) }; } catch (error) { return { evidence: clone(evidence), stale: true, reason: error.code ?? error.message, lines: [] }; }
  }
  async openEvidence(id, evidenceId) { return this.lock(id, async () => { const result = await this.evidenceStatus(id, evidenceId); await this.audit(id, 'evidence-opened', { evidenceId, stale: result.stale, ...(result.currentHash ? { currentHash: result.currentHash } : {}) }); return result; }); }
  async publish(id, raw, receipt, turn, guard) {
    const args = publishSchema.parse(raw); const mermaid = validateMermaid(args.mermaid);
    return this.lock(id, async () => {
      guard?.(); this.assertPersisted(id); const state = clone(this.assertUnarchived(id));
      // Empty additive defaults must not change old publication receipt bytes.
      const { sections, codeUnits, ...legacyPayload } = args;
      const payloadHash = digest(JSON.stringify({ ...legacyPayload, ...(sections.length ? { sections } : {}), ...(codeUnits.length ? { codeUnits } : {}) }));
      if (receipt && state.publishReceipts[receipt]) {
        const saved = state.publishReceipts[receipt];
        if (saved.payloadHash !== payloadHash) fail('RECEIPT_CONFLICT', '相同发布调用凭据不能对应不同内容');
        return clone(state.lessons.find(l => l.id === saved.lessonId));
      }
      if (state.intent === 'logic-graph') {
        const body = mermaid.replace(/^\s*(sequenceDiagram|flowchart\s+(?:TD|TB|BT|LR|RL)|classDiagram|stateDiagram-v2|erDiagram)\b/, '').replace(/;/g, '').split('\n').filter(line => !/^\s*%%/.test(line)).join('\n').trim();
        if (!body) fail('GRAPH_REQUIRED', '本轮生成逻辑图必须提供安全、非空的 mermaid 图内容；请继续取证后重试，不能归档无图结果');
      }
      if (state.revision !== args.expectedRevision) fail('STALE_REVISION', '阶段或主题已变化，请重新读取 reading_catalog');
      if (state.lessons.length >= 100) fail('LESSON_LIMIT', '此会话已有 100 个知识点，请新建阅读会话');
      if (turn !== undefined && state.lessons.some(l => l.turn === turn)) fail('ONE_TOPIC_PER_TURN', '每轮只保存一个知识点，等待用户后继续');
      const refs = [...new Set([...args.claims.flatMap(c => c.evidenceIds), ...args.topics.flatMap(t => t.evidenceIds), ...codeUnits.flatMap(unit => unit.evidenceIds)])];
      if (state.codeMapTask && !state.lessons.length && !refs.length) fail('CODE_MAP_EVIDENCE_REQUIRED', '代码地图需要实际读取的证据，不能只以假设标记生成完成');
      if (refs.length > 40) fail('LESSON_EVIDENCE_LIMIT', '一个知识点最多引用 40 条证据，请拆成下一轮');
      for (const evidenceId of refs) { const status = await this.evidenceStatus(id, evidenceId); if (status.stale) fail('STALE_EVIDENCE', '代码已变动或无法读取，重新取证后再发布'); }
      const verifiedUnits = await verifyCodeUnits(this, state, codeUnits, refs);
      const lesson = { id: makeId('lesson'), ...args, codeUnits: verifiedUnits, readingFocus: clone(state.readingFocus ?? null), ...(mermaid ? { mermaid } : {}), stage: state.stage, topic: state.topic, readingMode: state.readingMode ?? 'question', intent: state.intent ?? 'explain', revision: state.revision, createdAt: new Date().toISOString(), ...(turn === undefined ? {} : { turn }) };
      if (!mermaid) delete lesson.mermaid;
      const positions = refs.map(evidenceId => state.evidence.find(e => e.id === evidenceId));
      const note = `# ${lesson.title}\n\n兼容分类：${STAGE_LABELS[state.stage]} · 阅读入口：${lesson.readingMode} · 主题：${state.topic || '当前问题'}\n\n${lesson.markdown}${sectionMarkdown(lesson, 2)}${codeUnitsMarkdown(lesson)}\n\n## 核心结论\n\n${lesson.conclusion}\n\n## 证据与结论类型\n\n${lesson.claims.map(c => `- **${c.kind}**：${c.text}（${c.evidenceIds.join(', ') || '缺少证据'}）`).join('\n')}\n\n${positions.map(e => `- ${e.id} · ${e.repoId}:${e.path}:${e.startLine}–${e.endLine} · ${e.symbol || '无符号线索'} · SHA256 ${e.hash}`).join('\n')}\n${mermaid ? `\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n` : ''}\n## 建议下一个问题\n\n${lesson.nextQuestions.map(q => `- ${q}`).join('\n')}\n`;
      const dir = this.sessionDir(id); const graph = lesson.intent === 'logic-graph'; const written = [];
      const expected = new Set([path.resolve(dir, 'notes', `${lesson.id}.md`), path.resolve(dir, 'diagrams', `${lesson.id}.mmd`)]);
      const writeArtifact = async (file, text, max) => {
        if (graph) {
          // Never overwrite or later clean up a preexisting file, even on a UUID collision.
          try { await fs.lstat(file); fail('OUTPUT_EXISTS', '逻辑图产物路径已存在，拒绝覆盖'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        await atomicText(file, text, max, guard);
        if (graph) written.push({ file: path.resolve(file), stat: await fs.lstat(file) });
      };
      try {
        await this.writable(path.join(dir, 'notes')); await writeArtifact(path.join(dir, 'notes', `${lesson.id}.md`), note, 1048576);
        if (mermaid) { await this.writable(path.join(dir, 'diagrams')); await writeArtifact(path.join(dir, 'diagrams', `${lesson.id}.mmd`), `${mermaid}\n`, 20000); }
        await this.audit(id, graph ? 'lesson-publish-attempt' : 'lesson-published', { lessonId: lesson.id, stage: state.stage, revision: state.revision, evidenceIds: refs });
        state.lessons.push(lesson); if (receipt) state.publishReceipts[receipt] = { lessonId: lesson.id, payloadHash }; await this.saveState(state, guard); return clone(lesson);
      } catch (error) {
        const committed = this.session(id);
        if (graph && !committed.lessons.some(item => item.id === lesson.id) && !Object.values(committed.publishReceipts).some(item => item.lessonId === lesson.id)) {
          for (const owned of written) {
            try {
              // Exact paths are tied to this newly allocated lesson UUID, never a caller path.
              if (!expected.has(owned.file) || !contains(dir, owned.file)) fail('OUTPUT_DENIED', '逻辑图清理路径不属于本次发布');
              await checkBinding(this.storageBinding); await checkPlain(owned.file); const current = await fs.lstat(owned.file);
              if (!current.isFile() || current.nlink !== 1 || current.dev !== owned.stat.dev || current.ino !== owned.stat.ino || current.size !== owned.stat.size || current.mtimeMs !== owned.stat.mtimeMs) fail('OUTPUT_CHANGED', '逻辑图产物已变化，保留文件以供检查');
              await fs.unlink(owned.file);
            } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') error.message += '；本次逻辑图未提交，产物清理受阻，请检查阅读档案目录'; }
          }
        }
        throw error;
      }
    });
  }
  async changeStage(raw, guard) {
    const args = changeStageSchema.parse(raw);
    return this.lock(args.sessionId, async () => {
      guard?.(); const state = clone(this.assertUnarchived(args.sessionId)); if (state.revision !== args.expectedRevision) fail('STALE_REVISION', '阅读状态已变化，请刷新后重试');
      if (state.stageHistory.length >= 500) fail('STAGE_LIMIT', '阶段历史已达上限，请新建会话');
      state.revision++; state.stage = args.stage; state.topic = args.topic; state.stageHistory.push({ revision: state.revision, stage: state.stage, topic: state.topic, time: new Date().toISOString() });
      await this.audit(state.id, 'human-stage-selected', { stage: state.stage, revision: state.revision, topicHash: digest(state.topic) }); await this.saveState(state, guard); return this.catalog(state.id);
    });
  }
  async archiveEvents(id, events) {
    return this.lock(id, async () => {
      const state = clone(this.assertPersisted(id));
      if (events.some((event, index) => event.seq !== index)) fail('ARCHIVE_GAP', '归档必须重放从 0 开始的完整连续 DSH 事件前缀');
      for (const event of events) {
        if (event.seq <= state.archiveSeq) continue;
        if (event.type === 'user/message' || event.type === 'assistant/message') {
          const message = event.type === 'user/message' ? event.data : event.data.message;
          const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
          if (text) {
            if (state.messageRefs.length >= 2000 || text.length > 200000) fail('TRANSCRIPT_LIMIT', '对话归档达到上限；请新建会话');
            const dir = path.join(this.sessionDir(id), 'messages'); await this.writable(dir);
            const item = { seq: event.seq, time: event.time, role: message.role, text, ...(event.data.turn ? { turn: event.data.turn } : {}) };
            await atomicText(path.join(dir, `${event.seq}.json`), json(item), 1000000);
            state.messageRefs.push({ seq: event.seq, role: message.role });
          }
        }
        state.archiveSeq = event.seq;
      }
      await this.saveState(state); this.archiveErrors.delete(id);
    }).catch(error => { this.archiveErrors.set(id, error.message); throw error; });
  }
  async snapshot(id, beforeSeq) {
    const state = clone(this.session(id)); state.readerState = this.restoredReaderState(state); const selected = state.messageRefs.filter(m => beforeSeq === undefined || m.seq < beforeSeq).slice(-80); const messages = [];
    for (const item of selected) { const file = path.join(this.sessionDir(id), 'messages', `${item.seq}.json`); await checkPlain(file); messages.push(JSON.parse(await fs.readFile(file, 'utf8'))); }
    return { ...this.catalog(id), state, messages, hasMoreMessages: selected.length > 0 && state.messageRefs[0]?.seq < selected[0]?.seq, archiveError: this.archiveErrors.get(id) ?? null };
  }
  async exportSession(id) {
    return this.lock(id, async () => {
      const state = this.assertPersisted(id); const project = this.project(state.projectId);
      let text = `# ${project.title} — 阅读档案\n\n会话：${id}\n\n## 仓库绑定\n\n${project.repositories.map(r => `- ${r.name} (${r.id})：${r.root}`).join('\n')}\n\n## 阅读知识点\n\n${state.lessons.map(l => `### ${l.title}\n\n${l.markdown}${sectionMarkdown(l, 4)}${codeUnitsMarkdown(l, 4)}\n\n**核心结论**：${l.conclusion}\n${l.mermaid ? `\n\`\`\`mermaid\n${l.mermaid}\n\`\`\`\n` : ''}`).join('\n\n')}\n\n## 证据索引\n\n${state.evidence.map(e => `- ${e.id} · ${e.repoId}:${e.path}:${e.startLine}–${e.endLine} · SHA256 ${e.hash}`).join('\n')}\n\n> 历史证据对应读取时的版本，不是当前源码承诺。阅读调用未运行项目；多个仓库不是原子快照。\n`;
      text += annotationMarkdown((await loadAnnotations(this, id)).items);
      const dir = path.join(this.sessionDir(id), 'exports'); await this.writable(dir); const file = path.join(dir, 'reading.md'); await atomicText(file, text); await this.audit(id, 'exported'); return { path: file, markdown: text };
    });
  }
}
