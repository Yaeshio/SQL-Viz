#!/usr/bin/env node
// Agent-facing CLI for POST /api/query (Issue #27). Plain JS, no TypeScript
// imports — unlike openLocal.mjs it needs no PgEngine/type access, so it
// stays outside Node's erasable-syntax type-stripping constraint entirely.
import { pathToFileURL } from 'node:url';

const DEFAULT_URL = 'http://127.0.0.1:5173';
const USAGE =
  'Usage: npm run query -- "<SQL>" [--mode=design|experiment] [--url=http://127.0.0.1:PORT]\n' +
  '   or: npm run query < script.sql';

export function parseArgs(argv) {
  let mode = 'design';
  let url = DEFAULT_URL;
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--mode=')) {
      mode = arg.slice('--mode='.length);
    } else if (arg.startsWith('--url=')) {
      url = arg.slice('--url='.length);
    } else {
      positional.push(arg);
    }
  }
  return { sqlArg: positional.length ? positional.join(' ') : null, mode, url };
}

export async function readStdin(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

/** Pure: does the fetch, returns everything main() needs. Never touches
 * process.exit/console itself, so it's directly unit-testable with a
 * stubbed fetchImpl. */
export async function runQuery({ sql, mode, url, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`${url}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, mode }),
    });
  } catch (err) {
    return { exitCode: 2, stderr: `Could not reach sql-studio server at ${url}: ${err.message}\n` };
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    // leave json null; handled below via optional chaining
  }

  if (!res.ok) {
    return { exitCode: 3, stderr: `Request rejected (${res.status}): ${json?.error ?? '(no error message)'}\n` };
  }

  const failed = Boolean(json?.parseError) || (json?.results ?? []).some((r) => r.error);
  return { exitCode: failed ? 1 : 0, stdout: `${JSON.stringify(json)}\n` };
}

export async function main(argv = process.argv.slice(2)) {
  const { sqlArg, mode, url } = parseArgs(argv);

  if (mode !== 'design' && mode !== 'experiment') {
    process.stderr.write(`Invalid --mode: ${mode}\n${USAGE}\n`);
    process.exit(3);
    return;
  }

  let sql = sqlArg;
  if (!sql) {
    if (process.stdin.isTTY) {
      process.stderr.write(`${USAGE}\n`);
      process.exit(3);
      return;
    }
    sql = (await readStdin()).trim();
    if (!sql) {
      process.stderr.write(`No SQL provided (empty stdin).\n${USAGE}\n`);
      process.exit(3);
      return;
    }
  }

  const { exitCode, stdout, stderr } = await runQuery({ sql, mode, url });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
