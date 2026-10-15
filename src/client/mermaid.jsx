import React, { useEffect, useState } from 'react';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import { validateMermaid } from '../contracts.mjs';

let queue = Promise.resolve();
export async function renderDiagramDocument(source) {
  validateMermaid(source);
  const task = queue.catch(() => {}).then(async () => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', maxTextSize: 10000, maxEdges: 120, flowchart: { htmlLabels: false } });
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none';
    document.body.appendChild(container);
    try {
      const { svg } = await mermaid.render(`cr-${crypto.randomUUID()}`, source, container);
      const safe = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject', 'script', 'a', 'image'], FORBID_ATTR: ['href', 'xlink:href'] });
      if (/url\s*\(\s*["']?(?!#)[a-z]/i.test(safe)) throw new Error('图中存在外部资源引用');
      return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><style>body{margin:12px;background:#fff}svg{max-width:100%;height:auto}a{pointer-events:none}</style></head><body>${safe}</body></html>`;
    } finally { container.remove(); }
  });
  queue = task;
  return task;
}
export function MermaidDiagram({ source }) {
  const [documentText, setDocumentText] = useState(''); const [error, setError] = useState(''); const [showSource, setShowSource] = useState(false);
  useEffect(() => { let current = true; setDocumentText(''); setError(''); renderDiagramDocument(source).then(value => { if (current) setDocumentText(value); }).catch(reason => { if (current) setError(reason.message); }); return () => { current = false; }; }, [source]);
  return <div className="cr-diagram">
    {error ? <div className="cr-banner cr-error" role="alert">Mermaid 无法渲染：{error}。原文已保留，可修正后重新生成。</div> : documentText ? <iframe title="Mermaid 调用链图" sandbox="" referrerPolicy="no-referrer" srcDoc={documentText} /> : <p className="cr-muted">正在渲染图表…</p>}
    <div className="cr-row"><button type="button" onClick={() => setShowSource(!showSource)}>{showSource ? '收起图源码' : '查看图源码'}</button></div>
    {(showSource || error) && <pre><code>{source}</code></pre>}
  </div>;
}
