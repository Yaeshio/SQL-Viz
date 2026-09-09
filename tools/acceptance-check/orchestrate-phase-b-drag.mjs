#!/usr/bin/env node
// Phase B / Issue #34（テーブルのドラッグ移動）の受け入れシナリオのホスト側
// オーケストレーター。orchestrate-phase-b.mjs と同型: 2 テーブルの fixture の
// 使い捨てコピーに対して実 Vite dev サーバー（`npm run sql-studio` が使う
// spawnVite() と同じもの）を起動し、アプリが小さいキャンバスを自動ロードする
// ようにしてから、シナリオコンテナ（./Dockerfile からビルド）を実行する。
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawnVite } from '../../scripts/openLocal.mjs';

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const FIXTURE = path.join(here, 'fixtures', 'phaseB-drag-schema.sql');
const IMAGE = 'sql-viz-acceptance-check';

async function runDockerPhase(phase, port, tmpDir) {
  const args = [
    'run',
    '--rm',
    '-v',
    `${tmpDir}:/workspace`,
    IMAGE,
    `--phase=${phase}`,
    `--url=http://host.docker.internal:${port}`,
    '--schema=/workspace/schema.sql',
  ];
  try {
    const { stdout } = await execFileAsync('docker', args, { cwd: repoRoot });
    return JSON.parse(stdout.trim().split('\n').pop());
  } catch (err) {
    const stdout = err.stdout ?? '';
    const lastLine = stdout.trim().split('\n').pop();
    if (lastLine) {
      try {
        return JSON.parse(lastLine);
      } catch {
        // フォールスルー
      }
    }
    throw err;
  }
}

async function main() {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'sql-viz-acceptance-b-drag-'));
  const schemaPath = path.join(tmpDir, 'schema.sql');
  await copyFile(FIXTURE, schemaPath);

  let server;
  let report;
  try {
    server = await spawnVite({ filePath: schemaPath });
    const port = new URL(server.resolvedUrls.local[0]).port;
    report = await runDockerPhase('B-drag', port, tmpDir);
  } finally {
    if (server) await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }

  const out = { phase: 'B-drag', scenarios: report.scenarios, ok: report.scenarios.every((s) => s.pass) };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
