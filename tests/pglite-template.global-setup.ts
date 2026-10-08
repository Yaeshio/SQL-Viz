import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgliteTemplatePath: string;
  }
}

/**
 * Vitest の globalSetup（Issue #71）。テスト実行の最初に1回だけ `new PGlite()`
 * （内部で initdb を実行し約1.8秒かかる）でデータディレクトリを作り、それを
 * 非圧縮 tar として一時ファイルへ書き出して、パスを各ワーカーへ渡す。ワーカー側では
 * `pglite-template.setup.ts` がこれを `loadDataDir` として使い、1回あたりの起動を
 * 約0.35秒に縮める。中身は initdb 直後の空の DB なので、各テストが独立した新しい
 * DB を持つという性質は変わらない。テンプレートは毎回ここで生成するため、PGlite の
 * バージョンとずれることはない。
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const db = new PGlite();
  await db.waitReady;
  const dump = await db.dumpDataDir('none');
  await db.close();

  const dir = await mkdtemp(path.join(tmpdir(), 'sql-viz-pglite-template-'));
  const templatePath = path.join(dir, 'pgdata.tar');
  await writeFile(templatePath, Buffer.from(await dump.arrayBuffer()));
  project.provide('pgliteTemplatePath', templatePath);

  return async () => {
    await rm(dir, { recursive: true, force: true });
  };
}
