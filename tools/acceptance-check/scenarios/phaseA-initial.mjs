import { readFile, writeFile } from 'node:fs/promises';
import { runScenario } from './runScenario.mjs';

// AppHeader.tsx は "tables N" / "rows N" を `.font-mono.text-slate-200` の
// span 2 つとしてこの順に描画する——`.first()` がテーブル数。
const TABLE_COUNT_SELECTOR = 'span.font-mono.text-slate-200';

async function tableCountText(page) {
  return page.locator(TABLE_COUNT_SELECTOR).first().innerText();
}

/** Phase A の実ファイル I/O 受け入れテストのシナリオ 1〜3
 * （docs/alpha-phase-acceptance-criteria.md 参照）。まだ存在しないスキーマ
 * ファイルに対して実行するため、このプロセスがそれに触れる最初のものでなければ
 * ならない。 */
export async function run({ page, url, schemaPath, timeout }) {
  const results = [];

  results.push(
    await runScenario('cold-start-empty-canvas-no-schema-file', async () => {
      await page.goto(url, { waitUntil: 'load', timeout });
      await page.waitForSelector(TABLE_COUNT_SELECTOR, { timeout });
      const count = await tableCountText(page);
      if (count !== '0') {
        throw new Error(`expected 0 tables on cold start with no schema file, got "${count}"`);
      }
      const alerts = await page.locator('[role="alert"]').count();
      if (alerts !== 0) {
        throw new Error(`expected no error banners on cold start, found ${alerts}`);
      }
      return 'empty canvas, no error banner (GET /api/schema ENOENT path)';
    }),
  );

  results.push(
    await runScenario('author-table-and-save-writes-real-file', async () => {
      await page.locator('textarea').fill('CREATE TABLE users (id INT, name TEXT);');
      await page.click('text=Run SQL', { timeout });
      await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === '1', TABLE_COUNT_SELECTOR, {
        timeout,
      });

      const saveButton = page.locator('[data-testid="save-to-file-btn"]');
      if (await saveButton.isDisabled()) {
        throw new Error('save button still disabled after creating a table in design mode');
      }

      const responsePromise = page.waitForResponse(
        (res) => res.url().includes('/api/schema') && res.request().method() === 'POST',
        { timeout },
      );
      await saveButton.click();
      await responsePromise;

      const written = await readFile(schemaPath, 'utf-8');
      if (
        !written.includes('CREATE TABLE "users"') ||
        !written.includes('"id" INT') ||
        !written.includes('"name" TEXT')
      ) {
        throw new Error(`saved file did not contain expected DDL, got:\n${written}`);
      }
      return 'POST /api/schema wrote real DDL to the mounted file';
    }),
  );

  results.push(
    await runScenario('external-edit-and-reload-reflects-new-schema', async () => {
      // 別のプロセス（例: テキストエディタ）がアプリを完全にバイパスして
      // ファイルを直接書き込む状況をシミュレートする。
      await writeFile(schemaPath, 'CREATE TABLE products (id INT, price INT);\n', 'utf-8');

      const responsePromise = page.waitForResponse(
        (res) => res.url().includes('/api/schema') && res.request().method() === 'GET',
        { timeout },
      );
      await page.click('[aria-label="ファイルから再読み込み"]', { timeout });
      await responsePromise;
      // Reload は取得した DDL を *同じ* 生存中の PGlite セッションに対して
      // 再生する（ページのリロードではない）ため、前のシナリオの "users" は
      // 新しく読み込まれた "products" と並んで残っている——正確なテーブル数を
      // アサートせず、"products" が描画されたことだけを見る。
      // Reload の run({sql: content}) は読み込んだ DDL を SQL エディタの
      // textarea にも書き戻すため、素の `text=products` はキャンバスが実際に
      // テーブルを描画した証拠ではなくそちらに一致し得る——キャンバスの SVG に
      // スコープを絞る。
      await page.locator('svg').getByText('products', { exact: true }).waitFor({ timeout });
      return 'Reload picked up the externally-edited file';
    }),
  );

  return results;
}
