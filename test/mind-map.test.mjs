import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildMindMap, defaultMindMapCollapsed, extractMindMapEvidence, layoutMindMap, mindMapFocusTarget, mindMapPlainText, mindMapSectionSignature, shortenMindMapLabel, MIND_MAP_LIMITS, MIND_MAP_RELATION_NOTE } from '../src/client/mind-map-model.mjs';

const byLabel = (model, label) => model.nodes.find(node => node.fullLabel === label);
const rootOf = model => model.nodes.find(node => node.id === model.rootId);
const outline = Array.from({ length: 4 }, (_, i) => `## 模块 ${i + 1}\n模块说明 ${i + 1}\n### 入口 ${i + 1}\n入口说明 [源码](evidence://evidence-${i + 1})\n### 边界 ${i + 1}\n边界说明`).join('\n\n');

function assertLayout(layout) {
  assert.ok(Number.isFinite(layout.width) && layout.width > 0);
  assert.ok(Number.isFinite(layout.height) && layout.height > 0);
  assert.equal(layout.edges.length, layout.nodes.length - 1);
  for (const node of layout.nodes) {
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Number.isFinite(node[key]), `${node.id}.${key}`);
    assert.ok(node.x >= 0 && node.y >= 0);
    assert.ok(node.x + node.width <= layout.width && node.y + node.height <= layout.height);
    for (const peer of layout.nodes) {
      if (node.id === peer.id) continue;
      assert.ok(node.x + node.width <= peer.x || peer.x + peer.width <= node.x || node.y + node.height <= peer.y || peer.y + peer.height <= node.y, `nodes overlap: ${node.id} / ${peer.id}`);
    }
  }
  for (const edge of layout.edges) {
    assert.ok(layout.nodes.some(node => node.id === edge.from));
    assert.ok(layout.nodes.some(node => node.id === edge.to));
    assert.doesNotMatch(edge.path, /NaN|Infinity|undefined/);
  }
}

test('显式 title 始终是根：四个真实标题分支、八个子节点与本节点说明', () => {
  const model = buildMindMap({ title: '阅读项目', markdown: outline, conclusion: '这里只整理笔记。' });
  assert.equal(rootOf(model).fullLabel, '阅读项目');
  assert.equal(rootOf(model).children.length, 4);
  assert.equal(model.nodes.length, 13);
  assert.equal(byLabel(model, '入口 1').parentId, byLabel(model, '模块 1').id);
  assert.match(byLabel(model, '模块 1').markdown, /模块说明 1/);
  assert.doesNotMatch(byLabel(model, '模块 1').markdown, /入口说明/);
  assert.deepEqual(byLabel(model, '入口 1').evidence, [{ id: 'evidence-1', status: 'unverified' }]);
  assert.equal(model.relationNote, MIND_MAP_RELATION_NOTE);
  assert.match(model.relationNote, /按笔记层级整理，连线不代表调用关系/);
  assert.equal(model.truncated, false);
});

test('仅相同的文档一级标题并入根，不以笔记中的不同标题覆盖 title', () => {
  const same = buildMindMap({ title: '项目', markdown: '# 项目\n前言。\n## 业务\n正文。' });
  assert.equal(same.nodes.length, 2); assert.equal(rootOf(same).children[0], byLabel(same, '业务').id);
  assert.match(rootOf(same).markdown, /前言/);
  const other = buildMindMap({ title: '项目', markdown: '# 另一份笔记\n## 业务\n正文。' });
  assert.equal(other.nodes.length, 3); assert.equal(rootOf(other).fullLabel, '项目');
  assert.equal(byLabel(other, '业务').parentId, byLabel(other, '另一份笔记').id);
});

test('只提取有内容的列表，保留真实缩进、跳级标题和有序列表层级', () => {
  const markdown = '## 模块\n-\n- [ ]\n- [x] 读取\n  1. 校验\n     - 证据 [一](evidence://evidence-a)\n- 发布\n\n##### 限制\n说明。';
  const model = buildMindMap({ title: '根', markdown });
  assert.equal(byLabel(model, '读取').parentId, byLabel(model, '模块').id);
  assert.equal(byLabel(model, '校验').parentId, byLabel(model, '读取').id);
  assert.equal(byLabel(model, '发布').parentId, byLabel(model, '模块').id);
  assert.equal(byLabel(model, '限制').parentId, byLabel(model, '模块').id);
  assert.ok(model.nodes.every(node => !['', '[ ]', '-'].includes(node.fullLabel)));
  assert.ok(model.truncationReasons.includes('depth'));
  assert.equal(byLabel(model, '证据 一'), undefined);
  assert.equal(model.sources[0].markdown, markdown);
});

test('Setext 标题可用；水平线、缩进源码、围栏和 Mermaid 不制造分支', () => {
  const markdown = '业务\n====\n说明\n\n---\n\n```mermaid\ngraph TD\nA-->B\n# 不是真标题\n- 不是列表\n```\n\n~~~~text\n## 也不是标题\n~~~\n- 仍在围栏\n~~~~\n\n    # 缩进代码\n\n## 真标题\n正文';
  const model = buildMindMap({ title: '根', markdown });
  assert.deepEqual(model.nodes.map(node => node.fullLabel), ['根', '业务', '真标题']);
  assert.equal(byLabel(model, '真标题').parentId, byLabel(model, '业务').id);
  assert.equal(model.sources[0].markdown, markdown);
  assert.match(byLabel(model, '业务').markdown, /A-->B/);
});

test('纯段落旧笔记形成文本节点，不猜模块或调用关系', () => {
  const markdown = '项目负责记录阅读。\n\n调用关系仍待核对。[引用](evidence://missing)';
  const model = buildMindMap({ title: '旧笔记', markdown });
  assert.equal(model.nodes.length, 3); assert.ok(model.nodes.slice(1).every(node => node.kind === 'paragraph' && node.parentId === model.rootId));
  assert.deepEqual(model.nodes[2].evidence, [{ id: 'missing', status: 'unverified' }]);
  assert.equal(model.sources[0].markdown, markdown);
});

test('旧 sections 仅作为无结构正文的后备，完整原文/结论/所有分节不丢失', () => {
  const sections = [{ dimension: 'business', markdown: '说明 [证据](evidence://legacy)\n\n- 职责' }, { dimension: 'deep-read', markdown: '### 方法\n方法细节。' }];
  const model = buildMindMap({ title: '旧记录', markdown: '原来的概述。', conclusion: '原始结论。', sections });
  assert.equal(model.mode, 'sections'); assert.equal(rootOf(model).children.length, 2);
  assert.equal(byLabel(model, '业务解释').parentId, model.rootId);
  assert.equal(byLabel(model, '方法').parentId, byLabel(model, '代码逻辑').id);
  assert.deepEqual(byLabel(model, '业务解释').evidence, [{ id: 'legacy', status: 'unverified' }]);
  assert.equal(model.conclusion, '原始结论。');
  assert.deepEqual(model.sources.map(source => source.markdown), ['原来的概述。', ...sections.map(section => section.markdown)]);
  const preferred = buildMindMap({ title: '新记录', markdown: '## 正文层级\n正文', sections });
  assert.equal(preferred.mode, 'markdown'); assert.equal(preferred.nodes.length, 2); assert.equal(preferred.sources.length, 3);
});

test('引用只保留字面 ID 和待核验状态：未知、编码、重复不伪装有效', () => {
  const evidence = extractMindMapEvidence('[一](evidence://unknown) [重复](evidence://unknown) <evidence://%2F..%2Fmissing>\n`evidence://inline-example`\n```text\nevidence://fenced-example\n```');
  assert.deepEqual(evidence, [{ id: 'unknown', status: 'unverified' }, { id: '%2F..%2Fmissing', status: 'unverified' }]);
  assert.ok(evidence.every(ref => !('valid' in ref) && !('path' in ref) && !('repoId' in ref)));
});

test('引用式 Markdown 的同来源证据定义关联到对应节点，不推断未定义标签', () => {
  const model = buildMindMap({ title: '根', markdown: '## 职责\n- [读取][ SOURCE ]\n- [未知][missing]\n\n[source]: evidence://evidence-original\n' });
  assert.deepEqual(byLabel(model, '[读取][ SOURCE ]').evidence, [{ id: 'evidence-original', status: 'unverified' }]);
  assert.deepEqual(byLabel(model, '[未知][missing]').evidence, []);
});

test('恶意 HTML、脚本与外部媒体均只是标签文本或原文，不解释 HTML', () => {
  const unsafe = '<img src="https://invalid.example/media" onerror="alert(1)">';
  const markdown = `## ${unsafe}\n说明 [恶意](javascript:alert(1))\n- ![外部媒体](https://invalid.example/image.png)\n- <script>window.bad=1</script>`;
  const model = buildMindMap({ title: '<b>根</b>', markdown });
  assert.equal(rootOf(model).fullLabel, '<b>根</b>'); assert.ok(byLabel(model, unsafe));
  assert.ok(byLabel(model, '外部媒体')); assert.ok(byLabel(model, '<script>window.bad=1</script>'));
  assert.equal(model.sources[0].markdown, markdown);
  assert.ok(model.nodes.every(node => node.evidence.length === 0));
});

test('长标签按 Unicode 字符显式缩略，完整标题与原文仍可查', () => {
  const title = '说明😀'.repeat(60); const markdown = `## ${title}\n[末尾证据](evidence://end)`;
  const model = buildMindMap({ title: '根', markdown }); const node = byLabel(model, title);
  assert.ok(node.label.endsWith('…')); assert.ok(node.labelTruncated); assert.ok(Array.from(node.label).length <= MIND_MAP_LIMITS.label);
  assert.equal(node.fullLabel, title); assert.match(node.markdown, /末尾证据/);
  assert.equal(shortenMindMapLabel('😀'.repeat(50), 5), '😀😀😀😀…');
  assert.equal(mindMapPlainText('**职责** 与 `src/a_b.mjs`'), '职责 与 src/a_b.mjs');
});

test('节点和每支预算显式截断，广度优先保留后续模块，不伪造父子关系', () => {
  const markdown = Array.from({ length: 12 }, (_, branch) => `## 分支 ${branch}\n${Array.from({ length: 16 }, (_, child) => `- 节点 ${branch}-${child}`).join('\n')}`).join('\n');
  const model = buildMindMap({ title: '根', markdown });
  assert.equal(model.nodes.length, MIND_MAP_LIMITS.nodes); assert.equal(rootOf(model).children.length, MIND_MAP_LIMITS.children);
  assert.ok(byLabel(model, '分支 9')); assert.equal(byLabel(model, '分支 10'), undefined);
  assert.ok(model.truncated); assert.ok(model.truncationReasons.includes('children')); assert.ok(model.truncationReasons.includes('nodes'));
  assert.equal(model.omittedNodes, 1 + 12 + 12 * 16 - model.nodes.length);
  assert.ok(model.nodes.every(node => node.depth <= MIND_MAP_LIMITS.depth));
  assert.equal(model.sources[0].markdown, markdown);
});

test('极深列表不会无界递归，未显示的深层证据仍在完整原文', () => {
  const markdown = '## 层级\n' + Array.from({ length: 220 }, (_, i) => `${' '.repeat(i * 2)}- 层 ${i}${i === 219 ? ' [尾](evidence://deep)' : ''}`).join('\n');
  const model = buildMindMap({ title: '根', markdown });
  assert.ok(model.nodes.length <= 4); assert.ok(model.truncationReasons.includes('depth'));
  assert.match(model.sources[0].markdown, /evidence:\/\/deep/); assertLayout(layoutMindMap(model));
});

test('扫描字符/行数预算明确告知，不对末尾内容做完整性承诺', () => {
  const huge = `## 第一支\n${'说明。'.repeat(MIND_MAP_LIMITS.scanChars)}\n## 末尾\n[证据](evidence://tail)`;
  const chars = buildMindMap({ title: '根', markdown: huge });
  assert.ok(chars.truncationReasons.includes('scan-chars')); assert.equal(chars.sources[0].markdown, huge); assert.equal(byLabel(chars, '末尾'), undefined);
  const manyLines = `${'\n'.repeat(MIND_MAP_LIMITS.scanLines + 10)}## 最后标题`;
  const lines = buildMindMap({ title: '根', markdown: manyLines });
  assert.ok(lines.truncationReasons.includes('scan-lines')); assert.equal(lines.sources[0].markdown, manyLines);
});

test('大量分节保留全部源文，但仅有界整理；空值与未知维度不猜含义', () => {
  const sections = Array.from({ length: 18 }, (_, i) => ({ dimension: `自定义 ${i}`, markdown: `说明 ${i}` }));
  const model = buildMindMap({ title: '根', sections });
  assert.ok(model.truncationReasons.includes('sections')); assert.equal(model.sources.length, sections.length);
  assert.ok(byLabel(model, '自定义 0')); assert.ok(rootOf(model).children.length <= MIND_MAP_LIMITS.children);
  for (const input of [undefined, {}, { markdown: null, conclusion: false, sections: [null, { markdown: 3 }] }]) assert.equal(buildMindMap(input).nodes.length, 1);
});

test('默认展示有限概览，小型四分支双子节点完整可见', () => {
  const model = buildMindMap({ title: '根', markdown: outline });
  assert.deepEqual(defaultMindMapCollapsed(model), []); assert.equal(layoutMindMap(model, defaultMindMapCollapsed(model)).nodes.length, 13);
  const large = buildMindMap({ title: '根', markdown: Array.from({ length: 6 }, (_, i) => `## 模块${i}\n${Array.from({ length: 7 }, (_, j) => `- 子项${j}`).join('\n')}`).join('\n') });
  const layout = layoutMindMap(large, defaultMindMapCollapsed(large)); assert.equal(layout.nodes.length, 7);
});

test('左右分支布局有真实 SVG 连线、无重叠且父子边仅来自笔记', () => {
  const model = buildMindMap({ title: '根', markdown: outline }); const layout = layoutMindMap(model);
  assertLayout(layout); assert.ok(layout.nodes.some(node => node.side === -1)); assert.ok(layout.nodes.some(node => node.side === 1));
  for (const edge of layout.edges) assert.equal(model.nodes.find(node => node.id === edge.to).parentId, edge.from);
  assert.deepEqual(layoutMindMap(model), layout);
});

test('折叠隐藏真实后代、保留分支本身；再次展开精确恢复', () => {
  const model = buildMindMap({ title: '根', markdown: outline }); const branch = byLabel(model, '模块 1');
  const collapsed = layoutMindMap(model, [branch.id]); assert.equal(collapsed.nodes.length, 11);
  assert.ok(collapsed.nodes.some(node => node.id === branch.id)); assert.ok(branch.children.every(id => !collapsed.nodes.some(node => node.id === id)));
  assert.equal(layoutMindMap(model).nodes.length, 13); assertLayout(collapsed);
  assert.equal(layoutMindMap(model, [model.rootId]).nodes.length, 1);
});

test('方向键按可见节点移动，左右对应父子方向，Home/End 可用', () => {
  const model = buildMindMap({ title: '根', markdown: outline }); const layout = layoutMindMap(model);
  const first = byLabel(model, '模块 1'); const second = byLabel(model, '模块 2'); const child = byLabel(model, '入口 1');
  assert.equal(mindMapFocusTarget(layout, model.rootId, 'ArrowRight'), first.id);
  assert.equal(mindMapFocusTarget(layout, model.rootId, 'ArrowLeft'), second.id);
  assert.equal(mindMapFocusTarget(layout, first.id, 'ArrowRight'), child.id);
  assert.equal(mindMapFocusTarget(layout, child.id, 'ArrowLeft'), first.id);
  assert.equal(mindMapFocusTarget(layout, child.id, 'Home'), model.rootId);
  assert.equal(mindMapFocusTarget(layout, model.rootId, 'End'), layout.nodes.at(-1).id);
  assert.equal(mindMapFocusTarget(layout, model.rootId, 'ArrowDown'), first.id);
  assert.equal(mindMapFocusTarget(layout, 'missing', 'ArrowDown'), null);
  assert.equal(mindMapFocusTarget(layout, first.id, 'Enter'), null);
});

test('375px/窄画布采用可读纵向布局，原节点与引用不换 DOM 契约', () => {
  const model = buildMindMap({ title: '根', markdown: outline });
  for (const width of [280, 320, 375, 599]) {
    const layout = layoutMindMap(model, [], { width }); assertLayout(layout);
    assert.equal(layout.compact, true); assert.equal(layout.nodes.length, 13);
    assert.ok(layout.width <= width - 24); assert.ok(layout.height > 340);
    assert.ok(layout.nodes.every(node => node.width >= 140));
    assert.equal(Math.min(1, (width - 24) / layout.width), 1, 'fit keeps native font size');
    assert.deepEqual(layout.nodes.map(node => node.id), layoutMindMap(model).nodes.map(node => node.id));
    assert.equal(mindMapFocusTarget(layout, byLabel(model, '模块 2').id, 'ArrowLeft'), model.rootId);
  }
  assert.equal(!!layoutMindMap(model, [], { width: 920 }).compact, false);
});

test('快照/过滤产生新 sections 数组时内容签名相同，真实内容更新才改变', () => {
  const sections = [{ dimension: 'business', markdown: '业务说明' }, { dimension: 'deep-read', markdown: '- 节点' }];
  assert.equal(mindMapSectionSignature(sections), mindMapSectionSignature(structuredClone(sections).filter(Boolean)));
  assert.equal(mindMapSectionSignature(sections), mindMapSectionSignature(sections.map(section => ({ ignored: true, markdown: section.markdown, dimension: section.dimension }))));
  assert.notEqual(mindMapSectionSignature(sections), mindMapSectionSignature([{ ...sections[0], markdown: '真实更新' }, sections[1]]));
  assert.equal(mindMapSectionSignature(undefined), mindMapSectionSignature([]));
});

test('组件安全/懒加载与原生命名空间契约：无 HTML 注入、无新增运行时依赖', async () => {
  const jsx = await readFile(new URL('../src/client/mind-map.jsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/client/mind-map.css', import.meta.url), 'utf8');
  assert.doesNotMatch(jsx, /dangerouslySetInnerHTML|innerHTML|foreignObject|DOMParser|localStorage|fetch\(/);
  assert.match(jsx, /export function MindMap\(\{ title, markdown, conclusion, sections, Markdown, openEvidence \}\)/);
  assert.match(jsx, /\[title, markdown, conclusion, sectionSignature\]/);
  assert.match(jsx, /summary="完整阅读笔记"/); assert.match(jsx, /open && <div/);
  assert.match(jsx, /identity=\{model\}/); assert.match(jsx, /<svg[^>]*aria-hidden="true"/);
  assert.match(jsx, /<button[^>]*className="cr-mind-map-node"/);
  assert.match(css, /prefers-reduced-motion:reduce/); assert.match(css, /:focus-visible/);
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)) {
    const selector = match[1].trim(); if (selector.startsWith('@media')) continue;
    assert.ok(selector.split(',').every(part => part.trim().startsWith('.cr-mind-map') || /summary|\[tabindex\]/.test(part)), selector);
  }
});
