import { readFile, writeFile } from 'node:fs/promises';
import { runScenario } from './runScenario.mjs';

// AppHeader.tsx renders "tables N" / "rows N" as two `.font-mono.text-slate-200`
// spans in that order — `.first()` is the tables count.
const TABLE_COUNT_SELECTOR = 'span.font-mono.text-slate-200';

async function tableCountText(page) {
  return page.locator(TABLE_COUNT_SELECTOR).first().innerText();
}

/** Scenarios 1-3 of Phase A's real-file-I/O acceptance test (see
 * docs/alpha-phase-acceptance-criteria.md). Runs against a schema file that
 * does not exist yet, so this must be the first process to touch it. */
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
      // Simulates another process (e.g. a text editor) writing the file
      // directly, bypassing the app entirely.
      await writeFile(schemaPath, 'CREATE TABLE products (id INT, price INT);\n', 'utf-8');

      const responsePromise = page.waitForResponse(
        (res) => res.url().includes('/api/schema') && res.request().method() === 'GET',
        { timeout },
      );
      await page.click('[aria-label="ファイルから再読み込み"]', { timeout });
      await responsePromise;
      // Reload replays the fetched DDL against the *same* still-live PGlite
      // session (it isn't a page reload), so "users" from the previous
      // scenario is still present alongside the newly-loaded "products" —
      // don't assert an exact table count, just that "products" rendered.
      // Reload's run({sql: content}) also echoes the loaded DDL back into the
      // SQL editor textarea, so a bare `text=products` could match that
      // instead of proving the canvas actually rendered the table — scope to
      // the canvas SVG specifically.
      await page.locator('svg').getByText('products', { exact: true }).waitFor({ timeout });
      return 'Reload picked up the externally-edited file';
    }),
  );

  return results;
}
