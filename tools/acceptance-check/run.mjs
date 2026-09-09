import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const { values } = parseArgs({
  options: {
    phase: { type: 'string' },
    url: { type: 'string' },
    schema: { type: 'string' },
    'save-dir': { type: 'string' },
    'out-dir': { type: 'string' },
    out: { type: 'string' },
    timeout: { type: 'string', default: '15000' },
  },
});

if (!values.phase || !values.url || !values.schema) {
  process.stderr.write(
    'Usage: node run.mjs --phase=<A-initial|A-restart|A-verify|B-panzoom|B-drag|C-gallery> --url=<http://host:port/> --schema=</workspace/schema.sql> [--save-dir=</workspace/verify-saves>] [--out-dir=</out>] [--out=<path>] [--timeout=15000]\n',
  );
  process.exit(2);
}

// --phase=A-initial -> ./scenarios/phaseA-initial.mjs
const { run } = await import(`./scenarios/phase${values.phase}.mjs`);

const timeout = Number(values.timeout);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

let scenarios;
try {
  scenarios = await run({
    page,
    url: values.url,
    schemaPath: values.schema,
    saveDir: values['save-dir'],
    outDir: values['out-dir'],
    timeout,
  });
} catch (err) {
  scenarios = [{ name: 'unexpected-runner-error', pass: false, detail: String(err) }];
} finally {
  await browser.close();
}

const report = { phase: values.phase, scenarios, ok: scenarios.every((s) => s.pass) };
const json = JSON.stringify(report);

console.log(json);
if (values.out) await writeFile(values.out, json, 'utf-8');

process.exit(report.ok ? 0 : 1);
