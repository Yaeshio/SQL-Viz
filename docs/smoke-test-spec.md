# スモークテスト仕様書

このドキュメントは Issue #002「スモークテスト整備」に基づき、SQL-Viz のスモークテストが
**何を・なぜ**テストするかを定義するものである。実装方法（テストツール、ファイル配置、
実装パターン）については [smoke-test-design.md](./smoke-test-design.md) を参照。

ユニットテスト（[test-spec.md](./test-spec.md) / [test-design.md](./test-design.md)、
Issue #001）との関係、および対象シナリオは
[Sql animation tool spec .md](./Sql%20animation%20tool%20spec%20.md) に記述された
利用シナリオを踏まえて設計する。

## 1. 目的とスコープ

Issue #001 に基づき整備されたユニットテストは、`parser.ts`/`reducer.ts`/`diff.ts`/
`layout.ts` の各層を個別に検証するものであり、「各機能ごとの正しさ」は保証するが、
「今後の機能追加やリファクタリングを経てもシステム全体として動き続けるか」までは
保証しない。

スモークテストは、代表的な利用シナリオ（`CREATE TABLE` → `INSERT` → `SELECT` の一連の
流れ等）を **`App.tsx` の `run()` と同一の経路**で一気通貫に実行し、以下を高速に
確認するための、少数精鋭のテスト群と位置づける。

- 正常系の主要シナリオが壊れていないこと
- 実装済み機能に対するエラーハンドリングが期待通り機能すること
- 現時点で未実装の SQL 文に対する挙動（エラーになるか、ならないか）が、機能追加や
  リファクタリングによって意図せず変化していないこと

### スコープ外

- **E2E テスト**（Playwright 等によるブラウザの直接操作）— 3節「E2E方針」で述べる理由により、
  今回は導入しない。
- **UI コンポーネントのレンダリングテスト**（`Canvas.tsx`/`App.tsx` の DOM 検証）—
  test-spec.md 同様、引き続き対象外とする。
- 本書の初版では、未実装 SQL 構文の一部（`JOIN`・複合 `WHERE`・`GROUP BY`等）が
  エラーにならず黙って不完全処理される「既知のバグ」として存在し、その修正は
  本スモークテストのスコープ外・別issue対応とする方針だった。この修正は
  [Issue #3](https://github.com/Yaeshio/SQL-Viz/issues/3) として切り出され、
  スモークテスト整備（本Issue #002）に先立って完了した。そのため4節・5節の
  記述は「黙って不完全処理される既知のバグ」ではなく「すべて明示エラーになる」
  内容に更新されている（詳細は4節を参照）。

## 2. ユニットテストとの役割分担

test-spec.md 7節で定義された「イベント生成層（統合層）テスト」は、`parseSql → apply* →
diffStates` という経路（`layoutTables` を挟まない）を通した検証であり、あくまで
diff層の入出力契約を SQL 実行文脈で確認するものである。スモークテストはこれとは異なる
経路・目的を持つ。

| | イベント生成層テスト（test-spec.md 7節） | スモークテスト（本書） |
|---|---|---|
| 経路 | `parseSql → apply* → diffStates`（`layoutTables` を挟まない） | `parseSql → apply* → layoutTables → diffStates`（`App.tsx` の `run()` と同一経路） |
| 目的 | diff層の入出力契約を SQL 実行文脈で検証 | アプリ全体のオーケストレーション（エラー時の早期終了・`layoutTables` 連携・ログ生成含む）を代表シナリオで検証 |
| 粒度 | 各層の詳細な組み合わせを網羅 | 少数の「ゴールデンシナリオ」＋既知のギャップの固定 |
| ケースID | `EVENT-*` | `SMOKE-*` |

両者は重複ではなく補完関係にある。イベント生成層テストは「対応 SQL 構文が増えるたびに
細かくケースを追加する」網羅的な検証を担い、スモークテストは「システムが今も動いている
という安心感を素早く得る」ための代表シナリオに絞った検証を担う。

## 3. E2E方針

Issue #002 は、スクリプト操作（テストコード）によるテストを基本としつつ、必要に応じて
E2E的にフロントエンドを直接操作するテストを実施すべきか検討することを求めている。
検討の結果、**今回は E2E（Playwright 等）を導入しない**と結論づけた。理由は以下の3点。

1. スモークテストが検証したい「システムとして機能するか」という関心の中心は、
   `App.tsx` の `run()` が持つオーケストレーションロジック（文ごとの逐次適用・エラー時の
   早期終了・`layoutTables` 連携・ログ生成）である。これは
   [smoke-test-design.md](./smoke-test-design.md) 2節で述べる `runPipeline()` の抽出により、
   実アプリと同一コードパスをスクリプトテストから直接呼び出して検証できる。ブラウザを
   介した操作が本質的に必要な検証対象ではない。
2. CLAUDE.md は「明確な必要性がない限り、新たな UI/テーマ/アイコン系パッケージを
   追加しないこと」を明記しており、Playwright 等の新規重量級依存を追加するだけの
   具体的な根拠が現時点では無い。
3. Issue #001 も E2E テストを明示的にスコープ外としており、今回新たに導入を正当化する
   ような UI 側の複雑な状態（ドラッグ操作、複雑なフォーム等）は現状の実装には存在しない。

将来、キャンバス上のインタラクション機能（ドラッグでのテーブル移動等）が追加され、
UI 側のロジックが複雑化した場合は、この方針を再検討する。

## 4. 未実装 SQL 文の分類

現時点でサポートされているのは `CREATE TABLE` / `INSERT` / 単純な `SELECT`
（列指定・単一の `WHERE <col> <op> <value>` 比較のみ）である。それ以外の SQL 文・句が
どう扱われるかを調査した結果、初期実装では**一様にエラーになるわけではない**ことが
判明していた（`UPDATE`/`DELETE`等の非対応「文の種類」は `Unsupported statement type`
エラーになる一方、`JOIN`・複合`WHERE`・`GROUP BY`等の非対応「句」は `SELECT` 文の
内部処理がそれらを検査していなかったため、エラーにならず黙って不完全処理されていた）。

この非対称性は [Issue #3](https://github.com/Yaeshio/SQL-Viz/issues/3) で解消済みである。
`parser.ts` は、各文種（`create`/`insert`/`select`）についてサポートする AST の形
（許可フィールド）を定義し、それ以外のフィールドが AST 上に存在すれば
`Unsupported clause: <フィールド名>` エラーを返す「許可リスト（allowlist）方式」に
変更された。個別の構文名を都度列挙する「ブロックリスト方式」ではないため、`UNION` の
ように当初名指ししていなかった構文も含めて、サポート対象外の構文はすべて明示エラーに
なる。

現時点で `Unsupported clause: ...` エラーになることが確認されている構文の例:

- `SELECT`: `JOIN`（カンマ区切りの複数 `FROM` を含む）、複合 `WHERE`
  （`AND`/`OR`/`LIKE`/`IN`/`BETWEEN`/`IS NULL`/列同士の比較）、`UNION`、`DISTINCT`、
  `HAVING`、`GROUP BY`/`ORDER BY`/`LIMIT`、`WITH`句(CTE)、`FROM`句のサブクエリ、
  集約関数・エイリアス付き列（例: `COUNT(*)`）
- `CREATE TABLE`: `IF NOT EXISTS`、`AS SELECT`、`INDEX`/`FOREIGN KEY`等の制約定義
- `INSERT`: `INSERT ... SELECT`、`ON DUPLICATE KEY UPDATE`

5節の該当シナリオ（旧 C-1/C-2 区分の SMOKE-11〜16）は、この変更を反映し、いずれも
「明示的にエラーになること」を検証する統一パターンで実装する。

## 5. シナリオ一覧

ケースIDは `SMOKE-<連番>` とする。各シナリオは
[smoke-test-design.md](./smoke-test-design.md) の `tests/smoke.test.ts` の `it`/`it.each`
と 1:1 対応させる。

### A. 正常系（実装済み機能の一気通貫シナリオ）

| ケースID | シナリオ | 検証内容 |
|---|---|---|
| SMOKE-01 | `Sql animation tool spec .md` 10章のゴールデンシナリオ相当（`CREATE TABLE users (id, name, email)` → 複数行 `INSERT` → `SELECT name FROM users WHERE id > 1`。`App.tsx` の `SAMPLE` 定数と同一） | 最終 `DBState`（テーブル・行・`filteredOut`）、`layoutTables` 適用後の座標に重複がないこと、イベント順序（`table_appear` → `row_add`×N → `row_filter` → `select_highlight`）が一貫していること |
| SMOKE-02 | 2テーブル以上にまたがる `CREATE`/`INSERT`/`SELECT` | `layoutTables` によるグリッド配置が破綻しない（各テーブルの `x`/`y` 座標に重複がない）こと |
| SMOKE-03 | `SELECT *`（列指定なし） | `columns` が `['*']` として扱われ、全列がハイライト対象になること |
| SMOKE-04 | `WHERE` 付き `SELECT` の直後に `WHERE` なし `SELECT` を実行 | 直前でフィルタされた行に対し `row_unfilter` が発生し、絞り込みが解除されること |
| SMOKE-05 | 各データ型（`INT`/`VARCHAR`/`TEXT`/`BOOLEAN`/`DATE`）と `NULL` 値を含む `CREATE`+`INSERT` | 型が正しく `ColumnType` に正規化され、値が正しい JS 値として保持されること |

### B. エラー系（実装済み機能に対する妥当なエラー）

| ケースID | シナリオ | 検証内容 |
|---|---|---|
| SMOKE-06 | 存在しないテーブルへの `INSERT`/`SELECT` | `Table "..." does not exist` エラーになること |
| SMOKE-07 | 既存と同名のテーブルへの `CREATE TABLE` | `Table "..." already exists` エラーになること |
| SMOKE-08 | `columns` の数と `VALUES` の数が不一致な `INSERT` | `Column count mismatch` エラーになること |
| SMOKE-09 | SQL 構文として不正な文字列 | `Parse error: ...` エラーになること |
| SMOKE-10 | 複数文の列（例: `CREATE` → `INSERT`（存在しないテーブル） → `SELECT`）の途中でエラーが発生するシナリオ | エラーが発生した文以降は実行されないこと（`App.tsx` の `run()` の早期終了挙動を `layoutTables` 込みで検証） |

### C. 未実装 SQL 構文（Issue #002 の核心要求）

Issue #3 により、以下はすべて「明示的にエラーになること」を検証する統一パターンで
実装する（旧 C-1/C-2 の区分は解消済み。詳細は4節を参照）。

| ケースID | シナリオ | 検証内容 |
|---|---|---|
| SMOKE-11 | `UPDATE` 文 | `Unsupported statement type: update` エラーになること |
| SMOKE-12 | `DELETE` 文 | `Unsupported statement type: delete` エラーになること |
| SMOKE-13 | `ALTER TABLE` 文 | `Unsupported statement type: alter` エラーになること |
| SMOKE-14 | `INNER JOIN` を含む `SELECT` | `Unsupported clause: JOIN` エラーになること |
| SMOKE-15 | 複合 `WHERE`（`AND`/`OR`）を含む `SELECT` | `Unsupported clause: WHERE` エラーになること |
| SMOKE-16 | `GROUP BY`/`ORDER BY`/`LIMIT`/`UNION` を含む `SELECT` | それぞれ `Unsupported clause: <該当フィールド名>` エラーになること |

## 6. 各シナリオの共通検証観点

シナリオごとに、以下の観点をすべて検証する（該当する場合のみ）。

- 最終 `DBState`（テーブル・行・`filteredOut`・`version`）
- `diffStates` が生成する `AnimationEvent[]` の種類・順序
- `App.tsx` の `run()` が生成するログ行相当の文字列（文の要約）
- エラーメッセージの文字列内容
- エラー発生時、後続の文が実行されないこと

## 7. 将来の SQL 構文拡張時の運用

`UPDATE`/`DELETE`/`JOIN`/複合 `WHERE`/`GROUP BY` 等に対応する際は、5節の該当ケースを
「`Unsupported clause` エラーになること」の検証から「正常系として妥当な挙動」を
検証するテストへ書き換える（詳細は [smoke-test-design.md](./smoke-test-design.md)
4節を参照）。`parser.ts` は許可リスト方式（Issue #3）で実装されているため、新しい
構文に対応する際は許可フィールドの追加だけでなく、その構文が実際に `apply*`/
`layoutTables`/`diffStates` まで正しく流れることも合わせて検証すること。
