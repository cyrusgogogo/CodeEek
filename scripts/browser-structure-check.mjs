import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const mapRoot = page => page.locator('.cr-structure-map');
const mapFile = (page, relative) => mapRoot(page).locator(`[data-map-path=${JSON.stringify(relative)}]`).first();
const tick = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const dark = { '--dsw-alias-bg-base': '#18181b', '--dsw-alias-bg-layer-1': '#222733', '--dsw-alias-bg-layer-2': '#293044', '--dsw-alias-border-l1': '#475569', '--dsw-alias-label-primary': '#f1f5f9', '--dsw-alias-label-secondary': '#cbd5e1', '--dsw-alias-brand-primary': '#829af5' };
async function remount(page, sessionId) {
  await page.evaluate(id => { window.readingRoot.unmount(); localStorage.setItem('dsh-code-reading:active', id); const slot = window.slots['main:code-reading']; window.readingRoot = window.createRoot(document.getElementById('root')); window.readingRoot.render(window.React.createElement(slot.component, { ...slot.options.inject(), useWorkspaces: select => select({ items: [] }) })); }, sessionId);
  await page.locator('.cr-workbench').waitFor();
}
async function openMap(page) {
  const returnButton = page.getByRole('button', { name: '返回项目地图', exact: true });
  if (await returnButton.isVisible()) await returnButton.click();
  else await page.getByRole('button', { name: '项目地图', exact: true }).first().click();
  await mapRoot(page).waitFor();
}
async function findFile(page, relative) {
  const overview = mapRoot(page).getByRole('navigation', { name: '项目地图路径', exact: true }).getByRole('button', { name: '总览', exact: true });
  if (await overview.isVisible()) await overview.click();
  await mapRoot(page).getByLabel('搜索已索引路径', { exact: true }).fill(relative);
  await mapFile(page, relative).waitFor(); await mapFile(page, relative).click();
  await page.locator('.cr-structure-map[data-map-kind="file"]').waitFor();
}
async function assertBounds(page, label) {
  const result = await mapRoot(page).evaluate(root => { const r = root.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, viewport: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth }; });
  assert.ok(result.left >= -1 && result.right <= result.viewport + 1 && result.width > 0 && result.overflow <= 1, `${label}: ${JSON.stringify(result)}`);
}

// Runs against the actual Host module and filesystem fixture already owned by
// verifyFileWorkspace. No real model, installed profile or live GUI is touched.
export async function verifyStructureMap({ page, runtime, repo, repoId, project, sessionId, multiProject, multiId, output, calls, apiCalls, methodReadings }) {
  const baselinePrompts = calls.length; const parameters = { sessionId, repoId }; const originalDispatch = runtime.dispatch; let gate = null;
  runtime.dispatch = async (method, params, signal) => {
    const value = await originalDispatch(method, params, signal); const pending = gate;
    if (pending && method === pending.method && params.repoId === pending.repoId) {
      gate = null; pending.entered.resolve(); await pending.release.promise; pending.done.resolve();
      return pending.modify ? pending.modify(value) : value;
    }
    return value;
  };
  const shots = [];
  try {
    await page.setViewportSize({ width: 1380, height: 1000 }); await remount(page, sessionId);
    assert.equal((await runtime.dispatch('structure-map', parameters)).revision, 0);
    await openMap(page); await page.locator('.cr-structure-map[data-index-revision="0"]').waitFor();
    const sourceRequests = apiCalls.filter(row => ['view-file', 'structure-map-file'].includes(row.method)).length;
    assert.equal(apiCalls.filter(row => row.method === 'structure-map-refresh').length, 0, 'merely opening a map never writes an index');
    await mapRoot(page).getByRole('button', { name: '建立结构索引', exact: true }).click();
    await page.locator('.cr-structure-map[data-index-revision="1"]').waitFor();
    const first = await runtime.dispatch('structure-map', parameters);
    assert.equal(first.revision, 1); assert.ok(first.files.some(row => row.path === 'src/methods.js'));
    assert.equal(first.files.some(row => row.path === '.env'), false);
    assert.ok(first.files.find(row => row.path === 'src/methods.js').readingCount > 0, 'cross-session knowledge is aggregated without opening every source file');
    assert.equal(apiCalls.filter(row => ['view-file', 'structure-map-file'].includes(row.method)).length, sourceRequests, 'building the path index does not eagerly read source files');
    assert.equal(calls.length, baselinePrompts);
    await assertBounds(page, 'overview');
    await page.screenshot({ path: path.join(output, 'structure-map-overview.png'), fullPage: true, animations: 'disabled' }); shots.push('structure-map-overview.png');

    // Real hierarchy, not a second flat file tree. The native buttons remain keyboard operable.
    const layer = mapRoot(page).locator('[data-map-layer="core"]').first(); await layer.focus(); await page.keyboard.press('Enter');
    await mapRoot(page).getByRole('navigation', { name: '项目地图路径', exact: true }).waitFor();
    const module = mapRoot(page).locator('[data-map-module="src"]').first(); await module.waitFor(); await module.focus(); await page.keyboard.press('Enter');
    await mapFile(page, 'src/methods.js').waitFor(); await mapFile(page, 'src/methods.js').click();
    await page.locator('.cr-structure-map[data-map-kind="file"]').waitFor();
    const detail = await runtime.dispatch('structure-map-file', { ...parameters, path: 'src/methods.js' });
    assert.ok(detail.codeReadings.items.length > 0); assert.equal(Object.hasOwn(detail, 'lines'), false);
    assert.equal(await mapRoot(page).locator('script,iframe,object,embed,img[src^="http"]').count(), 0, 'archive names and conclusions never become executable media');
    assert.equal(await page.evaluate(() => globalThis.__METHOD_HOVER_EXECUTED__), undefined);
    const precise = mapRoot(page).locator(`[data-lesson-id=${JSON.stringify(methodReadings.crossSession.lessonId)}][data-session-id=${JSON.stringify(methodReadings.crossSession.sessionId)}]`).first();
    await precise.waitFor(); await precise.getByRole('button', { name: /^打开知识点 / }).click();
    await page.waitForFunction(id => document.querySelector('.cr-lesson')?.dataset.lessonId === id, methodReadings.crossSession.lessonId);
    assert.notEqual(methodReadings.crossSession.lessonId, methodReadings.crossSession.latestLessonId);
    await openMap(page); await page.locator('.cr-structure-map[data-map-kind="file"]').waitFor();
    assert.equal(await mapRoot(page).getAttribute('data-repo-id'), repoId, 'return from another reading session preserves map repository and route');

    await mapRoot(page).getByRole('button', { name: '打开源码', exact: true }).click();
    const viewer = page.locator('.cr-file-viewer'); await viewer.waitFor();
    assert.equal(await viewer.getAttribute('data-file-path'), 'src/methods.js');
    await openMap(page); await page.locator('.cr-structure-map[data-map-kind="file"]').waitFor(); await mapRoot(page).locator('.cr-map-hash').waitFor();

    // Source changes between detail validation and source opening cannot be presented as old evidence.
    const file = path.join(repo, 'src/methods.js'); const original = await fs.readFile(file);
    try {
      await fs.writeFile(file, `// MAP_CHANGED_AFTER_INSPECTION\n${original.toString('utf8')}`);
      await mapRoot(page).getByRole('button', { name: '打开源码', exact: true }).click(); await viewer.waitFor();
      await viewer.locator('.cr-source-stale').filter({ hasText: '项目地图定位已过期' }).waitFor();
      assert.equal(await viewer.locator('[data-evidence-line="true"], .cr-source-evidence').count(), 0, 'map hints cannot manufacture evidence highlighting');
      assert.equal(await viewer.locator('.cr-code-body').evaluate(node => node.scrollTop), 0, 'expired map ranges must start at the current file top');
    } finally { await fs.writeFile(file, original); }
    await openMap(page);

    // Refresh updates inventory, while reading alone never silently rescans.
    const newPath = 'src/map-new.fixture-extension'; await fs.writeFile(path.join(repo, newPath), 'MAP_LOCAL_ONLY\n');
    assert.equal((await runtime.dispatch('structure-map', parameters)).files.some(row => row.path === newPath), false);
    await mapRoot(page).getByRole('button', { name: '刷新结构索引', exact: true }).click();
    await findFile(page, newPath);
    assert.equal((await runtime.dispatch('structure-map', parameters)).files.some(row => row.path === newPath), true);

    // Persisted manual layers are edited through the real UI and remain plain text.
    const manualName = '地图测试层 <script>not executable</script>';
    await mapRoot(page).getByRole('button', { name: '配置架构层', exact: true }).click();
    const editor = mapRoot(page).getByRole('form', { name: '配置架构层', exact: true });
    await editor.getByRole('button', { name: '新增自定义层', exact: true }).click();
    await editor.getByLabel('层名称 1', { exact: true }).fill(manualName); await editor.getByLabel('层说明 1', { exact: true }).fill('只存Host项目档案');
    const customId = await editor.locator('[data-custom-layer-id]').getAttribute('data-custom-layer-id');
    await editor.getByRole('button', { name: '新增路径归属', exact: true }).click(); await editor.getByLabel('路径前缀 1', { exact: true }).fill('src'); await editor.getByLabel('归属架构层 1', { exact: true }).selectOption(customId);
    await editor.getByRole('button', { name: '保存架构层配置', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
    assert.equal((await runtime.dispatch('structure-map', parameters)).files.find(row => row.path === 'src/methods.js').layerId, customId);
    await mapRoot(page).getByRole('button', { name: '配置架构层', exact: true }).click(); await editor.getByLabel('层名称 1', { exact: true }).fill('冲突时保留的未提交草稿');
    const beforeConflict = await runtime.dispatch('structure-map', parameters); await runtime.dispatch('structure-map-refresh', { ...parameters, expectedRevision: beforeConflict.revision });
    const savesBefore = apiCalls.filter(row => row.method === 'structure-map-layers').length;
    await editor.getByRole('button', { name: '保存架构层配置', exact: true }).click(); await mapRoot(page).getByRole('alert').waitFor();
    assert.equal(await editor.getByLabel('层名称 1', { exact: true }).inputValue(), '冲突时保留的未提交草稿'); assert.equal(await editor.getByRole('button', { name: '保存架构层配置', exact: true }).isDisabled(), true);
    assert.equal(apiCalls.filter(row => row.method === 'structure-map-layers').length, savesBefore + 1, 'a conflicting save is never automatically retried');
    await mapRoot(page).getByRole('button', { name: '重新加载地图', exact: true }).click(); await mapRoot(page).getByRole('alert').waitFor({ state: 'hidden' }); await editor.getByRole('button', { name: '取消配置', exact: true }).click();
    await remount(page, sessionId); await openMap(page);
    await mapRoot(page).getByText(manualName, { exact: true }).waitFor(); assert.equal(await mapRoot(page).locator('script').count(), 0);
    await mapRoot(page).locator(`[data-map-layer=${JSON.stringify(customId)}]`).first().click();
    await mapRoot(page).locator('[data-map-module="src"]').first().click();

    for (const theme of ['light', 'dark']) {
      await page.locator('html').evaluate((element, { theme, tokens }) => { element.classList.toggle('dark', theme === 'dark'); for (const [key, value] of Object.entries(tokens)) theme === 'dark' ? element.style.setProperty(key, value) : element.style.removeProperty(key); }, { theme, tokens: dark });
      for (const size of [{ width: 1380, height: 1000 }, { width: 375, height: 812 }]) {
        await page.setViewportSize(size); await tick(page); await assertBounds(page, `${theme} ${size.width}`);
        const image = `structure-map-${theme}-${size.width}.png`; await page.screenshot({ path: path.join(output, image), fullPage: true, animations: 'disabled' }); shots.push(image);
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' }); await assertBounds(page, 'reduced motion'); await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1380, height: 1000 }); await page.locator('html').evaluate((element, tokens) => { element.classList.remove('dark'); for (const key of Object.keys(tokens)) element.style.removeProperty(key); }, dark);

    // Same-name repositories and late responses: ignore AbortSignal intentionally at the transport.
    const [a, b] = multiProject.repositories;
    for (const repository of [a, b]) { const params = { sessionId: multiId, repoId: repository.id }; const state = await runtime.dispatch('structure-map', params); await runtime.dispatch('structure-map-refresh', { ...params, expectedRevision: state.revision }); }
    await remount(page, multiId); await openMap(page);
    const picker = mapRoot(page).getByLabel('地图仓库', { exact: true }); await picker.selectOption(b.id); await page.waitForFunction(id => document.querySelector('.cr-structure-map')?.dataset.repoId === id && !document.querySelector('.cr-structure-map [aria-busy="true"]'), b.id);
    const pending = { method: 'structure-map', repoId: a.id, entered: deferred(), release: deferred(), done: deferred(), modify: value => ({ ...value, indexedAt: '2000-01-01T00:00:00.000Z' }) }; gate = pending;
    await picker.selectOption(a.id); await pending.entered.promise;
    await picker.selectOption(b.id); await picker.selectOption(a.id);
    await mapRoot(page).getByLabel('搜索已索引路径', { exact: true }).waitFor(); pending.release.resolve(); await pending.done.promise; await tick(page);
    assert.equal((await mapRoot(page).innerText()).includes('2000'), false, 'late first-A result is not admitted after A→B→A');
    await findFile(page, 'entry.ts'); await mapRoot(page).getByRole('button', { name: '打开源码', exact: true }).click(); await viewer.locator('.cr-code-text').filter({ hasText: 'ROOT_A_ONLY' }).waitFor();
    assert.equal(apiCalls.filter(row => row.method === 'view-file').at(-1).params.repoId, a.id);

    const storage = await page.evaluate(() => [localStorage, sessionStorage].flatMap(store => Array.from({ length: store.length }, (_, i) => store.getItem(store.key(i)))).join('\n'));
    assert.doesNotMatch(storage, /MAP_LOCAL_ONLY|MAP_CHANGED_AFTER_INSPECTION|custom-map-fixture|METHOD_CONCLUSION/);
    assert.equal(calls.length, baselinePrompts, 'map browsing, inventory and configuration never request a model');
    assert.ok(apiCalls.filter(row => row.method === 'reader-state').every(row => row.params.patch?.activeDocument !== 'map'), 'ephemeral map location never enters the legacy reader-state contract');
    return { passed: true, source: 'actual Host and temporary repositories', checks: ['Explicit path-only indexing without model calls or eager source fanout', 'Keyboard layer/module/file hierarchy with breadcrumbs', 'Cross-session exact knowledge navigation and independent return route', 'SHA checked again when opening source from a map hint', 'Explicit refresh observes new files', 'Manual prefix assignments persist without executable labels', 'Light/dark desktop and 375px no page overflow', 'Same-name repository and ignored-abort A→B→A isolation', 'No new browser source/index persistence or unsupported reader-state kinds'], previews: shots, additionalModelPrompts: calls.length - baselinePrompts };
  } finally { gate?.release.resolve(); runtime.dispatch = originalDispatch; }
}
