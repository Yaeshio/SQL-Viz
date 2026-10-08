import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // 初期化済みの PGlite テンプレートを1回だけ作り（globalSetup）、各テストの
    // `new PGlite()` をそこからの起動に差し替える（setupFiles）。Issue #71。
    globalSetup: ['tests/pglite-template.global-setup.ts'],
    setupFiles: ['tests/pglite-template.setup.ts'],
    // PgEngine を使うテストは、テンプレートからとはいえ実際の PGlite（WASM
    // Postgres）インスタンスを起動するため、純粋な JS ロジックのテストより遅い。
    testTimeout: 30000,
  },
});
