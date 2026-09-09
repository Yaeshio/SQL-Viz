import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { runScenario } from './runScenario.mjs';

// AppHeader.tsx は "tables N" / "rows N" を `.font-mono.text-slate-200` の
// span 2 つとしてこの順に描画する——`.first()` がテーブル数。
const TABLE_COUNT_SELECTOR = 'span.font-mono.text-slate-200';

/** Issue #32 の verify モードシナリオ: phaseA-restart.mjs が残した "products"
 * スキーマファイルに対し mode: 'verify' で起動した新しい openLocal.mjs プロセスと、
 * 同じくマウント済みの一時ディレクトリ配下の saveDir。多層の書き込みガードを
 * エンドツーエンドで通す: サイレント自動ロードは引き続き動作し（読み取りは
 * 制限されない）、Save は対象ファイルに触れず saveDir へエクスポートし、
 * POST /api/schema への直接アクセスは拒否される。 */
export async function run({ page, url, schemaPath, saveDir, timeout }) {
  const results = [];

  results.push(
    await runScenario('verify-mode-silently-autoloads-existing-schema', async () => {
      await page.goto(url, { waitUntil: 'load', timeout });
      await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === '1', TABLE_COUNT_SELECTOR, {
        timeout,
      });
      const productsOnCanvas = await page.locator('svg').getByText('products', { exact: true }).count();
      if (productsOnCanvas !== 1) {
        throw new Error('expected "products" table to appear on the canvas after silent auto-load in verify mode');
      }
      const badge = await page.locator('text=検証モード').count();
      if (badge !== 1) {
        throw new Error('expected a "検証モード" badge in the header while running in verify mode');
      }
      return 'existing schema auto-loaded silently, verify-mode badge visible';
    }),
  );

  results.push(
    await runScenario('verify-mode-save-exports-to-save-dir-without-touching-target-file', async () => {
      const beforeSave = await readFile(schemaPath, 'utf-8');

      await page.locator('textarea').fill('CREATE TABLE orders (id INT);');
      await page.click('text=Run SQL', { timeout });
      await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === '2', TABLE_COUNT_SELECTOR, {
        timeout,
      });

      const saveButton = page.locator('[data-testid="save-to-file-btn"]');
      if (await saveButton.isDisabled()) {
        throw new Error('save button unexpectedly disabled in verify mode (verify mode exports instead of disabling)');
      }

      const responsePromise = page.waitForResponse(
        (res) => res.url().includes('/api/schema/verify-save') && res.request().method() === 'POST',
        { timeout },
      );
      await saveButton.click();
      const response = await responsePromise;
      if (response.status() !== 200) {
        throw new Error(`expected POST /api/schema/verify-save to succeed, got status ${response.status()}`);
      }

      const afterSave = await readFile(schemaPath, 'utf-8');
      if (afterSave !== beforeSave) {
        throw new Error('target schema file was modified by Save in verify mode — write guard failed');
      }

      const savedFiles = (await readdir(saveDir)).filter((name) => name.startsWith('schema.'));
      if (savedFiles.length !== 1) {
        throw new Error(`expected exactly 1 exported file under saveDir, found ${savedFiles.length}: ${savedFiles.join(', ')}`);
      }
      const exportedContent = await readFile(path.join(saveDir, savedFiles[0]), 'utf-8');
      if (!exportedContent.includes('CREATE TABLE "orders"')) {
        throw new Error(`exported file did not contain the new table, got:\n${exportedContent}`);
      }

      return 'Save exported the new schema to saveDir; target file untouched';
    }),
  );

  results.push(
    await runScenario('verify-mode-rejects-direct-post-to-api-schema', async () => {
      const beforeSave = await readFile(schemaPath, 'utf-8');

      const status = await page.evaluate(async () => {
        const res = await fetch('/api/schema', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'DROP TABLE products;' }),
        });
        return res.status;
      });

      if (status !== 403) {
        throw new Error(`expected direct POST /api/schema to be rejected with 403 in verify mode, got ${status}`);
      }
      const afterSave = await readFile(schemaPath, 'utf-8');
      if (afterSave !== beforeSave) {
        throw new Error('target schema file was modified despite a 403 response — write guard failed');
      }
      return 'direct POST /api/schema rejected with 403, target file untouched';
    }),
  );

  return results;
}
