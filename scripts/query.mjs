#!/usr/bin/env node
// POST /api/query 用のエージェント向け CLI（Issue #27）。素の JS で、TypeScript
// の import は持たない——openLocal.mjs と違い PgEngine や型へのアクセスが不要な
// ため、Node の消去可能構文（erasable syntax）による型ストリッピングの制約の
// 外側に完全に留まれる。
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

/** 純粋関数: fetch を行い、main() が必要とするものをすべて返す。自身は
 * process.exit / console に一切触れないため、fetchImpl をスタブすれば
 * そのまま単体テストできる。 */
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
    // json は null のままにしておく（下でオプショナルチェーンにより処理する）
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
