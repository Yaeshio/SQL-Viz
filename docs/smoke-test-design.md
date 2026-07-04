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

### 2.1 課題

smoke-test-spec.md 1節の通り、スモークテストは `App.tsx` の `run()` と同一の経路
（`parseSql → apply* → layoutTables → diffStates`、文ごとの逐次適用、エラー時の
早期終了、ログ生成）を検証したい。しかし現状、この経路は `run()` 内に直接
書かれており（[App.tsx:85-152](../src/App.tsx#L85-L152)）、React の `useCallback` や
`setState` 呼び出しと密結合しているため、スクリプトテストから直接呼び出すことが
できない。

既存の `tests/test-utils.ts` の `runSqlStatements()` は `layoutTables` を挟まない
軽量なヘルパーであり（diff層・イベント生成層テスト用に設計されたもの）、`run()` の
オーケストレーションロジック（特にエラー時の早期終了と `layoutTables` 連携）を
再現していない。このヘルパーをスモークテスト用に流用・改変すると、本番コードの
実際の挙動とテストコードのロジックが将来的に乖離するリスクがある。

### 2.2 方針: `src/runner.ts` へのロジック抽出

`App.tsx` の `run()` からビジネスロジック（UI副作用を除いた部分）を、新設ファイル
`src/runner.ts`（`src/` 直下フラット配置の既存方針を踏襲、サブフォルダを作らない）に
純粋関数として抽出する。

```ts
// src/runner.ts
import type { AnimationEvent, DBState } from './types';

export interface StatementResult {
  label: string;
  state: DBState;
  events: AnimationEvent[];
  error?: string;
}

export interface RunResult {
  results: StatementResult[];
  parseError?: string;
}

export function runPipeline(
  sql: string,
  initialState: DBState,
  canvasWidth: number
): RunResult
```

`runPipeline()` の内部では、`parseSql()` の呼び出し、文ごとの `applyCreateTable`/
`applyInsert`/`applySelect` の適用、`layoutTables(cloneState(next), canvasWidth)`、
`diffStates(current, next)`、ログ用ラベルの生成、エラー発生時の早期終了
（それ以降の文を `results` に含めない）を行う。現在 `run()` 内にあるこれらの処理を
そのまま移設し、ロジックの変更は行わない。

`App.tsx` 側は次のように簡素化される。

```ts
const run = useCallback(async () => {
  setError(null);
  const { results, parseError } = runPipeline(sql, state, canvasRef.current?.clientWidth ?? 800);
  if (parseError) { setError(parseError); return; }
  if (results.length === 0) { setError('No executable statements found.'); return; }

  setPlaying(true);
  setLog([]);
  setHighlight(null);
  setAppearingRows(new Set());
  setFilteringRows(new Set());

  for (const r of results) {
    if (r.error) { setError(r.error); setPlaying(false); return; }
    pushLog(r.label);
    dispatch({ type: 'set', state: r.state });
    await playEvents(r.events);
  }
  setPlaying(false);
}, [sql, state, pushLog, playEvents]);
```

これにより `App.tsx` は UI 副作用（`pushLog`/`dispatch`/`playEvents`/`setError`/
`setPlaying` 等）にのみ責務を持ち、パイプラインのロジックそのものは `runner.ts` に
一元化される。スモークテストは実アプリと**同一のコードパス**（`runPipeline()`）を
`import` して直接呼び出すことで、`App.tsx` を経由しなくても本番同等の検証ができる。

### 2.3 既存ヘルパーとの役割分担

| ヘルパー | 経路 | 用途 |
|---|---|---|
| `tests/test-utils.ts` の `runSqlStatements()` | `parseSql → apply* → diffStates`（`layoutTables` を挟まない） | diff層・イベント生成層テスト（`EVENT-*`）専用の軽量ヘルパー。座標計算に関心がないテストのノイズを減らすため意図的に `layoutTables` を省いている |
| `src/runner.ts` の `runPipeline()` | `parseSql → apply* → layoutTables → diffStates`（`App.tsx` の `run()` と同一） | スモークテスト（`SMOKE-*`）専用。アプリの実際の実行経路をそのまま検証する |

両者を混同しないよう、`tests/smoke.test.ts` では必ず `runPipeline()` を使用し、
`runSqlStatements()` は使用しない。

### 2.4 注記: 本書におけるスコープ

`runner.ts` へのロジック抽出（`App.tsx` のリファクタリング）自体の実施は、本仕様書・
設計書の作成タスクのスコープ外とする。本書はあくまで実装方針を定義するものであり、
実際の抽出リファクタリングおよびそれに続くスモークテスト実装は、Issue #002 の
後続タスクとして別途行う。

## 3. テストファイル配置

test-design.md 3節の規約（`tests/` 直下フラット配置）を踏襲し、`tests/smoke.test.ts`
を新設する。

```
SQL-Viz/
├── src/
│   └── runner.ts   … 新設（オーケストレーションロジック）
└── tests/
    ├── parser.test.ts
    ├── reducer.test.ts
    ├── layout.test.ts
    ├── diff.test.ts
    ├── events.test.ts
    ├── smoke.test.ts   … 新設（本書の対象）
    └── test-utils.ts
```

`tests/smoke.test.ts` は既存の `tests/test-utils.ts` のビルダー関数
（`makeColumn`/`makeRow`/`makeTable`/`makeState`）や `SAMPLE_CREATE_USERS` 等の
共通定数を再利用し、フィクスチャの重複記述を避ける。

## 4. 各シナリオの実装方針

smoke-test-spec.md 5節の `SMOKE-*` ケースIDと 1:1 対応する `describe`/`it`（または
`it.each`）を用意する。テストは以下の形で `runPipeline()` を呼び出す。

```ts
import { runPipeline } from '../src/runner';
import { emptyState } from '../src/reducer';

describe('SMOKE-01: ゴールデンシナリオ', () => {
  it('CREATE → INSERT×3 → SELECT が一気通貫で実行される', () => {
    const { results, parseError } = runPipeline(SAMPLE_SQL, emptyState(), 800);
    expect(parseError).toBeUndefined();
    expect(results.every((r) => !r.error)).toBe(true);
    // 最終 DBState、イベント順序、座標重複の有無を検証
  });
});
```

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
it('SMOKE-14: JOINを含むSELECTはUnsupported clauseエラーになる', () => {
  const { parseError } = runPipeline('SELECT * FROM a JOIN b ON a.id=b.id', emptyState(), 800);
  expect(parseError).toBe('Unsupported clause: JOIN');
});
```

将来 `JOIN`/複合 `WHERE`/`GROUP BY` 等に実際の対応を追加する際は、該当ケースを
「正常系として妥当な挙動」を検証するテストへ書き換える（6節を参照）。

## 5. 既存テストスイート・設定との統合

- `npm test`（`vitest run`）に統合し、既存の `parser.test.ts`/`reducer.test.ts`/
  `diff.test.ts`/`layout.test.ts`/`events.test.ts` と並列に実行される一つのテスト
  ファイルとして位置づける。`vitest.config.ts` の `include: ['tests/**/*.test.ts']` の
  パターンに `tests/smoke.test.ts` はそのまま合致するため、設定変更は不要。
- `tsconfig.app.json` の `include: ["src", "tests"]`（test-design.md 3節で既に
  `tests/` を対象化済み）は、新設する `src/runner.ts` にも変更なく適用される。
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

- `src/runner.ts` へのオーケストレーションロジック抽出リファクタリング、および
  `tests/smoke.test.ts` の実装は、本書公開後に Issue #002 の後続タスクとして実施する。
- ~~C-2 区分（JOIN・複合WHERE・GROUP BY等の黙殺）の修正タイミング・issue番号は未定。~~
  → [Issue #3](https://github.com/Yaeshio/SQL-Viz/issues/3) として切り出され、
  Issue #002（本書のタスク）に先立って対応済み。`parser.ts` は許可リスト方式に
  変更され、C-2 に分類されていた構文もすべて明示エラーになる（4.2節を参照）。
