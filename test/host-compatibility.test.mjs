import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluatePluginCompatibility, getDshRuntimeVersion, pluginCompatibilityWarning } from '@deepseek-ai/dsh-app-boot';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const target = '0.2.1-rc.2';

test('真实 DSH SDK 版本与当前兼容目标一致，不使用旧版匹配器', () => {
  assert.equal(getDshRuntimeVersion(), target);
  assert.equal(manifest.devDependencies['@deepseek-ai/dsh-app-boot'], target);
});

test('原生门禁复现 0.1.4 的精确版本冲突，新版无需任何豁免即可通过', () => {
  const oldManifest = { ...manifest, version: '0.1.4', engines: { ...manifest.engines, dsh: '0.2.0-rc.2' } };
  const issue = evaluatePluginCompatibility(oldManifest, {}, target);
  assert.equal(issue.name, 'dsh-code-reading');
  assert.equal(issue.version, '0.1.4');
  assert.equal(issue.runtimeVersion, target);
  assert.deepEqual(issue.requirements, { 'engines.dsh': '0.2.0-rc.2' });
  assert.equal(issue.exempted, false);
  assert.match(pluginCompatibilityWarning(issue), /crashes or data loss/);
  assert.equal(evaluatePluginCompatibility(manifest, {}, target), undefined);
});

test('原生门禁不将本次验证扩张到旧宿主或未来预发布版', () => {
  for (const runtimeVersion of ['0.2.0-rc.2', '0.2.1-alpha.3', '0.2.1-rc.1', '0.2.1', '0.3.0']) {
    const issue = evaluatePluginCompatibility(manifest, {}, runtimeVersion);
    assert.deepEqual(issue.requirements, { 'engines.dsh': target });
    assert.equal(issue.exempted, false);
  }
});

test('原生 peer 后备检查同样兼容当前 DSH，不隐藏旧 peer 约束', () => {
  const { engines, ...peerOnly } = manifest;
  assert.equal(engines.dsh, target);
  assert.equal(evaluatePluginCompatibility(peerOnly, {}, target), undefined);
  const oldPeer = { ...peerOnly, peerDependencies: { ...peerOnly.peerDependencies, '@deepseek-ai/dsh-tools': '0.2.0-rc.2' } };
  const issue = evaluatePluginCompatibility(oldPeer, {}, target);
  assert.deepEqual(issue.requirements, { '@deepseek-ai/dsh-tools': '0.2.0-rc.2' });
  assert.equal(issue.exempted, false);
});
