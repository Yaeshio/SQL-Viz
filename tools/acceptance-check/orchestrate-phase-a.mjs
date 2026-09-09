#!/usr/bin/env node
// Phase A の実ファイル I/O 受け入れシナリオ（docs/alpha-phase-acceptance-criteria.md）
// のホスト側オーケストレーター。素の Node で、このツール自身の node_modules には
// 依存しない: サブプロセスを起動して stdout をスクレイピングするのではなく、
// scripts/openLocal.mjs の spawnVite()（`npm run sql-studio` と同じコードパス）を
// 直接 import し、使い捨ての一時ディレクトリに対して 3 つの実 Vite dev サーバーを
// プロセス内で起動し（author モード初回、author モード再起動、verify モード）、
// それぞれに対してシナリオコンテナ（./Dockerfile からビルド）を実行する。
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawnVite } from '../../scripts/openLocal.mjs';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMAGE = 'sql-viz-acceptance-check';

async function runDockerPhase(phase, port, tmpDir, extraArgs = []) {
  const args = [
    'run',
    '--rm',
    '-v',
    `${tmpDir}:/workspace`,
    IMAGE,
    `--phase=${phase}`,
    `--url=http://host.docker.internal:${port}`,
    '--schema=/workspace/schema.sql',
    ...extraArgs,
  ];
  try {
    const { stdout } = await execFileAsync('docker', args, { cwd: repoRoot });
    return JSON.parse(stdout.trim().split('\n').pop());
  } catch (err) {
    // `run.mjs` が非ゼロ終了した場合（いずれかのシナリオが失敗）でも、
    // コンテナ自身の JSON レポートは stdout に出ている——その場合
    // util.promisify(execFile) は reject されたエラーに stdout/stderr を
    // 付与するので、「exit code 1」だけを表に出すのではなくレポートを回収する。
    const stdout = err.stdout ?? '';
    const lastLine = stdout.trim().split('\n').pop();
    if (lastLine) {
      try {
        return JSON.parse(lastLine);
      } catch {
        // 下の rethrow へフォールスルー
      }
    }
    throw err;
  }
}

async function main() {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'sql-viz-acceptance-'));
  // 意図的に事前作成しない: ENOENT / コールドスタート経路を通す。
  const schemaPath = path.join(tmpDir, 'schema.sql');
  let server;
  const allScenarios = [];

  try {
    server = await spawnVite({ filePath: schemaPath });
    const initialPort = new URL(server.resolvedUrls.local[0]).port;
    const initialReport = await runDockerPhase('A-initial', initialPort, tmpDir);
    allScenarios.push(...initialReport.scenarios);
    await server.close();
    server = undefined;

    // サーバーの使い回しではなく新しいプロセス: シナリオ 4 は再起動時の
    // 自動ロード挙動を検証するもので、本当に新しいプロセスでしか再現できない。
    server = await spawnVite({ filePath: schemaPath });
    const restartPort = new URL(server.resolvedUrls.local[0]).port;
    const restartReport = await runDockerPhase('A-restart', restartPort, tmpDir);
    allScenarios.push(...restartReport.scenarios);
    await server.close();
    server = undefined;

    // Issue #32: 3 つ目の新しいプロセス。同じ schemaPath（上のシナリオ群が
    // すでに内容を書き込んだ状態）に対して verify モードで起動する。saveDir は
    // 同じくマウント済みの tmpDir 配下に置くため、コンテナ側シナリオは専用の
    // ボリュームを持たずにエクスポート結果を読み戻せる。
    const hostSaveDir = path.join(tmpDir, 'verify-saves');
    await mkdir(hostSaveDir, { recursive: true });
    server = await spawnVite({ filePath: schemaPath, mode: 'verify', saveDir: hostSaveDir });
    const verifyPort = new URL(server.resolvedUrls.local[0]).port;
    const verifyReport = await runDockerPhase('A-verify', verifyPort, tmpDir, ['--save-dir=/workspace/verify-saves']);
    allScenarios.push(...verifyReport.scenarios);
  } finally {
    if (server) await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }

  const report = { phase: 'A', scenarios: allScenarios, ok: allScenarios.every((s) => s.pass) };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
