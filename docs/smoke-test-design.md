# スモークテスト設計書

このドキュメントは [smoke-test-spec.md](./smoke-test-spec.md) で定義した検証観点を、
Vitest を用いて**どう実装・配置するか**を定義するものである。既存の
[test-design.md](./test-design.md) の規約（テストツール・ファイル配置・命名）を踏襲する。

## 1. 目的

smoke-test-spec.md の各シナリオ（`SMOKE-*`）を、既存のユニットテスト資産
（`tests/test-utils.ts` のビルダー関数等）を再利用しつつ実装・運用するための
技術的な指針を示す。特に、`App.tsx` の `run()` が持つオーケストレーションロジックを
どうテスト可能にするかが本書の中心的な論点となる。

## 2. オーケストレーションロジックの抽出方針

> **実施後の補足**: 本節はもともと `App.tsx` から `src/runner.ts`（新設の
> `runPipeline()`）へロジックを抽出する案として書かれたが、実際に採用された
> 形は異なる。Issue #4 の UI 分割リファクタリングでオーケストレーションは
> `hooks/useSqlRunner.ts` の `run()` に移動し、続く Issue #8（PGlite導入）で
> パイプライン本体は `src/pglite/engine.ts` の `PgEngine` クラスとして実装
> された（`src/runner.ts` というファイルは作られていない）。本節は歴史的な
> 検討過程として残しつつ、以下は実際に採用された設計を記述する。

### 2.1 課題（当時）

smoke-test-spec.md 1節の通り、スモークテストは本番の実行経路と同一の経路
（事前検証 → 実行 → レイアウト → 差分、文ごとの逐次適用、エラー時の
早期終了、ログ生成）を検証したい。当時この経路は `App.tsx` の `run()` 内に
直接書かれており、React の `useCallback` や `setState` 呼び出しと密結合して
いたため、スクリプトテストから直接呼び出すことができなかった。

既存の `tests/test-utils.ts` の `runSqlStatements()` は本番のオーケストレー
ションロジック（特にエラー時の早期終了）を再現しない軽量ヘルパーであり
（diff層・イベント生成層テスト用に設計されたもの）、これをスモークテスト用に
流用・改変すると本番コードとテストコードのロジックが乖離するリスクがあった。

### 2.2 実際に採用された設計: `PgEngine`（`src/pglite/engine.ts`）

オーケストレーションロジックの抽出は、当初案の `src/runner.ts`/
`runPipeline()`（純粋関数）ではなく、`src/pglite/engine.ts` の `PgEngine`
クラスとして実現された（Issue #8）。`PgEngine` は実際の PGlite（WASM
PostgreSQL）接続そのものを内部状態として保持するため、当初想定していた
「純粋関数として抽出する」という前提が成り立たず、statefulなクラスに
なっている。実際の公開インターフェースは以下の通り。

```ts
// src/pglite/engine.ts
export class PgEngine {
  isReady(): boolean;
  ensureReady(): Promise<void>;   // 初回のみPGlite(WASM)を起動する
  reset(): void;                  // PGliteインスタンスを破棄し再起動を必要とする
  run(sql: string, canvasWidth: number): Promise<RunResult>;
}
```

`run()` の内部では、`splitStatements()` による文分割、`parseSql()` による
事前検証、文ごとに実PGliteへの `db.query()` 実行、`snapshotAfter()` に
よる `DBState` 再構築、`layoutTables()`、`diffStates()`、ログ用ラベルの
生成、エラー発生時の早期終了（それ以降の文を `results` に含めず break）を
行う。

`hooks/useSqlRunner.ts` はこの `PgEngine` インスタンスを `useRef` で
アプリセッション中1つだけ保持し（PGlite接続の再利用のため）、`run()` は
UI副作用（`pushLog`/`dispatch`/`playEvents`/`setError`/`setPlaying`/
`initializing` 等）にのみ責務を持つ薄いラッパーとなっている。スモークテストは
実アプリと**同一のコードパス**（`PgEngine.run()`）を直接呼び出すことで、
UIやReactフックを経由しなくても本番同等の検証ができる。

### 2.3 既存ヘルパーとの役割分担

| ヘルパー | 経路 | 用途 |
|---|---|---|
| `tests/test-utils.ts` の `runSqlStatements()` | `splitStatements → parseSql(ゲート) → PgEngine.run()`（内部で `layoutTables`/`diffStates` まで実行） | diff層・イベント生成層テスト（`EVENT-*`）専用の軽量ヘルパー。新規 `PgEngine` を都度生成し、固定の `canvasWidth` で呼び出す |
| `PgEngine.run()`（`src/pglite/engine.ts`） | `splitStatements → parseSql(ゲート) → db.query(実行) → snapshotAfter → layoutTables → diffStates` | スモークテスト（`SMOKE-*`）・ユニットテスト（`ENGINE-*`）双方から使われる実行エンジン本体。`hooks/useSqlRunner.ts` の `run()` と同一経路 |

`tests/smoke.test.ts` は `PgEngine` を直接インスタンス化して使用する。

### 2.4 注記: 本節の解決状況

`App.tsx` からのオーケストレーションロジック抽出自体は、当初案の
`src/runner.ts` ではなく、Issue #8（PGlite導入、PR #12）にて `PgEngine`
という異なる形で実現・解決済みである。目的（`App.tsx` に依存しない
テスト可能なパイプライン）自体は当初案と同じ形で達成されている。

## 3. テストファイル配置

test-design.md 3節の規約（`tests/` 直下フラット配置）を踏襲し、`tests/smoke.test.ts`
を新設する。

```
SQL-Viz/
├── src/
│   └── pglite/
│       ├── engine.ts          … PgEngine（オーケストレーションロジック本体）
│       └── splitStatements.ts
└── tests/
    ├── parser.test.ts
    ├── engine.test.ts         … reducer.test.ts の後継（Issue #8）
    ├── splitStatements.test.ts
    ├── layout.test.ts
    ├── diff.test.ts
    ├── events.test.ts
    ├── smoke.test.ts          … 本書の対象
    └── test-utils.ts
```

`tests/smoke.test.ts` は既存の `tests/test-utils.ts` のビルダー関数
（`makeColumn`/`makeRow`/`makeTable`/`makeState`）や `SAMPLE_CREATE_USERS` 等の
共通定数を再利用し、フィクスチャの重複記述を避ける。

## 4. 各シナリオの実装方針

smoke-test-spec.md 5節の `SMOKE-*` ケースIDと 1:1 対応する `describe`/`it`（または
`it.each`）を用意する。テストは以下の形で `PgEngine.run()` を呼び出す。

```ts
import { PgEngine } from '../src/pglite/engine';

describe('SMOKE-01: ゴールデンシナリオ', () => {
  it('CREATE → INSERT×3 → SELECT が一気通貫で実行される', async () => {
    const engine = new PgEngine();
    const { results, parseError } = await engine.run(SAMPLE_SQL, 800);
    expect(parseError).toBeUndefined();
    expect(results.every((r) => !r.error)).toBe(true);
    // 最終 DBState、イベント順序、座標重複の有無を検証
  });
});
```

各テストは `beforeEach` で新規 `PgEngine` を生成し、実PGliteインスタンス上で
実行する（`vitest.config.ts` の `testTimeout: 30000` はこのため）。

### 4.1 正常系・エラー系（SMOKE-01〜10）

各ケースの入力 SQL 文字列と期待結果を smoke-test-spec.md 5節の表に対応させて実装する。
座標重複の検証（SMOKE-02）は、`results` の最終 `state.order` を走査し、各テーブルの
`(x, y)` ペアに重複がないことをチェックするヘルパーを `tests/test-utils.ts` に追加する
（`hasOverlappingTablePositions(state: DBState): boolean` 等）。

エラー時の早期終了（SMOKE-10）は、複数文のうち途中の文で `error` が設定された
`StatementResult` が現れた場合、`results` 配列がそれ以降の文を含まないことを
`toHaveLength` で検証する。

### 4.2 未実装 SQL 構文（SMOKE-11〜16）

[Issue #3](https://github.com/Yaeshio/SQL-Viz/issues/3) により、`parser.ts` は
未対応の文種・句をすべて明示的にエラーにする許可リスト方式に変更済みである。
そのため SMOKE-11〜16 はすべて同じ書き方でよく、旧 C-1/C-2 の区別（片方は
`parseError` を検証する正常なエラー系、もう片方はバグを固定する特性テスト）は
不要になった。

```ts
it('SMOKE-14: JOINを含むSELECTはUnsupported clauseエラーになる', async () => {
  const engine = new PgEngine();
  const { parseError } = await engine.run('SELECT * FROM a JOIN b ON a.id=b.id', 800);
  expect(parseError).toBe('Unsupported clause: JOIN');
});
```

将来 `JOIN`/複合 `WHERE`/`GROUP BY` 等に実際の対応を追加する際は、該当ケースを
「正常系として妥当な挙動」を検証するテストへ書き換える（6節を参照）。

## 5. 既存テストスイート・設定との統合

- `npm test`（`vitest run`）に統合し、既存の `parser.test.ts`/`engine.test.ts`/
  `diff.test.ts`/`layout.test.ts`/`events.test.ts` と並列に実行される一つのテスト
  ファイルとして位置づける。`vitest.config.ts` の `include: ['tests/**/*.test.ts']` の
  パターンに `tests/smoke.test.ts` はそのまま合致するため、設定変更は不要。
- `tsconfig.app.json` の `include: ["src", "tests"]`（test-design.md 3節で既に
  `tests/` を対象化済み）は、`src/pglite/` 配下にも変更なく適用される。
- `eslint.config.js` の `files: ['**/*.{ts,tsx}']` も同様に変更不要。

## 6. 将来の SQL 構文拡張時のテスト追加ガイドライン

test-design.md 7節の表にならい、スモークテスト向けに以下のガイドラインを設ける。

| 変更内容 | 対応するスモークテストの更新 |
|---|---|
| `UPDATE`/`DELETE`/`ALTER` 等、新しい文の種類に対応 | 対応する `SMOKE-*` を正常系シナリオへ書き換え、必要なら新規シナリオを追加 |
| `JOIN` に対応（C-2 修正） | `SMOKE-14` を「JOIN が正しく処理される」または「意図的に `Unsupported clause` エラーになる」ことを検証する正常系テストへ書き換える |
| 複合 `WHERE`（`AND`/`OR`）に対応 | `SMOKE-15` を同様に書き換える |
| `GROUP BY`/`ORDER BY`/`LIMIT` に対応 | `SMOKE-16` を同様に書き換える |
| 新しいユーザーシナリオ（複数機能の組み合わせ）が生まれる | `tests/smoke.test.ts` に新規 `SMOKE-*` ケースを追加し、smoke-test-spec.md 5節にも対応する行を追加する |

`SMOKE-*` のケースIDと、対応するテストコード内の `it()` の説明文は 1:1 対応させる運用とし、
仕様書とコードの対応関係をレビュー時に追いやすくする。

## 7. 未決事項

- ~~`src/runner.ts` へのオーケストレーションロジック抽出リファクタリング、および
  `tests/smoke.test.ts` の実装は、本書公開後に Issue #002 の後続タスクとして実施する。~~
  → `tests/smoke.test.ts` は実装済み。オーケストレーション抽出は当初案の
  `src/runner.ts` ではなく、Issue #8（PGlite導入）の `PgEngine`
  （`src/pglite/engine.ts`）として実現された（2.2〜2.4節を参照）。
- ~~C-2 区分（JOIN・複合WHERE・GROUP BY等の黙殺）の修正タイミング・issue番号は未定。~~
  → [Issue #3](https://github.com/Yaeshio/SQL-Viz/issues/3) として切り出され、
  Issue #002（本書のタスク）に先立って対応済み。`parser.ts` は許可リスト方式に
  変更され、C-2 に分類されていた構文もすべて明示エラーになる（4.2節を参照）。
