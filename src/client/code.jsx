import React, { useMemo, useRef, useState } from 'react';
import { prepareCode } from './code-tokens.mjs';
import { useCodeReadings } from './code-readings.jsx';

// Tokens are rendered as React text/spans, never HTML or executable source.
export function CodeBlock({ text, language = '', pathHint = '', startLine = 1, title, markers = {}, onMarker, evidenceRange = null, fontSize, onFontSizeChange, codeReadings, readingIdentity = '', readingsEnabled = false, onOpenReading }) {
  const root = useRef(null);
  const [wrap, setWrap] = useState(() => { try { return localStorage.getItem('dsh-code-reading:code-wrap') === 'true'; } catch { return false; } });
  const toggleWrap = () => setWrap(value => { const next = !value; try { localStorage.setItem('dsh-code-reading:code-wrap', String(next)); } catch { /* Browser preferences are optional. */ } return next; });
  const prepared = useMemo(() => prepareCode(text, { language, pathHint }), [text, language, pathHint]);
  const rows = useMemo(() => String(text).split('\n').map((value, index) => ({ number: startLine + index, text: value })), [text, startLine]);
  const readings = useCodeReadings({ value: codeReadings, rows, identity: readingIdentity, enabled: readingsEnabled, onOpenReading, root });
  return <section ref={root} {...readings.bind} style={readings.groups.length ? { '--cr-code-reading-digits': Math.max(2, String(startLine + prepared.lines.length - 1).length) } : undefined} className={`cr-code${wrap ? ' cr-code-wrap' : ''}${readings.groups.length ? ' cr-code-has-readings' : ''}`} aria-label={title ? `代码：${title}` : `${prepared.label} 代码`}>
    <header className="cr-code-toolbar"><div className="cr-code-caption"><span className="cr-code-dot" aria-hidden="true" /><strong title={title || pathHint || prepared.label}>{title || pathHint || '代码片段'}</strong><span className="cr-code-language">{prepared.label}</span></div><div className="cr-code-actions">{onFontSizeChange && <label className="cr-code-font-size"><span>字号</span><select aria-label="源码字号" value={fontSize ?? 13} onChange={event => onFontSizeChange(Number(event.target.value))}>{[13, 14, 15, 16].map(size => <option key={size} value={size}>{size}px</option>)}</select></label>}<span className="cr-code-readonly">只读</span><button type="button" aria-label="切换代码折行" aria-pressed={wrap} onClick={toggleWrap}>{wrap ? '取消折行' : '自动折行'}</button></div></header>
    {readings.summary}
    <pre className="cr-code-body" style={fontSize ? { fontSize: `${fontSize}px` } : undefined} tabIndex={0} aria-label="代码内容，可横向滚动"><code className="cr-code-lines">{prepared.lines.map((line, index) => {
      const number = startLine + index; const reading = readings.lineInfo.get(number); const evidence = evidenceRange && number >= evidenceRange.startLine && number <= evidenceRange.endLine;
      return <span className={`cr-code-line${evidence ? ' cr-code-evidence-line' : ''}${reading ? ' cr-code-reading-range' : ''}`} data-code-line={number} data-evidence-line={evidence ? 'true' : undefined} data-code-reading={reading ? 'true' : undefined} key={index}>
        {reading?.markers.length > 0 && <span className="cr-code-reading-gutter"><button type="button" className="cr-code-reading-marker" {...readings.markerProps(number, reading.markers)}><span aria-hidden="true">{reading.markers.length > 1 ? reading.markers.length : 'AI'}</span></button></span>}
        <span className="cr-code-number" aria-hidden="true">{number}</span><span className="cr-code-text" data-code-text="">{line.tokens.map((token, tokenIndex) => <span data-token={token.classes.filter(value => value.startsWith('hljs-')).at(-1)} className={token.classes.join(' ') || undefined} key={tokenIndex}>{token.text}</span>)}</span>{markers[number]?.length > 0 && <button type="button" className="cr-line-annotation" aria-label={`第 ${number} 行的 ${markers[number].length} 条批注`} title="查看本版本已确认的批注" onClick={() => onMarker?.(markers[number][0])}>●</button>}
      </span>;
    })}</code></pre>
    {readings.preview}
  </section>;
}

export function CodeFence({ children }) {
  const element = React.Children.toArray(children).find(React.isValidElement);
  const text = String(element?.props.children ?? '').replace(/\n$/, '');
  const language = /(?:^|\s)language-([^\s]+)/i.exec(element?.props.className ?? '')?.[1]?.toLowerCase() ?? '';
  return <CodeBlock text={text} language={language} />;
}
