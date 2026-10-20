import assert from 'node:assert/strict';
import path from 'node:path';
import { modelPopup, modelTrigger, waitForModel } from './browser-model-check.mjs';

const temporaryNotice = '临时阅读，开始前不会保存到阅读列表。';
const activePreference = page => page.evaluate(() => localStorage.getItem('dsh-code-reading:active'));
const remountPreservingPreference = page => page.evaluate(() => {
  window.readingRoot.unmount(); window.readingRoot = window.createRoot(document.getElementById('root')); window.renderReadingPanel();
});
const waitForMethod = (page, method, matches = () => true) => page.waitForResponse(response => {
  if (!response.url().endsWith('/api/code-reading')) return false;
  const body = response.request().postDataJSON(); return body?.method === method && matches(body.params);
});
const unavailable = async (locator, message) => {
  for (const item of await locator.all()) assert.ok(!await item.isVisible() || await item.isDisabled(), message);
};

// Exercises the actual bundled Client with only the intercepted fixtures from
// browser-test.mjs. It never starts a server, accesses user archives or admits a
// real model request. Fixture callbacks inspect mock state, not Client internals.
export async function verifySessionLifecycle({ page, output, requests, project, sessionId, topic, alternateId, alternateTopic, lessonTitle, selectSession, selectLesson, openHistory, openCitation, showFiles, refresh, stateFor, holdNextCreate }) {
  const sidebar = page.locator('aside[aria-label="阅读列表"]');
  const ongoing = sidebar.getByRole('button', { name: '阅读中', exact: true });
  const archived = sidebar.getByRole('button', { name: '已归档', exact: true });
  const newReading = sidebar.locator('.cr-new-reading');
  const draftNotice = page.locator('.cr-editor-statusbar .cr-draft-notice[role="status"]').filter({ hasText: temporaryNotice });
  const row = title => sidebar.locator('.cr-session-row').filter({ has: page.locator('.cr-session-title').filter({ hasText: title }) });
  const count = method => requests.filter(request => request.method === method).length;
  const storedIds = () => project.sessions.map(session => session.id);
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const readingTab = () => page.getByRole('navigation', { name: '打开的文档', exact: true }).locator('.cr-document-tab:has(.cr-document-tab-button[data-document-kind="reading"][aria-pressed="true"])');

  await openHistory(); await ongoing.waitFor();
  assert.equal(await ongoing.getAttribute('aria-pressed'), 'true'); assert.equal(await archived.getAttribute('aria-pressed'), 'false');
  await selectSession(topic); await selectLesson(lessonTitle); await page.getByRole('heading', { name: lessonTitle, exact: true }).waitFor();
  const beforeArchivePrompts = count('prompt'); const beforeArchiveRevision = stateFor(sessionId).revision; const archiveRevision = stateFor(sessionId).archiveRevision ?? 0;
  const archiveAction = row(topic).getByRole('button', { name: `归档阅读：${topic}`, exact: true });
  await archiveAction.waitFor(); assert.equal((await archiveAction.innerText()).trim(), '归档', 'archive action is visible text, not an icon-only affordance');
  const archivedResponse = waitForMethod(page, 'set-session-archived', params => params.sessionId === sessionId && params.archived === true);
  await archiveAction.click(); await archivedResponse;
  const archiveNotice = page.locator('.cr-archived-notice[role="status"]'); await archiveNotice.waitFor();
  await page.getByRole('heading', { name: lessonTitle, exact: true }).waitFor();
  await row(topic).waitFor({ state: 'detached' });
  assert.equal(await row(topic).count(), 0, 'archiving removes the active record from 阅读中 without deleting its detail');
  assert.equal(await activePreference(page), sessionId, 'archiving does not clear or replace the viewed persisted reading');
  assert.ok(stateFor(sessionId).archivedAt); assert.equal(stateFor(sessionId).archiveRevision, archiveRevision + 1);
  assert.equal(stateFor(sessionId).revision, beforeArchiveRevision, 'archive metadata does not consume the compatibility stage revision');
  await unavailable(page.getByRole('button', { name: /^(继续阅读|发送问题|开始阅读|重试本次分析)$/ }), 'archived details cannot send or retry questions');
  await unavailable(page.getByLabel('追问当前知识点', { exact: true }), 'archived question input is absent, hidden or disabled');

  const beforeFilterRequests = requests.length; await archived.click(); await row(topic).locator('.cr-session').waitFor();
  assert.equal(await archived.getAttribute('aria-pressed'), 'true'); assert.equal(await ongoing.getAttribute('aria-pressed'), 'false');
  const rowRestore = row(topic).getByRole('button', { name: `恢复阅读：${topic}`, exact: true });
  assert.equal((await rowRestore.innerText()).trim(), '恢复');
  assert.equal(requests.slice(beforeFilterRequests).some(request => ['prompt', 'create-session', 'set-session-archived'].includes(request.method)), false, 'list filters only navigate and never mutate or call a model');
  await page.screenshot({ path: path.join(output, 'session-archived.png'), fullPage: true, animations: 'disabled' });

  await remountPreservingPreference(page); await archiveNotice.waitFor(); await openHistory(); await archived.click();
  await row(topic).locator('.cr-session').click(); await page.getByRole('heading', { name: lessonTitle, exact: true }).waitFor();
  assert.equal(await activePreference(page), sessionId, 'an archived active reading remains viewable after panel remount');
  await openCitation('订单入口'); const viewer = page.getByLabel('文件阅读器', { exact: true }); await viewer.locator('[data-code-line="41"]').waitFor();
  await viewer.evaluate(root => {
    const code = root.querySelector('[data-code-line="41"] [data-code-text]'); if (!code?.textContent) throw new Error('fixture source line is unavailable');
    root.querySelector('pre').focus({ preventScroll: true }); const range = document.createRange(); range.selectNodeContents(code);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); code.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  const explainSelection = page.getByRole('button', { name: '解释这段', exact: true }); await explainSelection.waitFor();
  assert.equal(await explainSelection.isDisabled(), true, 'archived source remains readable but cannot start a selection explanation');
  await page.keyboard.press('Shift+F10'); await page.getByRole('menu', { name: '代码选区操作', exact: true }).waitFor();
  for (const name of ['让 AI 分析选中代码', 'AI 生成逻辑图']) {
    const action = page.getByRole('menuitem', { name, exact: true }); assert.equal(await action.isDisabled(), true, `archived source blocks ${name}`);
    await action.dispatchEvent('click');
  }
  await frames(); assert.equal(count('prompt'), beforeArchivePrompts); assert.equal(await page.getByRole('dialog', { name: '确认源码发送范围', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await sidebar.getByRole('button', { name: '收起列表', exact: true }).click(); await page.getByRole('button', { name: '展开列表', exact: true }).waitFor();
  assert.equal(await viewer.isVisible(), true, 'focus regression starts with source visible and the reading sidebar collapsed');
  const restoredResponse = waitForMethod(page, 'set-session-archived', params => params.sessionId === sessionId && params.archived === false);
  await archiveNotice.getByRole('button', { name: '恢复阅读', exact: true }).click(); await restoredResponse; await archiveNotice.waitFor({ state: 'detached' });
  await page.waitForFunction(() => {
    const active = document.activeElement;
    return !!active && active !== document.body && active.getClientRects().length > 0 && getComputedStyle(active).visibility === 'visible'
      && active.matches('.cr-document-tab[data-active="true"] .cr-document-tab-button, .cr-route-toolbar button[aria-label="展开列表"]');
  });
  assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'BODY', 'restoring from the source-view banner focuses a visible active document tab or sidebar opener, never body');
  assert.equal(await viewer.isVisible(), true, 'restoring an archived reading does not replace the viewed source document');
  await openHistory(); await ongoing.click(); await selectSession(topic); await page.getByRole('heading', { name: lessonTitle, exact: true }).waitFor();
  assert.equal(stateFor(sessionId).archivedAt, null); assert.equal(stateFor(sessionId).archiveRevision, archiveRevision + 2);
  const composer = page.locator('.cr-composer-toggle'); if (await composer.getAttribute('aria-expanded') === 'false') await composer.click();
  assert.equal(await page.getByLabel('追问当前知识点', { exact: true }).isDisabled(), false, 'restoring re-enables continuation of the original reading');

  // Exercise both restore entry points, including a history row that is not
  // replaced with a fake new reading when the original is archived.
  const archivedAgain = waitForMethod(page, 'set-session-archived', params => params.sessionId === sessionId && params.archived === true);
  await row(topic).getByRole('button', { name: `归档阅读：${topic}`, exact: true }).click(); await archivedAgain; await archiveNotice.waitFor(); await archived.click();
  const restoredFromRow = waitForMethod(page, 'set-session-archived', params => params.sessionId === sessionId && params.archived === false);
  await row(topic).getByRole('button', { name: `恢复阅读：${topic}`, exact: true }).click(); await restoredFromRow; await archiveNotice.waitFor({ state: 'detached' });
  await ongoing.click(); await selectSession(topic); assert.equal(count('prompt'), beforeArchivePrompts, 'archive, restore, source viewing and filters never call a model');
  assert.equal(stateFor(sessionId).revision, beforeArchiveRevision); assert.equal(stateFor(sessionId).archiveRevision, archiveRevision + 4);

  const savedBeforeDrafts = storedIds(); const beforeDraftPrompts = count('prompt');
  // Keep an existing reading tab available while the create response is held;
  // list rows are deliberately disabled by busy, but document tabs still navigate.
  await selectSession(alternateTopic); await selectSession(topic);
  const alternateTab = page.getByRole('navigation', { name: '打开的文档', exact: true }).locator('.cr-document-tab-button[data-document-kind="reading"]').filter({ hasText: alternateTopic });
  await alternateTab.waitFor(); const pendingCreation = holdNextCreate();
  try {
    const createdResponse = waitForMethod(page, 'create-session', params => params.projectId === project.id);
    await newReading.click(); const abandonedId = await pendingCreation.entered;
    assert.equal(stateFor(abandonedId).draft, true, 'the fixture allocated the held draft without saving a history row');
    const discardedLateDraft = waitForMethod(page, 'discard-draft', params => params.sessionId === abandonedId);
    await alternateTab.click(); await page.getByRole('heading', { name: alternateTopic, level: 1, exact: true }).waitFor();
    await page.waitForFunction(expected => localStorage.getItem('dsh-code-reading:active') === expected, alternateId);
    pendingCreation.release(); await createdResponse; await discardedLateDraft;
    await page.waitForFunction(() => document.querySelector('[role="combobox"][aria-label="阅读项目切换"]')?.disabled === false); await frames();
    assert.equal(stateFor(abandonedId), undefined, 'a late create response is explicitly discarded after the user navigates away');
    assert.equal(await alternateTab.getAttribute('aria-pressed'), 'true', 'a late create response cannot replace the existing reading chosen by the user');
    assert.equal(await activePreference(page), alternateId); assert.equal(await draftNotice.count(), 0); assert.deepEqual(storedIds(), savedBeforeDrafts);
    assert.equal(requests.some(request => request.method === 'snapshot' && request.params.sessionId === abandonedId), false, 'an abandoned late draft is never opened or loaded');
    assert.equal(count('prompt'), beforeDraftPrompts, 'discarding a late creation never admits a model turn');
  } finally { pendingCreation.release(); }
  await selectSession(topic);
  const createDraft = async () => {
    const response = waitForMethod(page, 'create-session', params => params.projectId === project.id);
    await newReading.click(); const result = await response; assert.equal(result.request().postDataJSON().params.draft, true);
    const id = (await result.json()).value.sessionId;
    await page.getByLabel('阅读目标', { exact: true }).waitFor(); await draftNotice.waitFor();
    assert.equal(stateFor(id).draft, true); assert.deepEqual(storedIds(), savedBeforeDrafts, 'new reading allocates only an in-memory draft');
    assert.notEqual(await activePreference(page), id, 'temporary reading ids never enter the existing active-session localStorage preference');
    assert.equal(await sidebar.locator('.cr-session').count(), savedBeforeDrafts.length, 'only saved readings appear in either lifecycle list');
    return id;
  };
  const firstDraft = await createDraft(); const createsAfterFirstDraft = count('create-session');
  await page.getByLabel('阅读目标', { exact: true }).fill('UNSENT_TEMPORARY_READING_ONLY');
  await newReading.click(); await frames();
  assert.equal(count('create-session'), createsAfterFirstDraft, 'repeated 新建阅读 reuses the current project draft');
  assert.equal(await page.getByLabel('阅读目标', { exact: true }).inputValue(), 'UNSENT_TEMPORARY_READING_ONLY', 'reopening the same temporary reading preserves edits until it is explicitly closed');
  const draftCloseLabel = await readingTab().getByRole('button', { name: /^关闭阅读 / }).getAttribute('aria-label');
  await showFiles(); await page.locator('.cr-tree-file[title="entry.ts"]').click(); await viewer.locator('[data-code-line="41"]').waitFor();
  await page.getByRole('button', { name: draftCloseLabel, exact: true }).click(); await viewer.locator('[data-code-line="41"]').waitFor();
  assert.deepEqual(storedIds(), savedBeforeDrafts, 'closing an unstarted reading tab does not persist it');
  assert.equal(stateFor(firstDraft).draft, true, 'closing the tab may retain the in-memory session needed by source browsing');
  await newReading.click(); await page.getByLabel('阅读目标', { exact: true }).waitFor();
  assert.equal(count('create-session'), createsAfterFirstDraft, 'reopening a closed temporary tab reuses the same memory draft');
  assert.equal(await page.getByLabel('阅读目标', { exact: true }).inputValue(), '', 'closing a temporary reading clears its unsent question');
  assert.equal(requests.some(request => request.method === 'reader-state' && request.params.sessionId === firstDraft), false, 'temporary navigation does not persist reader-position metadata');
  await page.getByLabel('阅读目标', { exact: true }).fill('DISCARDED_TEMPORARY_READING_ONLY');
  const discarded = waitForMethod(page, 'discard-draft', params => params.sessionId === firstDraft);
  await selectSession(topic); await discarded;
  assert.equal(stateFor(firstDraft), undefined, 'switching to a saved reading cleans up its abandoned memory draft'); assert.deepEqual(storedIds(), savedBeforeDrafts);
  assert.equal(await activePreference(page), sessionId);

  const reloadDraft = await createDraft(); await page.getByLabel('阅读目标', { exact: true }).fill('NOT_RESTORED_AFTER_PANEL_REMOUNT');
  await remountPreservingPreference(page); await page.getByRole('heading', { name: topic, level: 1, exact: true }).waitFor(); await openHistory();
  assert.equal(await draftNotice.count(), 0, 'panel remount restores the prior saved session, not the temporary one');
  assert.equal(await activePreference(page), sessionId); assert.notEqual(await activePreference(page), reloadDraft); assert.deepEqual(storedIds(), savedBeforeDrafts);
  assert.equal(await page.locator('body').getByText(/UNSENT_TEMPORARY_READING_ONLY|DISCARDED_TEMPORARY_READING_ONLY|NOT_RESTORED_AFTER_PANEL_REMOUNT/).count(), 0);
  assert.equal(count('prompt'), beforeDraftPrompts, 'creating, closing, switching and remounting temporary readings do not call a model');
  assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => /TEMPORARY_READING_ONLY|NOT_RESTORED_AFTER_PANEL_REMOUNT/.test(value))), false, 'temporary question text is not added to browser storage');

  const promotedId = await createDraft(); const promotionGoal = '验证阅读会话的临时保存与恢复';
  await modelTrigger(page).click(); await modelPopup(page).getByRole('option', { name: '本地 · Private Reader', exact: true }).click(); await waitForModel(page, '本地', 'Private Reader');
  assert.equal(stateFor(promotedId).draft, true, 'explicit model choice alone does not save an empty reading'); assert.deepEqual(storedIds(), savedBeforeDrafts);
  await page.getByLabel('阅读目标', { exact: true }).fill(promotionGoal); await page.getByRole('button', { name: '开始阅读', exact: true }).click();
  const consent = page.getByRole('dialog', { name: '确认源码发送范围', exact: true }); await consent.waitFor();
  assert.equal(count('prompt'), beforeDraftPrompts); assert.equal(stateFor(promotedId).draft, true); assert.deepEqual(storedIds(), savedBeforeDrafts);
  await consent.getByRole('button', { name: '暂不发送', exact: true }).click(); await consent.waitFor({ state: 'detached' });
  assert.deepEqual(storedIds(), savedBeforeDrafts, 'declining source consent does not promote the temporary reading');
  await page.getByRole('button', { name: '开始阅读', exact: true }).click(); await consent.waitFor();
  const acceptedPrompt = waitForMethod(page, 'prompt', params => params.sessionId === promotedId);
  await consent.getByRole('button', { name: '确认并开始阅读', exact: true }).click(); await acceptedPrompt;
  await draftNotice.waitFor({ state: 'detached' }); await row(promotionGoal).locator('.cr-session').waitFor();
  await page.getByRole('heading', { name: promotionGoal, level: 1, exact: true }).waitFor();
  assert.equal(stateFor(promotedId).draft, false); assert.deepEqual(storedIds(), [...savedBeforeDrafts, promotedId], 'the first accepted prompt saves the same reading identity exactly once');
  assert.equal(await activePreference(page), promotedId, 'only the promoted reading can become the persisted active session');
  assert.equal(count('prompt'), beforeDraftPrompts + 1, 'only explicit confirmation of the first question reached the fixture admission');
  await refresh(); await row(promotionGoal).locator('.cr-session').waitFor();
  assert.equal(await row(promotionGoal).count(), 1); assert.deepEqual(storedIds(), [...savedBeforeDrafts, promotedId]);
  assert.equal(requests.some(request => request.method === 'discard-draft' && request.params.sessionId === promotedId), false, 'promotion is never followed by draft cleanup of the saved reading');
  await page.screenshot({ path: path.join(output, 'session-draft-promoted.png'), fullPage: true, animations: 'disabled' });
  return { passed: true, archiveFilters: true, archivedDetailReadable: true, archivedPromptBlocked: true, archivedSelectionBlocked: true, archiveSurvivesRemount: true, collapsedSourceRestoreFocusVisible: true, bannerAndRowRestore: true, independentArchiveRevision: true, lateCreateDoesNotStealNavigation: true, lateCreateDraftDiscarded: true, draftAbsentFromList: true, sameDraftReused: true, closedDraftClearsQuestion: true, switchedDraftDiscarded: true, draftNotStoredInBrowser: true, draftNotRestoredAfterRemount: true, consentDeclineKeepsDraft: true, acceptedPromptPromotesOnce: true };
}
