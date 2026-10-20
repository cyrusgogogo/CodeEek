import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ReadingStore } from '../src/store.mjs';
import { readReadingSettings, setDefaultModel, SETTINGS_FILE } from '../src/preferences.mjs';
const base = path.resolve('.test-output');
const one = { provider: 'remote', model: 'reader' }, two = { provider: 'local', model: 'private' };
const update = (defaultModel, expectedRevision = 0) => ({ expectedRevision, defaultModel });
async function fixture(t) {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'preferences-'));
  const store = await new ReadingStore(path.join(root, 'artifacts')).init(); const file = path.join(store.root, SETTINGS_FILE);
  t.after(async () => { for (const pending of store.locks.values()) await pending.catch(() => {}); assert.equal(path.dirname(path.resolve(root)), base); assert.match(path.basename(root), /^preferences-/); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store, file };
}
test('无默认只读返回revision0/null且不创建文件；初始清除也是无写入', async t => {
  const f = await fixture(t); const before = await fs.readdir(f.store.root);
  assert.deepEqual(await readReadingSettings(f.store), { revision: 0, defaultModel: null });
  assert.deepEqual(await setDefaultModel(f.store, update(null)), { revision: 0, defaultModel: null });
  assert.deepEqual(await fs.readdir(f.store.root), before);
});
test('CAS独立、清除版本保留、重启恢复且返回不共享可变引用', async t => {
  const f = await fixture(t); const saved = await setDefaultModel(f.store, update(one));
  assert.deepEqual(saved, { revision: 1, defaultModel: one }); saved.defaultModel.model = 'tamper';
  assert.deepEqual(await readReadingSettings(f.store), { revision: 1, defaultModel: one });
  await assert.rejects(setDefaultModel(f.store, update(two)), { code: 'STALE_READING_SETTINGS' });
  const restarted = await new ReadingStore(f.store.root).init(); assert.deepEqual(await readReadingSettings(restarted), { revision: 1, defaultModel: one });
  assert.deepEqual(await setDefaultModel(restarted, update(null, 1)), { revision: 2, defaultModel: null });
  assert.deepEqual(await readReadingSettings(await new ReadingStore(f.store.root).init()), { revision: 2, defaultModel: null });
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), { version: 1, revision: 2, defaultModel: null });
});
test('并发同revision只提交一个；严格refs/NUL/版本/未知字段；核验失败不写入', async t => {
  const f = await fixture(t); const results = await Promise.allSettled([setDefaultModel(f.store, update(one)), setDefaultModel(f.store, update(two))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'STALE_READING_SETTINGS');
  const before = await fs.readFile(f.file);
  for (const raw of [update({ ...one, extra: true }, 1), update({ ...one, provider: 'x\0y' }, 1), update({ ...one, model: 'x\0y' }, 1), update({ ...one, model: 'm'.repeat(201) }, 1), update({ ...one, provider: ' ' }, 1), update(one, -1), update(one, Number.MAX_SAFE_INTEGER + 1), { ...update(one, 1), version: 1 }]) await assert.rejects(setDefaultModel(f.store, raw));
  await assert.rejects(setDefaultModel(f.store, update(two, 1), undefined, async () => { throw Object.assign(new Error('unavailable'), { code: 'DEFAULT_MODEL_UNAVAILABLE' }); }), { code: 'DEFAULT_MODEL_UNAVAILABLE' });
  assert.deepEqual(await fs.readFile(f.file), before);
});
test('损坏不影响store.init/list，仅显式0/null可恢复', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, '{broken');
  const restored = await new ReadingStore(f.store.root).init(); assert.deepEqual(restored.list().projects, []);
  await assert.rejects(readReadingSettings(restored), { code: 'READING_SETTINGS_CORRUPT' });
  await assert.rejects(setDefaultModel(restored, update(one)), { code: 'READING_SETTINGS_CORRUPT' });
  assert.equal(await fs.readFile(f.file, 'utf8'), '{broken');
  assert.deepEqual(await setDefaultModel(restored, update(null)), { revision: 1, defaultModel: null });
  assert.deepEqual(await readReadingSettings(restored), { revision: 1, defaultModel: null });
});
for (const attack of ['oversize', 'hardlink', 'junction', 'encoding']) test(`安全失败${attack}不可按损坏设置重置`, async t => {
  const f = await fixture(t); const target = path.join(f.root, 'outside.json'); await fs.writeFile(target, 'unrelated bytes');
  if (attack === 'oversize') await fs.writeFile(f.file, 'x'.repeat(8193));
  if (attack === 'hardlink') await fs.link(target, f.file);
  if (attack === 'junction') await fs.symlink(f.root, f.file, 'junction');
  if (attack === 'encoding') await fs.writeFile(f.file, Buffer.from([0xff, 0xfe]));
  for (const operation of [() => readReadingSettings(f.store), () => setDefaultModel(f.store, update(null))]) await assert.rejects(operation(), error => error.code !== 'READING_SETTINGS_CORRUPT');
  assert.equal(await fs.readFile(target, 'utf8'), 'unrelated bytes');
});
for (const point of ['validation', 'atomic']) test(`${point}等待期间guard阻止迟到提交`, async t => {
  const f = await fixture(t); await setDefaultModel(f.store, update(one)); const before = await fs.readFile(f.file); let active = true;
  const guard = () => { if (!active) throw Object.assign(new Error('disabled'), { code: 'READING_UNAVAILABLE' }); };
  const open = fs.open;
  if (point === 'atomic') fs.open = async (...args) => { const handle = await open(...args); if (String(args[0]).startsWith(f.file + '.') && String(args[0]).endsWith('.tmp')) { const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); active = false; }; } return handle; };
  try { await assert.rejects(setDefaultModel(f.store, update(two, 1), guard, async () => { if (point === 'validation') active = false; }), { code: 'READING_UNAVAILABLE' }); } finally { fs.open = open; }
  assert.deepEqual(await fs.readFile(f.file), before); assert.deepEqual(await readReadingSettings(f.store), { revision: 1, defaultModel: one });
});
