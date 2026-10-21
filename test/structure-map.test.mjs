import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReadingStore } from '../src/store.mjs';
import { digest } from '../src/filesystem.mjs';
import { getStructureMap, refreshStructureMap, updateStructureLayers, inspectStructureFile, STRUCTURE_LIMITS, STRUCTURE_LAYERS } from '../src/structure-map.mjs';

const base = path.resolve('.test-output');
const source = 'function submit(value) {\n  return value ? 1 : 0;\n}\n';
async function fixture(t, draft = false) {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'structure-map-'));
  const a = path.join(root, 'repo-a'); const b = path.join(root, 'repo-b'); await fs.mkdir(a); await fs.mkdir(b);
  const entries = { 'src/service.mjs': source, 'src/client/page.jsx': 'UI_SOURCE_SENTINEL\n', 'src/storage/cache.mjs': 'CACHE_SOURCE_SENTINEL\n', 'test/service.test.mjs': 'TEST_SOURCE_SENTINEL\n', 'docs/guide.md': 'DOC_SOURCE_SENTINEL\n', 'package.json': '{"secret":"CONFIG_SOURCE_SENTINEL"}\n', 'asset.raw': 'OTHER_SOURCE_SENTINEL\n', '.env': 'SECRET_SENTINEL\n', 'node_modules/hidden.mjs': 'DEPENDENCY_SENTINEL\n' };
  for (const [relative, text] of Object.entries(entries)) { const file = path.join(a, ...relative.split('/')); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
  await fs.mkdir(path.join(b, 'src')); await fs.writeFile(path.join(b, 'src', 'service.mjs'), source);
  const store = await new ReadingStore(path.join(root, 'artifacts')).init(); const project = await store.createProject({ repositories: [{ path: a }, { path: b }] }); const session = await store.createSession(project.id, { draft });
  const repoId = project.repositories[0].id; const repoB = project.repositories[1].id; const args = { sessionId: session.id, repoId };
  const archive = path.join(store.projectDir(project.id), 'structure', `${repoId}.json`);
  t.after(async () => { const absolute = path.resolve(root); assert.equal(path.dirname(absolute), base); assert.match(path.basename(absolute), /^structure-map-/); await fs.rm(absolute, { recursive: true, force: true }); });
  return { root, a, b, store, project, session, repoId, repoB, args, archive, sourceFile: path.join(a, 'src', 'service.mjs') };
}
const refresh = (f, expectedRevision = 0, extra = {}) => refreshStructureMap(f.store, { ...f.args, expectedRevision, ...extra });
const configure = (f, expectedRevision, customLayers = [], assignments = [], extra = {}) => updateStructureLayers(f.store, { ...f.args, expectedRevision, customLayers, assignments, ...extra });
const inspect = (f, relative = 'src/service.mjs', extra = {}) => inspectStructureFile(f.store, { ...f.args, path: relative, ...extra });
async function publish(f, sessionId = f.session.id, repoId = f.repoId, relative = 'src/service.mjs') {
  const evidence = (await f.store.read(sessionId, { repoId, path: relative })).evidence;
  const codeUnits = [{ kind: 'function', name: 'submit', repoId, path: relative, fileHash: evidence.hash, start: { line: 1, column: 0 }, end: { line: 3, column: 1 }, conclusion: '已有归档结论，不是结构解析器结论。', evidenceIds: [evidence.id] }];
  return f.store.publish(sessionId, { expectedRevision: 1, title: '提交方法', markdown: '完整读取后解释。', conclusion: '当前源码仍需核验。', claims: [{ kind: 'fact', text: '读取过此版本', evidenceIds: [evidence.id] }], nextQuestions: ['调用方是什么？'], codeUnits });
}

test('未索引get不扫描源码、不创建侧车或草稿档案，默认层全部是建议', async t => {
  const f = await fixture(t, true); const open = fs.open; const opendir = fs.opendir; let reads = 0;
  fs.open = async (file, ...args) => { if (path.resolve(file).startsWith(f.a + path.sep)) { reads++; throw new Error('get must not read source'); } return open(file, ...args); };
  fs.opendir = async () => { throw new Error('get must not scan directories'); };
  let result; try { result = await getStructureMap(f.store, f.args); } finally { fs.open = open; fs.opendir = opendir; }
  assert.equal(reads, 0); assert.equal(result.revision, 0); assert.equal(result.bindingRevision, 1); assert.equal(result.indexedAt, null); assert.equal(result.inventoryHash, null); assert.deepEqual(result.files, []); assert.equal(result.truncated, false);
  assert.deepEqual(result.layers.map(layer => layer.id), STRUCTURE_LAYERS.map(layer => layer.id)); assert.ok(result.layers.every(layer => layer.origin === 'heuristic' && layer.fileCount === 0));
  await assert.rejects(fs.stat(f.archive), { code: 'ENOENT' }); await assert.rejects(fs.stat(f.store.sessionDir(f.session.id)), { code: 'ENOENT' }); assert.equal(f.store.session(f.session.id).draft, true);
});

test('显式刷新持久化路径库存与建议分层，草稿仅写项目侧车，不读取源码字节', async t => {
  const f = await fixture(t, true); const open = fs.open; let sourceReads = 0;
  fs.open = async (file, ...args) => { if (path.resolve(file).startsWith(f.a + path.sep)) { sourceReads++; throw new Error('inventory must not open source'); } return open(file, ...args); };
  let result; try { result = await refresh(f); } finally { fs.open = open; }
  assert.equal(sourceReads, 0); assert.equal(result.revision, 1); assert.equal(result.truncated, false); assert.equal(result.files.length, 7); assert.ok(result.indexedAt); assert.equal(result.inventoryHash, digest(JSON.stringify(result.files.map(file => file.path))));
  const files = new Map(result.files.map(file => [file.path, file]));
  for (const [relative, layer] of [['src/service.mjs', 'core'], ['src/client/page.jsx', 'ui'], ['src/storage/cache.mjs', 'data'], ['test/service.test.mjs', 'tests'], ['docs/guide.md', 'docs'], ['package.json', 'config'], ['asset.raw', 'other']]) assert.equal(files.get(relative).layerId, layer);
  assert.equal(files.get('src/client/page.jsx').modulePath, 'src/client'); assert.equal(files.get('package.json').modulePath, ''); assert.equal(files.get('src/service.mjs').extension, 'mjs');
  const disk = await fs.readFile(f.archive, 'utf8'); assert.doesNotMatch(disk, /SOURCE_SENTINEL|SECRET_SENTINEL|DEPENDENCY_SENTINEL|function submit|readingCount|conclusion/); assert.ok(JSON.parse(disk).files.every(file => typeof file === 'string'));
  await assert.rejects(fs.stat(f.store.sessionDir(f.session.id)), { code: 'ENOENT' }); assert.equal(f.store.session(f.session.id).draft, true); assert.equal(f.store.session(f.session.id).evidence.length, 0);
});

test('重启恢复同一项目索引；源码内容变化不伪装成库存hash变化，get不自动重扫', async t => {
  const f = await fixture(t); const first = await refresh(f); const disk = await fs.readFile(f.archive, 'utf8');
  await fs.writeFile(f.sourceFile, source.replace('1 : 0', '2 : 0')); await fs.writeFile(path.join(f.a, 'new.mjs'), 'new source');
  const restored = await new ReadingStore(f.store.root).init(); const cached = await getStructureMap(restored, f.args); assert.equal(cached.revision, 1); assert.equal(cached.inventoryHash, first.inventoryHash); assert.equal(cached.files.some(file => file.path === 'new.mjs'), false); assert.equal(await fs.readFile(f.archive, 'utf8'), disk);
  const updated = await refreshStructureMap(restored, { ...f.args, expectedRevision: 1 }); assert.equal(updated.files.length, first.files.length + 1); assert.notEqual(updated.inventoryHash, first.inventoryHash); assert.equal(restored.session(f.session.id).revision, 1); assert.equal(restored.session(f.session.id).readerState.revision, 0);
});

test('人工归属最长字面前缀优先，精确文件覆盖目录；刷新保留配置且去除后恢复建议', async t => {
  const f = await fixture(t); await refresh(f); const custom = [{ id: 'custom-reading', name: '阅读工作台', description: '用户定义的逻辑分组' }];
  const assignments = [{ prefix: '', layerId: 'other' }, { prefix: 'src/', layerId: 'core' }, { prefix: 'src/client', layerId: 'custom-reading' }, { prefix: 'src/client/page.jsx', layerId: 'tests' }];
  const saved = await configure(f, 1, custom, assignments); assert.equal(saved.revision, 2); assert.equal(saved.assignments[1].prefix, 'src'); assert.equal(saved.layers.find(layer => layer.id === 'custom-reading').origin, 'manual');
  assert.equal(saved.files.find(file => file.path === 'src/client/page.jsx').layerId, 'tests'); assert.equal(saved.files.find(file => file.path === 'src/storage/cache.mjs').layerId, 'core'); assert.equal(saved.files.find(file => file.path === 'package.json').layerId, 'other');
  assert.equal((await configure(f, 2, custom, saved.assignments)).revision, 2);
  const rescanned = await refresh(f, 2); assert.deepEqual(rescanned.assignments, saved.assignments); assert.deepEqual(rescanned.customLayers, custom); assert.equal(rescanned.inventoryHash, saved.inventoryHash);
  const reset = await configure(f, 3); assert.equal(reset.files.find(file => file.path === 'src/client/page.jsx').layerId, 'ui'); assert.equal(reset.revision, 4);
});

test('未索引也可保存人工配置；非法层/路径/额外字段与集合预算均拒绝', async t => {
  const f = await fixture(t); const custom = [{ id: 'custom-a', name: '我的层', description: '' }]; const saved = await configure(f, 0, custom, [{ prefix: 'src', layerId: 'custom-a' }]); assert.equal(saved.revision, 1); assert.equal(saved.indexedAt, null); assert.deepEqual(saved.files, []);
  const before = await fs.readFile(f.archive, 'utf8');
  for (const prefix of ['../escape', '/absolute', 'C:/outside', 'a\\b', 'src//', '.env', 'node_modules', 'NUL']) await assert.rejects(configure(f, 1, custom, [{ prefix, layerId: 'custom-a' }]));
  await assert.rejects(configure(f, 1, custom, [{ prefix: 'src', layerId: 'custom-missing' }]), { code: 'STRUCTURE_LAYER_NOT_FOUND' });
  await assert.rejects(configure(f, 1, custom, [{ prefix: 'src', layerId: 'core' }, { prefix: 'src/', layerId: 'tests' }]), { code: 'STRUCTURE_PREFIX_CONFLICT' });
  await assert.rejects(configure(f, 1, [...custom, ...custom]), { code: 'STRUCTURE_LAYER_CONFLICT' });
  for (const customLayers of [[{ id: 'core', name: '不能冒充固定层', description: '' }], [{ id: 'custom-a', name: 'x'.repeat(61), description: '' }], [{ id: 'custom-a', name: '有效', description: 'x'.repeat(241) }], Array.from({ length: 17 }, (_, index) => ({ id: `custom-${index}`, name: '层', description: '' }))]) await assert.rejects(configure(f, 1, customLayers));
  await assert.rejects(configure(f, 1, [], Array.from({ length: 129 }, (_, index) => ({ prefix: `file-${index}`, layerId: 'core' }))));
  await assert.rejects(getStructureMap(f.store, { ...f.args, source: 'not-allowed' })); await assert.rejects(configure(f, 1, custom, [], { source: 'not-allowed' })); assert.equal(await fs.readFile(f.archive, 'utf8'), before);
});

test('多页面/跨会话共享repo索引CAS，不同repo与项目隔离，同名同hash不串联历史', async t => {
  const f = await fixture(t); const second = await f.store.createSession(f.project.id); await publish(f); const results = await Promise.allSettled([refresh(f), refresh(f, 0, { sessionId: second.id })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.find(result => result.status === 'rejected').reason.code, 'STALE_STRUCTURE_MAP');
  const a = await getStructureMap(f.store, { ...f.args, sessionId: second.id }); assert.equal(a.files.find(file => file.path === 'src/service.mjs').readingCount, 1);
  const b = await refresh(f, 0, { repoId: f.repoB }); assert.equal(b.revision, 1); assert.equal(b.files[0].readingCount, 0);
  const project = await f.store.createProject({ repositories: [{ path: f.a }] }); const session = await f.store.createSession(project.id); const other = await refreshStructureMap(f.store, { sessionId: session.id, repoId: project.repositories[0].id, expectedRevision: 0 }); assert.equal(other.files.find(file => file.path === 'src/service.mjs').readingCount, 0);
  await assert.rejects(getStructureMap(f.store, { ...f.args, repoId: project.repositories[0].id }), { code: 'REPO_NOT_BOUND' }); await assert.rejects(getStructureMap(f.store, { ...f.args, sessionId: `reading-${randomUUID()}` }), { code: 'READING_NOT_FOUND' });
});

test('历史计数去重知识点而非证据/单元，按需inspect核验hash但不生成新证据或源码返回', async t => {
  const f = await fixture(t); const lesson = await publish(f); const second = await f.store.createSession(f.project.id); await publish(f, second.id); const result = await refresh(f);
  assert.equal(result.files.find(file => file.path === 'src/service.mjs').readingCount, 2); assert.equal(result.layers.find(layer => layer.id === 'core').readingFileCount, 1); assert.equal(result.readingTruncated, false);
  const evidenceCount = f.store.session(f.session.id).evidence.length; const checked = await inspect(f); assert.equal(checked.codeReadings.items.length, 2); assert.ok(checked.codeReadings.items.some(item => item.lessonId === lesson.id)); assert.equal(checked.hash, digest(Buffer.from(source))); assert.equal(checked.bindingRevision, 1); assert.equal(checked.indexRevision, 1); assert.equal(checked.bytes, Buffer.byteLength(source)); assert.equal(checked.totalLines, 4); assert.equal(Object.hasOwn(checked, 'text'), false); assert.equal(Object.hasOwn(checked, 'lines'), false); assert.equal(f.store.session(f.session.id).evidence.length, evidenceCount);
  const stat = await fs.stat(f.sourceFile); await fs.writeFile(f.sourceFile, source.replace('1 : 0', '2 : 0')); await fs.utimes(f.sourceFile, stat.atime, stat.mtime);
  const stale = await inspect(f); assert.equal(stale.codeReadings.items.length, 0); assert.equal(stale.codeReadings.staleCount, 2); assert.notEqual(stale.hash, checked.hash); assert.equal((await getStructureMap(f.store, f.args)).files.find(file => file.path === 'src/service.mjs').readingCount, 2);
  const audit = await fs.readFile(path.join(f.store.sessionDir(f.session.id), 'audit.jsonl'), 'utf8'); assert.doesNotMatch(audit, /function submit|return value/); assert.equal(f.store.session(f.session.id).evidence.length, evidenceCount);
});

test('旧档案无codeUnits仍能展示真实证据关联，损坏引用明确readingTruncated且不猜方法', async t => {
  const f = await fixture(t); const saved = await publish(f); const state = f.store.session(f.session.id); delete state.lessons[0].codeUnits;
  state.lessons.push({ ...structuredClone(saved), id: `lesson-${randomUUID()}`, claims: [null], topics: [], codeUnits: [] });
  const result = await refresh(f); assert.equal(result.files.find(file => file.path === 'src/service.mjs').readingCount, 1); assert.equal(result.readingTruncated, true);
  const checked = await inspect(f); assert.equal(checked.codeReadings.items.length, 0); assert.equal(checked.codeReadings.legacyCount, 1);
});

test('索引历史扫描先隔离项目，并为会话/知识点/引用预算明确截断', async t => {
  const f = await fixture(t); const saved = await publish(f); await refresh(f); const foreignId = `project-${randomUUID()}`;
  for (let index = 0; index < 1100; index++) { const id = `reading-${randomUUID()}`; f.store.sessions.set(id, { id, projectId: foreignId, get lessons() { throw new Error('must not inspect foreign archive'); } }); }
  assert.equal((await getStructureMap(f.store, f.args)).readingTruncated, false);
  const state = f.store.session(f.session.id); state.lessons = Array.from({ length: STRUCTURE_LIMITS.lessons + 1 }, () => ({ ...structuredClone(saved), id: `lesson-${randomUUID()}` }));
  assert.equal((await getStructureMap(f.store, f.args)).readingTruncated, true);
  state.lessons = Array.from({ length: 3000 }, () => ({ ...structuredClone(saved), id: `lesson-${randomUUID()}`, claims: [{ evidenceIds: Array.from({ length: 20 }, () => state.evidence[0].id) }] }));
  assert.equal((await getStructureMap(f.store, f.args)).readingTruncated, true);
  state.lessons = [saved];
  for (let index = 0; index < STRUCTURE_LIMITS.sessions; index++) { const id = `reading-${randomUUID()}`; f.store.sessions.set(id, { id, projectId: f.project.id, lessons: [], evidence: [] }); }
  assert.equal((await getStructureMap(f.store, f.args)).readingTruncated, true);
});

test('目录访问预算包含排除文件，超宽目录及时关闭且不把截断当完整清单', async t => {
  const f = await fixture(t); const opendir = fs.opendir; let visited = 0; let closed = false;
  fs.opendir = async directory => directory === f.a ? (async function* () { try { for (let index = 0; index < 100000; index++) { visited++; yield { name: `.env.${index}`, isSymbolicLink: () => false }; } } finally { closed = true; } })() : opendir(directory);
  let result; try { result = await refresh(f); } finally { fs.opendir = opendir; }
  assert.equal(result.visited, 8000); assert.equal(result.truncated, true); assert.deepEqual(result.truncationReasons, ['scan-budget']); assert.deepEqual(result.files, []); assert.ok(visited <= 8001); assert.equal(closed, true); assert.equal((await getStructureMap(f.store, f.args)).truncated, true);
});

test('长路径库存有独立字节预算且显式截断，持久化与响应均受限', async t => {
  const f = await fixture(t); const opendir = fs.opendir;
  fs.opendir = async directory => directory === f.a ? (async function* () { for (let index = 0; index < 3000; index++) yield { name: `${String(index).padStart(5, '0')}-${'中'.repeat(600)}.ts`, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }; })() : opendir(directory);
  let result; try { result = await refresh(f); } finally { fs.opendir = opendir; }
  assert.equal(result.truncated, true); assert.deepEqual(result.truncationReasons, ['metadata-budget']); assert.ok(result.files.length > 0 && result.files.length < 3000); assert.equal(result.visited, 3000); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= STRUCTURE_LIMITS.responseBytes); assert.ok((await fs.stat(f.archive)).size <= STRUCTURE_LIMITS.archiveBytes); assert.deepEqual((await getStructureMap(f.store, f.args)).files, result.files);
});

test('损坏、未来格式、伪造绑定/清单hash、超大和别名侧车拒绝且不清空人工配置', async t => {
  const f = await fixture(t); await refresh(f); const original = JSON.parse(await fs.readFile(f.archive, 'utf8'));
  for (const patch of [{ version: 99 }, { repoId: f.repoB }, { projectId: `project-${randomUUID()}` }, { bindingKey: 'a'.repeat(64) }, { inventoryHash: 'a'.repeat(64) }, { files: ['../escape'] }, { source: 'MUST_NOT_ACCEPT' }, { truncated: true }]) {
    const disk = JSON.stringify({ ...original, ...patch }); await fs.writeFile(f.archive, disk); await assert.rejects(getStructureMap(f.store, f.args)); await assert.rejects(refresh(f, 1)); assert.equal(await fs.readFile(f.archive, 'utf8'), disk);
  }
  await fs.writeFile(f.archive, Buffer.alloc(STRUCTURE_LIMITS.archiveBytes + 1, 65)); await assert.rejects(getStructureMap(f.store, f.args), { code: 'STRUCTURE_ARCHIVE_LIMIT' });
  await fs.writeFile(f.archive, JSON.stringify(original)); const alias = path.join(f.root, 'archive-alias'); await fs.link(f.archive, alias); await assert.rejects(getStructureMap(f.store, f.args), { code: 'STRUCTURE_ARCHIVE_ALIAS' });
});

test('inspect继续拒绝越界/敏感/硬链接/二进制/编码/大小错误，不因清单存在放宽', async t => {
  const f = await fixture(t); await refresh(f);
  for (const relative of ['../escape', 'C:/outside', 'src\\service.mjs', '.env', 'node_modules/hidden.mjs']) await assert.rejects(inspect(f, relative));
  await fs.link(f.sourceFile, path.join(f.a, 'alias.mjs')); await assert.rejects(inspect(f), { code: 'FILE_ALIAS' }); const alias = path.join(f.a, 'alias.mjs'); assert.equal(path.dirname(alias), f.a); await fs.unlink(alias);
  for (const [data, code] of [[Buffer.from([65, 0, 66]), 'BINARY_FILE'], [Buffer.from([0xc3, 0x28]), 'ENCODING'], [Buffer.alloc(1048577, 65), 'FILE_LIMIT']]) { await fs.writeFile(f.sourceFile, data); await assert.rejects(inspect(f), { code }); }
  assert.equal(f.store.session(f.session.id).evidence.length, 0);
});

test('目录链接不扫描且按需读取拒绝，侧车目录链接不接入', async t => {
  const f = await fixture(t); const link = path.join(f.a, 'escape');
  try { await fs.symlink(f.b, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if (error.code === 'EPERM') return t.skip('系统不允许创建测试链接'); throw error; }
  const result = await refresh(f); assert.equal(result.files.some(file => file.path.startsWith('escape/')), false); await assert.rejects(inspect(f, 'escape/src/service.mjs'), { code: 'LINK_DENIED' });
  const other = await f.store.createProject({ repositories: [{ path: f.b }] }); const session = await f.store.createSession(other.id); await fs.symlink(f.a, path.join(f.store.projectDir(other.id), 'structure'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(getStructureMap(f.store, { sessionId: session.id, repoId: other.repositories[0].id }), { code: 'LINK_DENIED' });
});

for (const mode of ['cancel', 'disable', 'audit']) test(`刷新审计期间${mode}失败不提交新索引`, async t => {
  const f = await fixture(t); await refresh(f); const before = await fs.readFile(f.archive, 'utf8'); const audit = f.store.audit.bind(f.store); const controller = new AbortController(); let active = true;
  f.store.audit = async (...args) => { if (args[1] === 'structure-map-refresh-attempt') { if (mode === 'audit') throw new Error('audit unavailable'); await audit(...args); if (mode === 'cancel') controller.abort(Object.assign(new Error('cancelled'), { code: 'READING_CANCELLED' })); else active = false; } else await audit(...args); };
  await assert.rejects(refreshStructureMap(f.store, { ...f.args, expectedRevision: 1 }, controller.signal, () => { if (!active) throw Object.assign(new Error('disabled'), { code: 'READING_UNAVAILABLE' }); })); assert.equal(await fs.readFile(f.archive, 'utf8'), before); assert.equal((await getStructureMap(f.store, f.args)).revision, 1);
});

test('原子临时文件fsync期间停用时最终守卫拒绝rename，旧配置完整', async t => {
  const f = await fixture(t); await refresh(f); const before = await fs.readFile(f.archive, 'utf8'); const open = fs.open; let active = true; let observed = false;
  fs.open = async (file, ...args) => { const handle = await open(file, ...args); if (String(file).startsWith(f.archive + '.') && String(file).endsWith('.tmp')) { const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); active = false; observed = true; }; } return handle; };
  try { await assert.rejects(updateStructureLayers(f.store, { ...f.args, expectedRevision: 1, customLayers: [], assignments: [{ prefix: 'src', layerId: 'tests' }] }, undefined, () => { if (!active) throw Object.assign(new Error('disabled during fsync'), { code: 'READING_UNAVAILABLE' }); }), { code: 'READING_UNAVAILABLE' }); } finally { fs.open = open; }
  assert.equal(observed, true); assert.equal(await fs.readFile(f.archive, 'utf8'), before);
});

test('保存期间侧车被外部更新不覆盖，取消inspect审计不返回结果或创建证据', async t => {
  const f = await fixture(t); await refresh(f); const before = await fs.readFile(f.archive, 'utf8'); const audit = f.store.audit.bind(f.store); const external = before + ' ';
  f.store.audit = async (...args) => { await audit(...args); if (args[1] === 'structure-map-refresh-attempt') await fs.writeFile(f.archive, external); };
  await assert.rejects(refresh(f, 1), { code: 'STRUCTURE_ARCHIVE_CHANGED' }); assert.equal(await fs.readFile(f.archive, 'utf8'), external);
  const controller = new AbortController(); f.store.audit = async (...args) => { await audit(...args); if (args[1] === 'structure-file') controller.abort(Object.assign(new Error('cancelled'), { code: 'READING_CANCELLED' })); };
  await assert.rejects(inspectStructureFile(f.store, { ...f.args, path: 'src/service.mjs' }, controller.signal), { code: 'READING_CANCELLED' }); assert.equal(f.store.session(f.session.id).evidence.length, 0);
});

test('仓库移除与根身份变化后缓存不复活；旧请求不能访问跨绑定侧车', async t => {
  const f = await fixture(t); await refresh(f); const before = await fs.readFile(f.archive, 'utf8');
  const original = f.store.projects.get(f.project.id).repositories[0].identity; f.store.projects.get(f.project.id).repositories[0].identity = { ...original, ino: '-1' };
  await assert.rejects(getStructureMap(f.store, f.args), { code: 'ROOT_CHANGED' }); f.store.projects.get(f.project.id).repositories[0].identity = original;
  await f.store.removeProject({ projectId: f.project.id, expectedBindingRevision: 1 }); await assert.rejects(getStructureMap(f.store, f.args), { code: 'PROJECT_REMOVED' }); assert.equal(await fs.readFile(f.archive, 'utf8'), before);
});
