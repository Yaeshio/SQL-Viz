import { readFileSync } from 'node:fs';
import { inject, vi } from 'vitest';

/**
 * Vitest の setupFiles（Issue #71）。`@electric-sql/pglite` の `PGlite` を、引数なしで
 * 生成されたときだけ `pglite-template.global-setup.ts` が作った初期化済みテンプレートを
 * `loadDataDir` として使うサブクラスへ差し替える。`PgEngine.ensureReady()` の
 * `new PGlite()` はすべてこれを通るため、本番コードや各テストを書き換えずに、
 * queryApiPlugin や spawnVite 内部のエンジンも含むすべての経路で起動が速くなる。
 * 引数を渡した生成は元のコンストラクタへそのまま渡す。
 */
vi.mock('@electric-sql/pglite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@electric-sql/pglite')>();

  // PGlite を使わない純粋ロジックのテストにコストをかけないよう、最初の生成時に
  // 読み込む。node:fs/promises ではなく node:fs を使うのは、queryApiPlugin.test.ts が
  // node:fs/promises を vi.mock しているため。type を明示するのは、PGlite が Blob の
  // type で gzip かどうかを判定するため（テンプレートは非圧縮 tar）。
  let template: Blob | undefined;
  const loadTemplate = (): Blob =>
    (template ??= new Blob([readFileSync(inject('pgliteTemplatePath'))], { type: 'application/x-tar' }));

  class TemplatedPGlite extends actual.PGlite {
    constructor(...args: ConstructorParameters<typeof actual.PGlite>) {
      const templateArgs: ConstructorParameters<typeof actual.PGlite> = [{ loadDataDir: loadTemplate() }];
      super(...(args.length === 0 ? templateArgs : args));
    }
  }

  return { ...actual, PGlite: TemplatedPGlite };
});
