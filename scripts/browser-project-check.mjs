import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

export const projectTrigger = page => page.getByRole('combobox', { name: '阅读项目切换', exact: true, includeHidden: true });
const projectPopup = page => page.getByRole('listbox', { name: '阅读项目切换', exact: true });
const activePreference = page => page.evaluate(() => localStorage.getItem('dsh-code-reading:active'));
const waitForMethod = (page, method, matches = () => true) => page.waitForResponse(response => {
  if (!response.url().endsWith('/api/code-reading')) return false;
  const body = response.request().postDataJSON(); return body?.method === method && matches(body.params);
});

export async function verifyProjectSelect({ page, output, requests, refresh, primary, tools, empty, install, reset, setRemoveMode, setCreateFails, stateFor, holdNextCreate, selectSession, showFiles }) {
  const trigger = projectTrigger(page); const popup = projectPopup(page);
  const dialog = page.getByRole('dialog', { name: '阅读仓库', exact: true });
  const draftNotice = page.locator('.cr-editor-statusbar .cr-draft-notice[role="status"]');
  const sidebar = page.locator('aside[aria-label="阅读列表"]');
  const savedIds = () => [primary, tools, empty].map(owner => owner.sessions.map(session => session.id));
  const savedBefore = savedIds();
  const mutations = () => requests.filter(row => ['prompt', 'create-project', 'create-session', 'select-model'].includes(row.method)).length;
  const before = mutations(); const viewport = page.viewportSize();
  const theme = await page.evaluate(() => document.documentElement.style.cssText);
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const waitForEnabled = () => page.waitForFunction(() => document.querySelector('[role="combobox"][aria-label="阅读项目切换"]')?.disabled === false);
  const waitForFocus = () => page.waitForFunction(() => document.activeElement?.matches('[role="combobox"][aria-label="阅读项目切换"]'));
  const waitForOption = name => page.waitForFunction(expected => document.activeElement?.getAttribute('role') === 'option' && document.activeElement.textContent === expected, name);
  const assertBounds = async () => {
    const bounds = await popup.evaluate(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth }; });
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height, JSON.stringify(bounds));
    assert.ok(bounds.documentWidth <= bounds.width, 'repository popup and header must not overflow horizontally');
  };
  const screenshotPicker = async name => {
    const button = await trigger.boundingBox(); const list = await popup.boundingBox(); const view = page.viewportSize();
    const x = Math.max(0, Math.floor(Math.min(button.x, list.x) - 8)); const y = Math.max(0, Math.floor(Math.min(button.y, list.y) - 8));
    const right = Math.min(view.width, Math.ceil(Math.max(button.x + button.width, list.x + list.width) + 8)); const bottom = Math.min(view.height, Math.ceil(Math.max(button.y + button.height, list.y + list.height) + 8));
    await page.screenshot({ path: path.join(output, name), clip: { x, y, width: right - x, height: bottom - y } });
  };
  install();
  try {
    await refresh(); await trigger.getByText(primary.title, { exact: true }).waitFor();
    await trigger.click(); await popup.getByRole('option', { name: primary.title, exact: true, selected: true }).waitFor();
    assert.equal(await popup.getByRole('option').count(), 4);
    await popup.getByRole('option', { name: '管理仓库…', exact: true }).waitFor();
    await assertBounds(); await page.screenshot({ path: path.join(output, 'project-select-light.png'), fullPage: true });
    await screenshotPicker('project-select-preview.png');
    await page.keyboard.press('Escape'); await popup.waitFor({ state: 'detached' }); await waitForFocus();
    assert.equal(mutations(), before, 'opening and cancelling cannot create sessions or call a model');

    await trigger.press('ArrowDown'); await popup.waitFor(); await waitForOption(primary.title);
    await page.keyboard.press('Home'); await waitForOption(primary.title);
    await page.keyboard.press('ArrowDown'); await waitForOption(tools.title);
    const toTools = page.waitForResponse(response => response.url().endsWith('/api/code-reading') && response.request().postDataJSON()?.method === 'snapshot' && response.request().postDataJSON()?.params.sessionId === tools.sessions[0].id);
    await page.keyboard.press('Enter'); await toTools; await popup.waitFor({ state: 'detached' });
    await trigger.getByText(tools.title, { exact: true }).waitFor(); await waitForFocus();
    assert.equal(await activePreference(page), tools.sessions[0].id);
    assert.equal(await dialog.count(), 0, 'an existing repository switches directly without opening management');
    assert.equal(mutations(), before, 'switching to an existing reading cannot create another session or call a model');

    await trigger.click(); await popup.getByRole('option', { name: tools.title, exact: true, selected: true }).waitFor();
    const toPrimary = waitForMethod(page, 'snapshot', params => params.sessionId === primary.sessions[0].id);
    await popup.getByRole('option', { name: primary.title, exact: true }).click(); await toPrimary;
    await trigger.getByText(primary.title, { exact: true }).waitFor();
    assert.equal(mutations(), before, 'switching back also reuses the stored reading');

    // Failure must leave the current repository and reading intact, not send the
    // user to management or retry a write whose outcome they have not confirmed.
    setCreateFails(true);
    try {
      const failedCreate = waitForMethod(page, 'create-session', params => params.projectId === empty.id);
      await trigger.click(); await popup.getByRole('option', { name: empty.title, exact: true }).click();
      const failure = await failedCreate; assert.equal(failure.status(), 503);
      assert.deepEqual(failure.request().postDataJSON().params, { projectId: empty.id, draft: true });
      await page.getByRole('alert').filter({ hasText: '夹具会话创建失败' }).waitFor(); await waitForEnabled();
      await trigger.getByText(primary.title, { exact: true }).waitFor();
      assert.equal(await activePreference(page), primary.sessions[0].id);
      assert.equal(await sidebar.locator('.cr-session[aria-current="true"] .cr-session-title').innerText(), primary.sessions[0].topic);
      assert.equal(await dialog.count(), 0); assert.equal(await draftNotice.count(), 0); assert.deepEqual(savedIds(), savedBefore);
      assert.equal(mutations(), before + 1, 'failed creation makes exactly one draft request and never retries or calls a model');
    } finally { setCreateFails(false); }

    const opening = holdNextCreate(); let draftId;
    try {
      const createdResponse = waitForMethod(page, 'create-session', params => params.projectId === empty.id);
      await trigger.click(); await popup.waitFor(); await waitForOption(primary.title); await page.keyboard.press('Home'); await waitForOption(primary.title); await page.keyboard.press('ArrowDown'); await waitForOption(tools.title); await page.keyboard.press('ArrowDown'); await waitForOption(empty.title); await page.keyboard.press('Enter');
      draftId = await opening.entered; await popup.waitFor({ state: 'detached' }); await frames();
      assert.equal(await trigger.isDisabled(), true, 'the picker prevents duplicate creation while the response is pending');
      opening.release(); const created = await createdResponse;
      assert.deepEqual(created.request().postDataJSON().params, { projectId: empty.id, draft: true });
      assert.equal((await created.json()).value.sessionId, draftId);
      await trigger.getByText(empty.title, { exact: true }).waitFor();
      await page.getByRole('region', { name: '代码工作区空态', exact: true }).waitFor(); await draftNotice.waitFor(); await waitForEnabled(); await waitForFocus();
    } finally { opening.release(); }
    assert.equal(stateFor(draftId).draft, true); assert.equal(stateFor(draftId).projectId, empty.id);
    assert.equal(await dialog.count(), 0, 'selecting an empty repository must not open management');
    assert.equal(await page.getByLabel('阅读目标', { exact: true }).isVisible(), false, 'repository navigation does not open the question-reading form');
    assert.equal(await page.locator('.cr-document-tab-button[data-document-kind="reading"]').count(), 0, 'repository navigation does not create a reading document tab');
    assert.deepEqual(savedIds(), savedBefore, 'source browsing allocates no persisted reading archive');
    assert.equal(await sidebar.locator('.cr-session').count(), savedBefore.flat().length, 'the temporary reading is absent from the reading list');
    assert.equal(await activePreference(page), primary.sessions[0].id, 'the prior saved reading preference remains unchanged');
    assert.equal(await page.evaluate(id => Object.values(localStorage).some(value => value.includes(id)), draftId), false, 'no localStorage entry contains the temporary session id');
    assert.equal(mutations(), before + 2, 'empty repository navigation creates only one memory draft, with no model or project mutation');
    await page.screenshot({ path: path.join(output, 'project-select-empty-workspace.png'), fullPage: true });

    await trigger.click(); await popup.getByRole('option', { name: empty.title, exact: true, selected: true }).click(); await popup.waitFor({ state: 'detached' }); await frames();
    assert.equal(mutations(), before + 2, 'selecting the current draft-backed repository again must not allocate another draft');
    await showFiles(); await page.locator(`.cr-tree-root[data-repo-id="${empty.repositories[0].id}"]`).waitFor();
    await page.locator('.cr-tree-file[title="entry.ts"]').click(); await page.getByLabel('文件阅读器', { exact: true }).locator('[data-code-line="41"]').waitFor();
    assert.equal(requests.filter(row => row.method === 'view-file').at(-1).params.sessionId, draftId, 'the directly opened workspace browses source through its temporary session');
    assert.equal(await page.getByLabel('阅读目标', { exact: true }).isVisible(), false);
    assert.equal(requests.some(row => row.method === 'reader-state' && row.params.sessionId === draftId), false, 'temporary source navigation does not persist reading position metadata');

    const discarded = waitForMethod(page, 'discard-draft', params => params.sessionId === draftId);
    const restoredPrimary = waitForMethod(page, 'snapshot', params => params.sessionId === primary.sessions[0].id);
    await trigger.click(); await popup.getByRole('option', { name: primary.title, exact: true }).click(); await restoredPrimary; await discarded;
    await trigger.getByText(primary.title, { exact: true }).waitFor(); await draftNotice.waitFor({ state: 'detached' });
    assert.equal(stateFor(draftId), undefined, 'leaving the empty repository discards its temporary session');
    assert.equal(await activePreference(page), primary.sessions[0].id); assert.deepEqual(savedIds(), savedBefore);
    assert.equal(mutations(), before + 2, 'leaving the temporary workspace does not create a replacement reading');

    // Existing document tabs remain navigable while the picker is busy. A late
    // creation must respect that newer navigation and explicitly discard its draft.
    const alternate = primary.sessions[1]; await selectSession(alternate.topic); await selectSession(primary.sessions[0].topic);
    const alternateTab = page.getByRole('navigation', { name: '打开的文档', exact: true }).locator('.cr-document-tab-button[data-document-kind="reading"]').filter({ hasText: alternate.topic });
    await alternateTab.waitFor(); const pendingCreation = holdNextCreate();
    try {
      const lateCreated = waitForMethod(page, 'create-session', params => params.projectId === empty.id);
      await trigger.click(); await popup.getByRole('option', { name: empty.title, exact: true }).click();
      const abandonedId = await pendingCreation.entered; assert.equal(stateFor(abandonedId).draft, true);
      const discardedLate = waitForMethod(page, 'discard-draft', params => params.sessionId === abandonedId);
      await alternateTab.click(); await page.getByRole('heading', { name: alternate.topic, level: 1, exact: true }).waitFor();
      await page.waitForFunction(expected => localStorage.getItem('dsh-code-reading:active') === expected, alternate.id);
      pendingCreation.release(); const response = await lateCreated; await discardedLate; await waitForEnabled(); await frames();
      assert.deepEqual(response.request().postDataJSON().params, { projectId: empty.id, draft: true });
      assert.equal(stateFor(abandonedId), undefined, 'a late empty-project draft is discarded after newer navigation');
      assert.equal(await alternateTab.getAttribute('aria-pressed'), 'true', 'late repository creation cannot replace the reading chosen by the user');
      assert.equal(await activePreference(page), alternate.id); assert.deepEqual(savedIds(), savedBefore);
      assert.equal(await dialog.count(), 0); assert.equal(await draftNotice.count(), 0);
      assert.equal(requests.some(row => row.method === 'snapshot' && row.params.sessionId === abandonedId), false, 'an abandoned late draft is never opened');
      assert.equal(await page.evaluate(id => Object.values(localStorage).some(value => value.includes(id)), abandonedId), false);
      assert.equal(mutations(), before + 3, 'late creation and cleanup never retry, create a saved reading or admit a model turn');
    } finally { pendingCreation.release(); }
    await selectSession(primary.sessions[0].topic);

    await page.evaluate(() => { for (const [key, value] of Object.entries({ '--dsw-alias-bg-base': '#18181b', '--dsw-alias-bg-layer-1': '#222228', '--dsw-alias-border-l1': '#454550', '--dsw-alias-label-primary': '#fafafa', '--dsw-alias-label-secondary': '#b7bbc6' })) document.documentElement.style.setProperty(key, value); });
    await page.setViewportSize({ width: 375, height: 820 }); await trigger.click(); await popup.waitFor(); await assertBounds();
    assert.equal(await popup.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(24, 24, 27)');
    await page.screenshot({ path: path.join(output, 'project-select-dark-narrow.png'), fullPage: true });
    await screenshotPicker('project-select-preview-dark.png');
    await page.keyboard.press('Escape'); await popup.waitFor({ state: 'detached' }); await waitForFocus();
    assert.equal(mutations(), before + 3, 'opening and cancelling the narrow picker adds no session or model mutation');

    await page.setViewportSize(viewport);
    await trigger.click(); await popup.getByRole('option', { name: tools.title, exact: true }).click(); await trigger.getByText(tools.title, { exact: true }).waitFor();
    const removedBefore = requests.filter(row => row.method === 'remove-project').length;
    const manage = async () => { await trigger.click(); await popup.waitFor(); await waitForOption(tools.title); await page.keyboard.press('End'); await waitForOption('管理仓库…'); await page.keyboard.press('Enter'); await page.getByRole('dialog', { name: '阅读仓库', exact: true }).waitFor(); };
    await manage();
    assert.equal(await activePreference(page), tools.sessions[0].id, 'the explicit management entry does not switch the active reading');
    assert.equal(mutations(), before + 3, 'opening management makes no session, project or model mutation');
    await page.getByRole('button', { name: `删除仓库：${tools.title}`, exact: true }).click();
    const removeDialog = page.getByRole('dialog', { name: '删除仓库', exact: true }); await removeDialog.waitFor();
    await removeDialog.getByText(/不会删除磁盘上的源码目录/).waitFor();
    assert.equal(await removeDialog.getByRole('button', { name: '确认移除', exact: true }).isEnabled(), true);
    await removeDialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(requests.filter(row => row.method === 'remove-project').length, removedBefore, 'cancelling deletion makes no mutation');
    await page.getByRole('button', { name: `删除仓库：${tools.title}`, exact: true }).click(); await removeDialog.waitFor();
    setRemoveMode('unsupported'); await removeDialog.getByRole('button', { name: '确认移除', exact: true }).click();
    await removeDialog.getByRole('alert').filter({ hasText: '本次删除未执行' }).waitFor();
    assert.equal(await removeDialog.getByRole('button', { name: '确认移除', exact: true }).isDisabled(), true);
    assert.equal(tools.removedAt, undefined, 'unsupported deletion cannot hide or remove the project');
    assert.equal(requests.filter(row => row.method === 'remove-project').length, removedBefore + 1, 'UNKNOWN_METHOD makes exactly one request, never retries or falls back to filesystem deletion');
    await page.screenshot({ path: path.join(output, 'repository-remove-host-outdated.png'), fullPage: true });
    await removeDialog.getByRole('button', { name: '取消', exact: true }).click(); await page.getByRole('button', { name: '关闭阅读仓库', exact: true }).click();
    setRemoveMode('healthy'); await page.getByRole('button', { name: '重试连接与加载', exact: true }).click();
    await trigger.getByText(tools.title, { exact: true }).waitFor(); await page.waitForFunction(() => document.querySelector('[role="combobox"][aria-label="阅读项目切换"]')?.disabled === false);
    assert.equal(requests.filter(row => row.method === 'remove-project').length, removedBefore + 1, 'reconnecting cannot replay the failed mutation');
    assert.equal(await page.getByRole('alert').filter({ hasText: '本次删除未执行' }).count(), 0, 'a verified updated Host clears only the stale version error');
    await manage(); await page.getByRole('button', { name: `删除仓库：${tools.title}`, exact: true }).click(); await removeDialog.waitFor();
    await page.screenshot({ path: path.join(output, 'repository-remove-confirmation.png'), fullPage: true });
    const removal = page.waitForResponse(response => response.url().endsWith('/api/code-reading') && response.request().postDataJSON()?.method === 'remove-project');
    await removeDialog.getByRole('button', { name: '确认移除', exact: true }).click(); await removal; await removeDialog.waitFor({ state: 'detached' });
    await page.locator('.cr-welcome h1').waitFor();
    assert.notEqual(await page.evaluate(() => localStorage.getItem('dsh-code-reading:active')), tools.sessions[0].id, 'removal clears the active session preference');
    await trigger.click(); await popup.waitFor(); assert.equal(await popup.getByRole('option', { name: tools.title, exact: true }).count(), 0, 'removed project disappears from the selector');
    await popup.getByRole('option', { name: primary.title, exact: true }).click(); await trigger.getByText(primary.title, { exact: true }).waitFor();
    assert.deepEqual(requests.filter(row => row.method === 'remove-project').at(-1).params, { projectId: tools.id, expectedBindingRevision: 1 });
    assert.equal(tools.sessions.length, 1, 'removal never deletes the stored reading archive');
    assert.equal(mutations(), before + 3, 'management and removal never create further sessions or call a model');
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'project-select-failure.png'), fullPage: true }).catch(() => {});
    await writeFile(path.join(output, 'project-select-failure.json'), JSON.stringify({ message: error.message, requests: requests.slice(-20), dom: await page.evaluate(() => ({ dialogs: [...document.querySelectorAll('dialog')].map(node => node.outerHTML), focus: document.activeElement?.outerHTML, popup: document.querySelector('.cr-project-options')?.outerHTML, text: document.body.innerText })) }, null, 2));
    throw error;
  } finally {
    if (await popup.count()) { await page.keyboard.press('Escape'); await popup.waitFor({ state: 'detached' }); }
    await page.evaluate(value => { document.documentElement.style.cssText = value; }, theme);
    await page.setViewportSize(viewport); reset(); await refresh();
  }
  return { passed: true, keyboard: true, pointer: true, existingProjectReusesSession: true, emptyProjectCreatesDraftOnly: true, emptyProjectOpensCodeWorkspace: true, noReadingFormOnSwitch: true, draftSourceBrowsable: true, currentDraftProjectReused: true, draftAbsentFromList: true, draftNotStoredInBrowser: true, failedCreateKeepsCurrentProject: true, switchedDraftDiscarded: true, lateCreateDoesNotStealNavigation: true, lateCreateDraftDiscarded: true, managementEntry: true, removeConfirmation: true, removeCancelNoMutation: true, oldHostRejectionRetainsProject: true, oldHostMutationDisabled: true, reconnectDoesNotReplayRemoval: true, removedActivePreferenceCleared: true, removedProjectAbsent: true, archivesRetained: true, noModelRequest: true, darkTheme: true, narrowWidth: 375 };
}
