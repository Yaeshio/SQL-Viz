import { runScenario } from './runScenario.mjs';

const TABLE_COUNT_SELECTOR = 'span.font-mono.text-slate-200';

/** Scenario 4 of Phase A's real-file-I/O acceptance test: a *fresh*
 * openLocal.mjs process's mount-time behavior against the file left behind
 * by phaseA-initial.mjs's last scenario (a single "products" table) — this
 * cannot be simulated by reusing the still-running server from phaseA-initial,
 * since the thing under test is process-startup auto-load. */
export async function run({ page, url, timeout }) {
  const results = [];

  results.push(
    await runScenario('restart-silently-autoloads-populated-schema-file', async () => {
      await page.goto(url, { waitUntil: 'load', timeout });
      // App.tsx's startup effect also sets the sql-editor textarea to the
      // loaded DDL, so a bare `text=products` could match that instead of
      // the canvas actually rendering the table — wait on the header's table
      // count and scope the text check to the canvas SVG specifically.
      await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === '1', TABLE_COUNT_SELECTOR, {
        timeout,
      });
      const productsOnCanvas = await page.locator('svg').getByText('products', { exact: true }).count();
      if (productsOnCanvas !== 1) {
        throw new Error('expected "products" table to appear on the canvas after silent auto-load');
      }

      const count = await page.locator(TABLE_COUNT_SELECTOR).first().innerText();
      if (count !== '1') {
        throw new Error(`expected 1 table after silent auto-load, got "${count}"`);
      }

      // App.tsx's startup effect calls run({ sql, silent: true }) — silent
      // runs must not append to the execution log.
      const emptyLogCount = await page.locator('text=No statements run yet.').count();
      if (emptyLogCount !== 1) {
        throw new Error('expected empty execution log after silent auto-load (silent:true must not write log entries)');
      }
      return 'table restored silently on process restart, no log entry written';
    }),
  );

  return results;
}
