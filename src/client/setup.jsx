import React from 'react';
import { PLUGIN_NAME, PLUGIN_VERSION, TARGET_DSH_VERSION, API_VERSION } from '../version.mjs';

export function InstallationHelp({ connection, modelsState, models }) {
  const host = connection.status;
  const diagnostics = { plugin: PLUGIN_NAME, clientVersion: PLUGIN_VERSION, hostVersion: host?.version ?? null, apiVersion: host?.apiVersion ?? API_VERSION, targetDshVersion: TARGET_DSH_VERSION, connection: connection.state, errorCode: connection.error?.code ?? null, dataDirectory: host?.dataDirectory ?? null, dataSource: host?.dataSource ?? null, modelCatalog: modelsState, modelOptions: models?.groups?.reduce((total, group) => total + group.models.length, 0) ?? 0 };
  return <section id="cr-installation-help" className="cr-card cr-help" aria-labelledby="cr-installation-heading">
    <h2 id="cr-installation-heading">安装与使用</h2>
    <p role="status">{connection.state === 'loading' ? '正在连接阅读 Host…' : connection.state === 'ready' ? '阅读插件已连接。' : 'Host 尚未就绪，请检查安装与连接。'}</p>
    {connection.error && <p className="cr-banner cr-error" role="alert">{connection.error.message}</p>}
    <ol className="cr-checklist">
      <li><strong>安装：</strong>在当前 DSH 的插件管理中安装可信插件包并启用；提示需要重启时，完整退出 DSH（含托盘）再打开。</li>
      <li><strong>选模型：</strong>先在 DSH 配置提供方，再在“阅读设置”选择默认模型；当前会话可在底部单独切换。</li>
      <li><strong>开始阅读：</strong>打开仓库，选择代码或输入问题，核对模型与范围后开始。仅打开文件不会请求模型。</li>
    </ol>
    <p className="cr-muted">源码只读；模型服务会接收本轮读到的代码与对话。档案位置见“阅读设置”。</p>
    <details><summary>连接排查与版本信息</summary>
      <p>没有入口或界面仍旧：检查当前应用/profile 的插件已启用，完整重开 DSH 后刷新页面。修改源码或另开服务器不会更新已安装插件。</p>
      <div className="cr-row"><span className="cr-badge">Client {PLUGIN_VERSION}</span><span className="cr-badge">Host {host?.version ?? '未连接'}</span><span className="cr-badge">兼容 DSH {TARGET_DSH_VERSION}</span></div>
      <pre className="cr-diagnostics">{JSON.stringify(diagnostics, null, 2)}</pre>
      <p className="cr-muted">兼容版本不是当前 DSH 版本检测；反馈前请隐去路径中的个人信息。</p>
    </details>
  </section>;
}
