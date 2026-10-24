import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const id = (kind, number) => `${kind}-${String(number).padStart(8, '0')}-4444-4444-8444-444444444444`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const now = '2026-01-04T00:00:00Z';
const model = { provider: 'fixture', model: 'reader' };
const cleanChanges = () => ({ checkedAt: now, fingerprint: 'a'.repeat(64), added: [], modified: [], deleted: [], uncertain: [], changed: false, truncated: false });
const branches = ['请求入口与访问控制', '核心业务与跨模块协作', '证据归档与只读边界', '任务调度与兼容回退'];
const longNode = '跨仓库阅读会话的项目绑定、请求准入、增量更新与迟到响应隔离：这个足够长的模块名称必须可完整定位和阅读，不应撑破窄屏画布';
const children = [['请求接入与参数校验', '权限核对与路由分发'], ['业务编排与领域规则', longNode], ['源码证据与版本核验', '阅读档案与批注存储'], ['任务取消与失败恢复', '历史兼容与安全展示']];
const nodeDescription = 'MAP_NODE_DETAIL：入口先校验项目、会话与仓库归属，再把只读业务请求交给领域模块。';
const rawMarker = 'MAP_CONTENT_ONLY：入口处理业务请求，再交给领域模块。';
const mapMarkdown = [
  rawMarker,
  ...branches.map((branch, index) => `## ${branch}\n\n该分支来自已读取源码；未核实调用关系不会推断为事实。\n\n${children[index].map((child, number) => `### ${child}\n\n${index === 0 && number === 0 ? `${nodeDescription}\n\n[地图证据](evidence://map-proof)` : `模块说明 ${index + 1}.${number + 1}：保留独立职责、异常边界与可追溯阅读入口。`}${index === 3 && number === 1 ? '\n\n![外部内容](https://attacker.invalid/map)\n\n<img src="https://attacker.invalid/inline" onerror="window.mapUnsafe=true">\n<script>window.mapUnsafe=true</script>\n<iframe src="https://attacker.invalid/frame"></iframe>\n\n[危险链接](javascript:window.mapUnsafe=true)' : ''}`).join('\n\n')}`),
].join('\n\n');
const darkPalette = { '--dsw-alias-bg-base': '#18181b', '--dsw-alias-bg-layer-1': '#27272a', '--dsw-alias-bg-layer-2': '#303036', '--dsw-alias-border-l1': '#52525b', '--dsw-alias-label-primary': '#fafafa', '--dsw-alias-label-secondary': '#d4d4d8', '--dsw-alias-brand-primary': '#829af5' };

// Deliberately separate from the legacy fixture: absent code-map-v1 must keep
// old projects and existing browser tests usable without the new onboarding.
export async function verifyCodeMap({ browser, output, plugin, bootstrap, status }) {
  const page = await browser.newPage({ viewport: { width: 1380, height: 1000 }, locale: 'zh-CN' });
  page.setDefaultTimeout(10000);
  const requests = []; const errors = []; const external = [];
  const projects = []; const sessions = new Map(); const maps = new Map();
  let serial = 0; let generateMode = 'running'; let generateHold = null; let readHold = null; let catalogHold = null; let capabilities = true;
  let hidden = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:19389/')) external.push(request.url()); });
  const ownerForSession = sessionId => projects.find(project => project.id === sessions.get(sessionId)?.projectId);
  const listed = project => ({ ...project, sessions: [...sessions].filter(([, session]) => session.projectId === project.id && !session.draft).map(([sessionId, session]) => ({ id: sessionId, topic: session.topic, stage: 'discover', revision: 1, createdAt: now })) });
  const emptyMap = projectId => ({ projectId, revision: 0, latest: null, task: null, changes: null });
  const newProject = (title, onboarding = true) => { const n = ++serial; const project = { id: id('project', n), title, repositories: [{ id: id('repo', n), name: title, root: `D:\\fixtures\\${title}` }], bindingRevision: 1, ...(onboarding ? { codeMapOnboarding: true } : {}) }; projects.push(project); maps.set(project.id, emptyMap(project.id)); return project; };
  const newSession = (project, draft = false, title = project.title) => { const sessionId = id('reading', ++serial); sessions.set(sessionId, { projectId: project.id, draft, topic: title, lessons: [] }); return sessionId; };
  const original = newProject('旧项目', false); newSession(original);
  const completedMap = (project, title = '系统业务与模块全貌') => {
    const value = maps.get(project.id); const sessionId = value.task.sessionId; const lessonId = id('lesson', ++serial);
    const latest = { sessionId, lessonId, generatedAt: now, model: { ...model }, title, markdown: mapMarkdown, conclusion: '模块协作来自已读取源码，请结合证据核对。', truncated: true };
    Object.assign(value, { revision: value.revision + 1, latest, task: { ...value.task, status: 'completed' }, changes: cleanChanges() });
    sessions.get(sessionId).lessons = [{ ...latest, id: lessonId, stage: 'discover', createdAt: now, claims: [], nextQuestions: [] }]; return latest;
  };
  const response = (method, projectId) => page.waitForResponse(result => result.url().endsWith('/api/code-reading') && result.request().postDataJSON()?.method === method && (!projectId || result.request().postDataJSON()?.params.projectId === projectId));
  const modelCalls = () => requests.filter(row => ['prompt', 'code-map-generate'].includes(row.method));
  const globalWrites = () => requests.filter(row => ['select-model', 'set-default-model'].includes(row.method));
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const mapView = page.getByRole('region', { name: 'AI 代码地图', exact: true });
  const firstDialog = page.getByRole('dialog', { name: '选择模型并生成代码地图', exact: true });
  const updateDialog = page.getByRole('dialog', { name: '确认增量更新代码地图', exact: true });
  const header = page.locator('.cr-header');
  const maintenance = mapView.locator('.cr-map-maintenance');
  const tree = scope => scope.getByRole('region', { name: '笔记思维导图', exact: true });
  const node = (scope, label) => tree(scope).getByRole('button', { name: `查看节点：${label}`, exact: true });
  const notes = scope => scope.locator('summary').filter({ hasText: '完整阅读笔记' }).locator('..');
  const previews = []; const layouts = [];
  const choose = async dialog => { await dialog.getByRole('combobox', { name: '代码地图模型', exact: true }).click(); await page.getByRole('listbox', { name: '代码地图模型', exact: true }).getByRole('option', { name: '模拟提供方 · Fixture Reader', exact: true }).click(); };
  const switchProject = async project => { const trigger = page.getByRole('combobox', { name: '阅读项目切换', exact: true }); await trigger.click(); await page.getByRole('listbox', { name: '阅读项目切换', exact: true }).getByRole('option', { name: project.title, exact: true }).click(); await trigger.getByText(project.title, { exact: true }).waitFor(); await frames(); };
  const menu = async name => { await page.getByRole('button', { name: '阅读菜单', exact: true }).click(); await page.locator('#cr-project-actions').getByRole('button', { name, exact: true }).click(); };
  const openMap = async () => { const tab = page.locator('.cr-document-tab-button[data-document-kind="map"]'); if (await tab.count()) await tab.click(); else await menu('项目地图'); const toggle = page.getByRole('button', { name: '思维导图', exact: true }); if (await toggle.isVisible()) await toggle.click(); await mapView.waitFor(); };
  const focus = async () => { await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
  const setDetails = async (details, open) => { if (await details.evaluate(element => element.open) !== open) await details.locator(':scope > summary').click(); await frames(); };
  const manage = async name => { await setDetails(maintenance, true); await maintenance.getByRole('button', { name, exact: true }).click(); };
  const refreshMap = async project => { const result = response('code-map', project.id); await manage('核对地图任务状态'); await result; await frames(); await setDetails(maintenance, false); };
  const assertSafe = async scope => { assert.equal(await scope.locator('script,iframe,object,embed,img[src],video[src],audio[src],[onerror],a[href^="javascript:"]').count(), 0, 'model text never becomes executable HTML or external media'); assert.equal(await page.evaluate(() => window.mapUnsafe === true), false); assert.deepEqual(external, []); };
  const assertFocus = async value => { await page.waitForFunction(expected => document.querySelector('.cr-page')?.dataset.readingFocus === String(expected), value); assert.equal(await header.getByRole('button', { name: value ? '退出专注' : '专注阅读', exact: true }).getAttribute('aria-pressed'), String(value)); if (value) { assert.equal(await page.getByRole('complementary', { name: '文件目录', exact: true }).isVisible(), false); assert.equal(await page.getByRole('complementary', { name: '阅读列表', exact: true }).isVisible(), false); } };
  const shot = async name => { await page.screenshot({ path: path.join(output, name), fullPage: true, animations: 'disabled' }); previews.push(name); };
  const assertBounds = async (scope, label) => { const result = await tree(scope).locator('.cr-mind-map-viewport').evaluate(element => { const rect = element.getBoundingClientRect(); const main = element.closest('main').getBoundingClientRect(); const body = element.closest('.cr-body').getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, mainWidth: main.width, bodyWidth: body.width, viewport: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth }; }); assert.ok(result.width > 0 && result.left >= -1 && result.right <= result.viewport + 1 && result.overflow <= 1, `${label}: ${JSON.stringify(result)}`); if (result.viewport > 1100) assert.ok(result.mainWidth / result.bodyWidth >= .95 && result.width / result.mainWidth >= .8, `${label}: focused graph should reclaim the document area`); layouts.push({ label, ...result }); };
  const mount = async () => page.evaluate(() => { if (window.readingRoot) window.readingRoot.unmount(); const root = document.getElementById('root'); window.readingRoot = window.createRoot(root); const slot = window.slots['main:code-reading']; window.readingRoot.render(window.React.createElement(slot.component, { ...slot.options.inject() })); });
  async function verifyDiagram(scope, title) {
    await tree(scope).waitFor();
    for (const label of [title, ...branches, ...children.flat()]) await node(scope, label).waitFor();
    assert.equal(await tree(scope).locator('.cr-mind-map-node:visible').count(), 13, 'fixture renders a root, four branches, and two children per branch');
    assert.equal(await notes(scope).evaluate(element => element.open), false, 'full reading notes are collapsed by default');
    assert.equal(await notes(scope).locator('.cr-markdown').count(), 0, 'the original Markdown is mounted only on demand');
    assert.equal(await scope.getByText(rawMarker, { exact: true }).isVisible(), false);
    assert.equal(await tree(scope).getByRole('region', { name: '节点说明', exact: true }).isVisible(), false, 'node detail starts closed');

    const firstNode = node(scope, children[0][0]); await firstNode.focus(); await page.keyboard.press('Enter');
    const detail = tree(scope).getByRole('region', { name: '节点说明', exact: true }); await detail.waitFor(); await detail.getByText(nodeDescription, { exact: false }).waitFor();
    assert.equal(await firstNode.getAttribute('aria-pressed'), 'true');
    await detail.getByRole('button', { name: '核验引用：map-proof', exact: true }).waitFor();
    await assertSafe(detail); await shot('code-map-node-detail-light.png');
    await firstNode.focus(); await page.keyboard.press('Escape'); await detail.waitFor({ state: 'hidden' });

    const collapse = tree(scope).getByRole('button', { name: `折叠分支：${branches[0]}`, exact: true });
    await collapse.focus(); await page.keyboard.press('Space');
    assert.equal(await node(scope, children[0][0]).isVisible(), false);
    const expand = tree(scope).getByRole('button', { name: `展开分支：${branches[0]}`, exact: true }); assert.equal(await expand.getAttribute('aria-expanded'), 'false');
    await expand.focus(); await page.keyboard.press('Enter'); await firstNode.waitFor();
    await tree(scope).getByRole('button', { name: '收起分支', exact: true }).click();
    assert.equal(await tree(scope).locator('.cr-mind-map-node:visible').count(), 5, 'collapse leaves the root and first-level modules');
    await tree(scope).getByRole('button', { name: '展开分支', exact: true }).click();
    assert.equal(await tree(scope).locator('.cr-mind-map-node:visible').count(), 13);

    const rootNode = node(scope, title); await firstNode.focus(); await page.keyboard.press('Home');
    assert.equal(await rootNode.evaluate(element => element === document.activeElement), true, 'Home returns keyboard focus to the root');
    await page.keyboard.press('ArrowDown'); assert.equal(await rootNode.evaluate(element => element === document.activeElement), false);
    assert.equal(await tree(scope).evaluate(element => element.contains(document.activeElement) && document.activeElement.matches('.cr-mind-map-node')), true, 'arrow navigation stays on visible nodes');
    await page.keyboard.press('ArrowUp'); assert.equal(await rootNode.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('ArrowRight'); assert.equal(await node(scope, branches[0]).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('ArrowRight'); assert.equal(await firstNode.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('ArrowLeft'); assert.equal(await node(scope, branches[0]).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Home'); await page.keyboard.press('ArrowLeft'); assert.equal(await node(scope, branches[1]).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('ArrowRight'); assert.equal(await rootNode.evaluate(element => element === document.activeElement), true);
    assert.equal(await rootNode.evaluate(element => getComputedStyle(element).outlineStyle !== 'none'), true, 'keyboard focus remains visible');
    await page.keyboard.press('Enter'); await detail.waitFor(); await page.keyboard.press('Escape'); await detail.waitFor({ state: 'hidden' });
    const width = async () => (await rootNode.boundingBox()).width;
    const fitted = await width(); await tree(scope).getByRole('button', { name: '放大导图', exact: true }).click(); await frames(); const enlarged = await width(); assert.ok(enlarged > fitted + 1, 'zoom in changes the graph, not the surrounding page');
    await tree(scope).getByRole('button', { name: '缩小导图', exact: true }).click(); await frames(); assert.ok(await width() < enlarged - 1);
    await tree(scope).getByRole('button', { name: '放大导图', exact: true }).click(); await tree(scope).getByRole('button', { name: '适应视图', exact: true }).click(); await frames(); assert.ok(Math.abs(await width() - fitted) < 2, 'fit restores the complete graph at this viewport');

    await node(scope, longNode).click(); await detail.getByRole('heading', { name: longNode, exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await node(scope, children[3][1]).click(); await assertSafe(detail); await page.keyboard.press('Escape');
    await setDetails(notes(scope), true); await notes(scope).getByText(rawMarker, { exact: true }).waitFor(); await assertSafe(notes(scope));
    await setDetails(notes(scope), false); assert.equal(await notes(scope).getByText(rawMarker, { exact: true }).isVisible(), false);
  }
  await page.route('**/*', async route => {
    if (route.request().url() === 'http://127.0.0.1:19389/code-map-component') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0;font-family:system-ui}</style><div id="root"></div>' });
    if (!route.request().url().endsWith('/api/code-reading')) return route.abort();
    const body = route.request().postDataJSON(); requests.push(body); const p = body.params; let value;
    switch (body.method) {
      case 'status': value = { ...status, capabilities: ['remove-project', 'default-model', 'structure-map-v1', ...(capabilities ? ['code-map-v1'] : [])] }; break;
      case 'list': value = { projects: projects.map(listed), root: status.dataDirectory, diagnostics: [] }; break;
      case 'models': {
        if (catalogHold) { const hold = catalogHold; catalogHold = null; hold.seen.resolve(); await hold.release.promise; }
        value = { default: model, groups: [{ id: 'fixture', name: '模拟提供方', models: [{ id: 'reader', name: 'Fixture Reader' }] }], failures: [] }; break;
      }
      case 'create-project': value = newProject(path.win32.basename(p.repositories[0].path)); break;
      case 'create-session': { const owner = projects.find(row => row.id === p.projectId); assert.ok(owner); value = { sessionId: newSession(owner, p.draft === true), draft: p.draft === true }; break; }
      case 'discard-draft': { if (sessions.get(p.sessionId)?.draft) sessions.delete(p.sessionId); value = { discarded: true, sessionId: p.sessionId }; break; }
      case 'snapshot': {
        const session = sessions.get(p.sessionId); assert.ok(session, `known session ${p.sessionId}`); const project = ownerForSession(p.sessionId);
        value = { sessionId: p.sessionId, project: listed(project), topic: session.topic, ...(session.codeMapTask ? { codeMapTask: session.codeMapTask } : {}), stage: 'discover', revision: 1, modelSelection: null, draft: session.draft, archivedAt: null, archiveRevision: 0, running: false, messages: [], turnEnd: null, state: { lessons: session.lessons, evidence: [], readerState: { version: 1, revision: 0, activeDocument: null, selectedLessonId: session.selectedLessonId ?? null, viewedLessonIds: [], understoodLessonIds: [], readerPosition: null, lessonScrollTop: 0 } } }; break;
      }
      case 'reader-state': assert.notEqual(p.patch.activeDocument, 'map'); value = { ...p.patch, revision: p.expectedRevision + 1 }; break;
      case 'tree': value = { repoId: p.repoId, directory: '', entries: [], nextOffset: null, truncated: false }; break;
      case 'annotations': value = { revision: 0, items: [] }; break;
      case 'structure-map': { const project = ownerForSession(p.sessionId); value = { version: 1, projectId: project.id, repoId: p.repoId, bindingRevision: 1, revision: 0, indexedAt: null, inventoryHash: null, files: [], layers: [{ id: 'core', name: '业务模块', description: '路径规则建议', origin: 'heuristic', fileCount: 0, readingFileCount: 0 }], customLayers: [], assignments: [], visited: 0, truncated: false, readingTruncated: false, truncationReasons: [] }; break; }
      case 'code-map':
      case 'code-map-check': {
        assert.deepEqual(Object.keys(p), ['projectId']); const map = maps.get(p.projectId); assert.ok(map);
        if (body.method === 'code-map-check' && !map.changes) map.changes = cleanChanges();
        value = structuredClone(map);
        if (readHold && readHold.projectId === p.projectId && readHold.method === body.method) { const hold = readHold; readHold = null; hold.seen.resolve(); await hold.release.promise; value = hold.value ?? value; }
        break;
      }
      case 'code-map-generate': {
        const map = maps.get(p.projectId); assert.ok(map); assert.equal(p.consent, true); assert.deepEqual(p.model, model); assert.equal(p.expectedRevision, map.revision); assert.match(p.requestId, /^[0-9a-f-]{36}$/); assert.deepEqual(Object.keys(p).sort(), ['consent', 'expectedRevision', 'model', 'projectId', 'requestId']);
        const owner = projects.find(row => row.id === p.projectId); const sessionId = newSession(owner, false, '系统模块阅读记录');
        map.task = { requestId: p.requestId, sessionId, status: 'running', mode: map.latest ? 'incremental' : 'initial', startedAt: now, model: { ...model } }; map.revision++;
        value = structuredClone(map);
        if (generateHold) { const hold = generateHold; generateHold = null; hold.seen.resolve(); await hold.release.promise; }
        if (generateMode === 'network') return route.abort('failed');
        break;
      }
      case 'code-map-cancel': { const map = maps.get(p.projectId); assert.equal(p.requestId, map.task.requestId); map.task.status = 'cancelled'; map.revision++; value = structuredClone(map); break; }
      case 'evidence': assert.equal(p.evidenceId, 'map-proof'); value = { evidence: { repoId: ownerForSession(p.sessionId).repositories[0].id, path: 'entry.ts', startLine: 1, endLine: 1, hash: 'a'.repeat(64) }, stale: false, lines: [{ number: 1, text: 'export const mapFixture = true;' }] }; break;
      case 'view-file': value = { repoId: p.repoId, path: p.path, hash: 'a'.repeat(64), bytes: 31, totalLines: 1, offset: 1, lines: [{ number: 1, text: 'export const mapFixture = true;' }] }; break;
      case 'file-readings': value = { items: [], staleCount: 0, legacyCount: 0, truncated: false }; break;
      default: assert.fail(`unexpected code-map fixture method ${body.method}`);
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value }) });
  });
  try {
    await page.goto('http://127.0.0.1:19389/code-map-component'); await page.addScriptTag({ content: bootstrap }); await page.addScriptTag({ content: plugin });
    await page.evaluate(() => {
      window.slots = {}; window.disposers = [];
      window.plugin.apply({ effect: fn => { const dispose = fn(); if (dispose) window.disposers.push(dispose); }, uiWorkspace: { pickDirectory: async () => null }, slots: { inject: (_name, fn) => fn(), register: (options, component) => { window.slots[`${options.name}:${options.id ?? options.key}`] = { options, component }; return () => {}; } } });
      // Keep real HTTP interception but ignore AbortSignal to test late deliveries.
      window.__DSH_TRANSPORT__ = { fetch: (url, options) => fetch(url, { ...options, signal: undefined }) };
      window.__mapIntervals = []; const interval = window.setInterval.bind(window);
      window.setInterval = (fn, delay, ...args) => { if (delay === 30000) window.__mapIntervals.push(fn); return interval(fn, delay, ...args); };
    });
    await mount(); await page.locator('.cr-welcome').waitFor();
    await switchProject(original); await frames(); assert.equal(await firstDialog.count(), 0, 'legacy project does not get surprise onboarding');
    await menu('打开其他仓库'); await page.getByLabel('仓库 1 目录', { exact: true }).fill('D:\\fixtures\\新地图项目'); await page.getByRole('button', { name: '打开仓库', exact: true }).click();
    await firstDialog.waitFor(); const project = projects.at(-1); const initialMap = maps.get(project.id);
    assert.equal(modelCalls().length, 0, 'creation, catalog and local checks do not call a model'); assert.equal(await firstDialog.getByRole('button', { name: '确认并生成地图', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('.cr-document-tab-button[data-document-kind="map"]').getAttribute('aria-pressed'), 'true', 'new project defaults to the map document');
    assert.equal(await page.getByLabel('阅读目标', { exact: true }).isVisible(), false);
    await firstDialog.getByRole('button', { name: '暂不生成', exact: true }).click(); await focus(); await frames(); assert.equal(await firstDialog.count(), 0); assert.equal(modelCalls().length, 0);
    await switchProject(original); await switchProject(project); await openMap(); assert.equal(await firstDialog.count(), 0, 'not-now suppresses onboarding for this page, across project switches');
    await mapView.getByRole('button', { name: '生成 AI 代码地图', exact: true }).click(); await choose(firstDialog); assert.equal(modelCalls().length, 0, 'choosing a model is not consent'); assert.equal(globalWrites().length, 0);
    await shot('code-map-consent-light.png');
    await firstDialog.getByRole('button', { name: '暂不生成', exact: true }).click(); assert.equal(modelCalls().length, 0, 'selected model plus cancellation is still zero calls');
    await mapView.getByRole('button', { name: '生成 AI 代码地图', exact: true }).click(); await choose(firstDialog);
    const held = { seen: deferred(), release: deferred() }; generateHold = held;
    await firstDialog.getByRole('button', { name: '确认并生成地图', exact: true }).click(); await held.seen.promise; assert.equal(modelCalls().length, 1, 'one confirm starts without any question or select-model write');
    await mapView.getByRole('button', { name: '停止地图任务', exact: true }).click(); await mapView.locator('[role="status"]').filter({ hasText: '已停止' }).waitFor(); const cancelledRequest = initialMap.task.requestId;
    const delivered = response('code-map-generate', project.id); held.release.resolve(); await delivered; await frames(); assert.equal(await mapView.getAttribute('data-map-task-status'), 'cancelled', 'late admission response cannot undo cancellation'); assert.equal(modelCalls().length, 1);
    await mapView.getByRole('button', { name: '重试代码地图', exact: true }).click(); await choose(firstDialog); await firstDialog.getByRole('button', { name: '确认并生成地图', exact: true }).click(); await mapView.locator('.cr-map-task-state').filter({ hasText: /^正在生成$/ }).waitFor(); assert.notEqual(initialMap.task.requestId, cancelledRequest);
    const latest = completedMap(project); await refreshMap(project); await tree(mapView).waitFor();
    assert.equal(await page.locator('.cr-document-tab-button[data-document-kind="map"]').getAttribute('aria-pressed'), 'true', 'completion does not steal navigation into generated session');
    await assertFocus(true); await assertSafe(mapView);
    assert.equal(await page.locator('.cr-editor-statusbar').getByRole('combobox').count(), 0, 'map task model selection is confined to its consent dialog, not the session footer');
    assert.equal(await maintenance.evaluate(element => element.open), false, 'secondary task controls start collapsed');
    for (const name of ['核对地图任务状态', '检测本地变化', '打开地图对应阅读']) assert.equal(await mapView.getByRole('button', { name, exact: true }).isVisible(), false);
    assert.equal(await mapView.locator('.cr-map-primary-actions button:visible').count(), 1, 'only the primary map update action occupies the heading');
    await mapView.getByText('部分扫描', { exact: true }).waitFor();
    await setDetails(maintenance, true); await maintenance.getByText(/此地图基于部分扫描/).waitFor(); await setDetails(maintenance, false);
    await verifyDiagram(mapView, latest.title); await assertBounds(mapView, 'light desktop overview');
    await page.locator('.cr-structure-map').evaluate(element => { element.scrollTop = 0; }); await shot('code-map-overview-light.png');

    const beforeUi = modelCalls().length;
    await header.getByRole('button', { name: '退出专注', exact: true }).click(); await assertFocus(false);
    await page.getByRole('complementary', { name: '文件目录', exact: true }).waitFor(); await page.getByRole('complementary', { name: '阅读列表', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '收起文件目录', exact: true }).getAttribute('aria-expanded'), 'true');
    assert.equal(await page.getByRole('button', { name: '收起列表', exact: true }).getAttribute('aria-expanded'), 'true');
    await shot('code-map-restored-sidebars.png');
    await header.getByRole('button', { name: '专注阅读', exact: true }).click(); await assertFocus(true);
    await header.getByRole('button', { name: '文件目录', exact: true }).click(); await assertFocus(false); await page.getByRole('complementary', { name: '文件目录', exact: true }).waitFor();
    await header.getByRole('button', { name: '专注阅读', exact: true }).click(); await assertFocus(true);
    await header.getByRole('button', { name: '阅读列表', exact: true }).click(); await assertFocus(false); await page.getByRole('complementary', { name: '阅读列表', exact: true }).waitFor();
    await header.getByRole('button', { name: '专注阅读', exact: true }).click(); await assertFocus(true);
    assert.equal(modelCalls().length, beforeUi, 'all graph and focus interactions remain local');
    assert.equal(await page.locator('[data-map-layer="core"]').isVisible(), false, 'path cards do not compete with the default mind map');
    await page.getByRole('button', { name: '路径导航', exact: true }).click(); await page.locator('[data-map-layer="core"]').waitFor();
    assert.equal(await mapView.isVisible(), false, 'path navigation hides the AI overview');
    await page.locator('[data-map-layer="core"]').click(); assert.equal(await mapView.isVisible(), false, 'path drill-down does not repeat the long AI overview');
    await page.getByRole('navigation', { name: '项目地图路径', exact: true }).getByRole('button', { name: '总览', exact: true }).click();
    await page.getByRole('button', { name: '思维导图', exact: true }).click(); await mapView.waitFor();
    assert.equal(modelCalls().length, beforeUi, 'path navigation does not invoke the model');
    const beforeChanges = modelCalls().length;
    initialMap.changes = { ...cleanChanges(), changed: true, added: [{ repoId: project.repositories[0].id, path: 'new.ts' }], modified: [{ repoId: project.repositories[0].id, path: 'entry.ts' }], deleted: [{ repoId: project.repositories[0].id, path: 'old.ts' }] };
    const focusCheck = response('code-map-check', project.id); await focus(); await focusCheck; await mapView.getByText(/发现本地变化/).waitFor(); assert.equal(modelCalls().length, beforeChanges, 'focus detection cannot update a map');
    assert.equal(await maintenance.evaluate(element => element.open), false); assert.equal(await mapView.getByText('new.ts', { exact: true }).isVisible(), false, 'the change summary stays visible while paths stay folded');
    const manualCheck = response('code-map-check', project.id); await manage('检测本地变化'); await manualCheck; await frames();
    const changedPaths = maintenance.locator('details'); assert.equal(await changedPaths.evaluate(element => element.open), false); await setDetails(changedPaths, true);
    for (const relative of ['new.ts', 'entry.ts', 'old.ts']) await changedPaths.getByText(relative, { exact: true }).waitFor();
    await setDetails(changedPaths, false); await setDetails(maintenance, false); assert.equal(modelCalls().length, beforeChanges, 'manual local checks and path disclosure do not invoke a model');
    const timedCheck = response('code-map-check', project.id); await page.evaluate(() => window.__mapIntervals.at(-1)()); await timedCheck; assert.equal(modelCalls().length, beforeChanges, '30-second callback only checks local files');
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); }); hidden = true;
    const checksBeforeHidden = requests.filter(row => row.method === 'code-map-check').length; await focus(); await page.evaluate(() => window.__mapIntervals.at(-1)()); await frames(); assert.equal(requests.filter(row => row.method === 'code-map-check').length, checksBeforeHidden, 'hidden pages do not scan');
    const visibleCheck = response('code-map-check', project.id); await page.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); }); hidden = false; await visibleCheck;
    await mapView.getByRole('button', { name: '选择模型更新地图', exact: true }).click(); await updateDialog.waitFor(); assert.equal(modelCalls().length, beforeChanges);
    await choose(updateDialog); await updateDialog.getByRole('button', { name: '暂不更新', exact: true }).click(); assert.equal(modelCalls().length, beforeChanges);
    await mapView.getByRole('button', { name: '选择模型更新地图', exact: true }).click(); await choose(updateDialog); await updateDialog.getByRole('button', { name: '允许并更新地图', exact: true }).click(); await mapView.locator('.cr-map-task-state').filter({ hasText: /^正在生成$/ }).waitFor(); assert.equal(initialMap.task.mode, 'incremental'); assert.equal(initialMap.latest.lessonId, latest.lessonId);
    initialMap.task = { ...initialMap.task, status: 'failed', error: '模拟地图更新失败' }; initialMap.revision++; await refreshMap(project); await mapView.getByRole('alert').filter({ hasText: '模拟地图更新失败' }).waitFor(); await node(mapView, latest.title).waitFor(); assert.equal(initialMap.latest.lessonId, latest.lessonId);
    const beforeFailedRetry = modelCalls().length; await focus(); await frames(); assert.equal(modelCalls().length, beforeFailedRetry, 'failed task never retries itself');
    await mapView.getByRole('button', { name: '重试代码地图', exact: true }).click(); await choose(updateDialog); generateMode = 'network'; await updateDialog.getByRole('button', { name: '允许并更新地图', exact: true }).click(); await mapView.getByRole('alert').filter({ hasText: 'NETWORK_ERROR' }).waitFor();
    const beforeReconcile = modelCalls().length; assert.equal(await mapView.getByRole('button', { name: '重试代码地图', exact: true }).isDisabled(), true); await focus(); await frames(); assert.equal(modelCalls().length, beforeReconcile);
    generateMode = 'running'; await refreshMap(project); await mapView.getByRole('button', { name: '停止地图任务', exact: true }).click(); await mapView.locator('[role="status"]').filter({ hasText: '已停止' }).waitFor(); assert.equal(modelCalls().length, beforeReconcile, 'reconcile/cancel never repeats admission');
    initialMap.changes = { ...cleanChanges(), uncertain: [{ repoId: project.repositories[0].id, path: 'unreadable.ts' }], truncated: true }; const incompleteCheck = response('code-map-check', project.id); await focus(); await incompleteCheck; await mapView.getByText(/检测不完整，存在待复核路径/).waitFor();
    assert.equal(await maintenance.evaluate(element => element.open), false); await setDetails(maintenance, true); await maintenance.getByText(/本地变化检测为部分扫描/).waitFor();
    await manage('打开地图对应阅读'); const latestArticle = page.locator(`.cr-lesson[data-lesson-id="${latest.lessonId}"]`); await node(latestArticle, latest.title).waitFor();
    assert.equal(requests.filter(row => row.method === 'snapshot').at(-1).params.sessionId, latest.sessionId);
    assert.equal(sessions.get(latest.sessionId).codeMapTask, undefined, 'latest-reference fixture deliberately has no codeMapTask or legacy map title');
    await assertFocus(true); assert.equal(await notes(latestArticle).evaluate(element => element.open), false); await shot('code-map-latest-reading.png');
    await openMap(); await node(mapView, children[0][0]).click();
    const evidenceResponse = page.waitForResponse(result => result.url().endsWith('/api/code-reading') && result.request().postDataJSON()?.method === 'evidence');
    await tree(mapView).getByRole('region', { name: '节点说明', exact: true }).getByRole('button', { name: '核验引用：map-proof', exact: true }).click(); await evidenceResponse;
    assert.equal(requests.filter(row => row.method === 'evidence').at(-1).params.sessionId, latest.sessionId); await page.getByLabel('文件阅读器', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('文件阅读器', { exact: true }).getAttribute('data-file-path'), 'entry.ts'); await openMap();
    await setDetails(notes(mapView), true); const originalEvidence = response('evidence'); await notes(mapView).getByRole('button', { name: '地图证据', exact: true }).click(); await originalEvidence;
    assert.equal(requests.filter(row => row.method === 'evidence').at(-1).params.sessionId, latest.sessionId, 'the original Markdown evidence link keeps the exact originating session');
    await page.getByLabel('文件阅读器', { exact: true }).waitFor(); await openMap(); await setDetails(notes(mapView), false);
    // Read A held after capture, navigate A → B → A; identity text alone is not a token.
    const late = { projectId: project.id, method: 'code-map', seen: deferred(), release: deferred(), value: { ...structuredClone(initialMap), latest: { ...latest, title: 'LATE_A_SHOULD_NOT_APPEAR' }, revision: 999 } }; readHold = late;
    await manage('核对地图任务状态'); await late.seen.promise; await switchProject(original); await switchProject(project); await openMap(); await mapView.getByRole('heading', { name: latest.title, exact: true }).waitFor();
    const lateResponse = response('code-map', project.id); late.release.resolve(); await lateResponse; await frames(); assert.equal(await page.getByText('LATE_A_SHOULD_NOT_APPEAR', { exact: true }).count(), 0); assert.equal(modelCalls().length, beforeReconcile);
    // A pending write may finish on Host, but cannot repaint or chain requests in B.
    await mapView.getByRole('button', { name: '重试代码地图', exact: true }).click(); await choose(updateDialog); const pending = { seen: deferred(), release: deferred() }; generateHold = pending;
    await updateDialog.getByRole('button', { name: '允许并更新地图', exact: true }).click(); await pending.seen.promise; await switchProject(original); const afterSwitch = requests.length; const pendingResponse = response('code-map-generate', project.id); pending.release.resolve(); await pendingResponse; await frames(); assert.equal(requests.slice(afterSwitch).some(row => row.method === 'code-map-generate' || row.method === 'code-map-check' && row.params.projectId === project.id), false); assert.equal(await page.locator('.cr-document-tab-button[data-document-kind="map"][aria-pressed="true"]').count(), 0);
    initialMap.task.status = 'cancelled'; initialMap.revision++;
    await switchProject(project); await openMap(); await mapView.getByRole('heading', { name: latest.title, exact: true }).waitFor();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(({ theme, palette }) => { document.documentElement.classList.toggle('dark', theme === 'dark'); for (const [key, value] of Object.entries(palette)) { if (theme === 'dark') document.documentElement.style.setProperty(key, value); else document.documentElement.style.removeProperty(key); } }, { theme, palette: darkPalette });
      for (const viewport of [{ width: 1380, height: 1000 }, { width: 375, height: 812 }]) {
        await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: viewport.width === 375 ? 'reduce' : 'no-preference' }); await frames();
        await assertFocus(true); await tree(mapView).getByRole('button', { name: '适应视图', exact: true }).click(); await frames();
        await assertBounds(mapView, `${theme} ${viewport.width}`); await assertSafe(mapView);
        assert.equal(await notes(mapView).evaluate(element => element.open), false); assert.equal(await maintenance.evaluate(element => element.open), false);
        await page.locator('.cr-structure-map').evaluate(element => { element.scrollTop = 0; }); await shot(`code-map-${theme}-${viewport.width}.png`);
        if (viewport.width === 375) {
          const readability = await tree(mapView).locator('.cr-mind-map-viewport').evaluate(element => ({ layout: element.dataset.layout, pixels: Number(element.dataset.mindMapScale) * parseFloat(getComputedStyle(element.querySelector('.cr-mind-map-node-label')).fontSize) }));
          assert.equal(readability.layout, 'compact'); assert.ok(readability.pixels >= 12, `375px map labels remain legible after fit: ${JSON.stringify(readability)}`);
          await tree(mapView).getByRole('button', { name: '收起分支', exact: true }).click(); assert.equal(await tree(mapView).locator('.cr-mind-map-node:visible').count(), 5);
          await tree(mapView).getByRole('button', { name: '展开分支', exact: true }).click();
          await node(mapView, longNode).focus(); await page.keyboard.press('Enter');
          await tree(mapView).getByRole('region', { name: '节点说明', exact: true }).getByRole('heading', { name: longNode, exact: true }).waitFor();
          await assertBounds(mapView, `${theme} narrow long-node detail`); await shot(`code-map-node-${theme}-375.png`); await page.keyboard.press('Escape');
        }
      }
    }
    await shot('code-map-dark-narrow.png');
    await mapView.getByRole('button', { name: '重试代码地图', exact: true }).click(); await updateDialog.waitFor(); await updateDialog.getByRole('combobox', { name: '代码地图模型', exact: true }).focus(); await page.keyboard.press('Enter'); await page.getByRole('listbox', { name: '代码地图模型', exact: true }).waitFor(); await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await updateDialog.waitFor({ state: 'detached' });
    await page.setViewportSize({ width: 1380, height: 1000 }); await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.style.cssText = ''; });
    // Historical notes have no latest-map reference: metadata, old lesson titles,
    // and old session titles are independent display-only compatibility routes.
    const beforeHistory = modelCalls().length; const archiveProject = newProject('历史地图兼容项目', false);
    const historical = (topic, title, metadata = false) => {
      const sessionId = newSession(archiveProject, false, topic); const lessonId = id('lesson', ++serial);
      const session = sessions.get(sessionId); session.lessons = [{ id: lessonId, title, markdown: mapMarkdown, conclusion: '历史归档结论仍须结合源码证据核对。', stage: 'discover', createdAt: now, claims: [], nextQuestions: [] }];
      session.selectedLessonId = lessonId; if (metadata) session.codeMapTask = { requestId: '10000000-1111-4111-8111-111111111111' };
      return { sessionId, lessonId, title };
    };
    const metadataHistory = historical('首次全景阅读归档', '模块协作速览', true);
    const followup = { id: id('lesson', ++serial), title: '后续普通逻辑说明', markdown: 'ORDINARY_FOLLOWUP_ONLY：只解释当前函数，不把后续知识点自动变成地图。', conclusion: '', stage: 'deep-read', createdAt: now, claims: [], nextQuestions: [] };
    sessions.get(metadataHistory.sessionId).lessons.push(followup);
    const legacyHistory = historical('历史业务归档', '旧版项目地图');
    const topicHistory = historical('Code Map 历史记录', '旧版业务知识点');
    for (const [kind, archived] of [['metadata', metadataHistory], ['legacy-title', legacyHistory], ['legacy-topic', topicHistory]]) {
      await page.evaluate(sessionId => localStorage.setItem('dsh-code-reading:active', sessionId), archived.sessionId); await mount();
      const article = page.locator(`.cr-lesson[data-lesson-id="${archived.lessonId}"]`); await node(article, archived.title).waitFor(); await assertFocus(true);
      assert.equal(maps.get(archiveProject.id).latest, null); assert.equal(await notes(article).evaluate(element => element.open), false); assert.equal(await notes(article).locator('.cr-markdown').count(), 0);
      for (const branch of branches) await node(article, branch).waitFor();
      await node(article, children[0][0]).click(); await tree(article).getByRole('region', { name: '节点说明', exact: true }).getByText(nodeDescription, { exact: false }).waitFor();
      await assertSafe(article); await page.keyboard.press('Escape'); await assertBounds(article, `history ${kind}`); await shot(`code-map-history-${kind}.png`);
      if (kind === 'metadata') {
        await node(article, children[0][0]).click();
        await tree(article).getByRole('button', { name: `折叠分支：${branches[3]}`, exact: true }).click();
        await tree(article).getByRole('button', { name: '放大导图', exact: true }).click(); await frames();
        const scaleBefore = await tree(article).locator('.cr-mind-map-viewport').getAttribute('data-mind-map-scale');
        await setDetails(notes(article), true); const readingPoll = response('code-map-check', archiveProject.id); await focus(); await readingPoll; await frames();
        await tree(article).getByRole('region', { name: '节点说明', exact: true }).getByText(nodeDescription, { exact: false }).waitFor();
        assert.equal(await tree(article).getByRole('button', { name: `展开分支：${branches[3]}`, exact: true }).getAttribute('aria-expanded'), 'false');
        assert.equal(await tree(article).locator('.cr-mind-map-viewport').getAttribute('data-mind-map-scale'), scaleBefore, 'identical refreshed snapshots must not reset zoom');
        assert.equal(await notes(article).evaluate(element => element.open), true, 'identical refreshed snapshots must not close the original notes');
        await setDetails(notes(article), false);
        await header.getByRole('button', { name: '阅读列表', exact: true }).click();
        await page.getByRole('navigation', { name: '本次阅读内容', exact: true }).getByRole('button', { name: followup.title, exact: true }).click();
        const plainArticle = page.locator(`.cr-lesson[data-lesson-id="${followup.id}"]`); await plainArticle.getByText(followup.markdown, { exact: true }).waitFor();
        assert.equal(await tree(plainArticle).count(), 0, 'metadata only marks the first map lesson, not ordinary follow-ups'); await assertFocus(false);
      }
    }
    const ordinary = historical('理解登录流程', '普通登录逻辑说明');
    sessions.get(ordinary.sessionId).lessons[0].markdown = 'ORDINARY_NOTE_ONLY：普通阅读默认仍直接显示说明。\n\n## 分支一\n\n普通笔记即使带标题，也不应误判为地图。';
    await page.evaluate(sessionId => localStorage.setItem('dsh-code-reading:active', sessionId), ordinary.sessionId); await mount();
    const ordinaryArticle = page.locator(`.cr-lesson[data-lesson-id="${ordinary.lessonId}"]`); await ordinaryArticle.getByText('ORDINARY_NOTE_ONLY：普通阅读默认仍直接显示说明。', { exact: true }).waitFor();
    assert.equal(await tree(ordinaryArticle).count(), 0); assert.equal(await notes(ordinaryArticle).count(), 0); await assertFocus(false); await shot('code-map-ordinary-reading-unchanged.png');
    assert.equal(modelCalls().length, beforeHistory, 'opening historical maps and ordinary notes never starts a model task');
    // Reopen a new, not-started project: onboarding may return after remount, but
    // never auto-selects a model or sends when a delayed catalog resolves.
    const waitingProject = newProject('可恢复引导'); const waitingSession = newSession(waitingProject);
    await page.evaluate(sessionId => localStorage.setItem('dsh-code-reading:active', sessionId), waitingSession); catalogHold = { seen: deferred(), release: deferred() }; const slowCatalog = catalogHold; await mount(); await slowCatalog.seen.promise; await firstDialog.waitFor(); assert.equal(await firstDialog.getByRole('button', { name: '确认并生成地图', exact: true }).isDisabled(), true);
    const beforeCatalog = modelCalls().length; await firstDialog.getByRole('button', { name: '暂不生成', exact: true }).click(); slowCatalog.release.resolve(); await frames(); assert.equal(modelCalls().length, beforeCatalog); assert.equal(await firstDialog.count(), 0);
    await mount(); await firstDialog.waitFor(); await firstDialog.getByRole('button', { name: '暂不生成', exact: true }).click(); assert.equal(modelCalls().length, beforeCatalog);
    // Old Host fixture stays usable: hide just AI, not the reading plugin.
    capabilities = false; const beforeOld = requests.length; await mount(); await page.getByRole('heading', { name: '选择文件，开始阅读', exact: true }).waitFor(); assert.equal(await firstDialog.count(), 0); assert.equal(requests.slice(beforeOld).some(row => row.method.startsWith('code-map')), false);
    assert.equal(globalWrites().length, 0, 'map model choices never update global/session settings');
    const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })); assert.equal(JSON.stringify(storage).includes('MAP_CONTENT_ONLY'), false); assert.deepEqual(Object.keys(storage.local), ['dsh-code-reading:active']); assert.deepEqual(storage.session, {});
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    const report = { passed: true, source: 'intercepted HTTP with the real Client bundle and simulated model responses', loggedInGuiVerified: false, initialAutoDialog: true, defaultMapDocument: true, noModelBeforeConsent: true, noQuestionRequired: true, noGlobalModelMutation: true, selectedCancelNoAdmission: true, pendingCancelLateIgnored: true, failedMapRetained: true, independentIncrementalConsent: true, statusBeforeNetworkRetry: true, focusAndThirtySecondLocalChecks: true, hiddenPageDoesNotScan: true, incompleteScanWarning: true, exactReadingAndEvidenceSession: true, crossProjectAndABATokens: true, pendingWriteDoesNotStealProject: true, legacyCapabilityCompatible: true, noContentStorage: true, completeModuleTree: { branches: branches.length, childrenPerBranch: 2, nodes: 13 }, lazyOriginalNotes: true, secondaryManagementCollapsed: true, localChangeSummaryAndFoldedPaths: true, nodeDetailsAndEvidence: true, originalMarkdownEvidence: true, zoomFitAndBranchCollapse: true, defaultFocusAndExit: true, directSidebarNavigation: true, explicitPathNavigation: true, historicalMapDetection: ['codeMapTask', 'latest-reference', 'legacy-title', 'legacy-topic'], ordinaryReadingUnchanged: true, darkNarrow: true, lightAndDarkDesktopAnd375: true, keyboardAndReducedMotion: true, dangerousHtmlAndExternalMediaBlocked: true, realModelRequest: false, checks: requests.filter(row => row.method === 'code-map-check').length, admissions: modelCalls().length, layouts, previews };
    await writeFile(path.join(output, 'code-map-report.json'), JSON.stringify(report, null, 2)); return report;
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'code-map-failure.png'), fullPage: true }).catch(() => {});
    await writeFile(path.join(output, 'code-map-failure.json'), JSON.stringify({ message: error.message, stack: error.stack, errors, external, requests: requests.slice(-30), text: await page.locator('body').innerText().catch(() => '') }, null, 2)); throw error;
  } finally {
    generateHold?.release.resolve(); readHold?.release.resolve(); catalogHold?.release.resolve();
    if (hidden) await page.evaluate(() => { delete document.visibilityState; }).catch(() => {});
    await page.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { chromium } = await import('playwright'); const { build } = await import('esbuild');
  const output = path.resolve(process.env.DSH_TEST_BROWSER_OUTPUT ?? '.test-output/browser-code-map'); await mkdir(output, { recursive: true });
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const bootstrap = await build({ stdin: { contents: `import React from 'react';import * as jsx from 'react/jsx-runtime';import * as ReactDOM from 'react-dom';import {createRoot} from 'react-dom/client';window.React=React;window.createRoot=createRoot;window.__ModuleLoader__={load(row){window.plugin=row.factory(id=>{if(id==='react')return React;if(id==='react/jsx-runtime')return jsx;if(id==='react-dom')return ReactDOM;throw Error('Unexpected external '+id);});}};`, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const plugin = await readFile(process.env.DSH_TEST_CLIENT_BUNDLE ?? 'lib/client.js', 'utf8');
  const browser = await chromium.launch({ executablePath: process.env.DSH_TEST_BROWSER ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  try { console.log(JSON.stringify(await verifyCodeMap({ browser, output, plugin, bootstrap: bootstrap.outputFiles[0].text, status: { package: manifest.name, version: manifest.version, apiVersion: 1, targetDshVersion: manifest.engines.dsh, enabled: true, dataDirectory: 'D:\\fixtures\\reading-archive' } }), null, 2)); }
  finally { await browser.close(); }
}
