import assert from 'node:assert/strict';
import path from 'node:path';

// Exercise the actual portal from the built Client, not a separately bundled mock.
// Model ids contain NUL internally; neither the trigger nor DOM option values are
// a serialization contract. Observe visible labels, ARIA selection and API payloads.
export const modelTrigger = page => page.getByRole('combobox', { name: '阅读模型', exact: true, includeHidden: true }).filter({ visible: true });
export const modelPopup = page => page.getByRole('listbox', { name: '阅读模型', exact: true });
export async function waitForModel(page, provider, name) {
  const trigger = modelTrigger(page);
  await trigger.getByText(provider, { exact: true }).waitFor();
  await trigger.getByText(name, { exact: true }).waitFor();
  assert.equal(await trigger.isVisible(), true);
}
export async function assertModelDisabled(page, reason) {
  await page.waitForFunction(() => document.querySelector('[role="combobox"][aria-label="阅读模型"]')?.disabled === true);
  assert.equal(await modelTrigger(page).isDisabled(), true, reason);
  assert.equal(await modelPopup(page).count(), 0, 'a disabled model picker cannot retain an open popup');
}
export const longModelGroups = [
  { id: 'local', name: '本地', models: [{ id: 'private-reader', name: 'Private Reader' }, ...Array.from({ length: 24 }, (_, index) => ({ id: `local-${index}`, name: `Local Reader ${index + 1}` }))] },
  { id: 'remote', name: '远程', models: [{ id: 'cloud-reader', name: 'Cloud Reader' }, ...Array.from({ length: 24 }, (_, index) => ({ id: `remote-${index}`, name: `Cloud Reader ${index + 1}` }))] },
  { id: 'long-provider', name: '名称很长的企业提供方，用于验证窄屏换行与分组', models: [{ id: 'last-reader', name: '最后一个模型：支持非常长的名称，弹层仍应限制宽度并保持键盘滚动可达' }] },
];

export async function verifyModelSelect({ page, output, requests, sessionId, refresh, setCatalogMode, setCurrentModel, holdSelection }) {
  const trigger = modelTrigger(page); const popup = modelPopup(page);
  const selections = () => requests.filter(row => row.method === 'select-model');
  const prompts = () => requests.filter(row => row.method === 'prompt').length;
  const beforePrompts = prompts(); const initialSelections = selections().length;
  const focusReturned = async () => page.waitForFunction(() => document.activeElement?.matches('[role="combobox"][aria-label="阅读模型"]'));
  const focusedOption = async name => page.waitForFunction(expected => {
    const option = document.activeElement;
    return option?.getAttribute('role') === 'option' && option.textContent.replace(/\s+/g, ' ').trim() === expected;
  }, name);
  const selectedOption = async name => {
    await popup.getByRole('option', { name, exact: true, selected: true }).waitFor();
    assert.equal(await popup.getByRole('option', { selected: true }).count(), 1);
  };
  const closePopup = async () => { await page.keyboard.press('Escape'); await popup.waitFor({ state: 'detached' }); await focusReturned(); };
  const assertBounds = async () => {
    const metrics = await popup.evaluate(node => { const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight, documentWidth: document.documentElement.scrollWidth }; });
    assert.ok(metrics.x >= -1 && metrics.y >= -1 && metrics.right <= metrics.viewportWidth + 1 && metrics.bottom <= metrics.viewportHeight + 1, `popup must stay in viewport: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.width <= metrics.viewportWidth - 23 && metrics.height <= 361, 'popup is bounded, including long provider/model names');
    assert.ok(metrics.documentWidth <= metrics.viewportWidth, 'a portal cannot cause document-wide horizontal overflow');
  };

  await waitForModel(page, '远程', 'Cloud Reader');
  assert.equal(await trigger.evaluate(node => node.tagName), 'BUTTON', 'model picker is a custom accessible trigger, not a native select');
  await trigger.focus(); await page.keyboard.press('ArrowDown'); await popup.waitFor();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(await popup.evaluate(node => node.closest('.cr-page') === null), true, 'the real popup is portaled outside the reading panel');
  await selectedOption('远程 · Cloud Reader');
  await page.keyboard.press('Home'); await focusedOption('本地 · Private Reader');
  await page.keyboard.press('End'); await focusedOption('远程 · Cloud Reader');
  await page.keyboard.press('ArrowUp'); await focusedOption('本地 · Private Reader');
  await page.keyboard.press('ArrowDown'); await focusedOption('远程 · Cloud Reader');
  await page.keyboard.press('Home'); await focusedOption('本地 · Private Reader');
  await closePopup(); await waitForModel(page, '远程', 'Cloud Reader');
  assert.equal(selections().length, initialSelections, 'navigation and Escape do not commit a highlighted option');

  await page.keyboard.press('ArrowUp'); await popup.waitFor();
  await page.keyboard.press('Home'); await focusedOption('本地 · Private Reader');
  await page.keyboard.press('Enter'); await popup.waitFor({ state: 'detached' });
  await waitForModel(page, '本地', 'Private Reader'); await focusReturned();
  assert.deepEqual(selections().slice(initialSelections).map(row => row.params), [{ sessionId, provider: 'local', model: 'private-reader' }], 'Enter commits exactly one fully qualified model payload');
  assert.equal(await page.getByRole('dialog', { name: '确认源码发送范围', exact: true }).count(), 0, 'model selection does not itself ask to send source');

  const pointerStart = selections().length; const held = holdSelection();
  await trigger.click(); await selectedOption('本地 · Private Reader');
  await popup.getByRole('option', { name: '远程 · Cloud Reader', exact: true }).click(); await held.seen;
  try {
    await assertModelDisabled(page, 'an in-flight select-model operation disables the trigger');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    assert.equal(await popup.count(), 0, 'busy keyboard input cannot reopen the picker');
    assert.deepEqual(selections().slice(pointerStart).map(row => row.params), [{ sessionId, provider: 'remote', model: 'cloud-reader' }], 'one pointer choice emits exactly one select-model request');
  } finally { held.release(); }
  await waitForModel(page, '远程', 'Cloud Reader');
  await page.waitForFunction(() => document.querySelector('[role="combobox"][aria-label="阅读模型"]')?.disabled === false);

  const beforeFallback = selections().length;
  setCurrentModel({ provider: 'retired-provider', model: 'retired-reader' }); await refresh();
  await waitForModel(page, 'retired-provider', 'retired-reader');
  await trigger.getByText('当前会话', { exact: true }).waitFor();
  await trigger.click(); await selectedOption('retired-provider · retired-reader');
  assert.equal(await popup.getByRole('option').count(), 3, 'unknown current model coexists with the catalog instead of silently changing it');
  await closePopup();
  setCatalogMode('empty'); await refresh();
  await waitForModel(page, 'retired-provider', 'retired-reader');
  assert.equal(await trigger.isDisabled(), false, 'a missing catalog retains the explicit current-session fallback');
  await trigger.click(); await selectedOption('retired-provider · retired-reader');
  assert.equal(await popup.getByRole('option').count(), 1); await closePopup();
  assert.equal(selections().length, beforeFallback, 'unknown-current rendering and empty catalog recovery cannot select a default');

  setCurrentModel({ provider: 'remote', model: 'cloud-reader' }); setCatalogMode('long'); await refresh();
  await waitForModel(page, '远程', 'Cloud Reader');
  const viewport = page.viewportSize();
  const dark = { '--dsw-alias-bg-base': '#18181b', '--dsw-alias-bg-layer-1': '#27272a', '--dsw-alias-border-l1': '#52525b', '--dsw-alias-label-primary': '#fafafa', '--dsw-alias-label-secondary': '#d4d4d8', '--dsw-alias-brand-primary': '#8298ff' };
  const previousTheme = await page.evaluate(keys => keys.map(key => [key, document.documentElement.style.getPropertyValue(key), document.documentElement.style.getPropertyPriority(key)]), Object.keys(dark));
  try {
    await trigger.click(); await selectedOption('远程 · Cloud Reader');
    assert.equal(await popup.getByRole('option').count(), 51, 'long fixture includes every provider/model option');
    await assertBounds();
    const lightBackground = await popup.evaluate(node => getComputedStyle(node).backgroundColor);
    await page.screenshot({ path: path.join(output, 'model-popup-light-long.png'), fullPage: true, animations: 'disabled' });
    await page.keyboard.press('End');
    await focusedOption(`${longModelGroups.at(-1).name} · ${longModelGroups.at(-1).models[0].name}`);
    assert.ok(await popup.locator('.cr-select-viewport').evaluate(node => node.scrollTop > 0), 'End scrolls the final option into the bounded viewport');
    const finalOption = await popup.getByRole('option').last().boundingBox(); const popupBox = await popup.boundingBox();
    assert.ok(finalOption.y >= popupBox.y - 1 && finalOption.y + finalOption.height <= popupBox.y + popupBox.height + 1, 'keyboard-focused final model is visible, not clipped below the popup');
    await page.keyboard.press('Home'); await focusedOption('本地 · Private Reader'); await closePopup();

    await page.evaluate(palette => { for (const [key, value] of Object.entries(palette)) document.documentElement.style.setProperty(key, value); }, dark);
    await trigger.click(); await selectedOption('远程 · Cloud Reader'); await assertBounds();
    const darkColors = await popup.evaluate(node => ({ background: getComputedStyle(node).backgroundColor, text: getComputedStyle(node).color }));
    assert.equal(darkColors.background, 'rgb(24, 24, 27)', 'portal follows DSH background tokens outside .cr-page');
    assert.equal(darkColors.text, 'rgb(250, 250, 250)'); assert.notEqual(darkColors.background, lightBackground);
    await page.screenshot({ path: path.join(output, 'model-popup-dark-long.png'), fullPage: true, animations: 'disabled' }); await closePopup();
    await page.setViewportSize({ width: 480, height: 900 }); await trigger.click(); await selectedOption('远程 · Cloud Reader'); await assertBounds();
    await page.keyboard.press('End'); await focusedOption(`${longModelGroups.at(-1).name} · ${longModelGroups.at(-1).models[0].name}`); await assertBounds();
    await page.screenshot({ path: path.join(output, 'model-popup-narrow-long.png'), fullPage: true, animations: 'disabled' }); await closePopup();
  } finally {
    if (await popup.count()) { await page.keyboard.press('Escape'); await popup.waitFor({ state: 'detached' }); }
    await page.setViewportSize(viewport);
    await page.evaluate(rows => { for (const [key, value, priority] of rows) value ? document.documentElement.style.setProperty(key, value, priority) : document.documentElement.style.removeProperty(key); }, previousTheme);
    setCatalogMode('healthy'); setCurrentModel({ provider: 'remote', model: 'cloud-reader' }); await refresh();
  }
  await waitForModel(page, '远程', 'Cloud Reader');
  assert.equal(prompts(), beforePrompts, 'keyboard, pointer, fallback and presentation checks cannot invoke a model');
  assert.equal(selections().length, initialSelections + 2, 'only explicit Enter and pointer commits mutate the selected model');
  return { passed: true, keyboard: ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Escape', 'focus return'], pointerSinglePayload: true, noImplicitPrompt: true, unknownCurrentFallback: true, busyDisabled: true, longListOptions: 51, themes: ['light', 'dark'], narrowWidth: 480 };
}
