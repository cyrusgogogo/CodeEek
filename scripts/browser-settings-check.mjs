import assert from 'node:assert/strict';
import path from 'node:path';
import { waitForModel } from './browser-model-check.mjs';

const dialogFor = page => page.getByRole('dialog', { name: '阅读设置', exact: true });
const triggerFor = page => dialogFor(page).getByRole('combobox', { name: '默认阅读代码模型', exact: true });
const writes = requests => requests.filter(row => row.method === 'set-default-model');
const tick = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function ready(page) { await page.waitForFunction(() => document.querySelector('[role="combobox"][aria-label="默认阅读代码模型"]')?.disabled === false); }
async function choose(page, name) { await triggerFor(page).click(); const popup = page.getByRole('listbox', { name: '默认阅读代码模型', exact: true }); await popup.waitFor(); assert.equal(await popup.evaluate(node => !!node.closest('dialog[open]')), true, 'model popup must participate in the native modal, not an inert body portal'); await popup.getByRole('option', { name }).click(); }
async function saved(page) { await dialogFor(page).getByRole('status').filter({ hasText: '已保存，仅用于之后新建的阅读。' }).waitFor(); }

export async function verifyReadingSettings({ page, output, requests, expectedRoot, open, close, getSettings, setSettings, setMode, holdSave, setCatalogMode, newReading, restoreReading, currentSelection }) {
  const local = { provider: 'local', model: 'private-reader' }; const remote = { provider: 'remote', model: 'cloud-reader' };
  const initialSelection = structuredClone(currentSelection()); const originalViewport = page.viewportSize(); const originalStyle = await page.evaluate(() => document.documentElement.style.cssText);
  const noImplicit = () => requests.filter(row => ['prompt', 'select-model', 'create-session'].includes(row.method)).length;
  const before = noImplicit(); let held;
  try {
    await open(); await ready(page); const dialog = dialogFor(page); const trigger = triggerFor(page);
    assert.deepEqual(await dialog.locator('h3').allTextContents(), ['默认阅读代码模型', '插件档案位置']);
    assert.equal(await dialog.locator('.cr-archive-path').innerText(), expectedRoot); assert.equal((await dialog.innerText()).includes('内部状态版本'), false);
    assert.equal(await trigger.innerText(), '跟随 DSH 默认'); assert.equal(await dialog.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), true);
    await trigger.focus(); await page.keyboard.press('ArrowDown'); const keyboardPopup = page.getByRole('listbox', { name: '默认阅读代码模型', exact: true }); await keyboardPopup.waitFor();
    assert.equal(await keyboardPopup.evaluate(node => !!node.closest('dialog[open]')), true); await page.keyboard.press('End'); await page.keyboard.press('Escape'); await tick(page);
    assert.equal(await keyboardPopup.count(), 0); assert.equal(await dialog.isVisible(), true); assert.equal(await trigger.evaluate(node => node === document.activeElement), true, 'Escape closes only the popup and returns focus within the modal');
    await choose(page, /本地.*Private Reader/); assert.equal(noImplicit(), before, 'editing a preference must not select a session model or create a session');
    const firstWrite = writes(requests).length; await dialog.getByRole('button', { name: '保存设置', exact: true }).click(); await saved(page);
    assert.equal(writes(requests).length, firstWrite + 1); assert.deepEqual(writes(requests).at(-1).params, { expectedRevision: 0, defaultModel: local });
    assert.deepEqual(currentSelection(), initialSelection); assert.equal(noImplicit(), before, 'saving defaults must not mutate an existing reading or request a model');
    await page.screenshot({ path: path.join(output, 'reading-settings-light.png'), fullPage: true, animations: 'disabled' });
    await page.evaluate(() => { const vars = { '--dsw-alias-bg-base': '#18181b', '--dsw-alias-bg-layer-1': '#222733', '--dsw-alias-bg-layer-2': '#293044', '--dsw-alias-border-l1': '#475569', '--dsw-alias-label-primary': '#f1f5f9', '--dsw-alias-label-secondary': '#cbd5e1', '--dsw-alias-brand-primary': '#829af5' }; for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value); });
    await page.screenshot({ path: path.join(output, 'reading-settings-dark.png'), fullPage: true, animations: 'disabled' });
    await page.evaluate(style => { document.documentElement.style.cssText = style; }, originalStyle); await page.setViewportSize({ width: 480, height: 820 });
    assert.equal(await dialog.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1; }), true, 'compact settings remain within a narrow viewport');
    await page.screenshot({ path: path.join(output, 'reading-settings-480.png'), fullPage: true, animations: 'disabled' }); await page.setViewportSize(originalViewport);
    setCatalogMode('long'); await dialog.getByRole('button', { name: '重新加载模型目录', exact: true }).click(); await ready(page); await trigger.click(); await page.keyboard.press('End');
    const lastModel = page.getByRole('listbox', { name: '默认阅读代码模型', exact: true }).getByRole('option', { name: /最后一个模型/ }); await lastModel.click();
    assert.equal(noImplicit(), before, 'browsing a long default catalog cannot change a session model'); assert.equal(writes(requests).length, firstWrite + 1);
    setCatalogMode('healthy'); await dialog.getByRole('button', { name: '重新加载模型目录', exact: true }).click(); await ready(page); await trigger.getByText('Private Reader', { exact: true }).waitFor();
    await close(); await open(); await ready(page); await trigger.getByText('Private Reader', { exact: true }).waitFor(); assert.equal(writes(requests).length, firstWrite + 1, 'reopening only reads persisted preferences');
    await close(); await newReading(); await waitForModel(page, '本地', 'Private Reader'); assert.deepEqual(currentSelection(), initialSelection, 'new draft preference cannot overwrite the retained existing session');
    await restoreReading(); await waitForModel(page, '远程', 'Cloud Reader'); await open(); await ready(page);

    await choose(page, /远程.*Cloud Reader/); held = holdSave(); const heldBefore = writes(requests).length;
    const heldResponse = page.waitForResponse(response => response.url().endsWith('/api/code-reading') && response.request().postDataJSON()?.method === 'set-default-model');
    await dialog.getByRole('button', { name: '保存设置', exact: true }).evaluate(node => { node.click(); node.click(); }); await held.seen.promise;
    assert.equal(writes(requests).length, heldBefore + 1, 'same-tick double click submits once'); assert.equal(await trigger.isDisabled(), true);
    await close(); await open(); await ready(page); await trigger.getByText('Private Reader', { exact: true }).waitFor();
    held.release.resolve(); await heldResponse; await tick(page); await page.waitForFunction(() => !document.querySelector('dialog[open] [role="status"]'));
    assert.equal(await trigger.getByText('Private Reader', { exact: true }).count(), 1, 'a closed saving component cannot overwrite the reopened setting');
    await dialog.getByRole('button', { name: '重新加载模型目录', exact: true }).click(); await ready(page); await trigger.getByText('Cloud Reader', { exact: true }).waitFor(); assert.deepEqual(getSettings().defaultModel, remote);

    await choose(page, /本地.*Private Reader/); setMode('conflict'); const conflictBefore = writes(requests).length;
    await dialog.getByRole('button', { name: '保存设置', exact: true }).click(); await dialog.getByRole('alert').filter({ hasText: '已由另一页面更新' }).waitFor(); await tick(page);
    assert.equal(writes(requests).length, conflictBefore + 1); assert.equal(await trigger.isDisabled(), true); setMode('healthy');
    await dialog.getByRole('button', { name: '重新加载模型目录', exact: true }).click(); await ready(page); await trigger.getByText('Cloud Reader', { exact: true }).waitFor();
    assert.equal(writes(requests).length, conflictBefore + 1, 'read-only recovery cannot replay a conflicted write');

    await choose(page, /本地.*Private Reader/); setMode('offline'); const networkBefore = writes(requests).length;
    await dialog.getByRole('button', { name: '保存设置', exact: true }).click(); await dialog.getByRole('alert').filter({ hasText: '未能确认本次操作结果' }).waitFor(); await tick(page);
    assert.equal(writes(requests).length, networkBefore + 1); assert.deepEqual(getSettings().defaultModel, local, 'fixture committed before losing its response');
    setMode('healthy'); await dialog.getByRole('button', { name: '重新加载模型目录', exact: true }).click(); await ready(page); await trigger.getByText('Private Reader', { exact: true }).waitFor(); assert.equal(writes(requests).length, networkBefore + 1);

    await close(); setMode('corrupt'); await open(); await dialog.getByRole('alert').filter({ hasText: '设置损坏' }).waitFor();
    assert.equal(await trigger.isDisabled(), true); const corruptBefore = writes(requests).length; await dialog.getByRole('button', { name: '重置默认模型', exact: true }).click(); await saved(page);
    assert.equal(writes(requests).length, corruptBefore + 1); assert.deepEqual(writes(requests).at(-1).params, { expectedRevision: 0, defaultModel: null }); assert.equal(await trigger.innerText(), '跟随 DSH 默认');
    await close(); setSettings({ revision: 7, defaultModel: { provider: 'retired', model: 'unavailable-reader' } }); setCatalogMode('empty'); await open(); await ready(page);
    await trigger.getByText('unavailable-reader', { exact: true }).waitFor(); await trigger.getByText('已保存的模型', { exact: true }).waitFor(); assert.equal(await dialog.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), true);
    await choose(page, '跟随 DSH 默认'); await dialog.getByRole('button', { name: '保存设置', exact: true }).click(); await saved(page); assert.deepEqual(writes(requests).at(-1).params, { expectedRevision: 7, defaultModel: null });
    setCatalogMode('healthy'); await dialog.getByRole('button', { name: '重新加载模型目录', exact: true }).click(); await ready(page);
    await choose(page, /本地.*Private Reader/); setMode('unknown'); const oldHostBefore = writes(requests).length; await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: '本次设置未保存' }).waitFor(); await tick(page); assert.equal(writes(requests).length, oldHostBefore + 1); assert.equal(await trigger.isDisabled(), true);
    await close(); assert.equal(await page.getByRole('button', { name: '新建阅读', exact: true }).first().isDisabled(), true);
    setMode('healthy'); await page.locator('.cr-editor-notices').getByRole('button', { name: '重试连接与加载', exact: true }).click(); await page.locator('.cr-page').waitFor(); await page.waitForFunction(() => document.querySelector('aside[aria-label="阅读列表"] .cr-new-reading')?.disabled === false); await restoreReading(); await waitForModel(page, '远程', 'Cloud Reader');
    assert.equal(writes(requests).length, oldHostBefore + 1, 'Host recovery cannot replay an unsupported settings mutation'); assert.deepEqual(getSettings().defaultModel, null);
    assert.deepEqual(currentSelection(), initialSelection);
    return { passed: true, twoSectionsOnly: true, nativeModalMouseAndKeyboard: true, longCatalogScrollableInModal: true, pluginArchiveRoot: true, persistedOnReopen: true, appliesToNewReadingOnly: true, noImplicitSessionOrPrompt: true, duplicateSaveBlocked: true, closedSaveCannotOverwriteReopen: true, conflictReadOnlyRecovery: true, uncertainSaveNoAutomaticRetry: true, explicitCorruptionReset: true, unavailableSavedModelRetainedUntilCleared: true, fallbackWithoutCatalog: true, oldHostMutationPause: true, themes: ['light', 'dark'], narrowWidth: 480, realModelRequest: false };
  } finally {
    held?.release.resolve(); setMode('healthy'); setCatalogMode('healthy'); await page.setViewportSize(originalViewport); await page.evaluate(style => { document.documentElement.style.cssText = style; }, originalStyle);
  }
}
