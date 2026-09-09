#!/usr/bin/env node
// Issue #31 の Docker E2E ランブック（docs/issue31-docker-e2e-runbook.md）用に、
// 使い捨ての「対象プロジェクト」git リポジトリを決定論的に生成する。これは
// スキーマファイルを sql-studio コンテナへ bind mount する実際の下流プロジェクトの
// 代役であり、意図的に SQL-Viz リポジトリではない。
//
// 使い方:  node tools/acceptance-check/fixtures/make-e2e-target-repo.mjs <dest-dir>
//
// <dest-dir> はまだ存在しないか、空のディレクトリでなければならない。スキーマ DDL
// ファイル本体（db/schema.sql）は意図的に作成しない。これにより最初のコンテナ実行が、
// scenarios/phaseA-initial.mjs がアサートするコールドスタート / ENOENT 経路を通る。
//
// stdout（ランブックがパースする）:
//   SCHEMA_REL=db/schema.sql
//   DEST=<絶対パス>
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SCHEMA_REL = 'db/schema.sql';

// 固定された副作用のないファイル内容——タイムスタンプ / バージョン / ホスト名を
// 含まないため、リポジトリは毎回同一にハッシュされる。
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
  // -c によりマシンのグローバルな git identity への依存を避ける。
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
