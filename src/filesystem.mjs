import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fail } from './contracts.mjs';

export const LIMITS = Object.freeze({ fileBytes: 1024 * 1024, excerptChars: 100000, scanFiles: 8000, searchFiles: 2000, searchBytes: 16 * 1024 * 1024, auditBytes: 8 * 1024 * 1024, stateBytes: 8 * 1024 * 1024 });
const SKIP = new Set(['.git', '.svn', '.hg', 'node_modules', '.venv', 'venv', 'dist', 'build', 'coverage', '.next', '.cache']);
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const normalized = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
export function contains(parent, child) { const rel = path.relative(normalized(parent), normalized(child)); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)); }
export function assertDisjoint(a, b) { if (contains(a, b) || contains(b, a)) fail('STORAGE_OVERLAP', '阅读产物目录与仓库必须互不嵌套；不能将用户目录或产物目录绑定为仓库'); }
export function safeRelative(input) {
  if (typeof input !== 'string' || !input || input.length > 1024 || /[\\:\x00-\x1f]/.test(input) || input.startsWith('/') || input.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('PATH_DENIED', '仅允许仓库相对路径，使用 / 分隔；禁止穿越、设备路径和 ADS');
  if (input.split('/').some(p => SKIP.has(p) || /^\.env(?:\.|$)/i.test(p) || /^(id_rsa|id_ed25519|credentials)(?:\.|$)/i.test(p))) fail('SENSITIVE_PATH', '默认不读取依赖、构建目录或敏感配置文件');
  return input;
}
function identity(stat) { return { dev: String(stat.dev), ino: String(stat.ino) }; }
function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino; }
export async function checkPlain(absolute, allowMissing = false) {
  if (!path.isAbsolute(absolute) || (process.platform === 'win32' && /^\\\\/.test(absolute))) fail('ROOT_DENIED', '需要普通本地绝对目录，不支持 UNC / 设备路径');
  const resolved = path.resolve(absolute);
  let current = path.parse(resolved).root;
  for (const component of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) { if (allowMissing && error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) fail('LINK_DENIED', '不读取或写入符号链接 / junction，请选择真实目录');
  }
  if (normalized(await fs.realpath(resolved)) !== normalized(resolved)) fail('ALIAS_DENIED', '解析后的物理路径发生变化');
}
export async function bindDirectory(input) {
  await checkPlain(input);
  const root = await fs.realpath(input);
  const stat = await fs.stat(root, { bigint: true });
  if (!stat.isDirectory()) fail('NOT_DIRECTORY', '绑定对象必须为目录');
  return { root, identity: identity(stat) };
}
export async function checkBinding(binding) {
  await checkPlain(binding.root);
  const stat = await fs.stat(binding.root, { bigint: true });
  if (!stat.isDirectory() || !sameIdentity(identity(stat), binding.identity)) fail('ROOT_CHANGED', '仓库根目录已被替换，请新建阅读项目重新绑定');
}
export async function readRepository(binding, input, options = {}) {
  const rel = safeRelative(input);
  const maxBytes = Math.min(LIMITS.fileBytes, options.maxBytes ?? LIMITS.fileBytes);
  await checkBinding(binding);
  const target = path.resolve(binding.root, ...rel.split('/'));
  if (!contains(binding.root, target)) fail('PATH_DENIED', '路径超出绑定仓库');
  await checkPlain(target);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) fail('NOT_FILE', '只能读取普通文件');
    if (before.nlink !== 1n) fail('FILE_ALIAS', '不读取硬链接文件，请选择独立的源码副本');
    if (before.size > BigInt(LIMITS.fileBytes)) fail('FILE_LIMIT', '单文件限制为 1 MiB，请选择较小的源码文件');
    if (before.size > BigInt(maxBytes)) fail('SEARCH_BUDGET', '文件超出本次搜索剩余字节预算');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) { const result = await handle.read(buffer, length, buffer.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
    if (length > maxBytes) fail(maxBytes < LIMITS.fileBytes ? 'SEARCH_BUDGET' : 'FILE_LIMIT', '读取过程中超过字节预算');
    const after = await handle.stat({ bigint: true });
    await checkPlain(target);
    await checkBinding(binding);
    const named = await fs.stat(target, { bigint: true });
    if (!sameIdentity(identity(before), identity(named)) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('SOURCE_CHANGED', '文件在读取期间发生变化，请重试');
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0)) fail('BINARY_FILE', '不支持二进制源码');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('ENCODING', '源码必须为 UTF-8；不会修改原文件编码'); }
    return { hash: digest(bytes), bytes: length, lines: text.split(/\r\n|\n|\r/), text };
  } finally { await handle.close(); }
}
export async function listRepository(binding, signal) {
  await checkBinding(binding);
  const stack = ['']; const files = []; let visited = 0;
  while (stack.length && files.length < LIMITS.scanFiles && visited < LIMITS.scanFiles) {
    signal?.throwIfAborted();
    const rel = stack.pop(); const directory = path.join(binding.root, ...rel.split('/').filter(Boolean));
    await checkPlain(directory);
    const entries = await fs.opendir(directory);
    for await (const entry of entries) {
      signal?.throwIfAborted();
      if (visited >= LIMITS.scanFiles) break;
      visited++;
      if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      try { safeRelative(next); } catch { continue; }
      if (entry.isDirectory()) stack.push(next); else if (entry.isFile()) files.push(next);
      if (files.length >= LIMITS.scanFiles || visited >= LIMITS.scanFiles) break;
    }
  }
  await checkBinding(binding);
  return { files: files.sort(), truncated: stack.length > 0 || visited >= LIMITS.scanFiles, visited };
}
export async function ensurePlainDirectory(directory) { await checkPlain(directory, true); await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await checkPlain(directory); }
export async function atomicText(target, content, maxBytes = LIMITS.stateBytes) {
  if (Buffer.byteLength(content) > maxBytes) fail('STORAGE_LIMIT', '产物超出大小限制，请新建阅读会话');
  await checkPlain(path.dirname(target));
  try { if ((await fs.lstat(target)).isSymbolicLink()) fail('LINK_DENIED', '产物目标不能为符号链接'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${target}.${globalThis.crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await checkPlain(path.dirname(target));
  await fs.rename(temp, target);
}
export async function appendAudit(target, record) {
  await checkPlain(path.dirname(target));
  const handle = await fs.open(target, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) fail('OUTPUT_ALIAS', '审计目标必须为单链接普通文件');
    const line = `${JSON.stringify(record)}\n`;
    if (stat.size + Buffer.byteLength(line) > LIMITS.auditBytes) fail('AUDIT_LIMIT', '读取审计已达到 8 MiB，需新建阅读会话');
    if (stat.size > 0) { const tail = Buffer.alloc(1); await handle.read(tail, 0, 1, stat.size - 1); if (tail[0] !== 10) fail('AUDIT_CORRUPT', '审计末行不完整；请保留原档案并新建阅读会话'); }
    await handle.writeFile(line, 'utf8'); await handle.sync();
  } finally { await handle.close(); }
}
