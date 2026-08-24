#!/usr/bin/env node
// Host-side orchestrator for the Phase A real-file-I/O acceptance scenarios
// (docs/alpha-phase-acceptance-criteria.md). Plain Node, no dependency on
// this tool's own node_modules: it imports scripts/openLocal.mjs's
// spawnVite() directly (the same code path `npm run sql-studio` uses) rather
// than spawning a subprocess and scraping stdout, boots two real Vite dev
// servers in-process against a throwaway temp directory, and runs the
// scenario container (built from ./Dockerfile) against each one.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawnVite } from '../../scripts/openLocal.mjs';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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
    // The container's own JSON report is on stdout even when `run.mjs` exits
    // non-zero (some scenario failed) — util.promisify(execFile) attaches
    // stdout/stderr to the rejected error in that case, so recover the
    // report instead of only surfacing "exited with code 1".
    const stdout = err.stdout ?? '';
    const lastLine = stdout.trim().split('\n').pop();
    if (lastLine) {
      try {
        return JSON.parse(lastLine);
      } catch {
        // fall through to rethrow below
      }
    }
    throw err;
  }
}

async function main() {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'sql-viz-acceptance-'));
  // Deliberately not pre-created: exercises the ENOENT/cold-start path.
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

    // A fresh process, not a reused server: scenario 4 verifies restart-time
    // auto-load behavior, which only a genuinely new process can exercise.
    server = await spawnVite({ filePath: schemaPath });
    const restartPort = new URL(server.resolvedUrls.local[0]).port;
    const restartReport = await runDockerPhase('A-restart', restartPort, tmpDir);
    allScenarios.push(...restartReport.scenarios);
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
