import test from 'node:test';
import assert from 'node:assert/strict';
import { turnEndNotice } from '../src/client/turn-status.mjs';
const error = { message: 'DeepSeek Messages stream: tool input is invalid JSON', code: 'MALFORMED_RESPONSE' };

test('DeepSeek工具JSON错误明确说明本轮未完成及手动恢复，不声称已归档', () => {
  const reason = { kind: 'error', error: { ...error } }; const before = structuredClone(reason);
  const notice = turnEndNotice(reason);
  assert.match(notice, /工具参数不是合法 JSON/);
  assert.match(notice, /执行本次工具前中止/);
  assert.match(notice, /本轮未完成/);
  assert.match(notice, /已有知识点、证据和位置保留/);
  assert.match(notice, /手动重试/);
  assert.match(notice, /正确转义/);
  assert.match(notice, /不会自动修复参数或重发/);
  assert.match(notice, /只能降低格式错误风险/);
  assert.match(notice, /不能保证模型重试后不再出错/);
  assert.doesNotMatch(notice, /已归档|归档成功/);
  assert.deepEqual(reason, before);
});

test('错误分类严格匹配code和message，不将其它畸形响应、网络或取消误判为JSON', () => {
  for (const reason of [{ kind: 'error', error: { ...error, message: 'DeepSeek Messages SSE contains invalid JSON' } }, { kind: 'error', error: { ...error, code: 'STREAM_CLOSED' } }, { kind: 'cancelled', error }, { kind: 'error' }, null]) assert.doesNotMatch(turnEndNotice(reason), /工具参数不是合法 JSON/);
  assert.equal(turnEndNotice({ kind: 'cancelled' }), '本轮已结束：cancelled。已完成知识点和位置保留。');
});

test('不回显任意提供方错误正文或注入工具参数', () => {
  const raw = '<img src=https://example.invalid/secret><script>RAW_ARGUMENT</script>';
  assert.doesNotMatch(turnEndNotice({ kind: 'error', error: { code: 'MALFORMED_RESPONSE', message: raw } }), /RAW_ARGUMENT|https|script/);
});
