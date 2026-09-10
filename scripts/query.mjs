#!/usr/bin/env node
// POST /api/query 用のエージェント向け CLI（Issue #27）。--history/--replay
// （Issue #37）で GET /api/query/history も叩く。素の JS で、TypeScript の
// import は持たない——openLocal.mjs と違い PgEngine や型へのアクセスが不要な
// ため、Node の消去可能構文（erasable syntax）による型ストリッピングの制約の
// 外側に完全に留まれる。
import { pathToFileURL } from 'node:url';

const DEFAULT_URL = 'http://127.0.0.1:5173';
const USAGE =
  'Usage: npm run query -- "<SQL>" [--mode=design|experiment] [--url=http://127.0.0.1:PORT]\n' +
  '   or: npm run query < script.sql\n' +
  '   or: npm run query -- --history [--url=...]\n' +
  '   or: npm run query -- --replay=<seq> [--url=...]';

export function parseArgs(argv) {
  let mode = 'design';
  let url = DEFAULT_URL;
  let replaySeq = null;
  let showHistory = false;
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--mode=')) {
      mode = arg.slice('--mode='.length);
    } else if (arg.startsWith('--url=')) {
      url = arg.slice('--url='.length);
    } else if (arg.startsWith('--replay=')) {
      replaySeq = Number(arg.slice('--replay='.length));
    } else if (arg === '--history') {
      showHistory = true;
    } else {
      positional.push(arg);
    }
  }
  return { sqlArg: positional.length ? positional.join(' ') : null, mode, url, replaySeq, showHistory };
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

/** GET /api/query/history（Issue #37）を取得するだけの純粋関数。runQuery と同じく
 * process.exit/console には触れない。 */
export async function fetchHistory({ url, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`${url}/api/query/history`);
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

  return { exitCode: 0, stdout: `${JSON.stringify(json)}\n` };
}

/** --replay=<seq> の対象を履歴から解決する。見つかった場合は再現性を優先し、
 * 記録済みの sql/mode をそのまま返す（--mode 指定があっても無視される）。 */
export async function resolveReplay({ replaySeq, url, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`${url}/api/query/history`);
  } catch (err) {
    return { exitCode: 2, stderr: `Could not reach sql-studio server at ${url}: ${err.message}\n` };
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    // json は null のままにしておく
  }

  if (!res.ok) {
    return { exitCode: 3, stderr: `Request rejected (${res.status}): ${json?.error ?? '(no error message)'}\n` };
  }

  const entry = (json?.history ?? []).find((h) => h.seq === replaySeq);
  if (!entry) {
    return { exitCode: 3, stderr: `No history entry with seq=${replaySeq}\n` };
  }
  return { sql: entry.sql, mode: entry.mode };
}

export async function main(argv = process.argv.slice(2)) {
  const { sqlArg, mode, url, replaySeq, showHistory } = parseArgs(argv);

  const modeCount = [sqlArg != null, replaySeq != null, showHistory].filter(Boolean).length;
  if (modeCount > 1) {
    process.stderr.write(`--history, --replay, and inline SQL are mutually exclusive.\n${USAGE}\n`);
    process.exit(3);
    return;
  }

  if (showHistory) {
    const { exitCode, stdout, stderr } = await fetchHistory({ url });
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.exit(exitCode);
    return;
  }

  let sql = sqlArg;
  let effectiveMode = mode;

  if (replaySeq != null) {
    if (!Number.isInteger(replaySeq) || replaySeq <= 0) {
      process.stderr.write(`Invalid --replay: must be a positive integer.\n${USAGE}\n`);
      process.exit(3);
      return;
    }
    const resolved = await resolveReplay({ replaySeq, url });
    if ('exitCode' in resolved) {
      if (resolved.stdout) process.stdout.write(resolved.stdout);
      if (resolved.stderr) process.stderr.write(resolved.stderr);
      process.exit(resolved.exitCode);
      return;
    }
    // 再現性を優先し、記録済みの sql/mode をそのまま使う（--mode 指定は無視する）。
    sql = resolved.sql;
    effectiveMode = resolved.mode;
  } else {
    if (mode !== 'design' && mode !== 'experiment') {
      process.stderr.write(`Invalid --mode: ${mode}\n${USAGE}\n`);
      process.exit(3);
      return;
    }
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
  }

  const { exitCode, stdout, stderr } = await runQuery({ sql, mode: effectiveMode, url });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
