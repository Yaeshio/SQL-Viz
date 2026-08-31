import { runScenario } from './runScenario.mjs';

// AppHeader.tsx renders "tables N" as the first `.font-mono.text-slate-200` span.
const TABLE_COUNT_SELECTOR = 'span.font-mono.text-slate-200';
const PANE = '[data-testid="canvas-pane"]';
const FIT_BTN = '[data-testid="fit-view-btn"]';

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
      return Number.isFinite(s) && s > 0 && s < 1 && Number(el?.dataset.worldW) > 1200;
    },
    PANE,
    { timeout },
  );
  await page.waitForTimeout(250);

  let fittedScale = NaN;
  let fittedPanX = NaN;

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
      fittedPanX = t.panX;
      return `initial scale ${t.scale.toFixed(3)} (raw fit ${rawFit.toFixed(3)}, world ${t.worldW}x${t.worldH})`;
    }),
  );

  results.push(
    await runScenario('pan-has-no-snapback', async () => {
      // At fit scale the scaled world is only a little wider than the pane and
      // shorter than it — the exact "letterbox" case where the old strict clamp
      // snapped every nudge back to centre. A moderate drag must mostly stick.
      const pane = await paneBox(page);
      const before = await readTransform(page);
      await dragBy(page, { x: pane.cx, y: pane.cy }, 150, 90);
      await page.waitForTimeout(400); // longer than any clamp snap animation
      const after = await readTransform(page);
      const keptX = after.panX - before.panX;
      const keptY = after.panY - before.panY;
      if (keptX < 90 || keptY < 55) {
        throw new Error(
          `drag snapped back: kept (${keptX.toFixed(0)}, ${keptY.toFixed(0)}) of (150, 90) — before ${JSON.stringify(before)} after ${JSON.stringify(after)}`,
        );
      }
      return `drag of (150,90) kept (${keptX.toFixed(0)}, ${keptY.toFixed(0)}) — no snap-back`;
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
    await runScenario('pan-is-bounded', async () => {
      // Shove the same direction well past any sane content edge; the pan offset
      // must stop advancing (a limit exists) rather than run away forever.
      const pane = await paneBox(page);
      const readings = [];
      for (let batch = 0; batch < 4; batch++) {
        for (let i = 0; i < 4; i++) {
          await dragBy(page, { x: pane.cx, y: pane.cy }, 320, 260);
          await page.waitForTimeout(40);
        }
        await page.waitForTimeout(200);
        readings.push(await readTransform(page));
      }
      const a = readings[readings.length - 2];
      const b = readings[readings.length - 1];
      const drift = Math.abs(b.panX - a.panX) + Math.abs(b.panY - a.panY);
      if (drift > 3) {
        throw new Error(`pan did not settle at a bound: last two (${a.panX},${a.panY}) -> (${b.panX},${b.panY})`);
      }
      // and the world box still overlaps the viewport (never fully lost)
      if (b.panX >= pane.w || b.panY >= pane.h) {
        throw new Error(`world pushed entirely off screen: pan (${b.panX}, ${b.panY}) vs pane ${pane.w}x${pane.h}`);
      }
      return `pan bounded at (${b.panX.toFixed(0)}, ${b.panY.toFixed(0)})`;
    }),
  );

  results.push(
    await runScenario('fit-button-restores-fitted-view', async () => {
      const beforeFit = (await readTransform(page)).scale;
      await page.mouse.move(4, 4);
      await page.click(FIT_BTN);
      // wait for the fit to settle within tolerance across two consecutive reads
      let stableReads = 0;
      for (let i = 0; i < 25 && stableReads < 2; i++) {
        await page.waitForTimeout(120);
        const s = (await readTransform(page)).scale;
        stableReads = Math.abs(s - fittedScale) < 0.03 ? stableReads + 1 : 0;
      }
      const t = await readTransform(page);
      if (Math.abs(t.scale - fittedScale) > 0.03) {
        throw new Error(`fit scale ${t.scale} did not settle at initial fit ${fittedScale} (was ${beforeFit})`);
      }
      if (Math.abs(t.panX - fittedPanX) > 4) {
        throw new Error(`fit did not recenter: panX ${t.panX} vs initial ${fittedPanX}`);
      }
      return `fit: ${beforeFit.toFixed(3)} -> ${t.scale.toFixed(3)} (initial fit ${fittedScale.toFixed(3)}), recentered`;
    }),
  );

  return results;
}
