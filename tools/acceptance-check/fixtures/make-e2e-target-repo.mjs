#!/usr/bin/env node
// Deterministically materializes a throwaway "target project" git repo for the
// Issue #31 Docker E2E runbook (docs/issue31-docker-e2e-runbook.md). This
// stands in for a real downstream project that bind-mounts its schema file
// into the sql-studio container — it is intentionally NOT the SQL-Viz repo.
//
// Usage:  node tools/acceptance-check/fixtures/make-e2e-target-repo.mjs <dest-dir>
//
// <dest-dir> must not exist yet, or must be an empty directory. The schema DDL
// file itself (db/schema.sql) is deliberately NOT created, so the first
// container run exercises the cold-start / ENOENT path that
// scenarios/phaseA-initial.mjs asserts on.
//
// stdout (parsed by the runbook):
//   SCHEMA_REL=db/schema.sql
//   DEST=<absolute path>
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SCHEMA_REL = 'db/schema.sql';

// Fixed, side-effect-free file contents — no timestamps / versions / hostnames,
// so the repo hashes identically on every run.
const FILES = {
  '.gitignore': ['node_modules/', 'verify-saves/', ''].join('\n'),
  'README.md': [
    '# E2E target project (fixture)',
    '',
    'Throwaway fixture for the SQL-Viz Issue #31 Docker E2E runbook',
    '(`docs/issue31-docker-e2e-runbook.md`). Not a real project. Safe to delete.',
    '',
    `The sql-studio container is pointed at \`${SCHEMA_REL}\`, which does not exist`,
    'until the first Save writes it.',
    '',
  ].join('\n'),
  'db/.gitkeep': '',
  'migrations/0001_placeholder.sql': '-- placeholder migration, unrelated to db/schema.sql\n',
};

function main(argv) {
  const destArg = argv[0];
  if (!destArg) {
    process.stderr.write('Usage: node tools/acceptance-check/fixtures/make-e2e-target-repo.mjs <dest-dir>\n');
    process.exit(2);
    return;
  }
  const dest = path.resolve(destArg);

  if (existsSync(dest) && readdirSync(dest).length > 0) {
    process.stderr.write(`refusing to write into a non-empty directory: ${dest}\n`);
    process.exit(1);
    return;
  }

  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(dest, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }

  const git = (...args) => execFileSync('git', ['-C', dest, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  // -c avoids depending on the machine's global git identity.
  git(
    '-c',
    'user.email=e2e@example.invalid',
    '-c',
    'user.name=sql-viz-e2e',
    'commit',
    '-q',
    '-m',
    'fixture: E2E target project',
  );

  process.stdout.write(`SCHEMA_REL=${SCHEMA_REL}\n`);
  process.stdout.write(`DEST=${dest}\n`);
}

main(process.argv.slice(2));
