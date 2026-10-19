import assert from 'node:assert/strict';
import path from 'node:path';

export const sampleSource = `/** 提交订单：校验金额，再调用支付服务。
 * 跨行注释必须保持完整的着色上下文。 */
type Order = { id: string; amount: number; currency: "CNY" };

export async function submit(order: Order) {
  const amount = Math.round(order.amount * 100);
  if (amount <= 0) {
    throw new Error("支付金额必须大于 0");
  }
  const result = await paymentClient.charge({
    orderId: order.id,
    amount,
    currency: "CNY",
  });
  return { orderId: order.id, paymentId: result.id, status: "paid" };
}
// 长行阅读：${'保留原始缩进与字符；'.repeat(16)}`;

export async function verifyCodeReadability({ page, output, sourceText, startLine = 41, refresh }) {
  const source = page.getByLabel('文件阅读器', { exact: true });
  await source.locator('[data-token="hljs-keyword"]').first().waitFor();
  assert.equal(await source.locator('.cr-code-language').innerText(), 'TypeScript');
  assert.equal(await source.locator('.cr-code-number').first().innerText(), String(startLine));
  const displayed = () => source.locator('.cr-code-text').evaluateAll(rows => rows.map(row => row.textContent).join('\n'));
  assert.equal(await displayed(), sourceText);
  const metrics = await source.evaluate(element => {
    const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { const x = value / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; });
    const luminance = value => { const [r, g, b] = rgb(value); return .2126 * r + .7152 * g + .0722 * b; };
    const bg = getComputedStyle(element.querySelector('.cr-code-body')).backgroundColor; const background = luminance(bg);
    const colors = Object.fromEntries([...element.querySelectorAll('[data-token]')].filter(node => node.textContent.trim()).map(node => [node.dataset.token, getComputedStyle(node).color]));
    const ratios = Object.fromEntries(Object.entries(colors).map(([kind, color]) => { const fg = luminance(color); return [kind, (Math.max(fg, background) + .05) / (Math.min(fg, background) + .05)]; }));
    return { background: bg, colors, ratios, lineNumberColor: getComputedStyle(element.querySelector('.cr-code-number')).color, fontSize: getComputedStyle(element.querySelector('.cr-code-body')).fontSize };
  });
  for (const kind of ['hljs-keyword', 'hljs-string', 'hljs-number', 'hljs-comment']) assert.ok(metrics.colors[kind], `missing ${kind}`);
  assert.ok(new Set(Object.values(metrics.colors)).size >= 4);
  assert.ok(Math.min(...Object.values(metrics.ratios)) >= 4.5, 'all observed syntax foregrounds must meet WCAG AA normal-text contrast');
  assert.ok(parseFloat(metrics.fontSize) >= 13);
  assert.equal(await page.locator('.cr-stages, .cr-stage-index, .cr-route-stage, .cr-route-stage-button, .cr-welcome-route').count(), 0, 'five-stage navigation must not reappear in any workspace surface');
  assert.equal(await page.getByRole('navigation', { name: '阅读阶段', exact: true }).count(), 0);
  const route = page.locator('.cr-route-list');
  assert.equal(await route.locator('.cr-route-node').count(), 2, 'the reading list contains actual lesson nodes only');
  assert.equal(await route.locator('.cr-route-node[aria-current="true"]').count(), 1, 'selected lesson is explicit without decorative stage progress');
  await source.getByRole('button', { name: '切换代码折行' }).click(); assert.equal(await source.locator('.cr-code-wrap').count(), 1); assert.equal(await displayed(), sourceText);
  assert.equal(typeof refresh, 'function', 'the workbench must provide an explicit user refresh action');
  await refresh(); await source.locator('.cr-code-body').waitFor();
  assert.equal(await source.locator('.cr-code-wrap').count(), 1, 'refresh cannot discard the local reader wrap setting');
  await source.getByRole('button', { name: '切换代码折行' }).click();
  await source.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'code-light.png'), fullPage: true, animations: 'disabled' }); await source.locator('.cr-code').screenshot({ path: path.join(output, 'code-detail.png') });
  const dark = { '--dsw-alias-bg-base': '#18181b', '--dsw-alias-bg-layer-1': '#27272a', '--dsw-alias-bg-layer-2': '#32323a', '--dsw-alias-border-l1': '#52525b', '--dsw-alias-label-primary': '#fafafa', '--dsw-alias-label-secondary': '#d4d4d8', '--dsw-alias-brand-primary': '#8298ff', '--dsw-alias-state-success-primary': '#5ad0ae', '--dsw-alias-state-warn-primary': '#f4bd67' };
  await page.evaluate(palette => { for (const [key, value] of Object.entries(palette)) document.documentElement.style.setProperty(key, value); }, dark);
  assert.equal(await page.locator('.cr-page').evaluate(node => getComputedStyle(node).color), 'rgb(250, 250, 250)');
  assert.equal(await source.locator('[data-token="hljs-keyword"]').first().evaluate(node => getComputedStyle(node).color), metrics.colors['hljs-keyword']);
  await page.screenshot({ path: path.join(output, 'code-dark.png'), fullPage: true, animations: 'disabled' });
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 480, height: 950 });
  const expand = page.getByRole('button', { name: '展开文件目录', exact: true }); await expand.waitFor(); assert.equal(await page.getByRole('main', { name: '文档工作区', exact: true }).locator('.cr-file-viewer').isVisible(), true, 'narrow layout keeps the opened source in the center while the explorer is collapsed');
  await source.getByRole('button', { name: '切换代码折行' }).click(); await source.locator('.cr-code').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'long code must not expand the whole narrow page'); assert.equal(await displayed(), sourceText);
  await page.screenshot({ path: path.join(output, 'code-narrow.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize(desktopViewport); await source.getByRole('button', { name: '切换代码折行' }).click();
  await page.evaluate(keys => { for (const key of keys) document.documentElement.style.removeProperty(key); }, Object.keys(dark));
  const attack = '<img src="https://attacker.invalid/code" onerror="globalThis.__CODE_UI_INJECTION__=true">\n<script>globalThis.__CODE_UI_INJECTION__=true</script>';
  await page.evaluate(text => { const holder = document.createElement('div'); holder.id = 'code-safety-fixture'; holder.className = 'cr-page'; holder.style.display = 'none'; document.body.appendChild(holder); window.codeSafetyRoot = window.createRoot(holder); window.codeSafetyRoot.render(window.React.createElement(window.plugin.Markdown, { text: '```html\n' + text + '\n```', openEvidence: () => {} })); }, attack);
  await page.locator('#code-safety-fixture .cr-code').waitFor({ state: 'attached' }); assert.equal(await page.locator('#code-safety-fixture img,#code-safety-fixture script').count(), 0);
  assert.equal(await page.locator('#code-safety-fixture .cr-code-text').evaluateAll(rows => rows.map(row => row.textContent).join('\n')), attack); assert.equal(await page.evaluate(() => globalThis.__CODE_UI_INJECTION__), undefined);
  await page.evaluate(() => { window.codeSafetyRoot.unmount(); delete window.codeSafetyRoot; document.getElementById('code-safety-fixture').remove(); });
  return { passed: true, environment: 'Isolated intercepted Chrome, not the authenticated GUI.', themes: ['light', 'dark'], minObservedTokenContrast: Number(Math.min(...Object.values(metrics.ratios)).toFixed(2)), syntaxColors: metrics.colors, codeFontSize: metrics.fontSize, sourcePreserved: true, actualLineNumbers: true, wrapSurvivesRefresh: true, htmlRemainsText: true, narrowViewport: true };
}
