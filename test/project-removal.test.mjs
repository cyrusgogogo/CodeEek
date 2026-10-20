import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ReadingStore } from '../src/store.mjs';

const base = path.resolve('.test-output');
async function fixture(t) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'project-removal-'));
  const repo = path.join(root, 'source'); await fs.mkdir(repo);
  await fs.writeFile(path.join(repo, 'entry.ts'), 'export const answer = 42;\n');
  const dataDir = path.join(root, 'artifacts'); const store = await new ReadingStore(dataDir).init();
  const project = await store.createProject({ repositories: [{ path: repo }] });
  const session = await store.createSession(project.id);
  const draft = await store.createSession(project.id, { draft: true });
  const stateFile = path.join(store.sessionDir(session.id), 'state.json');
  t.after(async () => { for (const pending of store.locks.values()) await pending.catch(() => {}); assert.equal(path.dirname(path.resolve(root)), base); assert.match(path.basename(root), /^project-removal-/); await fs.rm(root, { recursive: true, force: true }); });
  return { root, repo, dataDir, store, project, session, draft, stateFile, args: { projectId: project.id, expectedBindingRevision: 1 } };
}

test('移除仓库只写项目 tombstone，不删源码、档案或改变不可变绑定，重启后不再列出', async t => {
  const f = await fixture(t); const source = await fs.readFile(path.join(f.repo, 'entry.ts')); const archive = await fs.readFile(f.stateFile);
  const result = await f.store.removeProject(f.args);
  assert.equal(result.projectId, f.project.id); assert.equal(typeof result.removedAt, 'string');
  assert.deepEqual(f.store.list().projects, []);
  assert.deepEqual(await fs.readFile(path.join(f.repo, 'entry.ts')), source); assert.deepEqual(await fs.readFile(f.stateFile), archive);
  const saved = JSON.parse(await fs.readFile(path.join(f.store.projectDir(f.project.id), 'project.json'), 'utf8'));
  assert.deepEqual(saved.repositories, f.project.repositories); assert.equal(saved.bindingRevision, 1); assert.equal(saved.removedAt, result.removedAt);
  assert.deepEqual(await f.store.removeProject(f.args), result, 'exact same removal is idempotent');
  assert.throws(() => f.store.project(f.project.id), { code: 'PROJECT_REMOVED' }); assert.throws(() => f.store.session(f.session.id), { code: 'PROJECT_REMOVED' }); assert.throws(() => f.store.repo(f.session.id, f.project.repositories[0].id), { code: 'PROJECT_REMOVED' });
  await assert.rejects(f.store.createSession(f.project.id), { code: 'PROJECT_REMOVED' });
  const restored = await new ReadingStore(f.dataDir).init(); assert.deepEqual(restored.list().projects, []); assert.deepEqual(restored.diagnostics, []);
  assert.throws(() => restored.project(f.project.id), { code: 'PROJECT_REMOVED' });
  const another = await f.store.createProject({ repositories: [{ path: f.repo }] }); await f.store.createSession(another.id);
  assert.equal(f.store.list().projects[0].id, another.id, 'a removed draft cannot block unrelated project writes');
});

test('移除核验绑定版本、严格参数与 busy；失败不改项目文件', async t => {
  const f = await fixture(t); const file = path.join(f.store.projectDir(f.project.id), 'project.json'); const before = await fs.readFile(file);
  await assert.rejects(f.store.removeProject({ ...f.args, expectedBindingRevision: 2 }), { code: 'STALE_BINDING_REVISION' });
  await assert.rejects(f.store.removeProject({ ...f.args, root: f.repo }));
  await assert.rejects(f.store.removeProject(f.args, undefined, id => id === f.session.id), { code: 'AGENT_BUSY' });
  assert.deepEqual(await fs.readFile(file), before); assert.equal(f.store.list().projects.length, 1);
});

test('等待会话准入期间停用时拒绝迟到移除，保留项目及会话', async t => {
  const f = await fixture(t); assert.equal(typeof f.store.removeProject, 'function'); let entered, release; const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const held = f.store.lock(`admission:${f.session.id}`, async () => { entered(); await gate; }); await started;
  let active = true; const guard = () => { if (!active) throw Object.assign(new Error('disabled'), { code: 'READING_UNAVAILABLE' }); };
  const before = f.store.locks.get(`admission:${f.session.id}`);
  const removal = f.store.removeProject(f.args, guard); const rejected = assert.rejects(removal, { code: 'READING_UNAVAILABLE' });
  try { await new Promise(setImmediate); assert.notEqual(f.store.locks.get(`admission:${f.session.id}`), before, 'removal has reached the held admission lock'); }
  finally { active = false; release(); await held; await rejected; }
  assert.equal(f.store.list().projects.length, 1); assert.equal(f.store.session(f.session.id).id, f.session.id);
});

test('同项目会话锁内的写入先完成，移除提交后旧操作不能读取或发布', async t => {
  const f = await fixture(t); assert.equal(typeof f.store.removeProject, 'function'); let entered, release; const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const held = f.store.lock(f.session.id, async () => { entered(); await gate; }); await started;
  const removal = f.store.removeProject(f.args); let committed = false; removal.then(() => { committed = true; });
  await Promise.resolve(); assert.equal(committed, false); release(); await held; await removal;
  await assert.rejects(f.store.read(f.session.id, { repoId: f.project.repositories[0].id, path: 'entry.ts' }), { code: 'PROJECT_REMOVED' });
});

for (const change of ['disable', 'busy']) test(`移除在临时文件 fsync 期间 ${change}，最终守卫保留原项目和档案`, async t => {
  const f = await fixture(t); const file = path.join(f.store.projectDir(f.project.id), 'project.json'); const before = await fs.readFile(file); const archive = await fs.readFile(f.stateFile); const open = fs.open;
  let active = true; let running = false; let observed = false;
  const guard = () => { if (!active) throw Object.assign(new Error('disabled'), { code: 'READING_UNAVAILABLE' }); };
  fs.open = async (...args) => { const handle = await open(...args); if (String(args[0]).startsWith(file + '.') && String(args[0]).endsWith('.tmp')) { const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); observed = true; if (change === 'disable') active = false; else running = true; }; } return handle; };
  try { await assert.rejects(f.store.removeProject(f.args, guard, () => running), { code: change === 'disable' ? 'READING_UNAVAILABLE' : 'AGENT_BUSY' }); } finally { fs.open = open; }
  assert.equal(observed, true); assert.deepEqual(await fs.readFile(file), before); assert.deepEqual(await fs.readFile(f.stateFile), archive); assert.equal(f.store.list().projects.length, 1);
});
