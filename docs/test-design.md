# テスト設計書

このドキュメントは [test-spec.md](./test-spec.md) で定義した検証観点を、Vitest を用いて
**どう実装・配置・実行するか**を定義するものである。

## 1. 目的

test-spec.md の各テストケースを、拡張性を保ちながら実装・運用するための技術的な
指針を示す。特に reducer 層・イベント生成層は対応 SQL 構文の増加に伴いケースが
増え続けることを前提に設計する。

## 2. テストツール・環境構築

### ツール選定

Issue #001 の指示通り **Vitest** を採用する。Vite の環境が既に整っており、
`vite.config.ts` の設定（`@vitejs/plugin-react` 等）と親和性が高いため、追加の
ビルド設定なしでテストを実行できる。

### 追加する依存関係

- `vitest`（devDependencies に追加）

現時点でテスト対象は UI を含まないため、`@testing-library/react` や `jsdom` は
追加しない。`@vitest/ui` はデバッグ時に便利だが必須ではなく、CLAUDE.md の
「明確な必要性がない限り新規パッケージを追加しない」方針に従い、今回は追加しない
（必要になった時点で改めて検討する）。

### `package.json` スクリプト

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

`test` は CI・コミット前チェック用に一度だけ実行して終了するモード、
`test:watch` はローカル開発時にファイル変更を検知して再実行するモードとする。

### `vitest.config.ts`

`vite.config.ts` とは別ファイルとして新設する。テスト対象は DOM に依存しない
純粋関数のみ（`parser.ts`/`reducer.ts`/`diff.ts`/`layout.ts`）のため、`environment` は
デフォルトの `'node'` で十分であり、`jsdom` 等は不要。テストファイルは 3節の通り
プロジェクトルート直下の `tests/` ディレクトリに配置するため、`include` パターンも
それに合わせる。テスト対象コード自体を `import` で参照できるよう、エイリアス等の
追加設定は不要（相対パス `../src/...` で参照する）。

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
```

将来 UI コンポーネントのテストを追加する場合は、`vite.config.ts` の設定
（`react()` プラグイン等）とマージする形で `vite.config.ts` 側に `test` フィールドを
統合する方針に切り替えることも検討可能だが、現時点では純粋関数のテストのみのため
分離したシンプルな設定を優先する。

## 3. テストファイルの配置規約

テストファイルはソースコードと分離し、プロジェクトルート直下に新設する
**`tests/` ディレクトリに集約配置**する。CLAUDE.md には「すべて `src/` 直下に
フラットに配置されている（サブフォルダ無し）」という既存の構成方針の記載があるが、
これはアプリケーションコードの構成方針であり、テストコード専用のディレクトリを
別途設けることで `src/` 側のフラット構成は変更せずに済む。`tests/` 内部も
`src/` と同様にサブフォルダを作らずフラットに配置し、対象ファイル名との対応が
一目で分かるようにする。

```
SQL-Viz/
├── src/            … アプリケーションコード（既存、フラット配置は変更しない）
└── tests/          … テストコード（新設）
    ├── parser.test.ts
    ├── reducer.test.ts
    ├── layout.test.ts
    ├── diff.test.ts
    ├── events.test.ts
    └── test-utils.ts
```

| ファイル | 対象 |
|---|---|
| `tests/parser.test.ts` | パーサー層（test-spec.md 3節） |
| `tests/reducer.test.ts` | reducer層（test-spec.md 4節） |
| `tests/layout.test.ts` | layout層（test-spec.md 5節） |
| `tests/diff.test.ts` | diff層（test-spec.md 6節） |
| `tests/events.test.ts` | イベント生成層（test-spec.md 7節）。`diff.test.ts` との
  混同を避けるため独立したファイル名にする |
| `tests/test-utils.ts` | 各テストで共有するフィクスチャ・ヘルパー関数。ファイル名に
  `.test.` を含めないことで Vitest の `include: ['tests/**/*.test.ts']` パターンの
  自動収集対象から除外される（テストランナーが直接実行しようとしない） |

各テストファイルはテスト対象を相対パスでインポートする（例:
`import { parseSql } from '../src/parser';`）。

### 関連する設定ファイルへの影響

`tests/` を `src/` の外に置くため、既存の型チェック・Lint 設定がテストコードを
カバーするか確認が必要。

- **`tsconfig.app.json`** — 現状 `include: ["src"]` のため、`tests/` はこのままでは
  `npm run typecheck`（`tsc --noEmit -p tsconfig.app.json`）の対象に含まれない。
  `include` に `"tests"` を追加し `["src", "tests"]` とする変更が必要。
- **`eslint.config.js`** — `files: ['**/*.{ts,tsx}']` はプロジェクトルートからの
  glob でありディレクトリを問わず全体に適用されるため、`tests/` 配下も追加設定なしで
  ESLint の対象になる（変更不要）。

## 4. 各層のテスト実装方針

### 4.1 パーサー層（`tests/parser.test.ts`）

`parseSql()` に実際の SQL 文字列を渡し、戻り値の `statements`/`error` を
アサーションする。`node-sql-parser` はモック化せず実際の依存をそのまま使用する
（パーサーの結果自体が検証対象であり、モックすると意味がなくなるため）。

test-spec.md 3節の各項目に 1:1 対応する `describe`/`it` を用意する。

### 4.2 reducer層（`tests/reducer.test.ts`）

`applyCreateTable`/`applyInsert`/`applySelect` を直接呼び出し、戻り値の
`state`/`error` を検証する。test-spec.md 4節の表形式ケースに対応させるため、
`it.each` によるテーブル駆動テストを基本形とする。

```ts
describe('applySelect', () => {
  it.each([
    // [ケースID, where, 期待するfilteredOutパターン]
    ['REDUCER-SELECT-03a', { column: 'id', operator: '>', value: 1 }, [false, true, true]],
    ['REDUCER-SELECT-03b', { column: 'id', operator: '<=', value: 2 }, [true, true, false]],
    // SQL構文が拡張されたらここに行を追加するだけでケースが増える
  ])('%s', (_id, where, expected) => {
    // ...
  });
});
```

`cloneState` の不変性検証（REDUCER-IMMUT-01）は、`apply*` 呼び出し前に元の
`state` を `structuredClone` 等で複製して保持しておき、呼び出し後に元の `state`
オブジェクトが変化していないことを `toEqual` で比較する形で実装する。

### 4.3 layout層（`tests/layout.test.ts`）

`layoutTables(state, canvasW)` と `TABLE_H(t)` を対象とする。test-spec.md 5節の
表に対応させ、`canvasW` と `state`（テーブル数・カラム数・行数）の組み合わせを
`it.each` で列挙する。

```ts
describe('layoutTables — 列数と折り返し', () => {
  it.each([
    ['LAYOUT-COLS-01', 1000, 3, /* 期待される cols */ 3],
    ['LAYOUT-COLS-02', 300, 3, /* 期待される cols */ 1],
    // canvasW と期待される列数の組み合わせを追加していく
  ])('%s', (_id, canvasW, tableCount, expectedCols) => {
    // ...
  });
});
```

`layoutTables()` は引数の `state` を直接書き換えて返す非 immutable な関数である
（LAYOUT-MUTATE-01、test-spec.md 5節）。他の層のテストのように「呼び出し前後で
元の state が不変であること」を検証するのではなく、逆に **呼び出し後に元の
`state` オブジェクトの `x`/`y` が書き換わっていること**、かつ戻り値と引数が
同一参照（`toBe`）であることを検証する。この非対称性（reducer層は immutable、
layout層は mutable）はコードコメントで明示し、reducer層のテストと混同しないよう
`describe` のタイトルに明記する。

LAYOUT-Y-01（同一行内で高さの異なるテーブルが並ぶ場合の `y` 計算）は、
「あるべき挙動」ではなく「現状の実装が実際にどう動くか」を固定する特性テストで
ある点をテストのコメントに明記し、将来 `layoutTables` の計算式を意図的に
変更した場合にはこのテストごと更新することを前提とする。

### 4.4 diff層（`tests/diff.test.ts`）

`diffStates(old, next)` に手組みの `DBState` ペアを渡して戻り値の
`AnimationEvent[]` を検証する。`DBState` を毎回手書きすると冗長になるため、
`test-utils.ts` に以下のビルダー関数を用意する。

- `makeColumn(name, type)`
- `makeRow(id, values, filteredOut?)`
- `makeTable(name, columns, rows)`
- `makeState(tables, order, lastSelect?)`

境界ケース（DIFF-ROW-02, DIFF-ORDER-01 等）では、これらのビルダーを組み合わせて
old/next のスナップショットを構築し、`diffStates` の戻り値の**順序**まで
`toEqual` で検証する（イベントの発生有無だけでなく順序もパイプラインの
アニメーション演出上重要なため）。

### 4.5 イベント生成層（統合テスト、`tests/events.test.ts`）

test-spec.md 2節で述べた通り、この層は「SQL文字列（列） → parser → reducer適用
→ diffStates」を通した検証を行う。`test-utils.ts` に以下のヘルパーを設ける。

```ts
// tests/test-utils.ts
import { parseSql } from '../src/parser';
import { applyCreateTable, applyInsert, applySelect, emptyState } from '../src/reducer';
import { diffStates } from '../src/diff';
import type { AnimationEvent, DBState } from '../src/types';

/**
 * SQL文字列の配列を順に実行し、文ごとに生成されたイベント列を返す。
 * layoutTables() は挟まない（diffStates は x/y 座標を参照しないため）。
 */
export function runSqlStatements(sqlList: string[]): { state: DBState; events: AnimationEvent[] }[] {
  let current = emptyState();
  const results: { state: DBState; events: AnimationEvent[] }[] = [];
  for (const sql of sqlList) {
    const { statements, error } = parseSql(sql);
    if (error) throw new Error(error);
    for (const stmt of statements) {
      let next: DBState;
      if (stmt.type === 'create') {
        next = applyCreateTable(current, stmt.table, stmt.columns).state;
      } else if (stmt.type === 'insert') {
        next = current;
        for (const row of stmt.rows) next = applyInsert(next, stmt.table, stmt.columns, row).state;
      } else {
        next = applySelect(current, stmt.table, stmt.columns, stmt.where).state;
      }
      results.push({ state: next, events: diffStates(current, next) });
      current = next;
    }
  }
  return results;
}
```

**`layoutTables` を挟まない理由**: `diff.ts` の実装は `Table.x`/`Table.y` を
一切参照しない（`diffStates` は `order`/`tables[].rows`/`lastSelect` のみを見る）。
`layoutTables` を挟むと `canvasWidth` という無関係なパラメータにテストの入力が
依存してしまい、テストの関心が拡散する。実運用の `App.tsx` の `run()` では
`layoutTables` を挟んでからログ・アニメーションを行っているが、これは描画用の
座標計算であり、イベント生成のロジックそのものには影響しない。

このヘルパーはエラーを `throw` する設計とし、EVENT-07（途中の文でエラーになる
シナリオ）は `expect(() => runSqlStatements([...])).toThrow()` として検証する。

## 5. テストデータ・フィクスチャの共通化方針

`tests/test-utils.ts` に以下を集約する。

- 共通の `CREATE TABLE` 文定数（例: `SAMPLE_CREATE_USERS = "CREATE TABLE users (id INT, name VARCHAR(50))"`）
- `makeColumn`/`makeRow`/`makeTable`/`makeState`（diff層テスト用ビルダー、layout層テストでの
  入力 `state` 組み立てにも流用する）
- `runSqlStatements`（イベント生成層テスト用ヘルパー）

これにより、各テストファイルは対象レイヤーのアサーションに集中でき、
フィクスチャの重複記述を避けられる。

## 6. CI/lint/typecheck との統合

- `npm test`（`vitest run`）を `npm run lint` / `npm run typecheck` と並ぶ
  基本チェックコマンドの一つとして位置づける。
- `tsconfig.app.json` の `include` を `["src", "tests"]` に変更し、`tests/*.test.ts`
  も `npm run typecheck`（`tsc --noEmit -p tsconfig.app.json`）の対象に含める
  （3節「関連する設定ファイルへの影響」を参照）。`strict`/`noUnusedLocals`/
  `noUnusedParameters` が有効なため、テストコードもこれらの制約に従う必要がある。
- `eslint.config.js` の `files: ['**/*.{ts,tsx}']` はディレクトリを問わず
  プロジェクト全体に適用されるため、`tests/*.test.ts` も変更なしで ESLint の
  対象になる。Vitest のグローバル関数（`describe`/`it`/`expect` 等）は ESLint の
  `globals` 設定を変更せず、各テストファイルで
  `import { describe, it, expect } from 'vitest'` と明示的にインポートする方針と
  する（設定変更を最小限にするため）。
- GitHub Actions 等の CI ワークフローの新設は、Issue #001 の記述には含まれて
  いないため今回のスコープ外とする（検討事項として8節に記載）。

## 7. 将来の SQL 構文拡張時のテスト追加ガイドライン

`UPDATE`/`DELETE`/`JOIN`/複合 `WHERE` などに対応する際は、影響範囲に応じて
以下の箇所にテストを追加する。

| 変更内容 | 追加が必要なテスト |
|---|---|
| `parser.ts` に新しい文種・構文パターンを追加 | `tests/parser.test.ts` に該当パターンのケースを追加（test-spec.md 3節） |
| `reducer.ts` に新しい `apply*` 関数を追加、または既存関数の挙動を変更 | `tests/reducer.test.ts` の該当 `describe` ブロックに `it.each` の要素として追加（test-spec.md 4節） |
| `layout.ts` のグリッド計算式・定数を変更 | `tests/layout.test.ts` の該当ケースを追加・更新（test-spec.md 5節） |
| `types.ts` の `AnimationEvent` に新しい種類のイベントを追加 | `tests/diff.test.ts` に発生条件のケースを追加（test-spec.md 6節） |
| 上記の組み合わせにより新しいユーザーシナリオが生まれる | `tests/events.test.ts` に `runSqlStatements` を使ったシナリオを追加（test-spec.md 7節） |

test-spec.md のケース ID（`REDUCER-*`/`LAYOUT-*`/`DIFF-*`/`EVENT-*`）と、対応する
テストコード内の `it.each` の要素・`it()` の説明文を 1:1 対応させる運用とし、
仕様書とコードの対応関係をレビュー時に追いやすくする。

## 8. 未決事項・検討事項

- UI コンポーネント（`Canvas.tsx`/`App.tsx`）のレンダリングテストの要否。導入する
  場合は `@testing-library/react` と `jsdom` の追加、`vitest.config.ts` の
  `environment` 変更が必要になる。
- CI（GitHub Actions 等）への `npm test` 組み込みの要否。
