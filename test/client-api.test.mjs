import test from 'node:test';
import assert from 'node:assert/strict';
import { api, validateHostStatus, validateReadingSettings } from '../src/client/api.mjs';
import { PLUGIN_NAME, PLUGIN_VERSION, TARGET_DSH_VERSION, API_VERSION } from '../src/version.mjs';

function transport(t, fetch) {
  const previous = globalThis.__DSH_TRANSPORT__;
  globalThis.__DSH_TRANSPORT__ = { fetch };
  t.after(() => { if (previous === undefined) delete globalThis.__DSH_TRANSPORT__; else globalThis.__DSH_TRANSPORT__ = previous; });
}

test('客户端请求保留原生载体、同源认证、参数和取消信号', async t => {
  const controller = new AbortController();
  transport(t, async (url, init) => {
    assert.equal(url, 'api/code-reading'); assert.equal(init.credentials, 'same-origin'); assert.equal(init.signal, controller.signal);
    assert.deepEqual(JSON.parse(init.body), { method: 'list', params: {} });
    return Response.json({ ok: true, value: { projects: [] } });
  });
  assert.deepEqual(await api('list', {}, controller.signal), { projects: [] });
});
test('Host 路由缺失的 HTML 404 给出可恢复安装提示，不泄露响应正文', async t => {
  transport(t, async () => new Response('<html>PRIVATE_SENTINEL</html>', { status: 404, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(api('list'), error => error.code === 'HOST_UNAVAILABLE' && /重启/.test(error.message) && !error.message.includes('PRIVATE_SENTINEL'));
});
test('认证失效与 Host 未启动明确区分', async t => {
  transport(t, async () => Response.json({ error: 'not authorized' }, { status: 401 }));
  await assert.rejects(api('list'), error => error.code === 'AUTH_REQUIRED' && /登录|认证/.test(error.message));
});
test('成功状态下的 HTML 页面也不能被当作插件响应', async t => {
  transport(t, async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(api('list'), error => error.code === 'PROTOCOL_ERROR' && /刷新|重启/.test(error.message));
});
test('网络失败给出结果未确认提示，不自动重试有副作用的操作', async t => {
  let calls = 0; transport(t, async () => { calls++; throw new TypeError('fetch failed'); });
  await assert.rejects(api('create-project', {}), error => error.code === 'NETWORK_ERROR' && /确认|刷新/.test(error.message));
  assert.equal(calls, 1);
});
test('业务错误保留稳定 code 与 HTTP 状态用于恢复判断', async t => {
  transport(t, async () => Response.json({ ok: false, error: { code: 'STALE_REVISION', message: '请刷新' } }, { status: 400 }));
  await assert.rejects(api('stage'), error => error.code === 'STALE_REVISION' && error.status === 400 && /请刷新/.test(error.message));
});
test('取消沿用原始 AbortError，不误报安装失败', async t => {
  const aborted = new DOMException('cancelled', 'AbortError'); transport(t, async () => { throw aborted; });
  await assert.rejects(api('snapshot'), error => error === aborted);
});
test('畸形的成功响应必须拒绝，不能静默当作空数据', async t => {
  transport(t, async () => Response.json({ ok: true }));
  await assert.rejects(api('status'), error => error.code === 'PROTOCOL_ERROR');
});
test('损坏的 JSON 不回显原始响应正文', async t => {
  transport(t, async () => new Response('{PRIVATE_SENTINEL', { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(api('list'), error => error.code === 'PROTOCOL_ERROR' && !error.message.includes('PRIVATE_SENTINEL'));
});
test('非 JSON 服务器故障与标准停用错误均能识别', async t => {
  transport(t, async () => new Response('unavailable', { status: 502 }));
  await assert.rejects(api('list'), { code: 'HOST_ERROR', status: 502 });
  globalThis.__DSH_TRANSPORT__.fetch = async () => Response.json({ ok: false, error: { code: 'READING_UNAVAILABLE', message: 'Host 已停用' } }, { status: 503 });
  await assert.rejects(api('list'), { code: 'READING_UNAVAILABLE', status: 503 });
});
test('默认模型响应只接受明确的空值或有界无歧义模型引用', () => {
  assert.deepEqual(validateReadingSettings({ revision: 0, defaultModel: null }), { revision: 0, defaultModel: null });
  const value = { revision: 2, defaultModel: { provider: 'local', model: 'reader' } };
  assert.deepEqual(validateReadingSettings(value), value); assert.notEqual(validateReadingSettings(value).defaultModel, value.defaultModel);
  for (const wrong of [null, {}, { revision: 0 }, { revision: -1, defaultModel: null }, { revision: 1.5, defaultModel: null }, { revision: Number.MAX_SAFE_INTEGER + 1, defaultModel: null }, ...[[], {}, { provider: 'a\u0000b', model: 'reader' }, { provider: ' local', model: 'reader' }, { provider: 'local', model: '' }, { provider: 'p'.repeat(101), model: 'reader' }, { provider: 'local', model: 'm'.repeat(201) }].map(defaultModel => ({ revision: 1, defaultModel }))]) assert.throws(() => validateReadingSettings(wrong), { code: 'PROTOCOL_ERROR' });
});

test('旧 Host 不支持状态方法时明确提示完整重启', async t => {
  transport(t, async () => Response.json({ ok: false, error: { code: 'UNKNOWN_METHOD', message: '不支持' } }, { status: 400 }));
  await assert.rejects(api('status'), error => error.code === 'VERSION_MISMATCH' && /完整退出/.test(error.message));
});
test('就绪判断要求包版本、接口、目标和启用状态全部一致', () => {
  const healthy = { package: PLUGIN_NAME, version: PLUGIN_VERSION, apiVersion: API_VERSION, targetDshVersion: TARGET_DSH_VERSION, enabled: true, dataDirectory: 'fixture-root', capabilities: ['remove-project', 'default-model', 'structure-map-v1'] };
  assert.equal(validateHostStatus(healthy), healthy);
  for (const wrong of [null, { ...healthy, version: '0.1.1' }, { ...healthy, apiVersion: 999 }, { ...healthy, enabled: false }, { ...healthy, targetDshVersion: 'unknown' }]) assert.throws(() => validateHostStatus(wrong), { code: 'VERSION_MISMATCH' });
});
test('rc.3 页面拒绝同包版本的 rc.2 Host，不能只刷新 Client 绕过升级', () => {
  assert.equal(TARGET_DSH_VERSION, '0.2.1-rc.3');
  const old = { package: PLUGIN_NAME, version: PLUGIN_VERSION, apiVersion: API_VERSION, targetDshVersion: '0.2.1-rc.2', enabled: true, dataDirectory: 'fixture-root', capabilities: ['remove-project', 'default-model', 'structure-map-v1'] };
  assert.throws(() => validateHostStatus(old), error => error.code === 'VERSION_MISMATCH' && /完整退出/.test(error.message));
});
test('同版本旧 Host 没有仓库移除能力也不能通过就绪检查', () => {
  const old = { package: PLUGIN_NAME, version: PLUGIN_VERSION, apiVersion: API_VERSION, targetDshVersion: TARGET_DSH_VERSION, enabled: true, dataDirectory: 'fixture-root' };
  for (const capabilities of [undefined, null, [], 'remove-project', ['other-feature']]) assert.throws(() => validateHostStatus({ ...old, capabilities }), error => error.code === 'VERSION_MISMATCH' && /仓库移除/.test(error.message) && /完整退出/.test(error.message));
  assert.doesNotThrow(() => validateHostStatus({ ...old, capabilities: ['remove-project', 'default-model', 'structure-map-v1', 'future-feature'] }));
});
test('同版本旧 Host 缺少默认模型能力不能开放新页面操作', () => {
  const old = { package: PLUGIN_NAME, version: PLUGIN_VERSION, apiVersion: API_VERSION, targetDshVersion: TARGET_DSH_VERSION, enabled: true, dataDirectory: 'fixture-root', capabilities: ['remove-project'] };
  assert.throws(() => validateHostStatus(old), error => error.code === 'VERSION_MISMATCH' && /默认阅读模型/.test(error.message) && /完整退出/.test(error.message));
});
test('同版本旧 Host 缺少项目地图能力时要求重启新构建', () => {
  const old = { package: PLUGIN_NAME, version: PLUGIN_VERSION, apiVersion: API_VERSION, targetDshVersion: TARGET_DSH_VERSION, enabled: true, dataDirectory: 'fixture-root', capabilities: ['remove-project', 'default-model'] };
  assert.throws(() => validateHostStatus(old), error => error.code === 'VERSION_MISMATCH' && /项目地图/.test(error.message) && /完整退出/.test(error.message));
});
for (const method of ['structure-map', 'structure-map-refresh', 'structure-map-layers', 'structure-map-file']) {
  test(`${method} 的旧 Host 失败有明确恢复说明且不自动重发`, async t => {
    let calls = 0; transport(t, async () => { calls++; return Response.json({ ok: false, error: { code: 'UNKNOWN_METHOD', message: '旧 Host' } }, { status: 400 }); });
    await assert.rejects(api(method, {}), error => error.code === 'VERSION_MISMATCH' && /地图操作未执行/.test(error.message));
    assert.equal(calls, 1);
  });
}

test('旧 Host 不支持默认模型设置时明确指出未保存，且不自动重发', async t => {
  let calls = 0; transport(t, async () => { calls++; return Response.json({ ok: false, error: { code: 'UNKNOWN_METHOD', message: '不支持此阅读页面操作' } }, { status: 400 }); });
  await assert.rejects(api('reading-settings'), error => error.code === 'VERSION_MISMATCH' && /默认阅读模型/.test(error.message));
  await assert.rejects(api('set-default-model', { expectedRevision: 0, defaultModel: null }), error => error.code === 'VERSION_MISMATCH' && /本次设置未保存/.test(error.message)); assert.equal(calls, 2);
});
test('删除返回截图 UNKNOWN_METHOD 时说明 Host 未更新，单次请求且不声称删除成功', async t => {
  const calls = []; transport(t, async (_url, init) => { calls.push(JSON.parse(init.body)); return Response.json({ ok: false, error: { code: 'UNKNOWN_METHOD', message: '不支持此阅读页面操作' } }, { status: 400 }); });
  const params = { projectId: 'project-fixture', expectedBindingRevision: 1 };
  await assert.rejects(api('remove-project', params), error => error.code === 'VERSION_MISMATCH' && /本次删除未执行/.test(error.message) && /完整退出/.test(error.message) && /安装/.test(error.message));
  assert.deepEqual(calls, [{ method: 'remove-project', params }]);
});
test('删除的业务失败和未知方法保留原错误；网络失败仍提示结果未确认', async t => {
  transport(t, async () => Response.json({ ok: false, error: { code: 'AGENT_BUSY', message: '阅读进行中' } }, { status: 400 }));
  await assert.rejects(api('remove-project'), { code: 'AGENT_BUSY', status: 400 });
  globalThis.__DSH_TRANSPORT__.fetch = async () => Response.json({ ok: false, error: { code: 'UNKNOWN_METHOD', message: '不支持此阅读页面操作' } }, { status: 400 });
  await assert.rejects(api('not-a-real-method'), { code: 'UNKNOWN_METHOD' });
  let calls = 0; globalThis.__DSH_TRANSPORT__.fetch = async () => { calls++; throw new TypeError('offline'); };
  await assert.rejects(api('remove-project'), error => error.code === 'NETWORK_ERROR' && /未能确认/.test(error.message) && !/本次删除未执行/.test(error.message)); assert.equal(calls, 1);
});
