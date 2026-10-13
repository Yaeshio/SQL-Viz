import { readFile } from 'node:fs/promises';
import { runScenario } from './runScenario.mjs';

// AppHeader.tsx は "tables N" を最初の `.font-mono.text-slate-200` span として描画する。
const TABLE_COUNT_SELECTOR = 'span.font-mono.text-slate-200';
const CONNECTOR = '[data-testid="relation-connector"]';
// src/layout.ts の定数（カード内のカラム行の位置を再計算するため）
const HEADER_H = 36;
const ROW_H = 30;
const TABLE_W = 240;
const RELATION_ID = 'posts.user_id->users.id';

function tableNodeSelector(name) {
  return `[data-testid="table-node"][data-table-name="${name}"]`;
}

function dragHandleSelector(name) {
  return `[data-testid="table-drag-handle"][data-table-name="${name}"]`;
}

async function readTablePos(page, name) {
  return page.$eval(tableNodeSelector(name), (el) => ({ x: Number(el.dataset.x), y: Number(el.dataset.y) }));
}

async function readConnector(page) {
  return page.$eval(CONNECTOR, (el) => ({
    id: el.dataset.relationId,
    fromTable: el.dataset.fromTable,
    fromColumn: el.dataset.fromColumn,
    toTable: el.dataset.toTable,
    toColumn: el.dataset.toColumn,
    x1: Number(el.dataset.x1),
    y1: Number(el.dataset.y1),
    x2: Number(el.dataset.x2),
    y2: Number(el.dataset.y2),
  }));
}

function near(actual, expected, label) {
  if (Math.abs(actual - expected) > 0.5) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

async function waitForConnectorCount(page, count, timeout) {
  await page.waitForFunction(
    ([sel, n]) => document.querySelectorAll(sel).length === n,
    [CONNECTOR, count],
    { timeout },
  );
}

async function runSql(page, sql, timeout) {
  await page.locator('textarea').fill(sql);
  await page.click('text=Run SQL', { timeout });
}

/** Phase C / Issue #45: 外部キーのリレーション線。FK 付き 2 テーブルの fixture
 * （posts.user_id -> users.id）を自動ロードした sql-studio dev サーバーに対して実
 * Chromium を操作し、コネクタ（`data-testid="relation-connector"`）が (1) テーブルの
 * 出現の後に引かれ（hiddenRelations が機能し、全リレーションが一斉に描かれない）、
 * (2) カラム行の位置に端点を持ち、(3) テーブルのドラッグにライブ追従し、(4) DROP で
 * 消え、(5) 親の DROP は Postgres に拒否され、(6) Save した DDL（PK/UNIQUE/FK 付き）を
 * 新しいページで読み込むと FK が復元される（FK だけ出力して PK を出さないと Reload が
 * 失敗する、という Issue #45 で見つけたバグの回帰）ことを確認する。 */
export async function run({ page, url, schemaPath, outDir, timeout }) {
  const shot = async (name) => {
    if (outDir) await page.screenshot({ path: `${outDir}/relation-${name}.png` });
  };
  const results = [];

  // 起動時の自動ロードで table-node / relation-connector が DOM へ追加された時刻を記録する
  // （performance.now()）。dispatch 直後にコネクタが出てしまっていないかの検証に使う。
  await page.addInitScript(() => {
    window.__sqlvizDomLog = [];
    const probe = (el) => {
      const id = el.getAttribute?.('data-testid');
      if (id === 'table-node') {
        window.__sqlvizDomLog.push({ kind: 'table', name: el.getAttribute('data-table-name'), t: performance.now() });
      } else if (id === 'relation-connector') {
        window.__sqlvizDomLog.push({ kind: 'relation', name: el.getAttribute('data-relation-id'), t: performance.now() });
      }
    };
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          probe(n);
          n.querySelectorAll?.('[data-testid="table-node"],[data-testid="relation-connector"]').forEach(probe);
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });

  await page.goto(url, { waitUntil: 'load', timeout });
  await page.waitForFunction(
    (sel) => Number(document.querySelector(sel)?.textContent) >= 2,
    TABLE_COUNT_SELECTOR,
    { timeout },
  );
  await waitForConnectorCount(page, 1, timeout);
  await page.waitForTimeout(500);
  await shot('1-loaded');

  results.push(
    await runScenario('connector-is-drawn-after-its-tables-appear', async () => {
      const log = await page.evaluate(() => window.__sqlvizDomLog);
      const posts = log.find((e) => e.kind === 'table' && e.name === 'posts');
      const relation = log.find((e) => e.kind === 'relation' && e.name === RELATION_ID);
      if (!posts || !relation) {
        throw new Error(`missing DOM log entries: ${JSON.stringify(log)}`);
      }
      const delta = relation.t - posts.t;
      // table_appear の再生待ち（120ms）の後に relation_add が来て初めて引かれる。dispatch と同じ
      // レンダーで描かれていれば delta は 0 付近になる。
      if (delta < 80) {
        throw new Error(`connector appeared ${delta.toFixed(0)}ms after the posts table; expected to wait for relation_add (>= 80ms)`);
      }
      return `connector mounted ${delta.toFixed(0)}ms after the posts table`;
    }),
  );

  results.push(
    await runScenario('connector-endpoints-sit-on-the-column-rows', async () => {
      const count = await page.locator(CONNECTOR).count();
      if (count !== 1) throw new Error(`expected exactly 1 connector, got ${count}`);
      const c = await readConnector(page);
      if (c.fromTable !== 'posts' || c.fromColumn !== 'user_id' || c.toTable !== 'users' || c.toColumn !== 'id') {
        throw new Error(`unexpected connector endpoints: ${JSON.stringify(c)}`);
      }
      const posts = await readTablePos(page, 'posts');
      const users = await readTablePos(page, 'users');
      // posts は users の右隣のグリッドセル: posts の左辺 → users の右辺。user_id は 2 番目、id は 1 番目のカラム。
      near(c.x1, posts.x, 'x1 (posts left edge)');
      near(c.x2, users.x + TABLE_W, 'x2 (users right edge)');
      near(c.y1, posts.y + HEADER_H + ROW_H * 1 + ROW_H / 2, 'y1 (posts.user_id row center)');
      near(c.y2, users.y + HEADER_H + ROW_H * 0 + ROW_H / 2, 'y2 (users.id row center)');
      return `connector ${c.id} ends on posts.user_id (${c.x1}, ${c.y1}) and users.id (${c.x2}, ${c.y2})`;
    }),
  );

  results.push(
    await runScenario('connector-follows-the-table-while-dragging', async () => {
      const before = await readConnector(page);
      const box = await page.locator(dragHandleSelector('users')).boundingBox();
      const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x, from.y + 180, { steps: 12 });
      // ボタンを押したまま（ドラッグ確定前）に、コネクタが既にライブ位置へ追従していること
      await page.waitForTimeout(100);
      const usersLive = await readTablePos(page, 'users');
      const midDrag = await readConnector(page);
      near(midDrag.y2, usersLive.y + HEADER_H + ROW_H / 2, 'mid-drag y2 (users.id row center)');
      if (midDrag.y2 - before.y2 < 100) {
        throw new Error(`connector did not follow mid-drag: y2 ${before.y2} -> ${midDrag.y2}`);
      }
      near(midDrag.y1, before.y1, 'mid-drag y1 (posts did not move)');
      await shot('2-mid-drag');
      await page.mouse.up();
      await page.waitForTimeout(300);
      const usersAfter = await readTablePos(page, 'users');
      const after = await readConnector(page);
      near(after.y2, usersAfter.y + HEADER_H + ROW_H / 2, 'post-drop y2');
      return `connector y2 followed users while dragging: ${before.y2} -> ${midDrag.y2} (mid-drag) -> ${after.y2} (dropped)`;
    }),
  );

  results.push(
    await runScenario('dropping-the-child-removes-the-connector', async () => {
      await runSql(page, 'DROP TABLE posts;', timeout);
      await waitForConnectorCount(page, 0, timeout);
      return 'connector removed after DROP TABLE posts';
    }),
  );

  results.push(
    await runScenario('dropping-a-referenced-parent-is-rejected-by-postgres', async () => {
      await runSql(
        page,
        'CREATE TABLE posts (id INT PRIMARY KEY, user_id INT REFERENCES users(id), title TEXT);',
        timeout,
      );
      await waitForConnectorCount(page, 1, timeout);
      await runSql(page, 'DROP TABLE users;', timeout);
      await page.getByText(/other objects depend on it/).first().waitFor({ timeout });
      await page.waitForTimeout(500);
      const connectors = await page.locator(CONNECTOR).count();
      const tables = await page.locator('[data-testid="table-node"]').count();
      if (connectors !== 1 || tables !== 2) {
        throw new Error(`state changed after the rejected DROP: ${connectors} connector(s), ${tables} table(s)`);
      }
      return 'Postgres refused DROP TABLE users; connector and both tables remain';
    }),
  );

  results.push(
    await runScenario('saved-ddl-keeps-constraints-and-restores-the-relation-on-a-fresh-load', async () => {
      const saveButton = page.locator('[data-testid="save-to-file-btn"]');
      const responsePromise = page.waitForResponse(
        (res) => res.url().includes('/api/schema') && res.request().method() === 'POST',
        { timeout },
      );
      await saveButton.click();
      await responsePromise;

      const written = await readFile(schemaPath, 'utf-8');
      for (const expected of [
        'PRIMARY KEY ("id")',
        'FOREIGN KEY ("user_id") REFERENCES "users" ("id")',
      ]) {
        if (!written.includes(expected)) {
          throw new Error(`saved DDL is missing ${expected}:\n${written}`);
        }
      }

      // 新しいページ = 新しい PGlite。起動時の自動ロードが保存した DDL を再生する。PK を出力せずに
      // FK だけ出力していると、users だけが作られて posts が作られずここで失敗する。
      await page.reload({ waitUntil: 'load', timeout });
      await page.waitForFunction(
        (sel) => Number(document.querySelector(sel)?.textContent) >= 2,
        TABLE_COUNT_SELECTOR,
        { timeout },
      );
      await waitForConnectorCount(page, 1, timeout);
      const c = await readConnector(page);
      if (c.id !== RELATION_ID) throw new Error(`unexpected relation after reload: ${JSON.stringify(c)}`);
      return 'Save wrote PRIMARY KEY + FOREIGN KEY, and a fresh load restored posts.user_id -> users.id';
    }),
  );

  return results;
}
