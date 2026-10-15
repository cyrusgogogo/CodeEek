import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProjectSchema, readSchema, filesSchema, searchSchema, publishSchema, changeStageSchema, idSchema, STAGE_LABELS, validateMermaid, fail } from './contracts.mjs';
import { bindDirectory, checkBinding, checkPlain, assertDisjoint, contains, readRepository, listRepository, ensurePlainDirectory, atomicText, appendAudit, digest } from './filesystem.mjs';

const makeId = prefix => `${prefix}-${randomUUID()}`;
const clone = value => structuredClone(value);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const RUNTIME_KEY = Symbol.for('dsh-code-reading.runtime.v1');
const RUNTIMES = globalThis[RUNTIME_KEY] ??= new WeakMap();
export function peekRuntime(root) { return RUNTIMES.get(root); }
export function setRuntime(root, runtime) { RUNTIMES.set(root, runtime); }
export function getRuntime(root) { const runtime = RUNTIMES.get(root); if (!runtime) fail('READING_UNAVAILABLE', '阅读模式 Host 未启动'); return runtime; }

export class ReadingStore {
  constructor(root) { this.root = path.resolve(root); this.projects = new Map(); this.sessions = new Map(); this.locks = new Map(); this.diagnostics = []; this.archiveErrors = new Map(); }
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
        this.projects.set(project.id, project);
        const dir = path.join(this.projectDir(project.id), 'sessions'); await checkPlain(dir);
        for (const folder of await fs.readdir(dir, { withFileTypes: true })) {
          if (!folder.isDirectory() || !folder.name.startsWith('reading-')) continue;
          idSchema.parse(folder.name);
          const stateFile = path.join(dir, folder.name, 'state.json'); await checkPlain(stateFile);
          const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
          if (state.id !== folder.name || state.projectId !== project.id || !Number.isSafeInteger(state.revision) || !Array.isArray(state.evidence) || !Array.isArray(state.lessons) || !Array.isArray(state.messageRefs)) fail('CORRUPT_SESSION', '阅读会话档案无效');
          this.sessions.set(state.id, state);
        }
      } catch (error) { this.diagnostics.push(`${entry.name}: ${error.message}`); }
    }
    return this;
  }
  projectDir(id) { idSchema.parse(id); return path.join(this.root, 'projects', id); }
  sessionDir(id) { const state = this.session(id); return path.join(this.projectDir(state.projectId), 'sessions', id); }
  session(id) { idSchema.parse(id); const state = this.sessions.get(id); if (!state) fail('READING_NOT_FOUND', '没有此阅读会话，请从阅读代码页面新建'); return state; }
  project(id) { idSchema.parse(id); const project = this.projects.get(id); if (!project) fail('PROJECT_NOT_FOUND', '阅读项目不存在'); return project; }
  repo(sessionId, repoId) { const project = this.project(this.session(sessionId).projectId); const repo = project.repositories.find(r => r.id === repoId); if (!repo) fail('REPO_NOT_BOUND', '此仓库未绑定到当前阅读项目'); return repo; }
  async lock(key, operation) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation); this.locks.set(key, next);
    try { return await next; } finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }
  async writable(directory) {
    await checkBinding(this.storageBinding);
    for (const project of this.projects.values()) for (const repo of project.repositories) assertDisjoint(this.root, repo.root);
    if (!contains(this.root, directory)) fail('OUTPUT_DENIED', '产物路径超出固定阅读目录');
    await ensurePlainDirectory(directory); await checkBinding(this.storageBinding);
  }
  async saveState(state) { const dir = this.sessionDir(state.id); await this.writable(dir); await atomicText(path.join(dir, 'state.json'), json(state)); this.sessions.set(state.id, clone(state)); }
  async audit(id, action, fields = {}) { const dir = this.sessionDir(id); await this.writable(dir); await appendAudit(path.join(dir, 'audit.jsonl'), { time: new Date().toISOString(), projectId: this.session(id).projectId, sessionId: id, action, ...fields }); }
  async createProject(raw) {
    const request = createProjectSchema.parse(raw);
    return this.lock('projects', async () => {
      const repositories = [];
      for (const input of request.repositories) {
        const binding = await bindDirectory(input.path); assertDisjoint(this.root, binding.root);
        for (const previous of repositories) if (contains(previous.root, binding.root) || contains(binding.root, previous.root)) fail('DUPLICATE_REPOSITORY', '同一个阅读项目中的仓库必须互不嵌套且不能重复');
        repositories.push({ id: makeId('repo'), name: input.name, ...binding, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) });
      }
      const project = { id: makeId('project'), title: request.title, createdAt: new Date().toISOString(), bindingRevision: 1, repositories };
      const dir = this.projectDir(project.id); await this.writable(dir);
      await ensurePlainDirectory(path.join(dir, 'sessions')); await atomicText(path.join(dir, 'project.json'), json(project));
      this.projects.set(project.id, project); return clone(project);
    });
  }
  async createSession(projectId) {
    const project = this.project(projectId); for (const repo of project.repositories) await checkBinding(repo);
    const state = { id: makeId('reading'), projectId, revision: 1, stage: 'discover', topic: '', createdAt: new Date().toISOString(), evidence: [], lessons: [], messageRefs: [], archiveSeq: -1, stageHistory: [{ revision: 1, stage: 'discover', topic: '', time: new Date().toISOString() }], publishReceipts: {} };
    this.sessions.set(state.id, state);
    try { for (const dir of ['', 'notes', 'diagrams', 'messages', 'exports']) await this.writable(path.join(this.sessionDir(state.id), dir)); await this.saveState(state); await this.audit(state.id, 'session-created', { bindingRevision: project.bindingRevision }); return clone(state); } catch (error) { this.sessions.delete(state.id); throw error; }
  }
  list() { return { root: this.root, diagnostics: [...this.diagnostics], projects: [...this.projects.values()].map(p => ({ ...clone(p), sessions: [...this.sessions.values()].filter(s => s.projectId === p.id).map(s => ({ id: s.id, stage: s.stage, topic: s.topic, createdAt: s.createdAt, revision: s.revision })) })) }; }
  catalog(id) { const state = this.session(id); return { sessionId: id, project: clone(this.project(state.projectId)), stage: state.stage, topic: state.topic, revision: state.revision, outputDirectory: this.sessionDir(id), limits: { fileBytes: 1048576, evidence: 500, lessons: 100 }, instructions: '每次显式指定 repoId。阶段只能由用户改变；发布一个知识点后等待用户。' }; }
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
  async publish(id, raw, receipt, turn) {
    const args = publishSchema.parse(raw); const mermaid = validateMermaid(args.mermaid);
    return this.lock(id, async () => {
      const state = clone(this.session(id));
      const payloadHash = digest(JSON.stringify(args));
      if (receipt && state.publishReceipts[receipt]) {
        const saved = state.publishReceipts[receipt];
        if (saved.payloadHash !== payloadHash) fail('RECEIPT_CONFLICT', '相同发布调用凭据不能对应不同内容');
        return clone(state.lessons.find(l => l.id === saved.lessonId));
      }
      if (state.revision !== args.expectedRevision) fail('STALE_REVISION', '阶段或主题已变化，请重新读取 reading_catalog');
      if (state.lessons.length >= 100) fail('LESSON_LIMIT', '此会话已有 100 个知识点，请新建阅读会话');
      if (turn !== undefined && state.lessons.some(l => l.turn === turn)) fail('ONE_TOPIC_PER_TURN', '每轮只保存一个知识点，等待用户后继续');
      const refs = [...new Set([...args.claims.flatMap(c => c.evidenceIds), ...args.topics.flatMap(t => t.evidenceIds)])];
      if (refs.length > 40) fail('LESSON_EVIDENCE_LIMIT', '一个知识点最多引用 40 条证据，请拆成下一轮');
      for (const evidenceId of refs) { const status = await this.evidenceStatus(id, evidenceId); if (status.stale) fail('STALE_EVIDENCE', '代码已变动或无法读取，重新取证后再发布'); }
      const lesson = { id: makeId('lesson'), ...args, ...(mermaid ? { mermaid } : {}), stage: state.stage, topic: state.topic, revision: state.revision, createdAt: new Date().toISOString(), ...(turn === undefined ? {} : { turn }) };
      if (!mermaid) delete lesson.mermaid;
      const positions = refs.map(evidenceId => state.evidence.find(e => e.id === evidenceId));
      const note = `# ${lesson.title}\n\n阶段：${STAGE_LABELS[state.stage]} · 主题：${state.topic || '业务发现'}\n\n${lesson.markdown}\n\n## 核心结论\n\n${lesson.conclusion}\n\n## 证据与结论类型\n\n${lesson.claims.map(c => `- **${c.kind}**：${c.text}（${c.evidenceIds.join(', ') || '缺少证据'}）`).join('\n')}\n\n${positions.map(e => `- ${e.id} · ${e.repoId}:${e.path}:${e.startLine}–${e.endLine} · ${e.symbol || '无符号线索'} · SHA256 ${e.hash}`).join('\n')}\n${mermaid ? `\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n` : ''}\n## 建议下一个问题\n\n${lesson.nextQuestions.map(q => `- ${q}`).join('\n')}\n`;
      const dir = this.sessionDir(id); await this.writable(path.join(dir, 'notes')); await atomicText(path.join(dir, 'notes', `${lesson.id}.md`), note, 80000);
      if (mermaid) { await this.writable(path.join(dir, 'diagrams')); await atomicText(path.join(dir, 'diagrams', `${lesson.id}.mmd`), `${mermaid}\n`, 20000); }
      await this.audit(id, 'lesson-published', { lessonId: lesson.id, stage: state.stage, revision: state.revision, evidenceIds: refs });
      state.lessons.push(lesson); if (receipt) state.publishReceipts[receipt] = { lessonId: lesson.id, payloadHash }; await this.saveState(state); return clone(lesson);
    });
  }
  async changeStage(raw) {
    const args = changeStageSchema.parse(raw);
    return this.lock(args.sessionId, async () => {
      const state = clone(this.session(args.sessionId)); if (state.revision !== args.expectedRevision) fail('STALE_REVISION', '阅读状态已变化，请刷新后重试');
      if (state.stageHistory.length >= 500) fail('STAGE_LIMIT', '阶段历史已达上限，请新建会话');
      state.revision++; state.stage = args.stage; state.topic = args.topic; state.stageHistory.push({ revision: state.revision, stage: state.stage, topic: state.topic, time: new Date().toISOString() });
      await this.audit(state.id, 'human-stage-selected', { stage: state.stage, revision: state.revision, topicHash: digest(state.topic) }); await this.saveState(state); return this.catalog(state.id);
    });
  }
  async archiveEvents(id, events) {
    return this.lock(id, async () => {
      const state = clone(this.session(id));
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
    const state = clone(this.session(id)); const selected = state.messageRefs.filter(m => beforeSeq === undefined || m.seq < beforeSeq).slice(-80); const messages = [];
    for (const item of selected) { const file = path.join(this.sessionDir(id), 'messages', `${item.seq}.json`); await checkPlain(file); messages.push(JSON.parse(await fs.readFile(file, 'utf8'))); }
    return { ...this.catalog(id), state, messages, hasMoreMessages: selected.length > 0 && state.messageRefs[0]?.seq < selected[0]?.seq, archiveError: this.archiveErrors.get(id) ?? null };
  }
  async exportSession(id) {
    return this.lock(id, async () => {
      const state = this.session(id); const project = this.project(state.projectId);
      const text = `# ${project.title} — 阅读档案\n\n会话：${id}\n\n## 仓库绑定\n\n${project.repositories.map(r => `- ${r.name} (${r.id})：${r.root}`).join('\n')}\n\n## 阅读知识点\n\n${state.lessons.map(l => `### ${l.title}\n\n${l.markdown}\n\n**核心结论**：${l.conclusion}\n${l.mermaid ? `\n\`\`\`mermaid\n${l.mermaid}\n\`\`\`\n` : ''}`).join('\n\n')}\n\n## 证据索引\n\n${state.evidence.map(e => `- ${e.id} · ${e.repoId}:${e.path}:${e.startLine}–${e.endLine} · SHA256 ${e.hash}`).join('\n')}\n\n> 历史证据对应读取时的版本，不是当前源码承诺。阅读调用未运行项目；多个仓库不是原子快照。\n`;
      const dir = path.join(this.sessionDir(id), 'exports'); await this.writable(dir); const file = path.join(dir, 'reading.md'); await atomicText(file, text); await this.audit(id, 'exported'); return { path: file, markdown: text };
    });
  }
}
