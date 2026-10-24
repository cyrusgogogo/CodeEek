import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluatePluginCompatibility, getDshRuntimeVersion, pluginCompatibilityWarning } from '@deepseek-ai/dsh-app-boot';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const target = '0.2.1-rc.3';

test('真实 DSH SDK 版本与当前兼容目标一致，不使用旧版匹配器', () => {
  assert.equal(getDshRuntimeVersion(), target);
  assert.equal(manifest.devDependencies['@deepseek-ai/dsh-app-boot'], target);
});

for (const [version, dsh] of [['0.1.4', '0.2.0-rc.2'], ['0.1.6', '0.2.1-rc.1'], ['0.1.7', '0.2.1-rc.2']]) {
  test(`原生门禁复现 ${version}（DSH ${dsh}）的精确版本冲突，当前源码无需豁免`, () => {
    const oldManifest = { ...manifest, version, engines: { ...manifest.engines, dsh } };
    const issue = evaluatePluginCompatibility(oldManifest, {}, target);
    assert.equal(issue.name, 'dsh-code-reading');
    assert.equal(issue.version, version);
    assert.equal(issue.runtimeVersion, target);
    assert.deepEqual(issue.requirements, { 'engines.dsh': dsh });
    assert.equal(issue.exempted, false);
    assert.match(pluginCompatibilityWarning(issue), /crashes or data loss/);
    assert.equal(evaluatePluginCompatibility(manifest, {}, target), undefined);
  });
}

test('原生门禁不将本次验证扩张到旧宿主或未来预发布版', () => {
  for (const runtimeVersion of ['0.2.0-rc.2', '0.2.1-alpha.3', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.4', '0.2.1', '0.3.0']) {
    const issue = evaluatePluginCompatibility(manifest, {}, runtimeVersion);
    assert.deepEqual(issue.requirements, { 'engines.dsh': target });
    assert.equal(issue.exempted, false);
  }
});

test('原生 peer 后备检查同样兼容当前 DSH，不隐藏旧 peer 约束', () => {
  const { engines, ...peerOnly } = manifest;
  assert.equal(engines.dsh, target);
  assert.equal(evaluatePluginCompatibility(peerOnly, {}, target), undefined);
  for (const name of Object.keys(peerOnly.peerDependencies)) {
    const oldPeer = { ...peerOnly, peerDependencies: { ...peerOnly.peerDependencies, [name]: '0.2.1-rc.2' } };
    const issue = evaluatePluginCompatibility(oldPeer, {}, target);
    assert.deepEqual(issue.requirements, { [name]: '0.2.1-rc.2' });
    assert.equal(issue.exempted, false);
  }
});
