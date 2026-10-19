import { PLUGIN_NAME, PLUGIN_VERSION, TARGET_DSH_VERSION, API_VERSION } from '../version.mjs';

export function validateHostStatus(value) {
  if (!value || value.package !== PLUGIN_NAME || value.version !== PLUGIN_VERSION || value.apiVersion !== API_VERSION || value.targetDshVersion !== TARGET_DSH_VERSION || value.enabled !== true) {
    throw new ReadingApiError('VERSION_MISMATCH', `页面版本 ${PLUGIN_VERSION} 与阅读 Host 不一致或 Host 尚未启用。请在插件管理确认版本，完整退出并重启 DSH，再刷新页面`);
  }
  if (typeof value.dataDirectory !== 'string' || !value.dataDirectory) throw protocolError(200);
  return value;
}

export class ReadingApiError extends Error {
  constructor(code, message, status = 0) {
    super(`${message} (${code})`); this.name = 'ReadingApiError'; this.code = code; this.status = status;
  }
}
const protocolError = status => new ReadingApiError('PROTOCOL_ERROR', '阅读插件响应格式不正确。请刷新页面；若仍失败，在插件管理确认已启用并完整退出、重启 DSH，使 Host 与页面版本一致', status);

/** Use the native authenticated carrier. Never retry mutations or fall back around authentication. */
export async function api(method, params = {}, signal) {
  const transport = globalThis.__DSH_TRANSPORT__;
  const fetcher = transport?.fetch ? transport.fetch.bind(transport) : globalThis.fetch.bind(globalThis);
  let response;
  try {
    response = await fetcher('api/code-reading', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }), ...(signal ? { signal } : {}) });
  } catch (error) {
    if (error.name === 'AbortError' || signal?.aborted) throw error;
    throw new ReadingApiError('NETWORK_ERROR', '连接中断，未能确认本次操作结果。请先刷新检查已有项目或会话，不要连续重复创建或发送');
  }
  if ([401, 403].includes(response.status)) throw new ReadingApiError('AUTH_REQUIRED', 'DSH 登录或认证已失效，请重新登录当前 DSH 页面后重试', response.status);
  if ([404, 405].includes(response.status)) throw new ReadingApiError('HOST_UNAVAILABLE', '阅读 Host 尚未加载。请在插件管理确认已启用；提示 restart-required 时须完整退出并重启 DSH，再刷新此页面', response.status);
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  if (contentType !== 'application/json' && !contentType.endsWith('+json')) {
    if (response.status >= 500) throw new ReadingApiError('HOST_ERROR', '阅读 Host 暂时无法处理请求，请检查 DSH 插件状态后刷新；已有操作结果需先确认', response.status);
    throw protocolError(response.status);
  }
  let result;
  try { result = await response.json(); } catch (error) { if (error.name === 'AbortError' || signal?.aborted) throw error; throw protocolError(response.status); }
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') throw protocolError(response.status);
  if (!result.ok) {
    if (!result.error || typeof result.error !== 'object' || typeof result.error.code !== 'string' || typeof result.error.message !== 'string') throw protocolError(response.status);
    if (method === 'status' && result.error.code === 'UNKNOWN_METHOD') throw new ReadingApiError('VERSION_MISMATCH', '页面已更新，但阅读 Host 仍为旧版本。请完整退出并重启 DSH 后刷新页面', response.status);
    throw new ReadingApiError(result.error.code.slice(0, 80), result.error.message.slice(0, 1200), response.status);
  }
  if (!response.ok || !Object.hasOwn(result, 'value')) throw protocolError(response.status);
  return result.value;
}
