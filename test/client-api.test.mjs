import test from 'node:test';
import assert from 'node:assert/strict';
import { api, validateHostStatus } from '../src/client/api.mjs';
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
test('旧 Host 不支持状态方法时明确提示完整重启', async t => {
  transport(t, async () => Response.json({ ok: false, error: { code: 'UNKNOWN_METHOD', message: '不支持' } }, { status: 400 }));
  await assert.rejects(api('status'), error => error.code === 'VERSION_MISMATCH' && /完整退出/.test(error.message));
});
test('就绪判断要求包版本、接口、目标和启用状态全部一致', () => {
  const healthy = { package: PLUGIN_NAME, version: PLUGIN_VERSION, apiVersion: API_VERSION, targetDshVersion: TARGET_DSH_VERSION, enabled: true, dataDirectory: 'fixture-root' };
  assert.equal(validateHostStatus(healthy), healthy);
  for (const wrong of [null, { ...healthy, version: '0.1.1' }, { ...healthy, apiVersion: 999 }, { ...healthy, enabled: false }, { ...healthy, targetDshVersion: 'unknown' }]) assert.throws(() => validateHostStatus(wrong), { code: 'VERSION_MISMATCH' });
});
