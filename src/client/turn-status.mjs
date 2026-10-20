// Match only a known provider failure; never echo raw provider/tool content.
export function turnEndNotice(reason) {
  if (reason?.kind === 'error' && reason.error?.code === 'MALFORMED_RESPONSE' && reason.error?.message === 'DeepSeek Messages stream: tool input is invalid JSON') return '模型返回的工具参数不是合法 JSON，DSH 已在执行本次工具前中止。本轮未完成；已有知识点、证据和位置保留。请先核对当前状态，再手动重试；可要求模型缩短归档内容，并正确转义英文双引号、反斜杠和换行。这些措施只能降低格式错误风险，不能保证模型重试后不再出错。不会自动修复参数或重发。';
  return `本轮已结束：${reason?.kind ?? 'unknown'}。已完成知识点和位置保留。`;
}
