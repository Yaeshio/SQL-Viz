import { runScenario } from './runScenario.mjs';

// AppHeader.tsx renders "tables N" as the first `.font-mono.text-slate-200` span.
const TABLE_COUNT_SELECTOR = 'span.font-mono.text-slate-200';
const PANE = '[data-testid="canvas-pane"]';
const FIT_BTN = '[data-testid="fit-view-btn"]';
const TABLES_BOUNDS = '#sqlviz-tables-bounds';

async function readTransform(page) {
  return page.$eval(PANE, (el) => ({
    scale: Number(el.dataset.canvasScale),
    panX: Number(el.dataset.canvasPanX),
    panY: Number(el.dataset.canvasPanY),
    worldW: Number(el.dataset.worldW),
    worldH: Number(el.dataset.worldH),
  }));
}

async function paneBox(page) {
  return page.$eval(PANE, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  });
}

async function dragBy(page, from, dx, dy) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
  await page.mouse.up();
}

/** Phase B / Issue #17: canvas pan & zoom + fit-to-content button. Drives real
 * wheel/pointer gestures against a fresh sql-studio dev server that has
 * auto-loaded the many-table fixture, and asserts on the data-* attributes
 * Canvas.tsx publishes (data-canvas-scale / -pan-x / -pan-y / -world-w/h). */
export async function run({ page, url, timeout }) {
  const results = [];

  await page.goto(url, { waitUntil: 'load', timeout });
  await page.waitForFunction(
    (sel) => Number(document.querySelector(sel)?.textContent) >= 12,
    TABLE_COUNT_SELECTOR,
    { timeout },
  );
  // The startup load streams tables in one CREATE at a time; the view auto-fits
  // as the world grows. Once all 12 tables exist the world box is final, so
  // wait for the published transform to be a real sub-1x fit of that world.
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      const s = Number(el?.dataset.canvasScale);
      return Number.isFinite(s) && s > 0 && s < 1 && Number(el?.dataset.worldW) > 1500;
    },
    PANE,
    { timeout },
  );
  await page.waitForTimeout(250);

  let fittedScale = NaN;

  results.push(
    await runScenario('initial-view-is-fitted-below-1x', async () => {
      const t = await readTransform(page);
      const pane = await paneBox(page);
      if (!(t.worldW > pane.w)) {
        throw new Error(`fixture world width ${t.worldW} not larger than pane ${pane.w}`);
      }
      const rawFit = Math.min(pane.w / t.worldW, pane.h / t.worldH);
      if (!(t.scale > 0.02)) throw new Error(`fitted scale not positive: ${t.scale}`);
      if (t.scale > rawFit + 0.02) {
        throw new Error(`fitted scale ${t.scale} exceeds raw fit ${rawFit.toFixed(3)} (edge padding expected)`);
      }
      if (t.scale >= 1) throw new Error(`expected fitted scale < 1 for an over-sized world, got ${t.scale}`);
      if (t.panX < -1 || t.panY < -1) {
        throw new Error(`fitted content not centered: pan (${t.panX}, ${t.panY})`);
      }
      fittedScale = t.scale;
      return `initial scale ${t.scale.toFixed(3)} (raw fit ${rawFit.toFixed(3)}, world ${t.worldW}x${t.worldH})`;
    }),
  );

  results.push(
    await runScenario('wheel-up-zooms-in', async () => {
      const pane = await paneBox(page);
      const before = (await readTransform(page)).scale;
      await page.mouse.move(pane.cx, pane.cy);
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(60);
      }
      await page.waitForFunction(
        (args) => Number(document.querySelector(args.sel)?.dataset.canvasScale) > args.before + 0.02,
        { sel: PANE, before },
        { timeout },
      );
      await page.waitForTimeout(150);
      const after = (await readTransform(page)).scale;
      if (!(after > before)) throw new Error(`wheel-up did not increase scale: ${before} -> ${after}`);
      return `scale ${before.toFixed(3)} -> ${after.toFixed(3)} on wheel-up`;
    }),
  );

  results.push(
    await runScenario('blank-drag-pans-without-selecting-text', async () => {
      // now zoomed in past the fit, so content overflows the pane and panning
      // is meaningful in both axes
      const pane = await paneBox(page);
      const before = await readTransform(page);
      await dragBy(page, { x: pane.cx, y: pane.cy }, -170, -120);
      await page.waitForTimeout(150);
      const after = await readTransform(page);
      const moved = Math.abs(after.panX - before.panX) + Math.abs(after.panY - before.panY);
      if (moved < 5) {
        throw new Error(`pan did not move: (${before.panX},${before.panY}) -> (${after.panX},${after.panY})`);
      }
      const selection = await page.evaluate(() => window.getSelection()?.toString() ?? '');
      if (selection !== '') {
        throw new Error(`text selection misfired during pan: ${JSON.stringify(selection)}`);
      }
      const userSelect = await page.$eval(
        `${PANE} .react-transform-component`,
        (el) => getComputedStyle(el).userSelect || getComputedStyle(el).webkitUserSelect,
      );
      if (userSelect !== 'none') {
        throw new Error(`transform content user-select expected "none", got "${userSelect}"`);
      }
      return `panned by (${(after.panX - before.panX).toFixed(0)}, ${(after.panY - before.panY).toFixed(0)}), no text selected`;
    }),
  );

  results.push(
    await runScenario('pan-is-bounded-to-bbox-plus-margin', async () => {
      const pane = await paneBox(page);
      for (let i = 0; i < 10; i++) {
        await dragBy(page, { x: pane.cx, y: pane.cy }, 300, 240);
        await page.waitForTimeout(40);
      }
      await page.waitForTimeout(200);
      const g = await page.$eval(TABLES_BOUNDS, (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
      const intersects =
        g.right > pane.x && g.left < pane.x + pane.w && g.bottom > pane.y && g.top < pane.y + pane.h;
      if (!intersects) {
        throw new Error(`tables panned fully off-screen: ${JSON.stringify(g)} vs pane ${JSON.stringify(pane)}`);
      }
      return 'table group still intersects the viewport after extreme panning';
    }),
  );

  results.push(
    await runScenario('fit-button-restores-fitted-view', async () => {
      const beforeFit = (await readTransform(page)).scale;
      // move the pointer off the canvas so a stray hover-wheel can't interfere
      await page.mouse.move(4, 4);
      await page.click(FIT_BTN);
      // wait for the fit to *settle* — the animation eases from beforeFit down
      // to the fit scale; require it to sit within tolerance across two reads.
      let stableReads = 0;
      let last = NaN;
      for (let i = 0; i < 25 && stableReads < 2; i++) {
        await page.waitForTimeout(120);
        last = (await readTransform(page)).scale;
        stableReads = Math.abs(last - fittedScale) < 0.03 ? stableReads + 1 : 0;
      }
      const t = await readTransform(page);
      if (Math.abs(t.scale - fittedScale) > 0.03) {
        throw new Error(`fit scale ${t.scale} did not settle at initial fit ${fittedScale} (was ${beforeFit})`);
      }
      if (t.panX < -1 || t.panY < -1) {
        throw new Error(`fit did not recenter: pan (${t.panX}, ${t.panY})`);
      }
      return `fit: ${beforeFit.toFixed(3)} -> ${t.scale.toFixed(3)} (initial fit ${fittedScale.toFixed(3)}), recentered`;
    }),
  );

  return results;
}
