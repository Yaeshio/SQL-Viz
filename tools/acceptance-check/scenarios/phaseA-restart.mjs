import { runScenario } from './runScenario.mjs';

const TABLE_COUNT_SELECTOR = 'span.font-mono.text-slate-200';

/** Phase A の実ファイル I/O 受け入れテストのシナリオ 4: *新しい* openLocal.mjs
 * プロセスの、phaseA-initial.mjs の最後のシナリオが残したファイル
 * （"products" テーブル 1 つ）に対するマウント時の挙動——検証対象がプロセス
 * 起動時の自動ロードであるため、phaseA-initial の生存中サーバーを使い回しても
 * 再現できない。 */
export async function run({ page, url, timeout }) {
  const results = [];

  results.push(
    await runScenario('restart-silently-autoloads-populated-schema-file', async () => {
      await page.goto(url, { waitUntil: 'load', timeout });
      // App.tsx の起動時 effect は SQL エディタの textarea にも読み込んだ DDL を
      // セットするため、素の `text=products` はキャンバスが実際にテーブルを
      // 描画したことではなくそちらに一致し得る——ヘッダーのテーブル数を待ち、
      // テキスト確認はキャンバスの SVG にスコープを絞る。
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

      // App.tsx の起動時 effect は run({ sql, silent: true }) を呼ぶ——silent の
      // 実行は実行ログに追記してはならない。
      const emptyLogCount = await page.locator('text=No statements run yet.').count();
      if (emptyLogCount !== 1) {
        throw new Error('expected empty execution log after silent auto-load (silent:true must not write log entries)');
      }
      return 'table restored silently on process restart, no log entry written';
    }),
  );

  return results;
}
