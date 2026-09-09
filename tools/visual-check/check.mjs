import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://host.docker.internal:5173' },
    out: { type: 'string', default: '/app/out/screenshot.png' },
    'wait-for': { type: 'string' },
    click: { type: 'string', multiple: true },
    'wait-after-click': { type: 'string' },
    'full-page': { type: 'boolean', default: false },
    timeout: { type: 'string', default: '10000' },
  },
});

const timeout = Number(values.timeout);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(String(err)));

let result = { ok: true, url: values.url, screenshot: values.out, consoleErrors: [] };

try {
  // Vite dev サーバーは HMR の WebSocket を開いたままにするため 'networkidle' は
  // 決して解決しない。'load' に加えて下の wait-for / click ステップで十分。
  await page.goto(values.url, { waitUntil: 'load', timeout });

  if (values['wait-for']) {
    await page.waitForSelector(values['wait-for'], { timeout });
  }
  // 繰り返し可能: --click a --click b は a → b の順にクリックする（例: モードを
  // 切り替えてから Run を押す）。次へ進む前に 1 つずつ個別に待機する。
  for (const selector of values.click ?? []) {
    await page.click(selector, { timeout });
  }
  // 一部の操作（例: Run SQL）は非同期処理——エンジンのコールドスタート、
  // その後の delay で刻まれるアニメーションのタイムライン——を引き起こし、
  // click() が解決した瞬間には DOM へ反映されていない。--wait-after-click は
  // その非同期処理が落ち着いて初めて現れるセレクタを呼び出し側が待てるようにする。
  if (values['wait-after-click']) {
    await page.waitForSelector(values['wait-after-click'], { timeout });
  }

  await page.screenshot({ path: values.out, fullPage: values['full-page'] });
  result.consoleErrors = consoleErrors;
} catch (err) {
  result = { ok: false, url: values.url, error: String(err), consoleErrors };
} finally {
  await browser.close();
}

console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
