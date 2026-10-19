import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { readFileBounded } from './bounded-file.mjs';

const required = ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'CHANGELOG.md', 'docs/INSTALL.md', 'docs/USAGE.md', 'skills/code-tutor/SKILL.md', 'lib/index.js', 'lib/preset.js', 'lib/client.js', 'lib/build-info.json', 'lib/THIRD_PARTY_NOTICES.txt'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const json = (files, name) => { try { return JSON.parse(files.get(name).toString('utf8')); } catch { throw new Error(`无法解析 ${name}；请重新构建，不要安装不完整的包`); } };
const allowedFile = name => required.includes(name) || /^lib\/(?:index|preset|chunk-[A-Z0-9]+)\.js(?:\.map)?$/.test(name);

/** Same interface for the directory and the actual tarball: no code execution, no extraction. */
export function verifyPackageFiles(files, { expectedVersion, expectedDshVersion } = {}) {
  for (const name of required) ensure(files.has(name) && files.get(name).length > 0, `缺少 ${name}；请先 pnpm run build，再重新打包`);
  for (const name of files.keys()) ensure(allowedFile(name), `包中包含未批准的文件：${name}`);
  const manifest = json(files, 'package.json');
  ensure(manifest.name === 'dsh-code-reading', '包名必须为 dsh-code-reading');
  ensure(/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(manifest.version), '缺少有效的包版本');
  if (expectedVersion) ensure(manifest.version === expectedVersion, '包版本与当前源码版本不同；请重新构建和打包');
  ensure(manifest.type === 'module', 'Host 必须为 ESM 包');
  ensure(typeof manifest.engines?.dsh === 'string' && manifest.engines.dsh.length > 0, '缺少明确的 engines.dsh 兼容性声明（旧包不满足当前发布契约）');
  if (expectedDshVersion) ensure(manifest.engines.dsh === expectedDshVersion, `目标 DSH 应为 ${expectedDshVersion}，不会自动豁免版本`);
  ensure(manifest.dsh?.manifestVersion === 1, '缺少 dsh.manifestVersion: 1');
  ensure(manifest.dsh.bundle?.patch === './cordis.patch.yml', 'bundle patch 入口不正确');
  ensure(manifest.dsh.client?.platform === 'web' && manifest.dsh.client.immediately === true, 'Client 必须声明 web 与立即加载');
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) ensure(!manifest.scripts?.[name], `禁止安装期生命周期脚本：${name}`);
  ensure(Object.keys(manifest.dependencies ?? {}).length === 0, '发布包应为自包含构建，不应要求额外生产依赖');
  for (const name of ['@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-skill']) {
    ensure(manifest.peerDependencies?.[name] === manifest.engines.dsh && manifest.peerDependenciesMeta?.[name]?.optional === true, `DSH peer 目标或可选声明不一致：${name}`);
  }
  const exports = { '.': './lib/index.js', './preset': './lib/preset.js', './client': './lib/client.js', './cordis.patch.yml': './cordis.patch.yml', './package.json': './package.json' };
  ensure(manifest.main === exports['.'], 'main 与 Host export 不一致');
  for (const [key, target] of Object.entries(exports)) ensure(manifest.exports?.[key] === target && files.has(target.slice(2)), `缺少或错误的 export：${key}`);
  for (const [name, bytes] of files) if (/^lib\/.*\.js$/.test(name) && name !== 'lib/client.js') {
    const source = bytes.toString('utf8');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;
      ensure(specifier.startsWith('./') || specifier.startsWith('../'), `${name} 仍依赖未打包模块：${specifier}`);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
      ensure(!target.startsWith('../') && files.has(target), `${name} 引用了包内缺失文件：${target}`);
    }
  }
  const client = files.get('lib/client.js').toString('utf8');
  ensure(client.startsWith('window.__ModuleLoader__.load(') && /id:\s*["']dsh-code-reading["']\s*,\s*factory:\s*\(require\)\s*=>/.test(client), 'Client 不是正确的原生 lazy-CJS factory');
  ensure(/require\(["']react["']\)/.test(client) && /require\(["']react\/jsx-runtime["']\)/.test(client), 'Client 没有复用 DSH 的共享 React');
  const patch = files.get('cordis.patch.yml').toString('utf8').split('\n').filter(line => line.trim() && !line.trimStart().startsWith('#')).join('\n').trim();
  ensure(/^- insert:\s*\n\s+- id: code-reading\s*\n\s+name: dsh-code-reading$/.test(patch), 'patch 必须只新增裸包 Host 行，不替换普通 preset 或其他插件');
  const readme = files.get('README.md').toString('utf8'); const install = files.get('docs/INSTALL.md').toString('utf8');
  ensure(readme.includes('restart-required') && /完整退出/.test(readme) && install.includes(manifest.version), '包内安装说明过时或未说明 Host 完整重启');
  const info = json(files, 'lib/build-info.json');
  ensure(info.package === manifest.name && info.version === manifest.version && info.targetDshVersion === manifest.engines.dsh && info.apiVersion === 1, '构建元数据与 manifest 不一致；请重新构建');
  ensure(info.files && typeof info.files === 'object', '缺少构建文件哈希清单');
  for (const [name, bytes] of files) if (name !== 'package.json' && name !== 'lib/build-info.json') ensure(info.files[name] === digest(bytes), `构建文件缺失、过期或被修改：${name}；请重新构建`);
  for (const name of Object.keys(info.files)) ensure(files.has(name), `构建清单所列文件未进入发布包：${name}`);
  return { package: manifest.name, version: manifest.version, targetDshVersion: manifest.engines.dsh, apiVersion: info.apiVersion, fileCount: files.size, builtAt: info.builtAt, checks: ['exports and bundle patch', 'Host/preset relative import closure', 'bundled tutor skill and notices', 'native Client factory and shared React', 'no installation lifecycle scripts', 'packaged install/usage documentation', 'version consistency and per-file SHA256'] };
}

export async function verifyDirectory(directory, { checkSources = false, ...options } = {}) {
  const root = path.resolve(directory); const files = new Map();
  async function walk(relative) {
    const full = path.join(root, relative); const stat = await lstat(full);
    ensure(!stat.isSymbolicLink(), `发布输入不能是链接：${relative}`);
    if (stat.isDirectory()) for (const row of await readdir(full)) await walk(path.posix.join(relative, row));
    else { ensure(stat.isFile() && stat.size <= 32 * 1024 * 1024, `发布文件类型或大小无效：${relative}`); files.set(relative, await readFile(full)); ensure(files.size <= 2000, '发布文件数量异常'); }
  }
  for (const name of ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'CHANGELOG.md', 'docs/INSTALL.md', 'docs/USAGE.md', 'lib', 'skills']) {
    try { await walk(name); } catch (error) { if (error.code === 'ENOENT') throw new Error(`缺少 ${name}；请先 pnpm run build`); throw error; }
  }
  const report = verifyPackageFiles(files, options);
  if (checkSources) {
    const info = json(files, 'lib/build-info.json'); ensure(info.sourceHashes && Object.keys(info.sourceHashes).length > 0, '缺少源码新鲜度记录；请重新构建');
    for (const [relative, hash] of Object.entries(info.sourceHashes)) {
      ensure(!relative.includes('\\') && !relative.split('/').includes('..') && !path.isAbsolute(relative), '非法源码哈希路径');
      let bytes; try { bytes = await readFile(path.join(root, relative)); } catch { throw new Error(`构建输入已缺失：${relative}；请重新构建`); }
      ensure(digest(bytes) === hash, `源码或文档在构建后有变化：${relative}；请重新执行 pnpm run build`);
    }
    const recorded = new Set(Object.keys(info.sourceHashes).filter(name => name.startsWith('src/')));
    async function checkNew(relative) { for (const row of await readdir(path.join(root, relative), { withFileTypes: true })) { const child = path.posix.join(relative, row.name); if (row.isDirectory()) await checkNew(child); else ensure(recorded.has(child), `构建后新增源码：${child}；请重新构建`); } }
    await checkNew('src'); report.checks.push('source and documentation freshness');
  }
  return report;
}

function safeArchivePath(name, directory = false) {
  const trimmed = directory ? name.replace(/\/$/, '') : name;
  ensure(trimmed.startsWith('package/') || (directory && trimmed === 'package'), `归档条目必须位于 package/：${name}`);
  ensure(!trimmed.includes('\\') && !trimmed.includes('\0') && !trimmed.includes('\ufffd') && !trimmed.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':') || /[. ]$/.test(part)), `归档条目路径无效：${name}`);
  return trimmed.slice(8);
}
function octal(header, start, size) {
  const text = header.subarray(start, start + size).toString('ascii').replace(/\0.*$/, '').trim();
  ensure(/^[0-7]*$/.test(text), '不支持或损坏的 tar 数值字段'); const value = parseInt(text || '0', 8); ensure(Number.isSafeInteger(value), 'tar 数值超限'); return value;
}
function paxRecords(bytes) {
  const records = Object.create(null); let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset); ensure(space > offset, '损坏的 PAX 记录');
    const lengthText = bytes.subarray(offset, space).toString('ascii'); ensure(/^\d+$/.test(lengthText), '损坏的 PAX 长度'); const length = Number(lengthText);
    ensure(length > space - offset + 2 && offset + length <= bytes.length && bytes[offset + length - 1] === 10, 'PAX 记录越界');
    const record = bytes.subarray(space + 1, offset + length - 1).toString('utf8'); const equals = record.indexOf('='); ensure(equals > 0, '损坏的 PAX 字段');
    const key = record.slice(0, equals); ensure(!key.startsWith('GNU.sparse'), '不支持稀疏 tar 文件'); records[key] = record.slice(equals + 1); offset += length;
  }
  return records;
}

/** Bounded USTAR/PAX reader; deliberately rejects links and never writes archive paths to disk. */
export function readArchiveBytes(compressed) {
  ensure(compressed.length <= 32 * 1024 * 1024, '压缩包超过 32 MiB 校验上限');
  const tar = gunzipSync(compressed, { maxOutputLength: 96 * 1024 * 1024 }); const files = new Map(); const kinds = new Map(); const parents = new Set(); let offset = 0; let nextPax = null; let ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) { ensure(offset + 1024 <= tar.length && tar.subarray(offset).every(byte => byte === 0), 'tar 结束标记不完整或尾部含非零数据'); ended = true; break; }
    let checksum = 0; for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    ensure(checksum === octal(header, 148, 8), 'tar header 校验和错误');
    const text = (start, size) => header.subarray(start, start + size).toString('utf8').replace(/\0.*$/, '');
    const prefix = text(345, 155); let name = `${prefix ? `${prefix}/` : ''}${text(0, 100)}`;
    const size = octal(header, 124, 12); const type = String.fromCharCode(header[156] || 48); const dataStart = offset + 512;
    ensure(size <= 32 * 1024 * 1024 && dataStart + size <= tar.length, 'tar 条目内容被截断或过大');
    const bytes = tar.subarray(dataStart, dataStart + size); offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') { const pax = paxRecords(bytes); if (type === 'x') nextPax = pax; else ensure(!pax.path && !pax.linkpath && !pax.size, '不支持改变路径或大小的全局 PAX'); continue; }
    if (nextPax) { name = nextPax.path ?? name; if (nextPax.size !== undefined) ensure(/^\d+$/.test(nextPax.size) && Number(nextPax.size) === size, 'PAX 与 tar 大小不一致'); nextPax = null; }
    ensure(name.length <= 4096, '归档路径超过 4096 字符上限');
    ensure(type === '0' || type === '5', `不允许 tar 链接或特殊条目（type ${type}）：${name}`);
    const relative = safeArchivePath(name, type === '5'); const identity = relative.toLowerCase();
    if (type === '5') ensure(size === 0, 'tar 目录含有非空内容');
    if (type === '0') ensure(relative && kinds.get(identity) !== '0', `归档重复条目：${name}`);
    ensure(!(type === '5' && kinds.get(identity) === '0') && !(type === '0' && (kinds.get(identity) === '5' || parents.has(identity))), `归档路径类型冲突：${name}`);
    for (let parent = path.posix.dirname(identity); parent !== '.'; parent = path.posix.dirname(parent)) {
      ensure(kinds.get(parent) !== '0', `归档文件不能充当父目录：${parent}`); parents.add(parent);
    }
    kinds.set(identity, type); ensure(kinds.size <= 4000, 'tar 条目数量超限');
    if (type === '5') continue;
    files.set(relative, Buffer.from(bytes)); ensure(files.size <= 2000, 'tar 文件数量超限');
  }
  ensure(ended && !nextPax && files.size > 0, 'tar 未正常结束或为空'); return files;
}
export async function verifyArchive(filename, options) {
  const bytes = await readFileBounded(filename, 32 * 1024 * 1024); const report = verifyPackageFiles(readArchiveBytes(bytes), options);
  return { ...report, bytes: bytes.length, sha256: digest(bytes), execution: 'static-only; no extraction, plugin activation or live DSH install' };
}
