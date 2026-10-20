import React from 'react';
import { ReadingDialog } from './workbench.jsx';

export function SourceConsent({ model, repositories, selection, onClose, onConfirm }) {
  const repository = repositories.find(repo => repo.id === selection?.repoId);
  const lastLine = selection && (selection.end.column === 0 ? Math.max(selection.start.line, selection.end.line - 1) : selection.end.line);
  return <ReadingDialog title="确认源码发送范围" className="cr-consent-dialog" onClose={onClose}>
    <dl className="cr-consent-summary">
      <div><dt>所选模型</dt><dd><strong>{model.replace('\u0000', ' / ')}</strong></dd></div>
      <div><dt>本次文件范围</dt><dd>{selection ? <strong className="cr-consent-range" title={`SHA256 ${selection.fileHash}`}>{repository?.name ?? selection.repoId} / {selection.path} · 第 {selection.start.line}{lastLine !== selection.start.line ? `–${lastLine}` : ''} 行</strong> : <><strong>未指定文件，按问题检索</strong><small className="cr-path">{repositories.map(repo => repo.name).join(' / ')}</small></>}</dd></div>
    </dl>
    <p className="cr-muted cr-consent-note">所选模型服务可能接收读到的源码、问题与对话；模型可在绑定仓库内补读完整方法及必要上下文。</p>
    <details className="cr-consent-details"><summary>查看可读取仓库</summary><ul>{repositories.map(repo => <li key={repo.id}>{repo.name}<small className="cr-path">{repo.root}</small></li>)}</ul><p className="cr-muted">接收端点与部署位置以 DSH 模型配置为准，不能仅凭名称判断是否本地。</p></details>
    <div className="cr-row"><button type="button" onClick={onClose}>暂不发送</button><button type="button" className="cr-primary" onClick={onConfirm}>确认并开始阅读</button></div>
  </ReadingDialog>;
}
