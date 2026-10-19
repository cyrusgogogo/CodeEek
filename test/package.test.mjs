import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { readFile as namedReadFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyPackageFiles, verifyDirectory, readArchiveBytes, verifyArchive } from '../scripts/package-check.mjs';
import { readFileBounded } from '../scripts/bounded-file.mjs';
import { checkReleaseDirectory } from '../scripts/release-path.mjs';

const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const base = path.resolve('.test-output');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixtureFiles() {
  const files = new Map(Object.entries({
    'package.json': JSON.stringify(manifest), 'cordis.patch.yml': '- insert:\n    - id: code-reading\n      name: dsh-code-reading\n',
    'README.md': 'restart-required 时完整退出 DSH', 'LICENSE': 'MIT', 'CHANGELOG.md': '0.1.2', 'docs/INSTALL.md': manifest.version, 'docs/USAGE.md': 'usage',
    'skills/code-tutor/SKILL.md': '# fixture tutor',
    'lib/index.js': 'import { shared } from "./chunk-TEST0000.js"; export function apply() { return shared; }',
    'lib/preset.js': 'import { shared } from "./chunk-TEST0000.js"; export function apply() { return shared; }',
    'lib/chunk-TEST0000.js': 'export const shared = true;',
    'lib/client.js': 'window.__ModuleLoader__.load({id:"dsh-code-reading",factory:(require)=>{require("react");require("react/jsx-runtime");return {};}});',
    'lib/THIRD_PARTY_NOTICES.txt': 'fixture third-party notices'
  }).map(([name, text]) => [name, Buffer.from(text)]));
  files.set('lib/build-info.json', Buffer.from(JSON.stringify({ package: manifest.name, version: manifest.version, targetDshVersion: manifest.engines.dsh, apiVersion: 1, builtAt: 'fixture', sourceHashes: { 'src/index.mjs': hash('source') }, files: Object.fromEntries([...files].filter(([name]) => name !== 'package.json').map(([name, bytes]) => [name, hash(bytes)])) })));
  return files;
}
async function temp(t) {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'package-contract-'));
  t.after(async () => { const absolute = path.resolve(root); assert.equal(path.dirname(absolute), base); assert.match(path.basename(absolute), /^package-contract-/); await fs.rm(absolute, { recursive: true, force: true }); });
  return root;
}
async function writeTree(root, files) {
  for (const [name, bytes] of files) { const target = path.resolve(root, name); assert.ok(path.relative(root, target) && !path.relative(root, target).startsWith('..')); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); }
}
function tarRows(rows) {
  const blocks = [];
  for (const { name, bytes = Buffer.alloc(0), type = '0' } of rows) {
    const header = Buffer.alloc(512); header.write(name, 0, 100, 'utf8');
    const octal = (value, start, size) => header.write(`${value.toString(8).padStart(size - 1, '0')}\0`, start, size, 'ascii');
    octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(bytes.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); header.write(type, 156, 1); header.write('ustar\0', 257, 6); header.write('00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0); header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
const archive = files => gzipSync(tarRows([...files].map(([name, bytes]) => ({ name: `package/${name}`, bytes }))));

test('发布契约对同一文件集合同时检查完整入口、版本和逐文件哈希', () => {
  const report = verifyPackageFiles(fixtureFiles()); assert.equal(report.version, manifest.version); assert.equal(report.apiVersion, 1); assert.ok(report.checks.length >= 7);
});
test('发布契约接受当前 DSH 0.2.1-rc.2，拒绝旧版和未验证的目标版本', () => {
  const report = verifyPackageFiles(fixtureFiles(), { expectedDshVersion: '0.2.1-rc.2' });
  assert.equal(report.targetDshVersion, '0.2.1-rc.2');
  for (const expectedDshVersion of ['0.2.0-rc.2', '0.2.1-rc.1', '0.2.1']) {
    assert.throws(() => verifyPackageFiles(fixtureFiles(), { expectedDshVersion }), /目标 DSH 应为/);
  }
});
test('共享 chunk 或 skill 遗漏必须拒绝，不因源码测试通过而放行', () => {
  const missingChunk = fixtureFiles(); missingChunk.delete('lib/chunk-TEST0000.js'); assert.throws(() => verifyPackageFiles(missingChunk), /缺失文件/);
  const missingSkill = fixtureFiles(); missingSkill.delete('skills/code-tutor/SKILL.md'); assert.throws(() => verifyPackageFiles(missingSkill), /缺少 skills/);
});
test('错误 export、Client 工厂 ID 与安装期脚本均拒绝', () => {
  const wrongExport = fixtureFiles(); const changed = { ...manifest, exports: { ...manifest.exports, './preset': './missing.js' } }; wrongExport.set('package.json', Buffer.from(JSON.stringify(changed))); assert.throws(() => verifyPackageFiles(wrongExport), /export/);
  const wrongFactory = fixtureFiles(); wrongFactory.set('lib/client.js', Buffer.from(wrongFactory.get('lib/client.js').toString().replace('id:"dsh-code-reading"', 'id:"wrong"'))); assert.throws(() => verifyPackageFiles(wrongFactory), /factory/);
  const script = fixtureFiles(); script.set('package.json', Buffer.from(JSON.stringify({ ...manifest, scripts: { ...manifest.scripts, postinstall: 'unexpected' } }))); assert.throws(() => verifyPackageFiles(script), /安装期/);
});
test('过期构建、额外敏感文件和旧安装文档均拒绝', () => {
  const modified = fixtureFiles(); modified.set('lib/index.js', Buffer.concat([modified.get('lib/index.js'), Buffer.from('\n// changed')])); assert.throws(() => verifyPackageFiles(modified), /过期或被修改/);
  const extra = fixtureFiles(); extra.set('.env', Buffer.from('DO_NOT_SHIP')); assert.throws(() => verifyPackageFiles(extra), /未批准的文件/);
  const docs = fixtureFiles(); docs.set('README.md', Buffer.from('安装后刷新即可')); assert.throws(() => verifyPackageFiles(docs), /安装说明过时/);
});
test('真实 gzip/tar 字节按同一契约验收，输出整包 SHA256', async t => {
  const root = await temp(t); const file = path.join(root, 'fixture.tgz'); const bytes = archive(fixtureFiles()); await fs.writeFile(file, bytes);
  const report = await verifyArchive(file, { expectedVersion: manifest.version }); assert.equal(report.sha256, hash(bytes)); assert.equal(report.bytes, bytes.length); assert.match(report.execution, /static-only/);
});
test('tar 不允许穿越、重复、硬链接或符号链接', () => {
  for (const rows of [
    [{ name: 'package/../../escape', bytes: Buffer.from('x') }],
    [{ name: 'package/a', type: '1' }], [{ name: 'package/a', type: '2' }],
    [{ name: 'package/a' }, { name: 'package/a' }]
  ]) assert.throws(() => readArchiveBytes(gzipSync(tarRows(rows))), /无效|不允许|重复/);
});
test('tar checksum、内容截断和尾随非零数据不能被忽略', () => {
  const original = tarRows([{ name: 'package/a', bytes: Buffer.alloc(1000) }]);
  const wrongHeader = Buffer.from(original); wrongHeader[0] ^= 1; assert.throws(() => readArchiveBytes(gzipSync(wrongHeader)), /校验和/);
  assert.throws(() => readArchiveBytes(gzipSync(original.subarray(0, 600))), /截断/);
  assert.throws(() => readArchiveBytes(gzipSync(Buffer.concat([original, Buffer.from('unexpected')]))), /尾部/);
});
test('PAX UTF-8 长路径按字节长度读取且仍检查穿越', () => {
  const pax = value => { const record = `path=${value}\n`; let length = Buffer.byteLength(record) + 2; while (Buffer.byteLength(`${length} ${record}`) !== length) length = Buffer.byteLength(`${length} ${record}`); return Buffer.from(`${length} ${record}`); };
  const name = `package/docs/${'阅读'.repeat(30)}.md`;
  const bytes = gzipSync(tarRows([{ name: 'PaxHeader', type: 'x', bytes: pax(name) }, { name: 'package/placeholder', bytes: Buffer.from('ok') }]));
  assert.equal(readArchiveBytes(bytes).get(name.slice(8)).toString(), 'ok');
  const unsafe = gzipSync(tarRows([{ name: 'PaxHeader', type: 'x', bytes: pax('package/../escape') }, { name: 'package/placeholder' }])); assert.throws(() => readArchiveBytes(unsafe), /路径无效/);
});
test('tar 文件与目录同名或文件充当父目录必须拒绝', () => {
  const rows = [...fixtureFiles()].map(([name, bytes]) => ({ name: `package/${name}`, bytes }));
  for (const name of ['package/PACKAGE.JSON/', 'package/package.json./', 'package/package.json /']) assert.throws(() => readArchiveBytes(gzipSync(tarRows([...rows, { name, type: '5' }]))), /类型冲突|路径无效/);
  const directory = { name: 'package/package.json/', type: '5' };
  for (const entries of [[directory, ...rows], [...rows, directory], [...rows, { name: 'package/lib/index.js/child', bytes: Buffer.from('x') }], [{ name: 'package/lib/index.js/child', bytes: Buffer.from('x') }, ...rows]]) assert.throws(() => readArchiveBytes(gzipSync(tarRows(entries))), /类型冲突|父目录/);
});
test('大压缩输入在无限量 readFile 之前拒绝，不先分配整个文件', async t => {
  const root = await temp(t); const target = path.join(root, 'oversized.tgz'); const file = await fs.open(target, 'w'); await file.truncate(33 * 1024 * 1024); await file.close();
  const original = fs.readFile; let unbounded = 0;
  fs.readFile = async (name, ...args) => { if (path.resolve(String(name)) === target) { unbounded++; throw Object.assign(new Error('unbounded input read'), { code: 'UNBOUNDED_READ' }); } return original(name, ...args); }; syncBuiltinESMExports();
  try {
    await assert.rejects(namedReadFile(target), { code: 'UNBOUNDED_READ' }); assert.equal(unbounded, 1); unbounded = 0;
    await assert.rejects(verifyArchive(target), /读取上限|32 MiB/); assert.equal(unbounded, 0);
  } finally { fs.readFile = original; syncBuiltinESMExports(); }
});
test('仓库内路径的祖先 junction 不能把发布带到仓库外', async t => {
  const root = await temp(t); const outside = await fs.mkdtemp(path.join(tmpdir(), 'code-reading-release-path-'));
  t.after(async () => { const absolute = path.resolve(outside); assert.equal(path.dirname(absolute), path.resolve(tmpdir())); assert.match(path.basename(absolute), /^code-reading-release-path-/); await fs.rm(absolute, { recursive: true, force: true }); });
  const nested = path.join(outside, 'normal'); await fs.mkdir(nested); await fs.writeFile(path.join(nested, 'sentinel'), 'keep'); const link = path.join(root, 'linked'); await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const result = spawnSync(process.execPath, ['scripts/release.mjs', '--out-dir', path.relative(process.cwd(), path.join(link, 'normal'))], { cwd: process.cwd(), stdio: 'inherit', env: { ...process.env, npm_execpath: '' } });
  assert.equal(result.error, undefined); assert.equal(result.status, 3); assert.deepEqual(await fs.readdir(nested), ['sentinel']); assert.equal(await fs.readFile(path.join(nested, 'sentinel'), 'utf8'), 'keep');
});

test('文件在 stat 后增长时仍最多读取上限加一字节，并关闭句柄', async () => {
  const limit = 100000; let total = 0; let closed = false;
  const fakeOpen = async () => ({ stat: async () => ({ isFile: () => true, size: 0 }), read: async (buffer, offset, length) => { assert.ok(length > 0); total += length; return { bytesRead: length }; }, close: async () => { closed = true; } });
  await assert.rejects(readFileBounded('growing fixture', limit, fakeOpen), { code: 'FILE_LIMIT' }); assert.equal(total, limit + 1); assert.equal(closed, true);
});
test('输出目录预检只读，显式创建后仍在真实仓库内，拒绝运行目录', async t => {
  const root = await temp(t); const output = path.join(root, 'releases', 'nested'); await checkReleaseDirectory(root, output); await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
  await checkReleaseDirectory(root, output, { create: true }); assert.equal(await fs.realpath(output), output);
  await assert.rejects(checkReleaseDirectory(root, path.join(root, 'lib', 'release')), { code: 'RELEASE_PATH' });
  await assert.rejects(checkReleaseDirectory(root, path.resolve(root, '..', 'escape')), { code: 'RELEASE_PATH' });
});

test('缺少 lib 的干净源码被明确拒绝，不会自动构建或写文件', async t => {
  const root = await temp(t); const files = fixtureFiles(); for (const name of [...files.keys()]) if (name.startsWith('lib/')) files.delete(name); await writeTree(root, files);
  await assert.rejects(verifyDirectory(root), /缺少 lib.*build/); assert.equal((await fs.readdir(root)).includes('lib'), false);
});
test('构建后源码变更与新增源码都要求重新构建', async t => {
  const root = await temp(t); const files = fixtureFiles(); await writeTree(root, files); await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src/index.mjs'), 'source');
  await verifyDirectory(root, { checkSources: true });
  await fs.writeFile(path.join(root, 'src/index.mjs'), 'changed'); await assert.rejects(verifyDirectory(root, { checkSources: true }), /构建后有变化/);
  await fs.writeFile(path.join(root, 'src/index.mjs'), 'source'); await fs.writeFile(path.join(root, 'src/new.mjs'), 'new'); await assert.rejects(verifyDirectory(root, { checkSources: true }), /新增源码/);
});
test('同版本发布在构建和包管理器检查前拒绝，旧归档字节保持不变', async t => {
  const root = await temp(t); const target = path.join(root, `${manifest.name}-${manifest.version}.tgz`); const sentinel = Buffer.from('immutable existing artifact'); await fs.writeFile(target, sentinel);
  const result = spawnSync(process.execPath, ['scripts/release.mjs', '--out-dir', path.relative(process.cwd(), root)], { cwd: process.cwd(), stdio: 'inherit', env: { ...process.env, npm_execpath: '' } });
  assert.equal(result.error, undefined); assert.equal(result.status, 2); assert.deepEqual(await fs.readFile(target), sentinel);
});
