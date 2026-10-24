import fs from 'node:fs/promises';
import { constants, lstatSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { idSchema, relativeSchema, fail } from './contracts.mjs';
import { modelRefSchema } from './preferences.mjs';
import { checkBinding, checkPlain, safeRelative, listRepository, readRepository, atomicText, digest, LIMITS } from './filesystem.mjs';

// Metadata only. A bounded local content scan is neither a model request nor an
// atomic cross-repository snapshot; missing coverage must never imply deletion.
export const CODE_MAP_LIMITS = Object.freeze({ files: 2000, bytes: 16 * 1024 * 1024, paths: 8000, scanBytes: 768 * 1024, archiveBytes: 2 * 1024 * 1024 });
const projectIdSchema = idSchema.refine(value => value.startsWith('project-'));
const sessionIdSchema = idSchema.refine(value => value.startsWith('reading-'));
const repoIdSchema = idSchema.refine(value => value.startsWith('repo-'));
const lessonIdSchema = idSchema.refine(value => value.startsWith('lesson-'));
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const dateSchema = z.string().max(64).refine(value => Number.isFinite(Date.parse(value)));
const readFailures = ['LINK_DENIED', 'ALIAS_DENIED', 'FILE_ALIAS', 'NOT_FILE', 'FILE_LIMIT', 'SEARCH_BUDGET', 'SOURCE_CHANGED', 'BINARY_FILE', 'ENCODING', 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EIO', 'ENAMETOOLONG'];
const reasons = ['path-budget', 'file-budget', 'byte-budget', 'metadata-budget', 'inventory-changed', 'policy-filtered', ...readFailures];
const fileSchema = z.object({ repoId: repoIdSchema, path: relativeSchema, hash: hashSchema.nullable(), skipped: z.enum(readFailures).optional() }).strict();
const statsSchema = z.object({ visited: z.number().int().min(0).max(CODE_MAP_LIMITS.paths), readFiles: z.number().int().min(0).max(CODE_MAP_LIMITS.files), readBytes: z.number().int().min(0).max(CODE_MAP_LIMITS.bytes) }).strict();
const scanSchema = z.object({ checkedAt: dateSchema, fingerprint: hashSchema, files: z.array(fileSchema).max(CODE_MAP_LIMITS.files), truncated: z.boolean(), reasons: z.array(z.enum(reasons)).max(reasons.length), stats: statsSchema.optional() }).strict();
const latestSchema = z.object({ sessionId: sessionIdSchema, lessonId: lessonIdSchema, generatedAt: dateSchema, model: modelRefSchema, baseline: scanSchema }).strict();
const taskSchema = z.object({ requestId: z.string().uuid(), sessionId: sessionIdSchema, status: z.enum(['running', 'completed', 'failed', 'cancelled']), mode: z.enum(['initial', 'incremental']), startedAt: dateSchema, model: modelRefSchema, baseline: scanSchema, error: z.string().max(2000).optional() }).strict();
const savedSchema = z.object({ version: z.literal(1), projectId: projectIdSchema, bindingKey: hashSchema, revision: revisionSchema, latest: latestSchema.nullable(), task: taskSchema.nullable() }).strict();
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fileKey = file => `${file.repoId}\0${file.path}`;
const sortedRepos = project => [...project.repositories].sort((a, b) => compare(a.id, b.id));
const bindingKey = project => digest(JSON.stringify([project.id, project.bindingRevision, sortedRepos(project).map(repo => [repo.id, repo.root, repo.identity.dev, repo.identity.ino])]));
const filename = context => path.join(context.store.projectDir(context.project.id), 'code-map.json');
const fingerprint = scan => digest(JSON.stringify({ files: scan.files, truncated: scan.truncated, reasons: scan.reasons }));
const initial = context => ({ version: 1, projectId: context.project.id, bindingKey: context.bindingKey, revision: 0, latest: null, task: null });

function validateScan(raw, project) {
  const scan = scanSchema.parse(raw); let previous = null;
  for (const file of scan.files) {
    safeRelative(file.path); const key = fileKey(file);
    if (previous !== null && key <= previous) fail('CODE_MAP_SCAN_INVALID', '代码地图扫描路径必须排序且不能重复');
    if (project && !project.repositories.some(repo => repo.id === file.repoId)) fail('CODE_MAP_BINDING_CHANGED', '代码地图扫描引用未绑定的仓库');
    if ((file.hash === null) !== (file.skipped !== undefined) || file.skipped && !scan.reasons.includes(file.skipped)) fail('CODE_MAP_SCAN_INVALID', '代码地图扫描缺少明确跳过原因');
    previous = key;
  }
  if (new Set(scan.reasons).size !== scan.reasons.length || scan.reasons.some((value, index) => index && value < scan.reasons[index - 1])) fail('CODE_MAP_SCAN_INVALID', '代码地图扫描原因必须排序且不能重复');
  // Static policy exclusions cannot occur in a valid baseline. Other omissions
  // (including links replacing formerly readable files) make deletion uncertain.
  if (scan.truncated !== scan.reasons.some(reason => reason !== 'policy-filtered') || scan.files.some(file => file.hash === null) && !scan.truncated) fail('CODE_MAP_SCAN_INVALID', '代码地图扫描完整性标记不一致');
  if (scan.fingerprint !== fingerprint(scan) || Buffer.byteLength(JSON.stringify(scan)) > CODE_MAP_LIMITS.scanBytes) fail('CODE_MAP_SCAN_INVALID', '代码地图扫描指纹无效或超出元数据预算');
  return scan;
}
function validateState(raw, context) {
  const state = savedSchema.parse(raw);
  if (state.projectId !== context.project.id || state.bindingKey !== context.bindingKey) fail('CODE_MAP_BINDING_CHANGED', '代码地图档案的项目或仓库绑定不一致');
  for (const reference of [state.latest, state.task].filter(Boolean)) {
    validateScan(reference.baseline, context.project);
    const session = context.store.session(reference.sessionId);
    if (session.projectId !== context.project.id || session.draft || reference.lessonId && !session.lessons.some(lesson => lesson.id === reference.lessonId)) fail('CODE_MAP_REFERENCE_INVALID', '代码地图只能引用当前项目已持久化的阅读会话与知识点');
  }
  return state;
}
function contextFor(store, projectId, signal, guard) {
  projectIdSchema.parse(projectId); guard?.(); signal?.throwIfAborted();
  const project = structuredClone(store.project(projectId)); const key = bindingKey(project);
  const current = () => {
    guard?.(); signal?.throwIfAborted();
    if (bindingKey(store.project(projectId)) !== key) fail('CODE_MAP_BINDING_CHANGED', '代码地图操作期间项目绑定已变化');
  };
  return { store, project, bindingKey: key, current };
}
async function checkContext(context) {
  context.current(); await checkBinding(context.store.storageBinding);
  for (const repo of context.project.repositories) { context.current(); await checkBinding(repo); }
  context.current();
}
function checkArchiveFile(stat) {
  if (!stat.isFile() || stat.nlink !== 1n) fail('CODE_MAP_ARCHIVE_ALIAS', '代码地图档案必须为单链接普通文件');
  if (stat.size > BigInt(CODE_MAP_LIMITS.archiveBytes)) fail('CODE_MAP_ARCHIVE_LIMIT', '代码地图档案超过 2 MiB，不会自动覆盖');
}
async function load(context) {
  await checkContext(context); const file = filename(context); await checkPlain(file, true); let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; context.current(); return { state: initial(context), stamp: null }; }
  let before; let bytes;
  try {
    before = await handle.stat({ bigint: true }); checkArchiveFile(before);
    const buffer = Buffer.alloc(CODE_MAP_LIMITS.archiveBytes + 1); let length = 0;
    while (length < buffer.length) { context.current(); const result = await handle.read(buffer, length, buffer.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
    if (length > CODE_MAP_LIMITS.archiveBytes) fail('CODE_MAP_ARCHIVE_LIMIT', '读取期间代码地图档案超过容量');
    const after = await handle.stat({ bigint: true }); checkArchiveFile(after);
    await checkPlain(file); await checkContext(context);
    const named = await fs.lstat(file, { bigint: true }); checkArchiveFile(named);
    if (stamp(before) !== stamp(after) || stamp(before) !== stamp(named)) fail('CODE_MAP_ARCHIVE_CHANGED', '代码地图档案在读取期间变化，请重新加载');
    bytes = buffer.subarray(0, length);
  } finally { await handle.close(); }
  context.current(); let state;
  try { state = validateState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), context); }
  catch (error) {
    if (error.code === 'CODE_MAP_BINDING_CHANGED') throw error;
    fail('CODE_MAP_ARCHIVE_INVALID', '代码地图档案格式或引用无效；请保留原档案检查，不会自动清空');
  }
  return { state, stamp: stamp(before) };
}
function rootUnchanged(binding) {
  const stat = lstatSync(binding.root, { bigint: true });
  if (!stat.isDirectory() || String(stat.dev) !== binding.identity.dev || String(stat.ino) !== binding.identity.ino) fail('ROOT_CHANGED', '代码地图操作期间绑定目录已变化');
}
async function commit(context, previous, next) {
  const file = filename(context); const text = JSON.stringify(next) + '\n';
  if (Buffer.byteLength(text) > CODE_MAP_LIMITS.archiveBytes) fail('CODE_MAP_ARCHIVE_LIMIT', '代码地图档案超过 2 MiB');
  await context.store.writable(path.dirname(file)); await checkContext(context);
  const current = () => {
    context.current(); rootUnchanged(context.store.storageBinding);
    for (const repo of context.project.repositories) rootUnchanged(repo);
    let named;
    try { named = lstatSync(file, { bigint: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (named) checkArchiveFile(named);
    if ((named ? stamp(named) : null) !== previous.stamp) fail('CODE_MAP_ARCHIVE_CHANGED', '代码地图在保存期间已变化，请重新加载');
  };
  await atomicText(file, text, CODE_MAP_LIMITS.archiveBytes, current);
}
export async function getCodeMap(store, projectId, guard) {
  projectIdSchema.parse(projectId);
  return store.lock(`code-map:${projectId}`, async () => {
    const context = contextFor(store, projectId, undefined, guard); const previous = await load(context);
    await checkContext(context); return structuredClone(previous.state);
  });
}
export async function mutateCodeMap(store, projectId, expectedRevision, update, guard) {
  projectIdSchema.parse(projectId); if (expectedRevision !== undefined) revisionSchema.parse(expectedRevision);
  if (typeof update !== 'function') fail('CODE_MAP_UPDATE_INVALID', '代码地图更新需要函数');
  return store.lock(`code-map:${projectId}`, async () => {
    const context = contextFor(store, projectId, undefined, guard); const previous = await load(context);
    if (expectedRevision !== undefined && previous.state.revision !== expectedRevision) fail('STALE_CODE_MAP', '代码地图已由另一请求更新，请重新加载');
    if (previous.state.revision === Number.MAX_SAFE_INTEGER) fail('CODE_MAP_REVISION_LIMIT', '代码地图版本达到上限');
    const candidate = await update(structuredClone(previous.state)); context.current();
    const next = validateState(candidate, context);
    if (next.revision !== previous.state.revision) fail('CODE_MAP_UPDATE_INVALID', '代码地图版本只能由存储层递增');
    next.revision++; await commit(context, previous, next); await checkContext(context);
    return structuredClone(next);
  });
}

// listRepository intentionally hides policy exclusions and links. A second,
// metadata-only pass detects hidden links/non-files and inventory churn without
// reading excluded content. Both walks share ONE conservative project path
// budget; directory checkpoints count too. Reserve half the remaining budget
// for this pass: if listRepository throws at its local ceiling, it cannot expose
// its partial inventory, but this pass can retain a useful bounded sample.
// Neither walk follows a symlink/junction.
async function inspectInventory(repo, inventory, checkpoint, note, sample) {
  const pending = inventory ? new Set(inventory) : null; const stack = [''];
  while (stack.length) {
    checkpoint(); const relative = stack.pop(); const directory = path.join(repo.root, ...relative.split('/').filter(Boolean));
    await checkPlain(directory); const entries = await fs.opendir(directory);
    for await (const entry of entries) {
      checkpoint(); const name = relative ? `${relative}/${entry.name}` : entry.name;
      try { safeRelative(name); } catch { note('policy-filtered'); continue; }
      if (entry.isSymbolicLink()) { note('LINK_DENIED'); continue; }
      if (entry.isDirectory()) stack.push(name);
      else if (entry.isFile()) { if (pending && !pending.delete(name)) note('inventory-changed'); sample?.push(name); }
      else note('NOT_FILE');
    }
  }
  if (pending?.size) note('inventory-changed');
}
export async function scanCodeMap(store, projectId, signal, guard) {
  const context = contextFor(store, projectId, signal, guard); await checkContext(context);
  const files = []; const notes = new Set(); const stats = { visited: 0, readFiles: 0, readBytes: 0 }; let metadataBytes = 2048;
  const note = code => notes.add(code);
  const checkpoint = () => { context.current(); if (stats.visited >= CODE_MAP_LIMITS.paths) fail('CODE_MAP_PATH_BUDGET', '代码地图项目路径预算已用尽'); stats.visited++; };
  const recover = error => {
    context.current();
    if (error.code === 'CODE_MAP_PATH_BUDGET' || error.code === 'CODE_MAP_LIST_BUDGET') { note('path-budget'); return; }
    if (readFailures.includes(error.code)) { note(error.code); return; }
    throw error;
  };
  for (const repo of sortedRepos(context.project)) {
    context.current(); let inventory;
    const listCeiling = stats.visited + Math.floor((CODE_MAP_LIMITS.paths - stats.visited) / 2);
    const listCheckpoint = () => { context.current(); if (stats.visited >= listCeiling) fail('CODE_MAP_LIST_BUDGET', '保留剩余路径预算用于安全局部采样'); checkpoint(); };
    try { inventory = await listRepository(repo, { throwIfAborted: listCheckpoint }); }
    catch (error) { recover(error); }
    if (inventory?.truncated) note('path-budget');
    const sample = inventory ? undefined : [];
    try { await inspectInventory(repo, inventory?.files, checkpoint, note, sample); } catch (error) { recover(error); }
    if (!inventory) inventory = { files: [...new Set(sample)].sort() };
    for (const relative of inventory.files) {
      context.current(); safeRelative(relative);
      if (stats.readFiles >= CODE_MAP_LIMITS.files) { note('file-budget'); break; }
      // Reserve bounded metadata for the largest hash/skipped record BEFORE IO.
      const entryBytes = Buffer.byteLength(JSON.stringify({ repoId: repo.id, path: relative, hash: 'f'.repeat(64), skipped: 'SEARCH_BUDGET' })) + 1;
      if (metadataBytes + entryBytes > CODE_MAP_LIMITS.scanBytes) { note('metadata-budget'); break; }
      const remaining = CODE_MAP_LIMITS.bytes - stats.readBytes;
      if (remaining <= 1) { note('byte-budget'); break; }
      const maxBytes = Math.min(LIMITS.fileBytes, remaining - 1); stats.readFiles++;
      let file;
      try {
        const source = await readRepository(repo, relative, { maxBytes }); context.current(); stats.readBytes += source.bytes;
        file = { repoId: repo.id, path: relative, hash: source.hash };
      } catch (error) {
        recover(error);
        // Failed reads may have consumed bytes before rejecting binary/encoding
        // or changed content. Charge their entire reservation, including the
        // sentinel byte, so repeated failures cannot evade the project budget.
        stats.readBytes += maxBytes + 1;
        file = { repoId: repo.id, path: relative, hash: null, skipped: error.code };
      }
      files.push(file); metadataBytes += entryBytes;
    }
    if (['path-budget', 'file-budget', 'byte-budget', 'metadata-budget'].some(reason => notes.has(reason))) break;
  }
  await checkContext(context);
  files.sort((a, b) => compare(fileKey(a), fileKey(b)));
  const scan = { checkedAt: new Date().toISOString(), fingerprint: '', files, truncated: [...notes].some(reason => reason !== 'policy-filtered'), reasons: [...notes].sort(), stats };
  scan.fingerprint = fingerprint(scan); return validateScan(scan, context.project);
}
export function diffCodeMap(previousScan, currentScan) {
  const previous = previousScan === null ? null : validateScan(previousScan); const current = validateScan(currentScan);
  const before = new Map((previous?.files ?? []).map(file => [fileKey(file), file]));
  const after = new Map(current.files.map(file => [fileKey(file), file]));
  const result = { added: [], modified: [], deleted: [], uncertain: [], changed: false, truncated: !!previous?.truncated || current.truncated };
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(key); const next = after.get(key); const file = next ?? old; const reference = { repoId: file.repoId, path: file.path };
    if (!old) result[next.hash === null || previous?.truncated ? 'uncertain' : 'added'].push(reference);
    else if (!next) result[current.truncated || old.hash === null ? 'uncertain' : 'deleted'].push(reference);
    else if (old.hash === null || next.hash === null) result.uncertain.push(reference);
    else if (old.hash !== next.hash) result.modified.push(reference);
  }
  result.changed = !!(result.added.length || result.modified.length || result.deleted.length);
  return result;
}
