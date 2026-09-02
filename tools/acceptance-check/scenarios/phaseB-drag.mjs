import { runScenario } from './runScenario.mjs';

// AppHeader.tsx renders "tables N" as the first `.font-mono.text-slate-200` span.
const TABLE_COUNT_SELECTOR = 'span.font-mono.text-slate-200';
const PANE = '[data-testid="canvas-pane"]';

function tableNodeSelector(name) {
  return `[data-testid="table-node"][data-table-name="${name}"]`;
}

function dragHandleSelector(name) {
  return `[data-testid="table-drag-handle"][data-table-name="${name}"]`;
}

async function readTransform(page) {
  return page.$eval(PANE, (el) => ({
    scale: Number(el.dataset.canvasScale),
    panX: Number(el.dataset.canvasPanX),
    panY: Number(el.dataset.canvasPanY),
  }));
}

async function readTablePos(page, name) {
  return page.$eval(tableNodeSelector(name), (el) => ({ x: Number(el.dataset.x), y: Number(el.dataset.y) }));
}

async function dragHandleBy(page, name, dx, dy) {
  const box = await page.locator(dragHandleSelector(name)).boundingBox();
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
  await page.mouse.up();
}

/** Phase B / Issue #34: drag-to-move table nodes. Drives real pointer
 * gestures (header-only, per TableNode.tsx's `data-testid="table-drag-handle"`)
 * against a fresh sql-studio dev server that auto-loaded a two-table fixture,
 * asserting on the world-space `data-x`/`data-y` TableNode.tsx publishes on
 * its `data-testid="table-node"` group and on the pan/zoom data-* attributes
 * Canvas.tsx publishes (to confirm dragging a table never also pans the
 * canvas — the header's pointerdown handler stops propagation before
 * react-zoom-pan-pinch's own listener on an ancestor sees it). The fixture
 * is small enough that the initial fit sits at exactly scale=1
 * (fitToContent caps zoom-in at 1x), so a drag's screen-px delta equals its
 * world-px delta and no scale conversion is needed here. */
export async function run({ page, url, timeout }) {
  const results = [];

  await page.goto(url, { waitUntil: 'load', timeout });
  await page.waitForFunction(
    (sel) => Number(document.querySelector(sel)?.textContent) >= 2,
    TABLE_COUNT_SELECTOR,
    { timeout },
  );
  await page.waitForFunction(
    (sel) => Number.isFinite(Number(document.querySelector(sel)?.dataset.canvasScale)),
    PANE,
    { timeout },
  );
  await page.waitForTimeout(250);

  let draggedX = NaN;
  let draggedY = NaN;

  results.push(
    await runScenario('drag-repositions-table-and-sticks', async () => {
      const before = await readTablePos(page, 't0');
      await dragHandleBy(page, 't0', 220, 160);
      await page.waitForTimeout(300);
      const after = await readTablePos(page, 't0');
      const movedX = after.x - before.x;
      const movedY = after.y - before.y;
      if (movedX < 150 || movedY < 100) {
        throw new Error(
          `drag did not stick: moved (${movedX.toFixed(0)}, ${movedY.toFixed(0)}) of (220, 160) — before ${JSON.stringify(before)} after ${JSON.stringify(after)}`,
        );
      }
      draggedX = after.x;
      draggedY = after.y;
      return `t0 moved by (${movedX.toFixed(0)}, ${movedY.toFixed(0)})`;
    }),
  );

  results.push(
    await runScenario('table-drag-does-not-pan-canvas', async () => {
      const before = await readTransform(page);
      await dragHandleBy(page, 't1', -140, 90);
      await page.waitForTimeout(200);
      const after = await readTransform(page);
      const drifted =
        Math.abs(after.panX - before.panX) +
        Math.abs(after.panY - before.panY) +
        Math.abs(after.scale - before.scale);
      if (drifted > 1) {
        throw new Error(
          `canvas transform moved during a table drag: before ${JSON.stringify(before)} after ${JSON.stringify(after)}`,
        );
      }
      return `canvas transform unchanged (drift ${drifted.toFixed(3)}) while dragging t1`;
    }),
  );

  results.push(
    await runScenario('dropped-position-survives-a-later-statement-and-new-table-avoids-it', async () => {
      await page.fill('textarea', 'CREATE TABLE t2 (id INT, note VARCHAR(50))');
      await page.click('text=Run SQL');
      await page.waitForFunction(
        (sel) => Number(document.querySelector(sel)?.textContent) >= 3,
        TABLE_COUNT_SELECTOR,
        { timeout },
      );
      await page.waitForTimeout(300);

      const t0After = await readTablePos(page, 't0');
      if (Math.abs(t0After.x - draggedX) > 1 || Math.abs(t0After.y - draggedY) > 1) {
        throw new Error(
          `dragged position discarded by the next statement: was (${draggedX}, ${draggedY}), now (${t0After.x}, ${t0After.y})`,
        );
      }

      const overlaps = await page.evaluate(
        ({ t0Sel, t2Sel }) => {
          const a = document.querySelector(t0Sel)?.getBoundingClientRect();
          const b = document.querySelector(t2Sel)?.getBoundingClientRect();
          if (!a || !b) return null;
          return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        },
        { t0Sel: tableNodeSelector('t0'), t2Sel: tableNodeSelector('t2') },
      );
      if (overlaps === null) throw new Error('could not read t0/t2 bounding rects');
      if (overlaps) throw new Error('newly created t2 overlaps the dragged t0');

      return `t0 stayed at (${t0After.x.toFixed(0)}, ${t0After.y.toFixed(0)}), new t2 does not overlap it`;
    }),
  );

  return results;
}
