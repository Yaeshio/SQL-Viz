# テスト仕様書

このドキュメントは Issue #001「テストスイート整備」に基づき、SQL-Viz のテストスイートが
**何を・なぜ**テストするかを定義するものである。実装方法（テストツール、ファイル配置、
実装パターン）については [test-design.md](./test-design.md) を参照。

## 1. 目的とスコープ

現在 SQL-Viz にはテストが一切整備されていない。今後 `UPDATE`/`JOIN` など対応 SQL 構文を
拡張していく際にリグレッションを防げるよう、Issue #001 が挙げる以下 4 層に加え、
`src/layout.ts`（グリッドレイアウト計算）を対象に加えた計 5 層についてテストスイートを
整備する。

1. パーサー層のテスト（`src/parser.ts`）
2. 状態遷移（reducer）層のテスト（`src/reducer.ts`）
3. diff 層のテスト（`src/diff.ts`）
4. イベント生成層のテスト（下記「2. イベント生成層の位置づけ」を参照）
5. layout 層のテスト（`src/layout.ts`）— Issue #001 の原文には含まれないが、
   純粋関数として決定的な入出力を持ちユニットテスト可能であるため、今回のスコープに追加する

テストツールは Vitest を用いる（Vite の環境が既に整っているため）。

### スコープ外

- **E2E テスト** — Issue #001 にて明示的に対象外とされている。
- **UI コンポーネントのレンダリングテスト**（`Canvas.tsx`/`App.tsx`）— Issue #001 は
  上記 4 層のみを列挙しており、UI の描画・アニメーション自体は対象に含まれていないと解釈する。
  将来的に React Testing Library 等の導入を検討する余地はあるが、本仕様書の対象外とする。

## 2. テスト対象レイヤーの全体像

SQL-Viz のパイプラインは以下のように構成されている（`App.tsx` の `run()` が駆動）。

```
SQL文字列
  → parser.ts: parseSql()          … ① パーサー層
  → reducer.ts: applyCreateTable() / applyInsert() / applySelect()
                                    … ② reducer層
  → layout.ts: layoutTables()      … ⑤ layout層
  → diff.ts: diffStates()          … ③ diff層
  → App.tsx: playEvents()          … (対象外、UI駆動)
```

`parser.ts` / `reducer.ts` / `diff.ts` / `layout.ts` はいずれも副作用のない純粋関数
（または純粋関数の集合）であり、入力と出力を直接比較する形でユニットテストが可能である。
ただし `layout.ts` の `layoutTables()` のみ、渡された `state` オブジェクトを直接変更して
返す（`x`/`y` を書き換える）という点で `reducer.ts` の不変（immutable）な設計とは異なる。
この違いはテスト実装上重要な注意点であり、5節および [test-design.md](./test-design.md)
にて詳述する。

なお `diff.ts` の `diffStates()` は `layout.ts` が計算する `x`/`y` を一切参照しないため、
パイプライン上は reducer の直後に layout が挟まっているが、diff層・イベント生成層の
テストでは layout層を経由させない（6節・7節を参照）。

### 「④ イベント生成層」の位置づけ

Issue #001 の原文では diff 層（3番）とイベント生成層（4番）が別項目として列挙されており、
かつ「2番と4番は対応 SQL 構文に応じてケースを追加する」という記述がある。diff 層単体の
テスト（③、手組みの `DBState` ペアを比較する）だけでは「ある SQL 文を実行した結果、
最終的にどのイベント列が生成されるか」という、対応 SQL 構文に紐づく振る舞いを直接は
検証できない。

そのため本仕様書では、④ イベント生成層のテストを **「SQL文字列（列） → parser →
reducer 適用 → diffStates」という一連の流れを通した統合的な検証層**と位置づける。
③ diff層テストが `diffStates()` という一関数の入出力（old/next の `DBState` ペア →
イベント列）を検証するのに対し、④ イベント生成層テストは「実際に SQL を実行したときに
何が起きるか」という、より利用者視点に近いシナリオを検証する。

| 層 | 検証対象 | 入力 | 出力 |
|---|---|---|---|
| ③ diff層 | `diffStates()` 単体 | 手組みの `DBState` old/next ペア | `AnimationEvent[]` |
| ④ イベント生成層 | SQL実行パイプライン全体（layout除く） | SQL文字列（列） | 文ごとの `AnimationEvent[]` |

## 3. パーサー層 (`parser.ts`) の検証観点

`parseSql(sql: string): { statements: Parsed[]; error?: string }` を対象とする。

- **CREATE TABLE**: テーブル名、カラム名・型（`normalizeType` 経由で `ColumnType` に
  正規化されること）の抽出。
- **INSERT**: テーブル名、カラムリスト省略時に `columns` が `null` になること、
  複数 `VALUES` 行を持つ複数行 INSERT、リテラル値の型変換（`null`/真偽値/数値/文字列）。
- **SELECT**: `columns` が `SELECT *` のとき `['*']` になること、特定カラム指定時は
  カラム名配列になること。`WHERE` 句は単一の二項比較（`<col> <op> <value>`）のみ対応し、
  `AND`/`OR` を含む複合条件は非対応で `where` が `null` になる（エラーにはならず
  黙って無視される）という制約を検証する。
- **複数文の一括パース**: セミコロン区切りで複数の文を渡した場合、`statements` に
  順序通り複数の `Parsed` が格納されること。
- **エラー系**: SQL 構文として不正な文字列を渡した場合に `error: "Parse error: ..."` が
  返ること。`UPDATE`/`DELETE`/`JOIN` など非対応の文種を渡した場合に
  `error: "Unsupported statement type: ..."` が返ること。

## 4. reducer層 (`reducer.ts`) の検証観点

`applyCreateTable` / `applyInsert` / `applySelect` はいずれも `ApplyResult = { state, error? }`
を返す純粋関数である。以下の観点を、対応 SQL 構文が増えるたびにケースを追加しやすい
表形式で管理する。ケース ID は `REDUCER-<関数名>-<連番>` の命名規則を用いる
（例: `REDUCER-CREATE-01`）。命名規則は [test-design.md](./test-design.md) の
`it.each` 設計と 1:1 対応させる。

### `applyCreateTable`

| ケースID | 入力 | 期待結果 |
|---|---|---|
| REDUCER-CREATE-01 | 新規テーブル名・カラム定義 | `tables` に追加され `order` に push、`version` が +1、`lastSelect` が `null` にリセット |
| REDUCER-CREATE-02 | 既存と同名のテーブル | `error: 'Table "..." already exists'`、`state` は変化しない |

### `applyInsert`

| ケースID | 入力 | 期待結果 |
|---|---|---|
| REDUCER-INSERT-01 | 存在するテーブルへの正常な INSERT | 行が末尾に追加、`version` が +1、`lastSelect` が `null` |
| REDUCER-INSERT-02 | `columns` 省略（`null`） | テーブル定義のカラム順に値が割り当てられる |
| REDUCER-INSERT-03 | 未知のカラム名を含む `columns` | 該当カラムの値は無視され、他のカラムは正しく設定される |
| REDUCER-INSERT-04 | 存在しないテーブルへの INSERT | `error: 'Table "..." does not exist'` |
| REDUCER-INSERT-05 | `columns` の数と `values` の数が不一致 | `error: 'Column count mismatch'` |

### `applySelect`

| ケースID | 入力 | 期待結果 |
|---|---|---|
| REDUCER-SELECT-01 | `WHERE` なし（`SELECT *`） | 全行の `filteredOut` が `false` になる |
| REDUCER-SELECT-02 | `WHERE col = value` | 一致しない行のみ `filteredOut: true` になる（行自体は削除されない） |
| REDUCER-SELECT-03 | 各比較演算子（`=`, `!=`, `<>`, `>`, `<`, `>=`, `<=`）| `compareValue` の仕様通りにフィルタされる |
| REDUCER-SELECT-04 | 直前の SELECT でフィルタされた状態から `WHERE` なしで再実行 | フィルタがリセットされる（絞り込みが解除される） |
| REDUCER-SELECT-05 | 存在しないテーブルへの SELECT | `error: 'Table "..." does not exist'` |

### 共通の検証観点

| ケースID | 検証内容 |
|---|---|
| REDUCER-IMMUT-01 | `apply*` 呼び出し前後で元の `state` オブジェクト（テーブル・行を含む）が変更されていないこと（`cloneState` の不変性） |

## 5. layout層 (`layout.ts`) の検証観点

`layoutTables(state: DBState, canvasW: number): DBState` と、その内部で使う
`TABLE_H(t: Table): number` を対象とする。両者とも `TABLE_W`/`HEADER_H`/`ROW_H`/
`COL_GAP`/`TABLE_GAP_X`/`TABLE_GAP_Y`/`PAD` の定数を用いたグリッド配置の計算であり、
入力（`state`, `canvasW`）に対して出力（各テーブルの `x`/`y`）が決定的に定まるため
純粋関数としてユニットテスト可能である。

| ケースID | 入力 | 期待結果 |
|---|---|---|
| LAYOUT-COLS-01 | 全テーブルが1行に収まる十分な `canvasW` | `cols = floor((canvasW - PAD) / (TABLE_W + TABLE_GAP_X))` の列数に従い、各テーブルの `x` が `PAD + col * (TABLE_W + TABLE_GAP_X)` になる |
| LAYOUT-COLS-02 | 1行に収まらない狭い `canvasW`（テーブル数 > 列数） | `col = i % cols`, `row = floor(i / cols)` の通りに次の行へ折り返される |
| LAYOUT-COLS-03 | `canvasW` がテーブル1つ分より狭い極端なケース | `Math.max(1, ...)` により列数が最低 1 にクランプされ、全テーブルが縦一列に並ぶ |
| LAYOUT-HEIGHT-01 | カラム数・行数が異なる複数のテーブル | `TABLE_H(t) = HEADER_H + columns.length * ROW_H + rows.length * ROW_H + COL_GAP` の計算式通りに高さが算出される |
| LAYOUT-Y-01 | 同じ行（`row` インデックス）に、高さの異なる複数のテーブルが並ぶケース | 実装は各テーブルの `y` を **そのテーブル自身の `TABLE_H`** を用いて計算しており、同じ行内の他テーブルの高さを考慮しない（行内の最大高さに揃える処理は無い）。この既存の挙動をそのまま特性テスト（characterization test）として固定し、意図せぬ挙動変化を検知できるようにする |
| LAYOUT-MUTATE-01 | 任意の `state` を渡して `layoutTables()` を呼び出す | 戻り値が新しいオブジェクトではなく、**引数に渡した `state.tables[name]` を直接書き換えて**返すこと（`reducer.ts` の `apply*` 系とは異なり非immutableである点を明示的に検証する）。`App.tsx` の呼び出し側 (`layoutTables(cloneState(next), w)`) がこの前提であらかじめ `cloneState` してから渡している設計を裏付ける |
| LAYOUT-EMPTY-01 | `state.order` が空 | エラーにならず、`state` がそのまま返る |

## 6. diff層 (`diff.ts`) の検証観点

`diffStates(old: DBState, next: DBState): AnimationEvent[]` を対象とする。

| ケースID | 入力（old → next） | 期待されるイベント |
|---|---|---|
| DIFF-TABLE-01 | テーブルが存在しない → 新規テーブルが `order` に追加 | `table_appear` |
| DIFF-ROW-01 | 既存テーブルに新しい行が追加 | 追加された行それぞれについて `row_add`（`index` 付き） |
| DIFF-ROW-02 | 新規テーブル作成と同時に複数行を持つ | `table_appear` の後、全行分の `row_add` が続く（順序性の検証） |
| DIFF-FILTER-01 | ある行の `filteredOut` が `false → true` | `row_filter` |
| DIFF-FILTER-02 | ある行の `filteredOut` が `true → false` | `row_unfilter` |
| DIFF-SELECT-01 | `next.lastSelect` が設定されている | イベント列の末尾に `select_highlight` |
| DIFF-NOOP-01 | old と next が同一内容 | 空のイベント配列 |
| DIFF-ORDER-01 | 複数テーブルに対する変化が同時に起きる | `table_appear` 群 → 各テーブルの `row_add`/`row_filter`/`row_unfilter` 群 → `select_highlight` という全体順序が保たれること |

## 7. イベント生成層（統合層）の検証観点

「2. テスト対象レイヤーの全体像」で述べた通り、SQL 文字列（列）を実行した結果として
生成される `AnimationEvent[]` を、文ごとに検証する。シナリオ ID は
`EVENT-<連番>` とする。

| シナリオID | SQL（文の列） | 期待されるイベント列（概要） |
|---|---|---|
| EVENT-01 | `CREATE TABLE users (...)` のみ | `table_appear` のみ（行がないため `row_add` は発生しない） |
| EVENT-02 | `CREATE TABLE` 後に複数行の `INSERT` | CREATE文の実行結果に `table_appear`、INSERT文の実行結果に行数分の `row_add` |
| EVENT-03 | 既存データに対する `INSERT` 1件 | 追加した1行分の `row_add` のみ（`table_appear` は発生しない） |
| EVENT-04 | `INSERT` 後に `SELECT ... WHERE ...` | 条件に合わない行の `row_filter` と、`select_highlight` |
| EVENT-05 | フィルタされた状態から `WHERE` なしで再度 `SELECT` | 該当行の `row_unfilter` と `select_highlight` |
| EVENT-06 | `CREATE` → `INSERT` → `SELECT` の3文連続実行 | 文ごとに独立したイベント列が生成され、後続の文の結果が前の文の結果に累積されること |
| EVENT-07 | 途中の文でエラーとなる SQL（例: 存在しないテーブルへの `INSERT`）を含む文の列 | エラーが発生した文以降は処理されない（`App.tsx` の `run()` の挙動に準じる） |

## 8. 現時点でサポートされている SQL 構文に基づく具体的テストケース一覧

上記 4〜7 節の表に加え、以下の観点を各層のテストに反映する。

- **CREATE TABLE**: `INT`/`VARCHAR`/`TEXT`/`BOOLEAN`/`DATE`/未知の型それぞれで
  `ColumnType` へ正しく正規化されること。
- **INSERT**: 文字列・数値・真偽値・`NULL` の各リテラルが正しい JS 値に変換されること。
- **SELECT**: 数値比較（`>`, `<`, `>=`, `<=`）と文字列一致（`=`, `!=`, `<>`）の両方で
  `compareValue` の型変換仕様（`Number()` / `String()`）通りに動作すること。存在しない
  カラム名を `WHERE` に指定した場合（`r.values[where.column]` が `undefined` になる）の
  挙動。
- **parseSql全体**: 複数文パース、構文エラー、非対応文種エラーの3パターン。

## 9. 非スコープ・既知の制約

- `UPDATE` / `DELETE` / `ALTER TABLE` は非対応（`parser.ts` が
  `Unsupported statement type` エラーを返す）。
- `JOIN`・複合 `WHERE`（`AND`/`OR`/`LIKE`/`IN`/`BETWEEN`等）・`UNION`・`DISTINCT`・
  `HAVING`・`GROUP BY`/`ORDER BY`/`LIMIT`・`WITH`句(CTE)・`FROM`句のサブクエリ・
  集約関数/エイリアス付き列・`CREATE TABLE ... AS SELECT`・`CREATE TABLE IF NOT EXISTS`・
  `PRIMARY KEY`/`INDEX`/`FOREIGN KEY`等の制約定義・`INSERT ... SELECT`・
  `INSERT ... ON DUPLICATE KEY UPDATE` は非対応であり、いずれも `parser.ts` が
  `Unsupported clause: <該当フィールド名>` エラーを返す（Issue #3 により、個別の
  構文を都度検知するのではなく、サポート対象の形以外を汎用的に拒否する許可リスト
  方式で実装されている）。
- E2E テストは Issue #001 にて明示的に対象外とされている。
- UI コンポーネント（`Canvas.tsx`/`App.tsx`）のレンダリングテストは、今回の対象層の
  スコープには含まれないと解釈し対象外とする（将来の検討事項）。

将来的に対応 SQL 構文を拡張する際は、本仕様書の該当セクション（4, 5, 6, 7節）に表形式で
ケースを追加していくこと。追加方法の詳細は [test-design.md](./test-design.md) の
「7. 将来の SQL 構文拡張時のテスト追加ガイドライン」を参照。
