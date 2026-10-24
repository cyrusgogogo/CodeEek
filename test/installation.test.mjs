import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Config } from '../src/index.mjs';
import { resolveDataDirectory } from '../src/config.mjs';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
test('安装包精确声明 DSH 0.2.1-rc.3 目标且所有宿主 peer 保持一致', () => {
  assert.equal(manifest.engines?.dsh, '0.2.1-rc.3');
  assert.equal(manifest.dsh.manifestVersion, 1);
  for (const version of Object.values(manifest.peerDependencies)) assert.equal(version, manifest.engines.dsh);
});
test('安装不要求执行生命周期脚本或单独安装 React', () => {
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(manifest.scripts[name], undefined);
  assert.equal(manifest.dependencies?.react, undefined);
});
test('自定义档案目录拒绝空值和相对路径，避免安装 CWD 决定数据位置', () => {
  for (const dataDir of ['', '  ', './reading', 'relative/directory']) assert.throws(() => Config.parse({ dataDir }));
  assert.equal(Config.parse({ dataDir: path.resolve('.test-output/archive') }).dataDir, path.resolve('.test-output/archive'));
});
test('Windows 数据根拒绝当前驱动器相对的根路径和 UNC', { skip: process.platform !== 'win32' }, () => {
  for (const dataDir of ['\\reading', '/reading', '\\\\server\\share\\reading']) assert.throws(() => Config.parse({ dataDir }));
});

test('数据根优先级可诊断且不受安装 CWD 影响', () => {
  const a = path.resolve('.test-output/archive-a'); const b = path.resolve('.test-output/archive-b'); const home = path.resolve('.test-output/user');
  assert.deepEqual(resolveDataDirectory({ dataDir: a }, { DSH_CODE_READING_HOME: b, DSH_HOME: 'invalid-low-priority' }, home), { directory: a, source: 'config.dataDir' });
  assert.deepEqual(resolveDataDirectory({}, { DSH_CODE_READING_HOME: b }, home), { directory: b, source: 'DSH_CODE_READING_HOME' });
  assert.deepEqual(resolveDataDirectory({}, { DSH_HOME: home }, home), { directory: path.join(home, 'code-reading'), source: 'DSH_HOME' });
  assert.deepEqual(resolveDataDirectory({}, {}, home), { directory: path.join(home, '.dsh', 'code-reading'), source: 'default' });
});
test('无效环境目录明确拒绝而不是隐式回退', () => {
  for (const name of ['DSH_HOME', 'DSH_CODE_READING_HOME']) for (const value of ['', '  ', 'relative']) assert.throws(() => resolveDataDirectory({}, { [name]: value }), { code: 'INVALID_DATA_DIR' });
});
