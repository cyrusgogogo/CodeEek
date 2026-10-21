import fs from 'node:fs/promises';
import { constants, lstatSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { idSchema, relativeSchema, fail } from './contracts.mjs';
import { safeRelative, checkBinding, checkPlain, listRepository, readRepository, atomicText, digest, LIMITS } from './filesystem.mjs';
import { collectCodeReadings, restoredCodeUnits, verifyUnitEvidence } from './code-units.mjs';

// A path inventory and archive-navigation index, not an AST, dependency graph,
// evidence producer, or cross-file source snapshot.
export const STRUCTURE_LIMITS = Object.freeze({ files: 8000, inventoryBytes: 1024 * 1024, archiveBytes: 2 * 1024 * 1024, responseBytes: 8 * 1024 * 1024, customLayers: 16, assignments: 128, sessions: 1000, lessons: 5000, references: 40000 });
export const STRUCTURE_LAYERS = Object.freeze([
  { id: 'ui', name: '界面与接口', description: '按 client、ui、api 等目录或界面文件扩展名建议，不代表已核实的架构。' },
  { id: 'core', name: '源码与核心', description: '按源码目录和编程语言扩展名建议，不代表已核实的业务职责。' },
  { id: 'data', name: '数据与基础设施', description: '按 data、storage、infra 等目录名建议，尚未核验实际依赖。' },
  { id: 'tests', name: '测试', description: '按测试目录和文件名建议，不代表已运行测试或验证覆盖。' },
  { id: 'docs', name: '文档', description: '按文档目录和扩展名建议，内容尚未自动读取。' },
  { id: 'config', name: '配置与工程', description: '按工程配置文件名和扩展名建议，不执行任何配置或构建脚本。' },
  { id: 'other', name: '其他', description: '未匹配路径建议规则的文件；不表示无用、不可读或没有业务价值。' }
].map(layer => Object.freeze(layer)));
const fixedIds = new Set(STRUCTURE_LAYERS.map(layer => layer.id));
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sessionId = idSchema.refine(value => value.startsWith('reading-'));
const repoId = idSchema.refine(value => value.startsWith('repo-'));
const projectId = idSchema.refine(value => value.startsWith('project-'));
const layerId = z.string().max(47).refine(value => fixedIds.has(value) || /^custom-[a-z0-9-]{1,40}$/.test(value));
const customLayerSchema = z.object({ id: z.string().regex(/^custom-[a-z0-9-]{1,40}$/), name: z.string().trim().min(1).max(60).regex(/^[^\x00-\x1f]+$/), description: z.string().max(240).default('') }).strict();
const assignmentSchema = z.object({ prefix: z.string().max(1024), layerId }).strict();
const scopeSchema = z.object({ sessionId, repoId }).strict();
const refreshSchema = scopeSchema.extend({ expectedRevision: revisionSchema }).strict();
const updateSchema = refreshSchema.extend({ customLayers: z.array(customLayerSchema).max(STRUCTURE_LIMITS.customLayers), assignments: z.array(assignmentSchema).max(STRUCTURE_LIMITS.assignments) }).strict();
const fileSchema = scopeSchema.extend({ path: relativeSchema }).strict();
const reasonsSchema = z.array(z.enum(['scan-budget', 'file-limit', 'metadata-budget'])).max(3);
const savedSchema = z.object({ version: z.literal(1), projectId, repoId, bindingRevision: z.literal(1), bindingKey: hashSchema, revision: revisionSchema, indexedAt: z.string().max(64).refine(value => Number.isFinite(Date.parse(value))).nullable(), inventoryHash: hashSchema.nullable(), files: z.array(relativeSchema).max(STRUCTURE_LIMITS.files), visited: z.number().int().min(0).max(LIMITS.scanFiles), truncated: z.boolean(), truncationReasons: reasonsSchema, customLayers: z.array(customLayerSchema).max(STRUCTURE_LIMITS.customLayers), assignments: z.array(assignmentSchema).max(STRUCTURE_LIMITS.assignments) }).strict();
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
const bindingKey = (project, repo) => digest(JSON.stringify([project.id, project.bindingRevision, repo.id, repo.root, repo.identity.dev, repo.identity.ino]));
const filename = context => path.join(context.store.projectDir(context.project.id), 'structure', `${context.repo.id}.json`);
const inventoryHash = files => digest(JSON.stringify(files));
function initial(context) { return { version: 1, projectId: context.project.id, repoId: context.repo.id, bindingRevision: 1, bindingKey: context.bindingKey, revision: 0, indexedAt: null, inventoryHash: null, files: [], visited: 0, truncated: false, truncationReasons: [], customLayers: [], assignments: [] }; }
function normalizeConfiguration(customLayers, assignments) {
  const ids = new Set(fixedIds);
  for (const layer of customLayers) { if (ids.has(layer.id)) fail('STRUCTURE_LAYER_CONFLICT', '分层 ID 不能重复'); ids.add(layer.id); }
  const prefixes = new Set();
  const normalized = assignments.map(assignment => {
    let prefix = assignment.prefix;
    if (prefix.startsWith('/')) fail('PATH_DENIED', '分层前缀只能是仓库相对路径');
    if (prefix.endsWith('/')) prefix = prefix.slice(0, -1);
    if (prefix) safeRelative(prefix);
    if (prefixes.has(prefix)) fail('STRUCTURE_PREFIX_CONFLICT', '同一路径前缀只能设置一次人工归属');
    if (!ids.has(assignment.layerId)) fail('STRUCTURE_LAYER_NOT_FOUND', '人工归属引用了不存在的分层');
    prefixes.add(prefix); return { prefix, layerId: assignment.layerId };
  });
  return { customLayers: structuredClone(customLayers), assignments: normalized };
}
function checkArchiveFile(stat) {
  if (!stat.isFile() || stat.nlink !== 1n) fail('STRUCTURE_ARCHIVE_ALIAS', '结构地图档案必须为单链接普通文件');
  if (stat.size > BigInt(STRUCTURE_LIMITS.archiveBytes)) fail('STRUCTURE_ARCHIVE_LIMIT', '结构地图档案超过 2 MiB 限制，不会自动覆盖');
}
async function load(context) {
  context.current(); await checkBinding(context.store.storageBinding);
  const file = filename(context); await checkPlain(file, true); let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; context.current(); return { state: initial(context), stamp: null }; }
  let bytes; let before;
  try {
    before = await handle.stat({ bigint: true }); checkArchiveFile(before);
    const buffer = Buffer.alloc(STRUCTURE_LIMITS.archiveBytes + 1); let length = 0;
    while (length < buffer.length) { context.current(); const result = await handle.read(buffer, length, buffer.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
    if (length > STRUCTURE_LIMITS.archiveBytes) fail('STRUCTURE_ARCHIVE_LIMIT', '结构地图档案在读取期间超过容量');
    const after = await handle.stat({ bigint: true }); checkArchiveFile(after);
    await checkPlain(file); await checkBinding(context.store.storageBinding);
    const named = await fs.lstat(file, { bigint: true }); checkArchiveFile(named);
    if (stamp(before) !== stamp(after) || stamp(before) !== stamp(named)) fail('STRUCTURE_ARCHIVE_CHANGED', '结构地图档案在读取期间变化，请重新加载');
    bytes = buffer.subarray(0, length);
  } finally { await handle.close(); }
  context.current(); let state;
  try { state = savedSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { fail('STRUCTURE_ARCHIVE_INVALID', '结构地图档案格式无效；请保留原档案检查，不会清空人工分层'); }
  if (state.projectId !== context.project.id || state.repoId !== context.repo.id || state.bindingKey !== context.bindingKey || state.bindingRevision !== context.project.bindingRevision) fail('STRUCTURE_BINDING_CHANGED', '结构地图档案的项目或仓库绑定不一致');
  const config = normalizeConfiguration(state.customLayers, state.assignments);
  if (JSON.stringify(config.assignments) !== JSON.stringify(state.assignments)) fail('STRUCTURE_ARCHIVE_INVALID', '结构地图中的路径前缀未规范化');
  for (const relative of state.files) safeRelative(relative);
  if (new Set(state.files).size !== state.files.length || state.files.some((value, index) => index > 0 && value < state.files[index - 1]) || Buffer.byteLength(JSON.stringify(state.files)) > STRUCTURE_LIMITS.inventoryBytes) fail('STRUCTURE_ARCHIVE_INVALID', '结构地图文件清单重复、无序或超过预算');
  if (state.indexedAt === null ? state.files.length || state.inventoryHash !== null || state.visited !== 0 || state.truncated : state.inventoryHash !== inventoryHash(state.files)) fail('STRUCTURE_ARCHIVE_INVALID', '结构地图清单指纹或索引状态无效');
  if (state.truncated !== (state.truncationReasons.length > 0) || new Set(state.truncationReasons).size !== state.truncationReasons.length) fail('STRUCTURE_ARCHIVE_INVALID', '结构地图截断状态无效');
  return { state, stamp: stamp(before) };
}
function rootUnchanged(binding) {
  const stat = lstatSync(binding.root, { bigint: true });
  if (!stat.isDirectory() || String(stat.dev) !== binding.identity.dev || String(stat.ino) !== binding.identity.ino) fail('ROOT_CHANGED', '结构地图操作期间绑定目录已变化');
}
async function commit(context, previous, next, action) {
  if (next.revision > Number.MAX_SAFE_INTEGER) fail('STRUCTURE_REVISION_LIMIT', '结构地图版本达到上限');
  const file = filename(context); const text = JSON.stringify(next) + '\n';
  if (Buffer.byteLength(text) > STRUCTURE_LIMITS.archiveBytes) fail('STRUCTURE_ARCHIVE_LIMIT', '结构地图档案超出 2 MiB 限制');
  await context.store.writable(path.dirname(file)); context.current(); await checkBinding(context.repo);
  // Draft audit is ephemeral; only this project sidecar is explicitly persisted.
  await context.store.audit(context.args.sessionId, `${action}-attempt`, { repoId: context.repo.id, revision: next.revision, files: next.files.length, visited: next.visited, truncated: next.truncated });
  context.current();
  const current = () => {
    context.current(); rootUnchanged(context.store.storageBinding); rootUnchanged(context.repo);
    let named;
    try { named = lstatSync(file, { bigint: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (named) checkArchiveFile(named);
    if ((named ? stamp(named) : null) !== previous.stamp) fail('STRUCTURE_ARCHIVE_CHANGED', '结构地图在保存期间已变化，请重新加载');
  };
  await atomicText(file, text, STRUCTURE_LIMITS.archiveBytes, current);
}
async function scoped(store, args, signal, guard, operation) {
  return store.lock(args.sessionId, async () => {
    const state = store.session(args.sessionId); const project = store.project(state.projectId); const repo = store.repo(args.sessionId, args.repoId); const key = bindingKey(project, repo);
    const current = () => { guard?.(); signal?.throwIfAborted(); const owner = store.session(args.sessionId); const now = store.project(owner.projectId); const bound = store.repo(args.sessionId, args.repoId); if (now.id !== project.id || bindingKey(now, bound) !== key) fail('STRUCTURE_BINDING_CHANGED', '结构地图请求的项目绑定已变化'); };
    // Writers always use session -> map ordering. Removal waits on session locks.
    return store.lock(`structure-map:${project.id}:${repo.id}`, async () => {
      current(); await checkBinding(repo); await checkBinding(store.storageBinding); current();
      const context = { store, args, project, repo, bindingKey: key, current }; const previous = await load(context);
      const result = await operation(context, previous);
      await checkBinding(repo); await checkBinding(store.storageBinding); current();
      return result;
    });
  });
}
const codeExtensions = new Set('js mjs cjs jsx ts tsx py go rs java kt kts c h cpp cc hpp cs fs fsx rb php swift scala sh bash ps1 bat cmd lua r sql ex exs erl dart vue svelte'.split(' '));
function extensionOf(relative) { const leaf = relative.split('/').at(-1); const index = leaf.lastIndexOf('.'); const extension = index > 0 ? leaf.slice(index + 1).toLowerCase() : ''; return extension.length <= 32 ? extension : ''; }
function suggestedLayer(relative, extension) {
  const parts = relative.toLowerCase().split('/'); const leaf = parts.at(-1); const directories = parts.slice(0, -1);
  const has = names => directories.some(part => names.includes(part));
  if (has(['test', 'tests', '__tests__', 'spec', 'specs', 'fixtures']) || /(?:^|\.)(?:test|spec)\./.test(leaf)) return 'tests';
  if (has(['doc', 'docs', 'documentation']) || ['md', 'markdown', 'rst', 'adoc'].includes(extension) || /^(?:readme|license|licence|notice|changelog)(?:\.|$)/.test(leaf)) return 'docs';
  if (['json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'lock', 'cfg', 'conf', 'config'].includes(extension) || /(?:^|[.-])config(?:[.-]|$)/.test(leaf) || ['.gitignore', '.gitattributes', '.editorconfig', 'makefile', 'dockerfile'].includes(leaf)) return 'config';
  if (has(['data', 'database', 'db', 'storage', 'infra', 'infrastructure', 'adapters', 'migrations'])) return 'data';
  if (has(['client', 'ui', 'frontend', 'components', 'pages', 'views', 'api', 'routes', 'controllers']) || ['jsx', 'tsx', 'css', 'scss', 'html', 'vue', 'svelte'].includes(extension)) return 'ui';
  if (has(['src', 'source', 'lib', 'packages', 'apps', 'server', 'core', 'domain', 'services']) || codeExtensions.has(extension)) return 'core';
  return 'other';
}
function historicalCounts(context, paths) {
  const counts = new Map(); const wanted = new Set(paths); let sessions = 0; let lessons = 0; let references = 0; let truncated = false;
  const current = context.store.session(context.args.sessionId); const boundRepos = new Set(context.project.repositories.map(repo => repo.id));
  function* states() { yield current; for (const state of context.store.sessions.values()) if (state.id !== current.id) yield state; }
  const evidenceValid = (evidence, state) => evidence && idSchema.safeParse(evidence.id).success && evidence.id.startsWith('evidence-') && evidence.sessionId === state.id && evidence.projectId === state.projectId && evidence.bindingRevision === 1 && boundRepos.has(evidence.repoId) && typeof evidence.path === 'string' && hashSchema.safeParse(evidence.hash).success && Number.isSafeInteger(evidence.startLine) && Number.isSafeInteger(evidence.endLine) && evidence.startLine >= 1 && evidence.endLine >= evidence.startLine;
  outer: for (const state of states()) {
    if (state.projectId !== context.project.id) continue;
    if (sessions++ >= STRUCTURE_LIMITS.sessions) { truncated = true; break; }
    if (!Array.isArray(state.lessons) || !Array.isArray(state.evidence)) { truncated = true; continue; }
    if (state.evidence.length > 500) truncated = true;
    const evidenceMap = new Map();
    for (const evidence of state.evidence.slice(0, 500)) {
      if (!evidenceValid(evidence, state)) { truncated = true; continue; }
      try { safeRelative(evidence.path); } catch { truncated = true; continue; }
      if (evidenceMap.has(evidence.id)) { truncated = true; continue; }
      evidenceMap.set(evidence.id, evidence);
    }
    const seen = new Set();
    for (const lesson of state.lessons) {
      if (lessons++ >= STRUCTURE_LIMITS.lessons) { truncated = true; break outer; }
      if (!lesson || !idSchema.safeParse(lesson.id).success || !lesson.id.startsWith('lesson-') || seen.has(lesson.id)) { truncated = true; continue; }
      seen.add(lesson.id); const linkedPaths = new Set();
      const add = id => {
        if (references++ >= STRUCTURE_LIMITS.references) { truncated = true; return false; }
        const evidence = evidenceMap.get(id);
        if (!evidence) { truncated = true; return true; }
        if (evidence.repoId === context.repo.id && wanted.has(evidence.path)) linkedPaths.add(evidence.path);
        return true;
      };
      for (const [rows, rowLimit, idLimit] of [[lesson.claims ?? [], 20, 20], [lesson.topics ?? [], 6, 10]]) {
        if (!Array.isArray(rows)) { truncated = true; continue; }
        if (rows.length > rowLimit) truncated = true;
        for (const row of rows.slice(0, rowLimit)) {
          if (!row || !Array.isArray(row.evidenceIds)) { truncated = true; continue; }
          if (row.evidenceIds.length > idLimit) truncated = true;
          for (const id of row.evidenceIds.slice(0, idLimit)) if (!add(id)) break outer;
        }
      }
      const units = restoredCodeUnits(lesson.codeUnits ?? []);
      if (lesson.codeUnits != null && !Array.isArray(lesson.codeUnits) || lesson.codeUnits?.length && !units.length) truncated = true;
      for (const unit of units) {
        try { safeRelative(unit.path); verifyUnitEvidence(unit, state, evidenceMap); } catch { truncated = true; continue; }
        for (const id of unit.evidenceIds) if (!add(id)) break outer;
      }
      for (const relative of linkedPaths) counts.set(relative, (counts.get(relative) ?? 0) + 1);
    }
  }
  return { counts, truncated };
}
function presented(context, state) {
  context.current(); const history = historicalCounts(context, state.files);
  const layers = [...STRUCTURE_LAYERS.map(layer => ({ ...layer, origin: 'heuristic' })), ...state.customLayers.map(layer => ({ ...layer, origin: 'manual' }))].map(layer => ({ ...layer, fileCount: 0, readingFileCount: 0 }));
  const layerMap = new Map(layers.map(layer => [layer.id, layer])); const assignments = [...state.assignments].sort((left, right) => right.prefix.length - left.prefix.length);
  const files = state.files.map(relative => {
    const extension = extensionOf(relative); const assigned = assignments.find(item => item.prefix === '' || relative === item.prefix || relative.startsWith(item.prefix + '/'));
    const layerId = assigned?.layerId ?? suggestedLayer(relative, extension); const readingCount = history.counts.get(relative) ?? 0; const layer = layerMap.get(layerId);
    layer.fileCount++; if (readingCount > 0) layer.readingFileCount++;
    return { path: relative, extension, layerId, modulePath: relative.split('/').slice(0, -1).slice(0, 2).join('/'), readingCount };
  });
  const result = { version: 1, projectId: context.project.id, repoId: context.repo.id, bindingRevision: context.project.bindingRevision, revision: state.revision, indexedAt: state.indexedAt, inventoryHash: state.inventoryHash, files, layers, customLayers: structuredClone(state.customLayers), assignments: structuredClone(state.assignments), truncated: state.truncated, visited: state.visited, readingTruncated: history.truncated, truncationReasons: [...state.truncationReasons] };
  if (Buffer.byteLength(JSON.stringify(result)) > STRUCTURE_LIMITS.responseBytes) fail('STRUCTURE_RESPONSE_LIMIT', '结构地图响应超过大小预算，请缩小人工分层配置');
  context.current(); return result;
}
function compareRevision(previous, expected) { if (previous.revision !== expected) fail('STALE_STRUCTURE_MAP', '结构地图已由另一页面更新，请重新加载后再保存'); if (previous.revision === Number.MAX_SAFE_INTEGER) fail('STRUCTURE_REVISION_LIMIT', '结构地图版本达到上限'); }
export async function getStructureMap(store, raw, signal, guard) {
  const args = scopeSchema.parse(raw); return scoped(store, args, signal, guard, async (context, previous) => presented(context, previous.state));
}
export async function refreshStructureMap(store, raw, signal, guard) {
  const args = refreshSchema.parse(raw);
  return scoped(store, args, signal, guard, async (context, previous) => {
    compareRevision(previous.state, args.expectedRevision); const inventory = await listRepository(context.repo, signal); context.current();
    const files = []; let bytes = 2; const reasons = inventory.truncated ? ['scan-budget'] : [];
    for (const relative of inventory.files) {
      context.current(); safeRelative(relative);
      if (files.length >= STRUCTURE_LIMITS.files) { reasons.push('file-limit'); break; }
      const size = Buffer.byteLength(JSON.stringify(relative)) + (files.length ? 1 : 0);
      if (bytes + size > STRUCTURE_LIMITS.inventoryBytes) { reasons.push('metadata-budget'); break; }
      files.push(relative); bytes += size;
    }
    const next = { ...previous.state, revision: previous.state.revision + 1, indexedAt: new Date().toISOString(), inventoryHash: inventoryHash(files), files, visited: inventory.visited, truncated: reasons.length > 0, truncationReasons: reasons };
    await commit(context, previous, next, 'structure-map-refresh'); return presented(context, next);
  });
}
export async function updateStructureLayers(store, raw, signal, guard) {
  const args = updateSchema.parse(raw); const configuration = normalizeConfiguration(args.customLayers, args.assignments);
  return scoped(store, args, signal, guard, async (context, previous) => {
    compareRevision(previous.state, args.expectedRevision);
    if (JSON.stringify(previous.state.customLayers) === JSON.stringify(configuration.customLayers) && JSON.stringify(previous.state.assignments) === JSON.stringify(configuration.assignments)) return presented(context, previous.state);
    const next = { ...previous.state, ...configuration, revision: previous.state.revision + 1 };
    await commit(context, previous, next, 'structure-layers-save'); return presented(context, next);
  });
}
export async function inspectStructureFile(store, raw, signal, guard) {
  const args = fileSchema.parse(raw); safeRelative(args.path);
  return scoped(store, args, signal, guard, async (context, previous) => {
    const source = await readRepository(context.repo, args.path); context.current();
    const codeReadings = collectCodeReadings(store, args.sessionId, args.repoId, args.path, source);
    await store.audit(args.sessionId, 'structure-file', { repoId: args.repoId, path: args.path, hash: source.hash, bytes: source.bytes, totalLines: source.lines.length }); context.current();
    return { projectId: context.project.id, repoId: args.repoId, bindingRevision: context.project.bindingRevision, path: args.path, indexRevision: previous.state.revision, hash: source.hash, bytes: source.bytes, totalLines: source.lines.length, codeReadings };
  });
}
