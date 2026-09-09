import path from 'node:path';
import { runScenario } from './runScenario.mjs';

/**
 * Issue #54: 表示例ドキュメント（docs/animation-gallery.md）用の「実行前 → 実行後」
 * スクリーンショットを決定論的に生成するシナリオ。pass/fail 判定も兼ねる
 * （各撮影でファイルが書け、consoleErrors が空であること）。
 *
 * 空スキーマで起動した実 sql-studio dev サーバーに対し、1ページ内で状態を
 * 積み上げながら SQL 操作を順に実行し、各操作の前後でキャンバスペインを撮影する。
 * テーブル配置は WORLD_W ベースで決定論的（src/layout.ts）なので、撮影前に毎回
 * Fit ボタンでズームを正規化すれば生成物も決定論的になる。
 */

const PANE = '[data-testid="canvas-pane"]';
const FIT_BTN = '[data-testid="fit-view-btn"]';
// SqlEditorPane の Run ボタンはラベルが状態遷移する（Run SQL / Running… /
// エンジン読込中… / モード切替中…）。この正規表現でボタンを特定し、
// 「Run SQL かつ enabled」を待機完了の条件にする。
const RUN_LABEL_RE = /Run SQL|Running|エンジン読込中|モード切替中/;

/** Run / モード切替 が完了しアイドルに戻るまで待つ（PGlite コールドスタート・
 * アニメーション再生・experiment→design の ROLLBACK 再生をまとめて待つ）。 */
async function waitIdle(page, timeout) {
  await page.waitForFunction(
    (src) => {
      const re = new RegExp(src);
      const btn = [...document.querySelectorAll('button')].find((b) => re.test(b.textContent || ''));
      return !!btn && !btn.disabled && /Run SQL/.test(btn.textContent || '');
    },
    RUN_LABEL_RE.source,
    { timeout },
  );
}

async function clickRun(page, timeout) {
  await page.locator('button', { hasText: /Run SQL/ }).first().click({ timeout });
}

/** テキストエリアへ SQL を入れて Run し、アイドルに戻るまで待つ。 */
async function runSql(page, sql, timeout) {
  await page.fill('textarea', sql, { timeout });
  await clickRun(page, timeout);
  await waitIdle(page, timeout);
}

/** 目的のモードへ切り替える（既にそのモードなら何もしない）。切替ボタンは
 * 現在モードだと disabled なので、それを「既にそのモード」の判定に使う。 */
async function switchMode(page, target, timeout) {
  const label = target === 'design' ? '設計モード' : '実験モード';
  const btn = page.getByRole('button', { name: label });
  if (await btn.isDisabled()) return;
  await btn.click({ timeout });
  await waitIdle(page, timeout);
}

/** キャンバスがある場合のみ Fit でズームを正規化する。 */
async function fitView(page) {
  const fit = page.locator(FIT_BTN);
  if (await fit.count()) await fit.click();
}

/** framer-motion の残存トランジション（値更新パルス scale[1,1.05,1]・フィルタの
 * フェード 0.6s・Fit の変換アニメーション等）が完全に止まるまで待つ。撮影が
 * 決定論的になるよう、JS 状態のアイドル（waitIdle）よりさらに余裕を持たせる。 */
async function settle(page) {
  await page.waitForTimeout(1500);
}

async function shoot(page, outDir, key, phase) {
  await fitView(page);
  await settle(page);
  await page.locator(PANE).screenshot({ path: path.join(outDir, `${key}-${phase}.png`) });
}

// 各操作は「setup（撮影しない前提 SQL）→ before 撮影 → sql 実行 → after 撮影」。
// design → experiment → モード復帰 の順で 1 ページ内に状態を積み上げる。
const STEPS = [
  {
    key: 'table-appear',
    mode: 'design',
    setup: [],
    sql: 'CREATE TABLE users (id INT, name VARCHAR(50), email VARCHAR(120));',
  },
  {
    key: 'column-add',
    mode: 'design',
    setup: [],
    sql: 'ALTER TABLE users ADD COLUMN signup_date DATE;',
  },
  {
    key: 'column-drop',
    mode: 'design',
    setup: [],
    sql: 'ALTER TABLE users DROP COLUMN signup_date;',
  },
  {
    key: 'table-remove',
    mode: 'design',
    setup: ['CREATE TABLE draft_notes (id INT, body VARCHAR(200));'],
    sql: 'DROP TABLE draft_notes;',
  },
  {
    key: 'row-add',
    mode: 'experiment',
    setup: [],
    sql:
      "INSERT INTO users (id, name, email) VALUES " +
      "(1, 'Alice', 'alice@example.com'), (2, 'Bob', 'bob@example.com'), (3, 'Carol', 'carol@example.com');",
  },
  {
    key: 'select-filter-highlight',
    mode: 'experiment',
    setup: [],
    sql: 'SELECT name, email FROM users WHERE id > 1;',
  },
  {
    key: 'select-unfilter',
    mode: 'experiment',
    setup: [],
    sql: 'SELECT id, name, email FROM users WHERE id > 0;',
  },
  {
    key: 'row-update',
    mode: 'experiment',
    setup: [],
    sql: "UPDATE users SET name = 'Alicia' WHERE id = 1;",
  },
  {
    key: 'row-remove',
    mode: 'experiment',
    setup: [],
    sql: 'DELETE FROM users WHERE id = 3;',
  },
  // 実験→設計モードへ戻ると experiment 中の INSERT/UPDATE/DELETE が ROLLBACK され、
  // その差分が通常アニメーションとして再生される。SQL ではなくトグル操作。
  { key: 'mode-return-rollback', type: 'mode-return' },
];

export async function run({ page, url, outDir, timeout }) {
  if (!outDir) {
    return [{ name: 'out-dir-provided', pass: false, detail: '--out-dir が指定されていません' }];
  }

  // React の開発モード警告（console.error 経由で出る）は無視する。特に
  // react-zoom-pan-pinch は初回マウント時に "`ref` is not a prop" 警告を出すが
  // 実害はなく、既存の Phase B シナリオでも問題視していない。
  const isBenign = (t) => t.startsWith('Warning:') || t.includes('`ref` is not a prop');
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !isBenign(m.text())) consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  const results = [];

  results.push(
    await runScenario('app-loads', async () => {
      await page.goto(url, { waitUntil: 'load', timeout });
      await waitIdle(page, timeout);
      await page.waitForSelector(PANE, { timeout });
      return 'sql-studio 起動・Run ボタン待機完了';
    }),
  );

  for (const step of STEPS) {
    results.push(
      await runScenario(`gallery:${step.key}`, async () => {
        const errBefore = consoleErrors.length;

        if (step.type === 'mode-return') {
          await switchMode(page, 'experiment', timeout); // 念のため実験モードに居ることを保証
          await shoot(page, outDir, step.key, 'before');
          await switchMode(page, 'design', timeout);
          await shoot(page, outDir, step.key, 'after');
        } else {
          await switchMode(page, step.mode, timeout);
          for (const s of step.setup) await runSql(page, s, timeout);
          await shoot(page, outDir, step.key, 'before');
          await runSql(page, step.sql, timeout);
          await shoot(page, outDir, step.key, 'after');
        }

        const newErrors = consoleErrors.slice(errBefore);
        if (newErrors.length) throw new Error(`console error: ${newErrors.join(' | ')}`);
        return `${step.key}: before/after 撮影完了`;
      }),
    );
  }

  return results;
}
