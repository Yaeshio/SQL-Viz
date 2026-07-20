import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://host.docker.internal:5173' },
    out: { type: 'string', default: '/app/out/screenshot.png' },
    'wait-for': { type: 'string' },
    click: { type: 'string' },
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
  // Vite dev server keeps an HMR WebSocket open, so 'networkidle' never
  // resolves; 'load' plus the wait-for/click steps below is sufficient.
  await page.goto(values.url, { waitUntil: 'load', timeout });

  if (values['wait-for']) {
    await page.waitForSelector(values['wait-for'], { timeout });
  }
  if (values.click) {
    await page.click(values.click, { timeout });
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
