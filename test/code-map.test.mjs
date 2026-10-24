import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReadingStore } from '../src/store.mjs';
import { digest } from '../src/filesystem.mjs';
import { getCodeMap, mutateCodeMap, scanCodeMap, diffCodeMap, CODE_MAP_LIMITS } from '../src/code-map.mjs';

const base = path.resolve('.test-output');
const source = 'export const answer = 1;\n';
const model = { provider: 'test-provider', model: 'test-model' };
const ref = (repoId, relative) => ({ repoId, path: relative });
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fileKey = file => `${file.repoId}\0${file.path}`;
function sealed(files, reasons = []) {
  const scan = { checkedAt: new Date().toISOString(), fingerprint: '', files: structuredClone(files).sort((a, b) => compare(fileKey(a), fileKey(b))), truncated: reasons.some(reason => reason !== 'policy-filtered'), reasons: [...reasons].sort() };
  scan.fingerprint = digest(JSON.stringify({ files: scan.files, truncated: scan.truncated, reasons: scan.reasons })); return scan;
}
async function fixture(t, draft = false) {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'code-map-'));
  const a = path.join(root, 'repo-a'); const b = path.join(root, 'repo-b');
  for (const repo of [a, b]) { await fs.mkdir(path.join(repo, 'src'), { recursive: true }); await fs.writeFile(path.join(repo, 'src', 'service.mjs'), source); }
  for (const [relative, text] of Object.entries({ 'docs/guide.md': 'DOCUMENT_BODY_SENTINEL\n', '.env': 'SECRET_SENTINEL\n', '.git/config': 'GIT_SENTINEL\n', 'node_modules/hidden.mjs': 'DEPENDENCY_SENTINEL\n' })) { const file = path.join(a, ...relative.split('/')); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
  const store = await new ReadingStore(path.join(root, 'artifacts')).init(); const project = await store.createProject({ repositories: [{ path: a }, { path: b }] }); const session = await store.createSession(project.id, { draft });
  const archive = path.join(store.projectDir(project.id), 'code-map.json'); const sourceFile = path.join(a, 'src', 'service.mjs');
  t.after(async () => { const absolute = path.resolve(root); assert.equal(path.dirname(absolute), base); assert.match(path.basename(absolute), /^code-map-/); await fs.rm(absolute, { recursive: true, force: true }); });
  return { root, a, b, store, project, session, archive, sourceFile, repoA: project.repositories[0].id, repoB: project.repositories[1].id };
}
const scan = f => scanCodeMap(f.store, f.project.id);
const get = f => getCodeMap(f.store, f.project.id);
const mutate = (f, revision, update, guard) => mutateCodeMap(f.store, f.project.id, revision, update, guard);
const taskFor = (f, baseline) => ({ requestId: randomUUID(), sessionId: f.session.id, status: 'running', mode: 'initial', startedAt: new Date().toISOString(), model, baseline });
async function savedTask(f) { const baseline = await scan(f); return mutate(f, 0, state => ({ ...state, task: taskFor(f, baseline) })); }
async function publish(f) {
  const evidence = (await f.store.read(f.session.id, { repoId: f.repoA, path: 'src/service.mjs' })).evidence;
  const codeUnits = [{ kind: 'file', name: 'service.mjs', repoId: f.repoA, path: 'src/service.mjs', fileHash: evidence.hash, start: { line: 1, column: 0 }, end: { line: 2, column: 0 }, conclusion: '完整读取入口文件。', evidenceIds: [evidence.id] }];
  return f.store.publish(f.session.id, { expectedRevision: 1, title: '项目代码地图', markdown: 'MAP_BODY_SENTINEL', conclusion: '地图正文只保存在知识点档案。', claims: [{ kind: 'fact', text: '已读取入口。', evidenceIds: [evidence.id] }], nextQuestions: ['调用方是什么？'], codeUnits });
}
async function virtualFiles(f, count, operation, name = index => `virtual-${String(index).padStart(5, '0')}.mjs`) {
  const originals = Object.fromEntries(['opendir', 'lstat', 'stat', 'realpath', 'open'].map(key => [key, fs[key]])); const metrics = { entries: 0, opens: 0, bytes: 0 };
  const roots = new Map(f.project.repositories.map(repo => [repo.root, path.join(repo.root, 'src', 'service.mjs')]));
  const translated = file => typeof file === 'string' && roots.has(path.dirname(file)) && path.basename(file).startsWith('virtual-') ? roots.get(path.dirname(file)) : null;
  fs.opendir = async directory => roots.has(directory) ? (async function* () { for (let index = 0; index < count; index++) { metrics.entries++; yield { name: name(index), isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }; } })() : originals.opendir(directory);
  for (const method of ['lstat', 'stat']) fs[method] = async (file, ...args) => originals[method](translated(file) ?? file, ...args);
  fs.realpath = async (file, ...args) => translated(file) ? file : originals.realpath(file, ...args);
  fs.open = async (file, ...args) => {
    const actual = translated(file); const handle = await originals.open(actual ?? file, ...args);
    if (actual) { metrics.opens++; const read = handle.read.bind(handle); handle.read = async (...readArgs) => { const result = await read(...readArgs); metrics.bytes += result.bytesRead; return result; }; }
    return handle;
  };
  try { return await operation(metrics); } finally { Object.assign(fs, originals); }
}

test('缺失地图返回绑定默认状态，get不扫描/读源码、不创建侧车或草稿档案', async t => {
  const f = await fixture(t, true); const open = fs.open; const opendir = fs.opendir;
  fs.open = async (file, ...args) => { assert.ok(!String(file).startsWith(f.a + path.sep) && !String(file).startsWith(f.b + path.sep)); return open(file, ...args); };
  fs.opendir = async () => { throw new Error('get must not enumerate source'); };
  let state; try { state = await get(f); } finally { fs.open = open; fs.opendir = opendir; }
  assert.deepEqual(state, { version: 1, projectId: f.project.id, bindingKey: state.bindingKey, revision: 0, latest: null, task: null }); assert.match(state.bindingKey, /^[a-f0-9]{64}$/);
  await assert.rejects(fs.stat(f.archive), { code: 'ENOENT' }); await assert.rejects(fs.stat(f.store.sessionDir(f.session.id)), { code: 'ENOENT' });
  state.revision = 50; assert.equal((await get(f)).revision, 0);
});

test('多仓扫描使用实际字节SHA256，稳定指纹不含时间，过滤敏感正文且完全只读', async t => {
  const f = await fixture(t, true); const original = await fs.readFile(f.sourceFile); const originalStat = await fs.stat(f.sourceFile);
  const first = await scan(f); const second = await scan(f);
  assert.equal(first.files.length, 3); assert.equal(first.truncated, false); assert.deepEqual(first.reasons, ['policy-filtered']); assert.equal(first.fingerprint, second.fingerprint); assert.equal(first.stats.readFiles, 3);
  assert.equal(first.files.find(file => file.repoId === f.repoA && file.path === 'src/service.mjs').hash, digest(original)); assert.equal(first.files.find(file => file.repoId === f.repoB).hash, digest(original));
  assert.ok(first.stats.visited <= CODE_MAP_LIMITS.paths); assert.ok(first.stats.readBytes <= CODE_MAP_LIMITS.bytes);
  assert.doesNotMatch(JSON.stringify(first), /export const|DOCUMENT_BODY_SENTINEL|SECRET_SENTINEL|GIT_SENTINEL|DEPENDENCY_SENTINEL|\.env|hidden\.mjs/);
  assert.deepEqual(await fs.readFile(f.sourceFile), original); assert.equal((await fs.stat(f.sourceFile)).mtimeMs, originalStat.mtimeMs);
  await assert.rejects(fs.stat(f.archive), { code: 'ENOENT' }); assert.equal(f.store.session(f.session.id).evidence.length, 0); await assert.rejects(fs.stat(f.store.sessionDir(f.session.id)), { code: 'ENOENT' });
});

test('增改删按repoId/path隔离；同路径同尺寸同mtime的内容变化仍被检测', async t => {
  const f = await fixture(t); const before = await scan(f); const unchanged = diffCodeMap(before, await scan(f)); assert.equal(unchanged.changed, false); assert.deepEqual(unchanged.uncertain, []);
  const stat = await fs.stat(f.sourceFile); await fs.writeFile(f.sourceFile, source.replace('1', '2')); await fs.utimes(f.sourceFile, stat.atime, stat.mtime);
  const deleted = path.join(f.a, 'docs', 'guide.md'); assert.equal(path.dirname(deleted), path.join(f.a, 'docs')); await fs.unlink(deleted); await fs.writeFile(path.join(f.b, 'added.mjs'), 'export const added = true;\n');
  const current = await scan(f); const delta = diffCodeMap(before, current);
  assert.notEqual(current.fingerprint, before.fingerprint); assert.deepEqual(delta.added, [ref(f.repoB, 'added.mjs')]); assert.deepEqual(delta.modified, [ref(f.repoA, 'src/service.mjs')]); assert.deepEqual(delta.deleted, [ref(f.repoA, 'docs/guide.md')]); assert.deepEqual(delta.uncertain, []); assert.equal(delta.changed, true); assert.equal(delta.truncated, false);
});

test('不完整current不把未扫描判删除；未知hash与不完整previous不虚报新增/修改', async t => {
  const f = await fixture(t); const known = relative => ({ ...ref(f.repoA, relative), hash: digest(relative) }); const before = sealed([known('a.mjs'), known('b.mjs')]);
  const current = sealed([known('a.mjs')], ['path-budget']); const delta = diffCodeMap(before, current); assert.deepEqual(delta.deleted, []); assert.deepEqual(delta.uncertain, [ref(f.repoA, 'b.mjs')]); assert.equal(delta.changed, false); assert.equal(delta.truncated, true);
  const skipped = sealed([{ ...ref(f.repoA, 'a.mjs'), hash: null, skipped: 'SOURCE_CHANGED' }], ['SOURCE_CHANGED']); const skippedDelta = diffCodeMap(before, skipped); assert.equal(skippedDelta.uncertain.length, 2); assert.deepEqual(skippedDelta.modified, []);
  const recovered = diffCodeMap(current, before); assert.deepEqual(recovered.added, []); assert.deepEqual(recovered.uncertain, [ref(f.repoA, 'b.mjs')]);
  assert.deepEqual(diffCodeMap(null, before).added, [ref(f.repoA, 'a.mjs'), ref(f.repoA, 'b.mjs')]); assert.deepEqual(diffCodeMap(null, skipped).uncertain, [ref(f.repoA, 'a.mjs')]);
  assert.throws(() => diffCodeMap(before, { ...current, truncated: false }));
});

test('task/latest仅存引用和扫描元数据，重启恢复相同revision，get不自动重扫', async t => {
  const f = await fixture(t); const first = await savedTask(f); const lesson = await publish(f);
  const completed = await mutate(f, 1, async state => { await Promise.resolve(); state.latest = { sessionId: f.session.id, lessonId: lesson.id, generatedAt: lesson.createdAt, model, baseline: state.task.baseline }; state.task.status = 'completed'; return state; });
  assert.equal(first.revision, 1); assert.equal(completed.revision, 2); const disk = await fs.readFile(f.archive, 'utf8'); assert.doesNotMatch(disk, /MAP_BODY_SENTINEL|export const|DOCUMENT_BODY_SENTINEL|SECRET_SENTINEL/);
  await fs.writeFile(f.sourceFile, source.replace('1', '9')); const restarted = await new ReadingStore(f.store.root).init(); assert.deepEqual(await getCodeMap(restarted, f.project.id), completed); assert.equal(await fs.readFile(f.archive, 'utf8'), disk);
  assert.equal(diffCodeMap(completed.latest.baseline, await scanCodeMap(restarted, f.project.id)).modified.length, 1);
  completed.task.status = 'failed'; assert.equal((await get(f)).task.status, 'completed');
});

test('异步update始终在项目锁下执行，CAS拒绝并发旧revision，undefined仅内部省略CAS', async t => {
  const f = await fixture(t); const baseline = await scan(f); const entered = Promise.withResolvers(); const release = Promise.withResolvers(); let secondCalled = false;
  const first = mutate(f, 0, async state => { entered.resolve(); await release.promise; state.task = taskFor(f, baseline); return state; }); await entered.promise;
  const second = mutate(f, 0, state => { secondCalled = true; return state; }); const outcomes = Promise.allSettled([first, second]); assert.equal(secondCalled, false); release.resolve();
  const results = await outcomes; assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'STALE_CODE_MAP'); assert.equal(secondCalled, false);
  const internal = await mutate(f, undefined, async state => { await Promise.resolve(); state.task.status = 'failed'; state.task.error = '测试失败信息'; return state; }); assert.equal(internal.revision, 2); assert.equal(internal.task.status, 'failed');
  await assert.rejects(mutate(f, null, state => state)); await assert.rejects(mutate(f, 2, state => ({ ...state, revision: 100 })), { code: 'CODE_MAP_UPDATE_INVALID' }); assert.equal((await get(f)).revision, 2);
});

test('严格schema/绑定/会话知识点引用与回调失败都不能覆盖旧状态', async t => {
  const f = await fixture(t); const state = await savedTask(f); const before = await fs.readFile(f.archive, 'utf8');
  const foreignProject = await f.store.createProject({ repositories: [{ path: f.a }] }); const foreign = await f.store.createSession(foreignProject.id); const draft = await f.store.createSession(f.project.id, { draft: true });
  const invalid = [
    next => ({ ...next, text: 'BODY_NOT_ALLOWED' }),
    next => ({ ...next, task: { ...next.task, requestId: 'invalid' } }),
    next => ({ ...next, task: { ...next.task, status: 'queued' } }),
    next => ({ ...next, task: { ...next.task, error: 'x'.repeat(2001) } }),
    next => ({ ...next, task: { ...next.task, markdown: 'BODY_NOT_ALLOWED' } }),
    next => ({ ...next, task: { ...next.task, sessionId: foreign.id } }),
    next => ({ ...next, task: { ...next.task, sessionId: draft.id } }),
    next => ({ ...next, task: { ...next.task, baseline: { ...next.task.baseline, text: 'SOURCE_NOT_ALLOWED' } } }),
    next => ({ ...next, latest: { sessionId: f.session.id, lessonId: `lesson-${randomUUID()}`, generatedAt: new Date().toISOString(), model, baseline: state.task.baseline } }),
    next => ({ ...next, bindingKey: '0'.repeat(64) }),
    next => { next.task.status = 'cancelled'; throw new Error('update failed'); }
  ];
  for (const update of invalid) { await assert.rejects(mutate(f, 1, update)); assert.equal(await fs.readFile(f.archive, 'utf8'), before); }
  assert.equal((await get(f)).task.status, 'running');
});

test('损坏/未来格式/伪造hash/绑定/非法路径拒绝且不自动修复侧车', async t => {
  const f = await fixture(t); const original = await savedTask(f);
  const candidates = [
    { ...original, version: 99 }, { ...original, bindingKey: '0'.repeat(64) }, { ...original, projectId: `project-${randomUUID()}` }, { ...original, source: 'not metadata' },
    { ...original, task: { ...original.task, baseline: { ...original.task.baseline, fingerprint: '0'.repeat(64) } } },
    { ...original, task: { ...original.task, baseline: sealed([{ ...ref(f.repoA, '../escape'), hash: digest('x') }]) } },
    { ...original, task: { ...original.task, baseline: sealed([{ ...ref(f.repoA, '.env'), hash: digest('x') }]) } },
    { ...original, task: { ...original.task, baseline: sealed([{ ...ref(`repo-${randomUUID()}`, 'x.mjs'), hash: digest('x') }]) } },
    { ...original, task: { ...original.task, baseline: sealed([{ ...ref(f.repoA, 'x.mjs'), hash: null }]) } },
    { ...original, task: { ...original.task, baseline: { ...original.task.baseline, stats: { visited: 0, readFiles: 0, readBytes: CODE_MAP_LIMITS.bytes + 1 } } } }
  ];
  for (const candidate of candidates) { const text = JSON.stringify(candidate); await fs.writeFile(f.archive, text); await assert.rejects(get(f)); await assert.rejects(mutate(f, 1, next => next)); assert.equal(await fs.readFile(f.archive, 'utf8'), text); }
  for (const bytes of [Buffer.from('{broken'), Buffer.from([0xc3, 0x28])]) { await fs.writeFile(f.archive, bytes); await assert.rejects(get(f), { code: 'CODE_MAP_ARCHIVE_INVALID' }); assert.deepEqual(await fs.readFile(f.archive), bytes); }
  await fs.writeFile(f.archive, JSON.stringify({ ...original, revision: Number.MAX_SAFE_INTEGER })); await assert.rejects(mutate(f, Number.MAX_SAFE_INTEGER, next => next), { code: 'CODE_MAP_REVISION_LIMIT' });
});

test('侧车拒绝超大、硬链接和目录；读取有界且拒绝读取期间外部变化', async t => {
  const f = await fixture(t); const original = await savedTask(f);
  await fs.writeFile(f.archive, Buffer.alloc(CODE_MAP_LIMITS.archiveBytes + 1, 65)); await assert.rejects(get(f), { code: 'CODE_MAP_ARCHIVE_LIMIT' });
  await fs.writeFile(f.archive, JSON.stringify(original)); const alias = path.join(f.root, 'archive-alias'); await fs.link(f.archive, alias); await assert.rejects(get(f), { code: 'CODE_MAP_ARCHIVE_ALIAS' }); await assert.rejects(mutate(f, 1, next => next), { code: 'CODE_MAP_ARCHIVE_ALIAS' });
  assert.equal(path.dirname(alias), f.root); await fs.unlink(alias);
  const open = fs.open; let observed = false;
  fs.open = async (file, ...args) => { const handle = await open(file, ...args); if (file === f.archive) { const read = handle.read.bind(handle); handle.read = async (buffer, ...readArgs) => { assert.ok(buffer.length <= CODE_MAP_LIMITS.archiveBytes + 1); const result = await read(buffer, ...readArgs); if (!observed) { observed = true; await fs.appendFile(f.archive, ' '); } return result; }; } return handle; };
  try { await assert.rejects(get(f), { code: 'CODE_MAP_ARCHIVE_CHANGED' }); } finally { fs.open = open; } assert.equal(observed, true);
  assert.equal(path.dirname(f.archive), f.store.projectDir(f.project.id)); await fs.unlink(f.archive); await fs.mkdir(f.archive); await assert.rejects(get(f), error => ['CODE_MAP_ARCHIVE_ALIAS', 'EISDIR', 'EPERM'].includes(error.code));
});

test('单链接/二进制/编码/单文件预算失败显式跳过，敏感路径不进入扫描', async t => {
  const f = await fixture(t); const before = await scan(f);
  await fs.link(f.sourceFile, path.join(f.a, 'hardlink.mjs')); await fs.writeFile(path.join(f.a, 'binary.bin'), Buffer.from([65, 0, 66])); await fs.writeFile(path.join(f.a, 'invalid.txt'), Buffer.from([0xc3, 0x28])); await fs.writeFile(path.join(f.a, 'large.txt'), Buffer.alloc(1048577, 65));
  const current = await scan(f); assert.equal(current.truncated, true);
  for (const [relative, code] of [['src/service.mjs', 'FILE_ALIAS'], ['hardlink.mjs', 'FILE_ALIAS'], ['binary.bin', 'BINARY_FILE'], ['invalid.txt', 'ENCODING'], ['large.txt', 'FILE_LIMIT']]) { const file = current.files.find(file => file.repoId === f.repoA && file.path === relative); assert.deepEqual(file, { ...ref(f.repoA, relative), hash: null, skipped: code }); assert.ok(current.reasons.includes(code)); }
  assert.equal(current.files.some(file => /\.env|node_modules|\.git/.test(file.path)), false); assert.deepEqual(diffCodeMap(before, current).deleted, []);
});

test('普通目录被替换为junction时检测不完整，不把原文件误判删除；侧车目录链接拒绝', async t => {
  const f = await fixture(t); const before = await scan(f); const src = path.join(f.a, 'src'); const backup = path.join(f.root, 'original-src'); assert.equal(path.dirname(src), f.a); assert.equal(path.dirname(backup), f.root); await fs.rename(src, backup);
  try { await fs.symlink(path.join(f.b, 'src'), src, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if (error.code === 'EPERM') return t.skip('系统不允许创建测试链接'); throw error; }
  const current = await scan(f); assert.equal(current.truncated, true); assert.ok(current.reasons.includes('LINK_DENIED')); const delta = diffCodeMap(before, current); assert.deepEqual(delta.deleted, []); assert.ok(delta.uncertain.some(file => file.repoId === f.repoA && file.path === 'src/service.mjs'));
  const other = await f.store.createProject({ repositories: [{ path: f.b }] }); const directory = f.store.projectDir(other.id); const relocated = path.join(f.root, 'project-original'); assert.equal(path.dirname(directory), path.join(f.store.root, 'projects')); assert.equal(path.dirname(relocated), f.root); await fs.rename(directory, relocated); await fs.symlink(relocated, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(getCodeMap(f.store, other.id), { code: 'LINK_DENIED' }); await assert.rejects(mutateCodeMap(f.store, other.id, 0, next => next), { code: 'LINK_DENIED' });
});

test('路径预算全项目共享，两次元数据遍历也计入，超宽目录及时关闭', async t => {
  const f = await fixture(t); const opendir = fs.opendir; let entries = 0; let closed = 0;
  fs.opendir = async directory => [f.a, f.b].includes(directory) ? (async function* () { try { for (let index = 0; index < 2500; index++) { entries++; yield { name: `.env.${index}`, isSymbolicLink: () => false }; } } finally { closed++; } })() : opendir(directory);
  let result; try { result = await scan(f); } finally { fs.opendir = opendir; }
  assert.equal(result.stats.visited, CODE_MAP_LIMITS.paths); assert.ok(entries <= CODE_MAP_LIMITS.paths); assert.equal(closed, 4); assert.equal(result.truncated, true); assert.ok(result.reasons.includes('path-budget')); assert.deepEqual(result.files, []);
});

test('读取文件数全项目最多2000，未扫描部分明确为不完整', async t => {
  const f = await fixture(t);
  await virtualFiles(f, 2001, async metrics => { const result = await scan(f); assert.equal(metrics.opens, CODE_MAP_LIMITS.files); assert.equal(result.stats.readFiles, CODE_MAP_LIMITS.files); assert.equal(result.files.length, CODE_MAP_LIMITS.files); assert.ok(result.reasons.includes('file-budget')); assert.equal(result.truncated, true); assert.ok(result.stats.visited <= CODE_MAP_LIMITS.paths); });
});

test('超出8000路径的大仓仍保留局部哈希并检测内容变更，不永久退化为空扫描', async t => {
  const f = await fixture(t);
  await virtualFiles(f, 9000, async metrics => {
    const before = await scan(f); assert.equal(before.truncated, true); assert.ok(before.reasons.includes('path-budget')); assert.ok(before.files.length > 0 && before.files.length <= CODE_MAP_LIMITS.files); assert.ok(before.files.every(file => file.hash === digest(source))); assert.ok(metrics.entries <= CODE_MAP_LIMITS.paths); assert.equal(before.stats.visited, CODE_MAP_LIMITS.paths);
    const repo = f.project.repositories.find(item => item.id === before.files[0].repoId); await fs.writeFile(path.join(repo.root, 'src', 'service.mjs'), source.replace('1', '3'));
    const current = await scan(f); const delta = diffCodeMap(before, current); assert.equal(delta.modified.length, before.files.length); assert.equal(delta.changed, true); assert.equal(delta.truncated, true); assert.deepEqual(delta.deleted, []); assert.notEqual(current.fingerprint, before.fingerprint);
  });
});

test('字节预算跨仓共享，失败读取也保守收费，实际源码读取始终不超过16MiB', async t => {
  const f = await fixture(t); for (const repo of [f.a, f.b]) await fs.writeFile(path.join(repo, 'src', 'service.mjs'), Buffer.alloc(1048576, 65));
  await virtualFiles(f, 10, async metrics => { const result = await scan(f); assert.ok(result.files.some(file => file.repoId === f.repoA)); assert.ok(result.files.some(file => file.repoId === f.repoB)); assert.ok(metrics.bytes <= CODE_MAP_LIMITS.bytes); assert.equal(result.stats.readBytes, CODE_MAP_LIMITS.bytes); assert.ok(result.reasons.includes('byte-budget')); assert.ok(result.reasons.includes('SEARCH_BUDGET')); assert.equal(result.truncated, true); });
  for (const repo of [f.a, f.b]) await fs.writeFile(path.join(repo, 'src', 'service.mjs'), Buffer.alloc(1048576, 0));
  await virtualFiles(f, 10, async metrics => { const result = await scan(f); assert.ok(metrics.bytes <= CODE_MAP_LIMITS.bytes); assert.equal(result.stats.readBytes, CODE_MAP_LIMITS.bytes); assert.ok(result.files.every(file => file.hash === null)); assert.ok(result.reasons.includes('BINARY_FILE')); assert.ok(result.reasons.includes('byte-budget')); });
});

test('长路径元数据有独立预算，可持久化的扫描和双baseline侧车均受限', async t => {
  const f = await fixture(t);
  await virtualFiles(f, 1200, async () => { const result = await scan(f); assert.equal(result.truncated, true); assert.ok(result.reasons.includes('metadata-budget')); assert.ok(result.files.length > 0 && result.files.length < CODE_MAP_LIMITS.files); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= CODE_MAP_LIMITS.scanBytes); const lesson = await publish(f); const state = await mutate(f, 0, next => ({ ...next, task: taskFor(f, result), latest: { sessionId: f.session.id, lessonId: lesson.id, generatedAt: lesson.createdAt, model, baseline: result } })); assert.equal((await fs.stat(f.archive)).size <= CODE_MAP_LIMITS.archiveBytes, true); assert.deepEqual(await get(f), state); }, index => `virtual-${String(index).padStart(5, '0')}-${'中'.repeat(600)}.mjs`);
});

for (const mode of ['disable', 'remove', 'cancel']) test(`扫描中${mode}守卫阻断返回且不写侧车`, async t => {
  const f = await fixture(t); const open = fs.open; const controller = new AbortController(); let active = true; let read = false;
  fs.open = async (file, ...args) => { const handle = await open(file, ...args); if (String(file).startsWith(f.a + path.sep) || String(file).startsWith(f.b + path.sep)) { read = true; if (mode === 'cancel') controller.abort(Object.assign(new Error('cancelled'), { code: 'READING_CANCELLED' })); else if (mode === 'remove') f.store.projects.get(f.project.id).removedAt = new Date().toISOString(); else active = false; } return handle; };
  const code = mode === 'cancel' ? 'READING_CANCELLED' : mode === 'remove' ? 'PROJECT_REMOVED' : 'READING_UNAVAILABLE';
  try { await assert.rejects(scanCodeMap(f.store, f.project.id, controller.signal, () => { if (!active) throw Object.assign(new Error('disabled'), { code: 'READING_UNAVAILABLE' }); }), { code }); } finally { fs.open = open; }
  assert.equal(read, true); await assert.rejects(fs.stat(f.archive), { code: 'ENOENT' });
});

for (const phase of ['before', 'update', 'fsync']) test(`停用guard在${phase}阶段生效，异步回调和最终rename前均不覆盖`, async t => {
  const f = await fixture(t); await savedTask(f); const before = await fs.readFile(f.archive, 'utf8'); const open = fs.open; let active = phase !== 'before'; let observed = false;
  const guard = () => { if (!active) throw Object.assign(new Error('disabled'), { code: 'READING_UNAVAILABLE' }); };
  fs.open = async (file, ...args) => { const handle = await open(file, ...args); if (phase === 'fsync' && String(file).startsWith(f.archive + '.') && String(file).endsWith('.tmp')) { const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); active = false; observed = true; }; } return handle; };
  try { await assert.rejects(mutate(f, 1, async next => { if (phase === 'update') { await Promise.resolve(); active = false; } next.task.status = 'cancelled'; return next; }, guard), { code: 'READING_UNAVAILABLE' }); } finally { fs.open = open; }
  if (phase === 'fsync') assert.equal(observed, true); assert.equal(await fs.readFile(f.archive, 'utf8'), before);
  if (phase === 'before') await assert.rejects(getCodeMap(f.store, f.project.id, guard), { code: 'READING_UNAVAILABLE' });
});

for (const mode of ['remove', 'root-change']) test(`fsync期间${mode}在最终提交边界阻断rename`, async t => {
  const f = await fixture(t); await savedTask(f); const before = await fs.readFile(f.archive, 'utf8'); const open = fs.open; let observed = false;
  fs.open = async (file, ...args) => {
    const handle = await open(file, ...args);
    if (String(file).startsWith(f.archive + '.') && String(file).endsWith('.tmp')) {
      const sync = handle.sync.bind(handle); handle.sync = async () => {
        await sync(); observed = true;
        if (mode === 'remove') f.store.projects.get(f.project.id).removedAt = new Date().toISOString();
        else { const backup = path.join(f.root, 'repo-a-original'); assert.equal(path.dirname(f.a), f.root); assert.equal(path.dirname(backup), f.root); await fs.rename(f.a, backup); await fs.mkdir(f.a); }
      };
    }
    return handle;
  };
  try { await assert.rejects(mutate(f, 1, next => next), { code: mode === 'remove' ? 'PROJECT_REMOVED' : 'ROOT_CHANGED' }); } finally { fs.open = open; }
  assert.equal(observed, true); assert.equal(await fs.readFile(f.archive, 'utf8'), before);
});

test('异步update或fsync期间外部改写侧车不能被覆盖，文件身份冲突优先保留外部档案', async t => {
  const f = await fixture(t); await savedTask(f); const original = await fs.readFile(f.archive, 'utf8'); const external = original + ' ';
  await assert.rejects(mutate(f, 1, async next => { await fs.writeFile(f.archive, external); return next; }), { code: 'CODE_MAP_ARCHIVE_CHANGED' }); assert.equal(await fs.readFile(f.archive, 'utf8'), external);
  const open = fs.open; const later = external + ' ';
  fs.open = async (file, ...args) => { const handle = await open(file, ...args); if (String(file).startsWith(f.archive + '.') && String(file).endsWith('.tmp')) { const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); await fs.writeFile(f.archive, later); }; } return handle; };
  try { await assert.rejects(mutate(f, 1, next => next), { code: 'CODE_MAP_ARCHIVE_CHANGED' }); } finally { fs.open = open; } assert.equal(await fs.readFile(f.archive, 'utf8'), later);
});

test('仓库/产物根身份、运行中绑定变化与项目移除均拒绝缓存复活或迟到提交', async t => {
  const f = await fixture(t); await savedTask(f); const before = await fs.readFile(f.archive, 'utf8'); const project = f.store.projects.get(f.project.id); const identity = project.repositories[0].identity;
  project.repositories[0].identity = { ...identity, ino: '-1' }; await assert.rejects(get(f), { code: 'ROOT_CHANGED' }); await assert.rejects(scan(f), { code: 'ROOT_CHANGED' }); project.repositories[0].identity = identity;
  const storage = f.store.storageBinding.identity; f.store.storageBinding.identity = { ...storage, ino: '-1' }; await assert.rejects(get(f), { code: 'ROOT_CHANGED' }); f.store.storageBinding.identity = storage;
  await assert.rejects(mutate(f, 1, async next => { await Promise.resolve(); project.repositories[0].identity = { ...identity, ino: '-1' }; return next; }), { code: 'CODE_MAP_BINDING_CHANGED' }); project.repositories[0].identity = identity;
  await assert.rejects(mutate(f, 1, async next => { await Promise.resolve(); project.removedAt = new Date().toISOString(); return next; })); delete project.removedAt; assert.equal(await fs.readFile(f.archive, 'utf8'), before);
  await f.store.removeProject({ projectId: f.project.id, expectedBindingRevision: 1 }); await assert.rejects(get(f), { code: 'PROJECT_REMOVED' }); await assert.rejects(scan(f), { code: 'PROJECT_REMOVED' }); await assert.rejects(mutate(f, 1, next => next), { code: 'PROJECT_REMOVED' }); assert.equal(await fs.readFile(f.archive, 'utf8'), before);
});
