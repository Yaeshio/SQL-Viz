import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ViteDevServer } from 'vite';
import { spawnVite } from '../scripts/openLocal.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Issue #27 の HTTP API + CLI の実エンドツーエンドのラウンドトリップ
// （docs/alpha-phase-acceptance-criteria.md で事前決定済み——この Issue には
// ブラウザ要素が無いので、その受け入れテストは tools/acceptance-check ではなく
// ここに属する）。本物の dev サーバーを起動し（tools/acceptance-check/
// orchestrate-phase-a.mjs が既にこの方法で使っているのと同じ spawnVite()）、
// 使い捨ての一時ディレクトリに対して scripts/query.mjs を実際の子プロセスとして
// spawn する。

async function waitForHealthy(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${url}api/query/health`);
      if (res.ok) {
        const { ready } = await res.json();
        if (ready) return;
      }
    } catch {
      // サーバーはまだ接続を受け付けていない
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${url}api/query/health`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync('node', ['scripts/query.mjs', ...args], { cwd: repoRoot });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

let server: ViteDevServer | undefined;
let tmpDir: string | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('agent query API — real server + real CLI subprocess', () => {
  it(
    'QUERY-INT-01: HTTP API — health/query/state/resetの実往復',
    async () => {
      tmpDir = await mkdtemp(path.join(tmpdir(), 'sql-viz-query-api-'));
      const schemaPath = path.join(tmpDir, 'schema.sql'); // 意図的に事前作成しない

      server = await spawnVite({ filePath: schemaPath, port: undefined });
      const url = server.resolvedUrls!.local[0];
      await waitForHealthy(url);

      const createRes = await fetch(`${url}api/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: 'CREATE TABLE users (id INT, name VARCHAR(50))', mode: 'design' }),
      });
      expect(createRes.status).toBe(200);
      const createBody = await createRes.json();
      expect(createBody.results[0].error).toBeUndefined();

      const stateRes = await fetch(`${url}api/query/state`);
      const { state } = await stateRes.json();
      expect(state.order).toEqual(['users']);

      const resetRes = await fetch(`${url}api/query/reset`, { method: 'POST' });
      expect(resetRes.status).toBe(200);
      expect(await resetRes.json()).toEqual({ ok: true, error: null });

      const afterResetState = await (await fetch(`${url}api/query/state`)).json();
      expect(afterResetState.state.order).toEqual([]); // スキーマファイルは空/不在だった
    },
    60000,
  );

  it(
    'QUERY-INT-02: CLI — npm run query 相当のプロセスがJSONのみをstdoutに出しexit 0で終了する',
    async () => {
      tmpDir = await mkdtemp(path.join(tmpdir(), 'sql-viz-query-api-'));
      const schemaPath = path.join(tmpDir, 'schema.sql');

      server = await spawnVite({ filePath: schemaPath, port: undefined });
      const url = server.resolvedUrls!.local[0];
      await waitForHealthy(url);

      const create = await runCli(['CREATE TABLE users (id INT)', `--url=${url.replace(/\/$/, '')}`]);
      expect(create.code).toBe(0);
      expect(create.stdout.trim()).not.toBe('');
      const parsed = JSON.parse(create.stdout); // そのまま JSON.parse できなければならない
      expect(parsed.results[0].error).toBeUndefined();

      // セッションの現在のモードで許可されない文: CLI はそれを引き続き exit code 1
      // （SQL 実行エラー）として報告し、stdout は依然として純粋な JSON。
      const modeViolation = await runCli(['SELECT * FROM users', `--url=${url.replace(/\/$/, '')}`, '--mode=design']);
      expect(modeViolation.code).toBe(1);
      const violationBody = JSON.parse(modeViolation.stdout);
      expect(violationBody.parseError).toContain('is not allowed in design mode');
    },
    60000,
  );

  it(
    'QUERY-INT-04: 実験モードのエラー後もセッションが汚染されず後続リクエストが通る (Issue #36)',
    async () => {
      tmpDir = await mkdtemp(path.join(tmpdir(), 'sql-viz-query-api-'));
      const schemaPath = path.join(tmpDir, 'schema.sql');

      server = await spawnVite({ filePath: schemaPath, port: undefined });
      const url = server.resolvedUrls!.local[0];
      await waitForHealthy(url);

      const post = (sql: string, mode: string) =>
        fetch(`${url}api/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql, mode }),
        }).then((r) => r.json());

      expect((await post('CREATE TABLE users (id INT, name VARCHAR(50))', 'design')).results[0].error).toBeUndefined();

      const bad = await post('INSERT INTO ghost (x) VALUES (1)', 'experiment');
      expect(bad.results[0].error).toBe('relation "ghost" does not exist');

      // SAVEPOINT 修正の前は、これは
      // "current transaction is aborted, commands ignored until end of transaction block"
      // で失敗していた。
      const recovered = await post('SELECT * FROM users', 'experiment');
      expect(recovered.parseError).toBeUndefined();
      expect(recovered.results[0].error).toBeUndefined();

      // experiment のエラー後の design モードの文も、再び動作する。
      const alter = await post('ALTER TABLE users ADD COLUMN age INT', 'design');
      expect(alter.results[0].error).toBeUndefined();
    },
    60000,
  );

  it(
    'QUERY-INT-03: CLI — サーバー未起動/接続不可 → exit code 2',
    async () => {
      const result = await runCli(['SELECT 1', '--url=http://127.0.0.1:1']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('Could not reach');
    },
    15000,
  );

  it(
    'QUERY-INT-05: CLI — --history で一覧取得後、--replay=<seq> で再実行できる (Issue #37)',
    async () => {
      tmpDir = await mkdtemp(path.join(tmpdir(), 'sql-viz-query-api-'));
      const schemaPath = path.join(tmpDir, 'schema.sql');

      server = await spawnVite({ filePath: schemaPath, port: undefined });
      const url = server.resolvedUrls!.local[0];
      await waitForHealthy(url);
      const urlArg = `--url=${url.replace(/\/$/, '')}`;

      const create = await runCli(['CREATE TABLE users (id INT)', urlArg]);
      expect(create.code).toBe(0);

      const historyRes = await runCli(['--history', urlArg]);
      expect(historyRes.code).toBe(0);
      const { history } = JSON.parse(historyRes.stdout);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ seq: 1, sql: 'CREATE TABLE users (id INT)', mode: 'design', ok: true });

      // 同一SQLをdesignモードで再実行するとテーブルが既に存在し失敗する——これは
      // replayが実際に元のsql/modeを再送していることの検証を兼ねる。
      const replay = await runCli(['--replay=1', urlArg]);
      expect(replay.code).toBe(1);
      const replayBody = JSON.parse(replay.stdout);
      expect(replayBody.results[0].error).toContain('already exists');

      // replay自体も新しい履歴エントリとして記録される。
      const historyAfter = await runCli(['--history', urlArg]);
      expect(JSON.parse(historyAfter.stdout).history).toHaveLength(2);
    },
    60000,
  );

  it(
    'QUERY-INT-06: POST /api/query/reset を挟んでも --history の内容は消えない (Issue #37)',
    async () => {
      tmpDir = await mkdtemp(path.join(tmpdir(), 'sql-viz-query-api-'));
      const schemaPath = path.join(tmpDir, 'schema.sql');

      server = await spawnVite({ filePath: schemaPath, port: undefined });
      const url = server.resolvedUrls!.local[0];
      await waitForHealthy(url);
      const urlArg = `--url=${url.replace(/\/$/, '')}`;

      await runCli(['CREATE TABLE users (id INT)', urlArg]);

      const resetRes = await fetch(`${url}api/query/reset`, { method: 'POST' });
      expect(await resetRes.json()).toEqual({ ok: true, error: null });

      const historyRes = await runCli(['--history', urlArg]);
      const { history } = JSON.parse(historyRes.stdout);
      expect(history).toHaveLength(1);
      expect(history[0].sql).toBe('CREATE TABLE users (id INT)');
    },
    60000,
  );
});
