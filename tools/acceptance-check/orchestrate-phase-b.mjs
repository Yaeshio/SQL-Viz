#!/usr/bin/env node
// Host-side orchestrator for the Phase B (Issue #17 — canvas pan/zoom + fit)
// acceptance scenario. Same shape as orchestrate-phase-a.mjs but simpler: one
// dev server, no verify/restart passes. Boots a real Vite dev server (the same
// spawnVite() `npm run sql-studio` uses) against a throwaway copy of the
// many-table fixture so the app auto-loads a canvas larger than the Playwright
// viewport, then runs the scenario container (built from ./Dockerfile).
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
const FIXTURE = path.join(here, 'fixtures', 'phaseB-panzoom-schema.sql');
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
        // fall through
      }
    }
    throw err;
  }
}

async function main() {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'sql-viz-acceptance-b-'));
  const schemaPath = path.join(tmpDir, 'schema.sql');
  await copyFile(FIXTURE, schemaPath);

  let server;
  let report;
  try {
    server = await spawnVite({ filePath: schemaPath });
    const port = new URL(server.resolvedUrls.local[0]).port;
    report = await runDockerPhase('B-panzoom', port, tmpDir);
  } finally {
    if (server) await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }

  const out = { phase: 'B', scenarios: report.scenarios, ok: report.scenarios.every((s) => s.pass) };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
