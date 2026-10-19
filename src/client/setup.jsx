import React from 'react';
import { PLUGIN_NAME, PLUGIN_VERSION, TARGET_DSH_VERSION, API_VERSION } from '../version.mjs';

export function InstallationHelp({ connection, modelsState, models }) {
  const host = connection.status;
  const diagnostics = { plugin: PLUGIN_NAME, clientVersion: PLUGIN_VERSION, hostVersion: host?.version ?? null, apiVersion: host?.apiVersion ?? API_VERSION, targetDshVersion: TARGET_DSH_VERSION, connection: connection.state, errorCode: connection.error?.code ?? null, dataDirectory: host?.dataDirectory ?? null, dataSource: host?.dataSource ?? null, modelCatalog: modelsState, modelOptions: models?.groups?.reduce((total, group) => total + group.models.length, 0) ?? 0 };
  return <section id="cr-installation-help" className="cr-card cr-help" aria-labelledby="cr-installation-heading">
    <h2 id="cr-installation-heading">安装与使用检查</h2>
    <div className="cr-row"><span className="cr-badge">Client {PLUGIN_VERSION}</span><span className="cr-badge">Host {host?.version ?? '未连接'}</span><span className="cr-badge">目标 DSH {TARGET_DSH_VERSION}</span></div>
    <p role="status">{connection.state === 'loading' ? '正在检查阅读 Host，请稍候…' : connection.state === 'ready' ? 'Host 与页面版本一致；模型调用仍需你明确开始。' : '尚未通过 Host 就绪检查，创建和发送操作已暂停。'}</p>
    {connection.error && <p className="cr-banner cr-error" role="alert">{connection.error.message}</p>}
    <ol className="cr-checklist">
      <li><strong>确认安装并启用。</strong>在 DSH 插件管理安装可信的预构建 <code>.tgz</code>，确认启用。提示 <code>restart-required</code> 时完整退出 DSH 再打开，不是只刷新浏览器；Host 生效后仍显示旧 Client 时再刷新当前页。</li>
      <li><strong>准备模型与仓库。</strong>在 DSH“设置 → 模型”配置提供方；新建阅读项目时确认所有仓库路径，绑定后不可随普通工作区切换或添加仓库而改变。</li>
      <li><strong>确认本会话实际模型。</strong>检查阅读页面的提供方与模型。远程提供方会接收读取到的源码、问题和对话；本插件不自带本地模型。</li>
      <li><strong>由你开始。</strong>打开仓库不会自动请求模型。从问题或选中的代码开始阅读；每轮一个知识点，不必按固定阶段推进。</li>
    </ol>
    {host && <p className="cr-muted">档案目录（{host.dataSource}）：<span className="cr-path">{host.dataDirectory}</span>。停用或卸载不删除档案；升级前建议备份。目录位置变化需要重启，不会自动迁移旧档案。</p>}
    <details><summary>排查“已安装但没有入口”或旧页面</summary><p>依次确认：安装在当前应用/profile → bundle 已启用 → 按安装器要求完整重启 → 刷新当前页面。不要用 CLI 管理桌面版保留的 profile，不要为未知版本盲目豁免。源码开发须重新构建、打包和安装；另开 Web 服务器不会更新当前 DSH。</p></details>
    <details><summary>诊断信息（不含源码、对话或密钥）</summary><pre className="cr-diagnostics">{JSON.stringify(diagnostics, null, 2)}</pre><p className="cr-muted">其中目录可能包含你的用户名；对外反馈前可自行脱敏。目标版本是插件兼容声明，不是对当前 DSH 版本的自动检测。</p></details>
  </section>;
}
