import fs from 'node:fs/promises';
import { constants, lstatSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { fail } from './contracts.mjs';
import { checkBinding, checkPlain, atomicText } from './filesystem.mjs';

export const SETTINGS_FILE = 'reading-settings.json';
export const SETTINGS_MAX_BYTES = 8192;
const ref = max => z.string().trim().min(1).max(max).refine(value => !value.includes('\0'), { message: '模型标识不能包含NUL' });
export const modelRefSchema = z.object({ provider: ref(100), model: ref(200) }).strict();
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const savedSchema = z.object({ version: z.literal(1), revision, defaultModel: modelRefSchema.nullable() }).strict();
const updateSchema = z.object({ expectedRevision: revision, defaultModel: modelRefSchema.nullable() }).strict();
const initial = () => ({ revision: 0, defaultModel: null });
const view = state => structuredClone({ revision: state.revision, defaultModel: state.defaultModel });
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
function corrupt() { fail('READING_SETTINGS_CORRUPT', '默认阅读模型设置损坏；存量阅读不受影响。可明确重置默认模型后重新设置'); }
function checkFile(stat) {
  if (!stat.isFile() || stat.nlink !== 1n) fail('READING_SETTINGS_ALIAS', '默认模型设置必须为单链接普通文件，不能覆盖别名或目录');
  if (stat.size > BigInt(SETTINGS_MAX_BYTES)) fail('READING_SETTINGS_LIMIT', '默认模型设置超过8KiB限制，请检查档案，不会自动重置');
}
async function inspect(store, guard) {
  guard?.(); await checkBinding(store.storageBinding);
  const file = path.join(store.root, SETTINGS_FILE); await checkPlain(file, true);
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await checkBinding(store.storageBinding); guard?.();
    return { state: initial(), stamp: null, corrupt: false };
  }
  let bytes, before;
  try {
    before = await handle.stat({ bigint: true }); checkFile(before);
    const buffer = Buffer.alloc(SETTINGS_MAX_BYTES + 1); let length = 0;
    while (length < buffer.length) { const result = await handle.read(buffer, length, buffer.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
    if (length > SETTINGS_MAX_BYTES) fail('READING_SETTINGS_LIMIT', '读取期间默认模型设置超过8KiB限制');
    const after = await handle.stat({ bigint: true }); checkFile(after);
    await checkPlain(file); await checkBinding(store.storageBinding);
    const named = await fs.lstat(file, { bigint: true }); checkFile(named);
    if (stamp(before) !== stamp(after) || stamp(before) !== stamp(named)) fail('READING_SETTINGS_CHANGED', '默认模型设置在读取期间变化，请重新加载');
    bytes = buffer.subarray(0, length);
  } finally { await handle.close(); }
  guard?.();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('READING_SETTINGS_ENCODING', '默认模型设置不是有效UTF-8，不会自动重置'); }
  let state;
  try { state = savedSchema.parse(JSON.parse(text)); }
  catch { return { state: null, stamp: stamp(before), corrupt: true }; }
  return { state: view(state), stamp: stamp(before), corrupt: false };
}
export async function readReadingSettings(store, guard) {
  return store.lock('reading-settings', async () => {
    const result = await inspect(store, guard); if (result.corrupt) corrupt(); return view(result.state);
  });
}
export async function setDefaultModel(store, raw, guard, validateModel) {
  const args = updateSchema.parse(raw);
  return store.lock('reading-settings', async () => {
    const result = await inspect(store, guard);
    if (result.corrupt && (args.expectedRevision !== 0 || args.defaultModel !== null)) corrupt();
    const previous = result.corrupt ? initial() : result.state;
    if (args.expectedRevision !== previous.revision) fail('STALE_READING_SETTINGS', '默认阅读模型已由另一页面更新，请重新加载后保存');
    if (args.defaultModel !== null) { await validateModel?.(structuredClone(args.defaultModel)); guard?.(); }
    if (!result.corrupt && JSON.stringify(args.defaultModel) === JSON.stringify(previous.defaultModel)) return view(previous);
    if (previous.revision === Number.MAX_SAFE_INTEGER) fail('READING_SETTINGS_REVISION_LIMIT', '默认模型设置版本达到上限');
    const next = { version: 1, revision: previous.revision + 1, defaultModel: args.defaultModel };
    await store.writable(store.root); guard?.();
    // Best-effort checks at the existing atomicText boundary, not a cross-process transaction.
    const current = () => {
      guard?.(); const root = lstatSync(store.root, { bigint: true });
      if (!root.isDirectory() || String(root.dev) !== store.storageBinding.identity.dev || String(root.ino) !== store.storageBinding.identity.ino) fail('ROOT_CHANGED', '阅读产物根目录身份已变化');
      let named;
      try { named = lstatSync(path.join(store.root, SETTINGS_FILE), { bigint: true }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (named) checkFile(named);
      if ((named ? stamp(named) : null) !== result.stamp) fail('READING_SETTINGS_CHANGED', '默认模型设置在保存期间变化，请重新加载');
    };
    await atomicText(path.join(store.root, SETTINGS_FILE), `${JSON.stringify(next, null, 2)}\n`, SETTINGS_MAX_BYTES, current);
    return view(next);
  });
}
