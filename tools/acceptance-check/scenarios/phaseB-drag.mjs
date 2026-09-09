import { runScenario } from './runScenario.mjs';

// AppHeader.tsx は "tables N" を最初の `.font-mono.text-slate-200` span として描画する。
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

async function readTableScreenRect(page, name) {
  const box = await page.locator(tableNodeSelector(name)).boundingBox();
  return { x: box.x, y: box.y };
}

async function readWorldBox(page) {
  return page.$eval(PANE, (el) => ({
    minX: Number(el.dataset.worldMinX),
    minY: Number(el.dataset.worldMinY),
    width: Number(el.dataset.worldW),
    height: Number(el.dataset.worldH),
  }));
}

async function dragHandleBy(page, name, dx, dy) {
  const box = await page.locator(dragHandleSelector(name)).boundingBox();
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
  await page.mouse.up();
}

/** Phase B / Issue #34: テーブルノードのドラッグ移動。2 テーブルの fixture を
 * 自動ロードした新しい sql-studio dev サーバーに対して実ポインタジェスチャー
 * （ヘッダー限定。TableNode.tsx の `data-testid="table-drag-handle"` に従う）を
 * 行い、TableNode.tsx が `data-testid="table-node"` グループへ公開する
 * ワールド座標の `data-x`/`data-y` と、Canvas.tsx が公開するパン/ズームの
 * data-* 属性でアサートする。テーブルのドラッグはキャンバスの *パン
 * ジェスチャー* を一切起動しない（ヘッダーはそこから除外されている）が、
 * Canvas.tsx はドラッグ中にパン変換をずらして、左/上へのドラッグが引き起こす
 * SVG viewBox 原点のシフトを打ち消す——そのため非ドラッグのテーブルは画面上で
 * 固定されたまま、ドラッグ中の最左/最上テーブルはピン留めされて見えず
 * カーソルに追従する。fixture は十分小さく初期フィットがちょうど scale=1 に
 * なる（fitToContent はズームインを 1x で頭打ちにする）ため、ドラッグの
 * 画面 px 差分がワールド px 差分と一致し、ここではスケール変換が不要。 */
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
    await runScenario('left-drag-tracks-cursor-and-holds-other-tables-fixed', async () => {
      // t0 は上で右/下へドラッグされた。ここで t1 を左へ 140 ドラッグすると
      // t1 は t0 を追い越して左へ動き、t1 が最左テーブルになってワールドボックスの
      // minX がそれを追い始める。どの方向でも同じく次の 2 点が保たれねばならない:
      // (a) ドラッグ中のテーブルはカーソルに追従し続ける（キャンバスが周囲で
      // 育つあいだピン留めされて見えてはならない）、(b) *他の* テーブルはすべて
      // 画面上で静止する——Canvas.tsx が minX/minY の差分だけパン変換をずらして
      // viewBox 原点のシフトを打ち消す。この fixture では scale は 1 なので、
      // 画面 px の差分はマウスの差分と一致する。
      const t0Before = await readTableScreenRect(page, 't0');
      const t1Before = await readTableScreenRect(page, 't1');
      const scaleBefore = (await readTransform(page)).scale;
      await dragHandleBy(page, 't1', -140, 90);
      await page.waitForTimeout(200);
      const t0After = await readTableScreenRect(page, 't0');
      const t1After = await readTableScreenRect(page, 't1');
      const scaleAfter = (await readTransform(page)).scale;

      const t0Drift = Math.abs(t0After.x - t0Before.x) + Math.abs(t0After.y - t0Before.y);
      if (t0Drift > 6) {
        throw new Error(
          `non-dragged t0 shifted on screen while dragging t1: before ${JSON.stringify(t0Before)} after ${JSON.stringify(t0After)}`,
        );
      }

      const t1MovedX = t1After.x - t1Before.x;
      const t1MovedY = t1After.y - t1Before.y;
      if (t1MovedX > -120 || t1MovedY < 70) {
        throw new Error(
          `dragged t1 looked pinned instead of tracking the cursor: moved (${t1MovedX.toFixed(0)}, ${t1MovedY.toFixed(0)}) of (-140, 90) — before ${JSON.stringify(t1Before)} after ${JSON.stringify(t1After)}`,
        );
      }
      if (Math.abs(scaleAfter - scaleBefore) > 0.001) {
        throw new Error(`zoom changed during a table drag: ${scaleBefore} -> ${scaleAfter}`);
      }
      return `t1 tracked the cursor (${t1MovedX.toFixed(0)}, ${t1MovedY.toFixed(0)}) while t0 held still (drift ${t0Drift.toFixed(1)}px)`;
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

  results.push(
    await runScenario('drag-past-the-origin-grows-the-canvas-left-and-up', async () => {
      const worldBefore = await readWorldBox(page);
      const t2Before = await readTablePos(page, 't2');
      await dragHandleBy(page, 't2', -(t2Before.x + 400), -(t2Before.y + 300));
      await page.waitForTimeout(300);
      const t2After = await readTablePos(page, 't2');
      const worldAfter = await readWorldBox(page);

      if (t2After.x >= 0 || t2After.y >= 0) {
        throw new Error(
          `dragging past the origin was clamped back to non-negative: before ${JSON.stringify(t2Before)} after ${JSON.stringify(t2After)}`,
        );
      }
      if (worldAfter.minX >= worldBefore.minX || worldAfter.minY >= worldBefore.minY) {
        throw new Error(
          `world box did not extend left/up: before ${JSON.stringify(worldBefore)} after ${JSON.stringify(worldAfter)}`,
        );
      }
      if (worldAfter.minX > t2After.x || worldAfter.minY > t2After.y) {
        throw new Error(
          `world box does not actually contain the dragged table: table ${JSON.stringify(t2After)} world ${JSON.stringify(worldAfter)}`,
        );
      }

      return `t2 dragged to (${t2After.x.toFixed(0)}, ${t2After.y.toFixed(0)}), world box now starts at (${worldAfter.minX.toFixed(0)}, ${worldAfter.minY.toFixed(0)})`;
    }),
  );

  return results;
}
