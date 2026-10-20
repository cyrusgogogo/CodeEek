import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

export const projectTrigger = page => page.getByRole('combobox', { name: '阅读项目切换', exact: true, includeHidden: true });
const projectPopup = page => page.getByRole('listbox', { name: '阅读项目切换', exact: true });

export async function verifyProjectSelect({ page, output, requests, refresh, primary, tools, empty, install, reset, setRemoveMode }) {
  const trigger = projectTrigger(page); const popup = projectPopup(page);
  const mutations = () => requests.filter(row => ['prompt', 'create-project', 'create-session', 'select-model'].includes(row.method)).length;
  const before = mutations(); const viewport = page.viewportSize();
  const theme = await page.evaluate(() => document.documentElement.style.cssText);
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
    assert.equal(await page.evaluate(() => localStorage.getItem('dsh-code-reading:active')), tools.sessions[0].id);

    await trigger.click(); await popup.getByRole('option', { name: tools.title, exact: true, selected: true }).waitFor();
    const toPrimary = page.waitForResponse(response => response.url().endsWith('/api/code-reading') && response.request().postDataJSON()?.method === 'snapshot' && response.request().postDataJSON()?.params.sessionId === primary.sessions[0].id);
    await popup.getByRole('option', { name: primary.title, exact: true }).click(); await toPrimary;
    await trigger.getByText(primary.title, { exact: true }).waitFor();
    await trigger.click(); await popup.waitFor(); await waitForOption(primary.title); await page.keyboard.press('Home'); await waitForOption(primary.title); await page.keyboard.press('ArrowDown'); await waitForOption(tools.title); await page.keyboard.press('ArrowDown'); await waitForOption(empty.title); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: '阅读仓库', exact: true }); await dialog.waitFor();
    await dialog.getByRole('heading', { name: empty.title, exact: true }).waitFor();
    assert.equal(mutations(), before, 'selecting a repository without a session must not create one implicitly');
    await dialog.getByRole('button', { name: '关闭阅读仓库', exact: true }).click();
    await trigger.getByText(primary.title, { exact: true }).waitFor();

    await page.evaluate(() => { for (const [key, value] of Object.entries({ '--dsw-alias-bg-base': '#18181b', '--dsw-alias-bg-layer-1': '#222228', '--dsw-alias-border-l1': '#454550', '--dsw-alias-label-primary': '#fafafa', '--dsw-alias-label-secondary': '#b7bbc6' })) document.documentElement.style.setProperty(key, value); });
    await page.setViewportSize({ width: 375, height: 820 }); await trigger.click(); await popup.waitFor(); await assertBounds();
    assert.equal(await popup.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(24, 24, 27)');
    await page.screenshot({ path: path.join(output, 'project-select-dark-narrow.png'), fullPage: true });
    await screenshotPicker('project-select-preview-dark.png');
    await page.keyboard.press('Escape'); await popup.waitFor({ state: 'detached' }); await waitForFocus();
    assert.equal(mutations(), before, 'repository switches only navigate existing sessions');

    await page.setViewportSize(viewport);
    await trigger.click(); await popup.getByRole('option', { name: tools.title, exact: true }).click(); await trigger.getByText(tools.title, { exact: true }).waitFor();
    const removedBefore = requests.filter(row => row.method === 'remove-project').length;
    const manage = async () => { await trigger.click(); await popup.waitFor(); await waitForOption(tools.title); await page.keyboard.press('End'); await waitForOption('管理仓库…'); await page.keyboard.press('Enter'); await page.getByRole('dialog', { name: '阅读仓库', exact: true }).waitFor(); };
    await manage();
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
    assert.equal(mutations(), before, 'management and removal never create sessions or call a model');
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'project-select-failure.png'), fullPage: true }).catch(() => {});
    await writeFile(path.join(output, 'project-select-failure.json'), JSON.stringify({ message: error.message, requests: requests.slice(-20), dom: await page.evaluate(() => ({ dialogs: [...document.querySelectorAll('dialog')].map(node => node.outerHTML), focus: document.activeElement?.outerHTML, popup: document.querySelector('.cr-project-options')?.outerHTML, text: document.body.innerText })) }, null, 2));
    throw error;
  } finally {
    if (await popup.count()) { await page.keyboard.press('Escape'); await popup.waitFor({ state: 'detached' }); }
    await page.evaluate(value => { document.documentElement.style.cssText = value; }, theme);
    await page.setViewportSize(viewport); reset(); await refresh();
  }
  return { passed: true, keyboard: true, pointer: true, emptyProjectDoesNotCreate: true, managementEntry: true, removeConfirmation: true, removeCancelNoMutation: true, oldHostRejectionRetainsProject: true, oldHostMutationDisabled: true, reconnectDoesNotReplayRemoval: true, removedActivePreferenceCleared: true, removedProjectAbsent: true, archivesRetained: true, noModelRequest: true, darkTheme: true, narrowWidth: 375 };
}
