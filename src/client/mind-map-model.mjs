// A deliberately small Markdown outline reader, not a call-graph or Mermaid parser.
// Every omission affects only the overview; sources retain the exact input strings.
export const MIND_MAP_LIMITS = Object.freeze({ nodes: 61, depth: 3, children: 10, scanChars: 160000, scanLines: 6000, sections: 12, label: 44, preview: 900 });
export const MIND_MAP_RELATION_NOTE = '按笔记层级整理，连线不代表调用关系';
const SECTION_LABELS = { discover: '业务概览', business: '业务解释', 'call-chain': '调用链笔记', 'deep-read': '代码逻辑', verify: '理解自查' };
const textOf = value => typeof value === 'string' ? value : '';

// These are display-only replacements. HTML/entities are never interpreted.
export function mindMapPlainText(value) {
  return textOf(value)
    .replace(/!?\[([^\]\n]*)\]\([^\n]*?\)/g, '$1')
    .replace(/`+([^`\n]+)`+/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_, a, b) => a ?? b)
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/gm, '')
    .replace(/\s+/g, ' ').trim();
}

export function shortenMindMapLabel(value, limit = MIND_MAP_LIMITS.label) {
  const characters = Array.from(textOf(value));
  return characters.length > limit ? `${characters.slice(0, Math.max(1, limit - 1)).join('')}…` : characters.join('');
}

function withoutCode(value) {
  let fence = null;
  return textOf(value).split(/\r?\n/).map(line => {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return '';
    }
    if (marker) { fence = { char: marker[1][0], length: marker[1].length }; return ''; }
    return line.replace(/(`+)[\s\S]*?\1/g, '');
  }).join('\n');
}

function evidenceDefinitions(value) {
  const definitions = new Map();
  for (const match of withoutCode(value).matchAll(/^ {0,3}\[([^\]\n]+)\]:\s*<?evidence:\/\/([^\s<>()[\]"'`]+)/gm)) {
    const key = match[1].trim().replace(/\s+/g, ' ').toLowerCase();
    if (!definitions.has(key)) definitions.set(key, match[2]);
  }
  return definitions;
}

// References are *unverified* literal IDs, including unknown/encoded IDs. No path,
// repo, line range, freshness or validity is inferred from their spelling.
export function extractMindMapEvidence(value, definitions = evidenceDefinitions(value)) {
  const content = withoutCode(value); const ids = new Set();
  for (const match of content.matchAll(/evidence:\/\/([^\s<>()[\]"'`]+)/g)) ids.add(match[1]);
  for (const match of content.matchAll(/\[([^\]\n]+)\](?:\[([^\]\n]*)\])?(?!\()/g)) {
    const key = (match[2] || match[1]).trim().replace(/\s+/g, ' ').toLowerCase();
    if (definitions.has(key)) ids.add(definitions.get(key));
  }
  return [...ids].map(id => ({ id, status: 'unverified' }));
}

function sectionTitle(section, index) {
  return textOf(section?.title).trim() || SECTION_LABELS[section?.dimension] || textOf(section?.dimension).trim() || `笔记分节 ${index + 1}`;
}

export function mindMapSectionSignature(sections) {
  return JSON.stringify((Array.isArray(sections) ? sections : []).map(section => [textOf(section?.title), textOf(section?.dimension), textOf(section?.markdown)]));
}

export function buildMindMap({ title, markdown, conclusion, sections } = {}) {
  const main = textOf(markdown); const summary = textOf(conclusion);
  const sources = [];
  if (main) sources.push({ id: 'markdown', title: '阅读笔记', markdown: main });
  const sectionSources = (Array.isArray(sections) ? sections : []).flatMap((section, index) => typeof section?.markdown === 'string' && section.markdown.trim()
    ? [{ id: `section-${index}`, title: sectionTitle(section, index), markdown: section.markdown }] : []);
  sources.push(...sectionSources);
  const rootTitle = textOf(title).trim() || '阅读笔记';
  const raw = []; const byId = new Map(); const reasons = new Set(); const references = new Map();
  let charsLeft = MIND_MAP_LIMITS.scanChars; let linesLeft = MIND_MAP_LIMITS.scanLines;
  function add(parent, kind, label, sourceId, line) {
    const node = { id: `note-${raw.length}`, parentId: parent?.id ?? null, depth: parent ? parent.depth + 1 : 0, kind, fullLabel: label, children: [], sourceId, line, lines: [] };
    raw.push(node); byId.set(node.id, node); parent?.children.push(node.id); return node;
  }
  const root = add(null, 'root', rootTitle, null, 0);
  if (summary) root.lines.push(summary.slice(0, MIND_MAP_LIMITS.scanChars));
  if (summary.length > MIND_MAP_LIMITS.scanChars) reasons.add('scan-chars');

  function parse(source, base) {
    const scanned = source.markdown.slice(0, Math.max(0, charsLeft)); charsLeft -= scanned.length;
    if (scanned.length < source.markdown.length) reasons.add('scan-chars');
    const allLines = scanned.split(/\r?\n/); const lines = allLines.slice(0, Math.max(0, linesLeft)); linesLeft -= lines.length;
    if (lines.length < allLines.length) reasons.add('scan-lines');
    references.set(source.id, evidenceDefinitions(lines.join('\n')));
    const headings = []; const lists = []; let fence = null; let fenceOwner = null; let structural = 0;
    const headingOwner = () => headings.at(-1)?.node ?? base;
    const ownerFor = line => {
      const indent = /^(\s*)/.exec(line)[1].replace(/\t/g, '    ').length;
      return lists.length && (indent > lists.at(-1).indent || !line.trim()) ? lists.at(-1).node : headingOwner();
    };
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]; const trimmed = line.trim();
      const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        fenceOwner.lines.push(line);
        if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
        continue;
      }
      if (marker) { fence = { char: marker[1][0], length: marker[1].length }; fenceOwner = ownerFor(line); fenceOwner.lines.push(line); continue; }
      const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)\s*#*\s*|\s*)$/.exec(line);
      const setext = trimmed && !/^\s*(?:[-+*]|\d+[.)])(?:\s|$)/.test(line) && !/^\s{4}/.test(line) && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1] ?? '');
      if (atx || setext) {
        const level = atx ? atx[1].length : lines[index + 1].trim().startsWith('=') ? 1 : 2;
        const label = mindMapPlainText(atx ? atx[2] : line); lists.length = 0;
        while (headings.length && headings.at(-1).level >= level) headings.pop();
        if (label) {
          // Only a matching document title can merge into the explicit root.
          const mergeRoot = base === root && !structural && level === 1 && label === mindMapPlainText(rootTitle);
          const node = mergeRoot ? root : add(headingOwner(), 'heading', label, source.id, index + 1);
          node.lines.push(line); if (setext) node.lines.push(lines[index + 1]);
          headings.push({ level, node }); structural++;
        } else headingOwner().lines.push(line);
        if (setext) index++;
        continue;
      }
      const rule = /^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
      const item = !rule && /^([ \t]*)(?:[-+*]|\d+[.)])(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
      if (item && (!/^ {4}/.test(line) || lists.length)) {
        const indent = item[1].replace(/\t/g, '    ').length;
        while (lists.length && lists.at(-1).indent >= indent) lists.pop();
        const content = (item[2] ?? '').replace(/^\[[ xX]\]\s*/, ''); const label = mindMapPlainText(content);
        if (label) {
          const node = add(lists.at(-1)?.node ?? headingOwner(), 'list', label, source.id, index + 1);
          node.lines.push(content); lists.push({ indent, node }); structural++;
        } else (lists.at(-1)?.node ?? headingOwner()).lines.push(line);
        continue;
      }
      if (trimmed && lists.length && !/^\s/.test(line)) lists.length = 0;
      ownerFor(line).lines.push(line);
    }
    return { structural, lines };
  }

  // Prefer actual headings/lists; legacy dimensional sections are a fallback.
  // Parse the main text once, then discard only its *outline* if sections are better.
  let parsed = null; let mode = 'empty';
  if (main.trim()) { parsed = parse(sources[0], root); mode = 'markdown'; }
  if ((!parsed || !parsed.structural) && sectionSources.length) {
    mode = 'sections';
    if (sectionSources.length > MIND_MAP_LIMITS.sections) reasons.add('sections');
    for (const source of sectionSources.slice(0, MIND_MAP_LIMITS.sections)) {
      const node = add(root, 'section', source.title, source.id, 1); parse(source, node);
    }
  } else if (parsed && !parsed.structural) {
    // Unstructured old notes still get readable paragraph nodes, never guessed modules.
    const paragraphs = withoutCode(parsed.lines.join('\n')).split(/\n\s*\n/).filter(value => value.trim() && !/^\s*\[[^\]]+\]:/.test(value));
    for (const paragraph of paragraphs) {
      const label = mindMapPlainText(paragraph); if (!label) continue;
      const node = add(root, 'paragraph', label, 'markdown', 1); node.lines.push(paragraph);
    }
    if (paragraphs.length) root.lines = summary ? [summary.slice(0, MIND_MAP_LIMITS.scanChars)] : [];
  }

  // Breadth-first admission keeps later top-level branches discoverable even when
  // an earlier branch is huge. Never reparent omitted descendants as invented peers.
  const keep = new Set([root.id]); const queue = [root];
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index];
    if (node.depth >= MIND_MAP_LIMITS.depth) { if (node.children.length) reasons.add('depth'); continue; }
    if (node.children.length > MIND_MAP_LIMITS.children) reasons.add('children');
    for (const id of node.children.slice(0, MIND_MAP_LIMITS.children)) {
      if (keep.size >= MIND_MAP_LIMITS.nodes) { reasons.add('nodes'); break; }
      keep.add(id); queue.push(byId.get(id));
    }
  }
  const nearest = new Map(); const omitted = new Map();
  for (const node of raw) {
    const owner = keep.has(node.id) ? node.id : nearest.get(node.parentId);
    nearest.set(node.id, owner);
    if (!keep.has(node.id)) omitted.set(owner, (omitted.get(owner) ?? 0) + 1);
  }
  const nodes = raw.filter(node => keep.has(node.id)).map(node => {
    const markdown = node.lines.join('\n').trim();
    const label = shortenMindMapLabel(node.fullLabel);
    return { id: node.id, parentId: node.parentId, depth: node.depth, kind: node.kind, label, fullLabel: node.fullLabel, labelTruncated: label !== node.fullLabel, children: node.children.filter(id => keep.has(id)), sourceId: node.sourceId, line: node.line, markdown, evidence: extractMindMapEvidence(markdown, references.get(node.sourceId ?? 'markdown')), omitted: omitted.get(node.id) ?? 0 };
  });
  return { rootId: root.id, nodes, sources, conclusion: summary, mode, relationNote: MIND_MAP_RELATION_NOTE, truncated: reasons.size > 0, truncationReasons: [...reasons], omittedNodes: raw.length - nodes.length, shortenedLabels: nodes.filter(node => node.labelTruncated).length };
}

export function defaultMindMapCollapsed(model) {
  const depthTwo = model.nodes.filter(node => node.depth <= 2).length;
  return model.nodes.filter(node => node.children.length && node.depth >= (depthTwo > 24 ? 1 : 2)).map(node => node.id);
}

// Geometry only: native SVG paths and HTML buttons share the same coordinate space.
export function layoutMindMap(model, collapsedIds = [], { width: viewportWidth } = {}) {
  const collapsed = new Set(collapsedIds); const byId = new Map(model.nodes.map(node => [node.id, node]));
  const root = byId.get(model.rootId); if (!root) return { nodes: [], edges: [], width: 320, height: 220 };
  const width = 184; const rootWidth = 204; const height = 64; const row = 88; const step = 232; const padding = 40;
  const spans = new Map(); const sides = new Map([[root.id, 0]]); const visible = [];
  const childrenOf = node => collapsed.has(node.id) ? [] : node.children.map(id => byId.get(id)).filter(Boolean);
  function measure(node, side) {
    sides.set(node.id, side); visible.push(node);
    const children = childrenOf(node);
    const span = children.length ? children.reduce((sum, child) => sum + measure(child, side), 0) : row;
    spans.set(node.id, span); return span;
  }
  visible.push(root);
  const branches = childrenOf(root); const left = []; const right = [];
  branches.forEach((node, index) => { const side = index % 2 ? -1 : 1; (side < 0 ? left : right).push(node); measure(node, side); });
  if (Number.isFinite(viewportWidth) && viewportWidth > 0 && viewportWidth < 600) {
    const totalWidth = Math.max(224, viewportWidth - 24); const inset = 22; const indent = 18;
    const nodes = visible.map((node, index) => ({ ...node, side: node.depth ? 1 : 0, x: inset + node.depth * indent, y: 24 + index * row, width: totalWidth - inset * 2 - node.depth * indent, height }));
    const positions = new Map(nodes.map(node => [node.id, node]));
    const edges = nodes.filter(node => node.parentId).map(node => {
      const parent = positions.get(node.parentId); const x1 = parent.x + 8; const y1 = parent.y + parent.height; const y2 = node.y + node.height / 2;
      return { from: parent.id, to: node.id, side: 1, path: `M ${x1} ${y1} V ${y2 - 8} Q ${x1} ${y2}, ${x1 + 8} ${y2} H ${node.x}` };
    });
    return { nodes, edges, width: totalWidth, height: Math.max(220, visible.length * row + 24), compact: true };
  }
  const leftDepth = Math.max(0, ...visible.filter(node => sides.get(node.id) < 0).map(node => node.depth));
  const rightDepth = Math.max(0, ...visible.filter(node => sides.get(node.id) > 0).map(node => node.depth));
  const sumSpan = rows => rows.reduce((sum, node) => sum + spans.get(node.id), 0);
  const totalHeight = Math.max(220, Math.max(sumSpan(left), sumSpan(right), row) + padding * 2);
  const totalWidth = Math.max(320, (leftDepth + rightDepth) * step + rootWidth + padding * 2);
  const rootX = padding + leftDepth * step + rootWidth / 2; const rootY = totalHeight / 2;
  const positions = new Map();
  positions.set(root.id, { ...root, side: 0, x: rootX - rootWidth / 2, y: rootY - height / 2, width: rootWidth, height });
  function place(node, side, top) {
    const span = spans.get(node.id); const center = top + span / 2;
    positions.set(node.id, { ...node, side, x: rootX + side * node.depth * step - width / 2, y: center - height / 2, width, height });
    let nextTop = top;
    for (const child of childrenOf(node)) { place(child, side, nextTop); nextTop += spans.get(child.id); }
  }
  for (const [rows, side] of [[left, -1], [right, 1]]) {
    let top = (totalHeight - sumSpan(rows)) / 2;
    for (const node of rows) { place(node, side, top); top += spans.get(node.id); }
  }
  const nodes = visible.map(node => positions.get(node.id));
  const edges = nodes.filter(node => node.parentId).map(node => {
    const parent = positions.get(node.parentId); const side = node.side;
    const x1 = parent.x + (side > 0 ? parent.width : 0); const y1 = parent.y + parent.height / 2;
    const x2 = node.x + (side > 0 ? 0 : node.width); const y2 = node.y + node.height / 2; const bend = (x1 + x2) / 2;
    return { from: parent.id, to: node.id, side, path: `M ${x1} ${y1} C ${bend} ${y1}, ${bend} ${y2}, ${x2} ${y2}` };
  });
  return { nodes, edges, width: totalWidth, height: totalHeight };
}

export function mindMapFocusTarget(layout, id, key) {
  const index = layout.nodes.findIndex(node => node.id === id); const node = layout.nodes[index];
  if (!node) return null;
  if (key === 'Home') return layout.nodes[0]?.id ?? null;
  if (key === 'End') return layout.nodes.at(-1)?.id ?? null;
  if (key === 'ArrowUp' || key === 'ArrowDown') return layout.nodes[index + (key === 'ArrowUp' ? -1 : 1)]?.id ?? null;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const direction = key === 'ArrowLeft' ? -1 : 1;
  if (node.side && node.side !== direction) return node.parentId;
  return layout.nodes.find(child => child.parentId === id && (!node.side ? child.side === direction : true))?.id ?? null;
}
