import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

async function sampleViewport(viewport, count = 90) {
  const frames = await viewport.evaluate((element, count) => new Promise(resolve => {
    const rows = [];
    const record = () => {
      const surface = element.querySelector('.cr-mind-map-surface'); const rect = surface.getBoundingClientRect(); const outer = element.getBoundingClientRect();
      rows.push({ width: element.clientWidth, height: element.clientHeight, scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight, scale: Number(element.dataset.mindMapScale), layout: element.dataset.layout, x: Math.round((rect.x - outer.x) * 100) / 100, y: Math.round((rect.y - outer.y) * 100) / 100, scrollLeft: element.scrollLeft, scrollTop: element.scrollTop });
      if (rows.length < count) requestAnimationFrame(record); else resolve(rows);
    };
    requestAnimationFrame(record);
  }), count);
  const settled = frames.slice(30);
  return { frames: frames.length, settledStates: [...new Set(settled.map(row => JSON.stringify(row)))].map(row => JSON.parse(row)), transitions: settled.slice(1).filter((row, index) => JSON.stringify(row) !== JSON.stringify(settled[index])).length };
}

// Exercise the real mounted Client: a screenshot cannot catch a resize feedback loop.
export async function verifyMindMapStability({ page, root, output }) {
  const viewport = root.locator('.cr-mind-map-viewport');
  await root.getByRole('button', { name: '展开分支', exact: true }).click();
  assert.equal(await root.locator('.cr-mind-map-node').count(), 32);
  const scrollbarStyle = await page.addStyleTag({ content: '.cr-mind-map-viewport::-webkit-scrollbar { width:15px; height:15px; }' });
  const samples = []; const interactions = [];
  const resetSize = () => viewport.evaluate(element => { element.style.removeProperty('width'); element.style.removeProperty('height'); element.style.removeProperty('zoom'); });
  try {
    // Real, space-consuming scrollbars must be enabled at launch. CSS zoom drives
    // fractional layout pixels; it is not advertised as an OS-DPI/browser-zoom test.
    // 1000px @ 1.5 with 32 expanded nodes was red: 59 transitions in 60 idle frames.
    for (const zoom of [1, 1.25, 1.5, 1.75]) for (const width of [1000, 1000.5, 615, 614, 602, 601.5, 601, 600.5, 600, 599.5, 599]) {
      await viewport.evaluate((element, { width, zoom }) => { element.style.zoom = zoom; element.style.width = `${width}px`; element.style.height = '460.5px'; }, { width, zoom });
      await root.getByRole('button', { name: '适应视图', exact: true }).click();
      samples.push({ cssZoom: zoom, requestedWidth: width, ...await sampleViewport(viewport) });
    }
    await writeFile(path.join(output, 'mind-map-stability.json'), JSON.stringify({ samples }, null, 2));
    assert.deepEqual(samples.filter(sample => sample.settledStates.length > 1), [], 'idle map must settle: no repeated resize/scale/position/scrollbar changes');

    await viewport.evaluate(element => { element.style.zoom = 1; element.style.width = '375px'; element.style.height = '340px'; });
    const narrow = await sampleViewport(viewport, 60); const narrowState = narrow.settledStates[0];
    assert.equal(narrow.settledStates.length, 1);
    assert.equal(narrowState.layout, 'compact'); assert.ok(narrowState.width <= 363, 'test browser must reserve space for the vertical scrollbar, not silently hide it');
    assert.equal(narrowState.scale, 1, 'narrow map remains legible'); interactions.push({ label: 'compact with real scrollbar', ...narrow });

    await resetSize(); await root.getByRole('button', { name: '适应视图', exact: true }).click();
    for (let i = 0; i < 4; i++) await root.getByRole('button', { name: '放大导图', exact: true }).click();
    await sampleViewport(viewport, 60);
    const zoomBefore = await viewport.getAttribute('data-mind-map-scale');
    await viewport.evaluate(element => { element.scrollTop = 90; });
    const scrolled = await sampleViewport(viewport, 60);
    assert.equal(scrolled.settledStates.length, 1); assert.ok(scrolled.settledStates[0].scrollTop > 80, 'idle observation must not reset a manual scroll');
    interactions.push({ label: 'manual zoom and scroll', ...scrolled });

    await viewport.evaluate(element => { element.style.width = '900.5px'; });
    const resized = await sampleViewport(viewport, 60);
    assert.equal(resized.settledStates.length, 1); assert.equal(await viewport.getAttribute('data-mind-map-scale'), zoomBefore, 'resizing preserves explicit zoom');
    interactions.push({ label: 'resize while zoomed', ...resized });
    await root.locator('.cr-mind-map-node').first().focus(); await page.keyboard.press('End');
    assert.equal(await root.locator('.cr-mind-map-node').last().evaluate(element => element === document.activeElement), true);
    const keyboard = await sampleViewport(viewport, 60);
    assert.equal(keyboard.settledStates.length, 1); assert.ok(keyboard.settledStates[0].scrollTop > 90, 'keyboard navigation reaches the bottom node');
    interactions.push({ label: 'keyboard to last node', ...keyboard });

    await root.getByRole('button', { name: '收起分支', exact: true }).click();
    await root.getByRole('button', { name: '展开分支', exact: true }).click();
    await root.getByRole('button', { name: '适应视图', exact: true }).click();
    const refit = await sampleViewport(viewport, 60);
    assert.equal(refit.settledStates.length, 1); assert.equal(await root.locator('.cr-mind-map-node').count(), 32);
    interactions.push({ label: 'collapse expand and refit', ...refit });
    const report = { passed: true, nodes: 32, samples, interactions };
    await writeFile(path.join(output, 'mind-map-stability.json'), JSON.stringify(report, null, 2));
    return report;
  } finally {
    await resetSize().catch(() => {});
    await scrollbarStyle.evaluate(element => element.remove()).catch(() => {});
  }
}
