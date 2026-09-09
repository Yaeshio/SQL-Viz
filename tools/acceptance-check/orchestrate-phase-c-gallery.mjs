#!/usr/bin/env node
// Issue #54 — 表示例ギャラリー生成オーケストレーター。
// orchestrate-phase-b.mjs と同型: spawnVite() で実 Vite dev サーバー
// （`npm run sql-studio` と同じもの）を空スキーマで起動し、シナリオコンテナ
// （./Dockerfile ビルド）を走らせる。B との違いは、fixture を使わず空キャンバス
// から状態を積み上げること、そして docs/assets/animation/ をコンテナへ bind mount
// して before/after PNG を直接リポジトリ内へ書き出させること。
//
// 使い方:
//   cd tools/acceptance-check && npm install && cd -
//   docker build -t sql-viz-acceptance-check tools/acceptance-check
//   node tools/acceptance-check/orchestrate-phase-c-gallery.mjs
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawnVite } from '../../scripts/openLocal.mjs';

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const OUT_DIR = path.join(repoRoot, 'docs', 'assets', 'animation');
const IMAGE = 'sql-viz-acceptance-check';

async function runDockerPhase(port, tmpDir) {
  const args = [
    'run',
    '--rm',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '-v',
    `${tmpDir}:/workspace`,
    '-v',
    `${OUT_DIR}:/out`,
    IMAGE,
    '--phase=C-gallery',
    `--url=http://host.docker.internal:${port}`,
    '--schema=/workspace/schema.sql',
    '--out-dir=/out',
    '--timeout=30000',
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
        // fall through
      }
    }
    throw err;
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'sql-viz-gallery-'));
  const schemaPath = path.join(tmpDir, 'schema.sql');
  await writeFile(schemaPath, '', 'utf-8'); // 空スキーマ = 空キャンバス起動

  let server;
  let report;
  try {
    server = await spawnVite({ filePath: schemaPath });
    const port = new URL(server.resolvedUrls.local[0]).port;
    report = await runDockerPhase(port, tmpDir);
  } finally {
    if (server) await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }

  const out = { phase: 'C-gallery', scenarios: report.scenarios, ok: report.scenarios.every((s) => s.pass) };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
