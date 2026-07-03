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
- 4節で扱う「既知のバグ」（黙って不完全処理される未実装 SQL 構文）の**修正そのもの**
  （`parser.ts` を明示的エラーに変更する対応）は本スモークテストのスコープ外。
  スモークテスト整備完了後に、別 issue として起票・対応する。

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
どう扱われるかを調査した結果、**一様にエラーになるわけではない**ことが判明した。

`parser.ts` の `parseSql()` は、SQL文ごとの `node.type`（AST のトップレベル種別）を
`if`/`else if` で分岐しており、いずれにも一致しない場合にのみ `else` 節で
`Unsupported statement type: <type>` エラーを返す。この「文の種類（type）レベル」の
網羅チェックと、`SELECT` 文の中の「句（clause）レベル」の網羅チェックとで、
実装の作り込みに非対称性がある。

### C-1: 明示的エラーになるもの（意図通りの挙動）

`UPDATE`/`DELETE`/`ALTER TABLE` は `node.type` がいずれの `if`/`else if` にも一致しない
文の種類であるため、`else` 節に落ちて `Unsupported statement type: <type>` エラーになる。
これは意図通りの挙動である。

### C-2: エラーにならず黙って不完全に処理されるもの（既知のバグ）

`JOIN`・複合 `WHERE`（`AND`/`OR`）・`GROUP BY`/`ORDER BY`/`LIMIT` は、SQL文としては
いずれも `node.type === 'select'` であるため、`else` 節のエラーには到達しない。
`SELECT` 分岐の内部処理がこれらの句を検査していないため、句が黙って無視されたまま
処理が進んでしまう。

- **`JOIN`**: `table = from?.[0]?.table` として `FROM` 句の先頭テーブルのみを読み、
  JOIN 先テーブル・結合条件は単純に無視される。
- **複合 `WHERE`（`AND`/`OR`）**: `parseWhere()` は `node.type !== 'binary_expr'` の場合
  `null` を返す。`AND`/`OR` を含む `WHERE` は入れ子になった論理式の AST となり
  `binary_expr` と一致しないため `null` にフォールバックし、`WHERE` なし（絞り込み無し）
  として扱われる。
- **`GROUP BY`/`ORDER BY`/`LIMIT`**: `parseSql()` はそもそも AST からこれらのフィールドを
  一切読み出していないため、単純に無視される。

これは**意図された仕様ではなく実装漏れ（バグ）**と判断する。根拠は以下の3点。

1. 「文の種類（type）レベル」の網羅チェックは存在するのに、「`SELECT` 文内の句
   （clause）レベル」の網羅チェックが一切実装されておらず、実装として非対称である。
2. Issue #002 の文言自体が「未実装SQLはエラーになる」ことを前提としており、現状の
   黙殺挙動はその前提を裏切っている。
3. 黙殺は「未対応なので何も起きない」ではなく「一部だけ実行されて見た目上は動いている
   ように見える」ため、明示的エラーより悪質な失敗モードである（例: JOIN を書いたのに
   最初のテーブルだけが描画される、複合 WHERE を書いたのに絞り込みが一切効かない）。

**この修正（`parser.ts` を明示的エラーに変更する対応）は本スモークテストのスコープ外**
とする。5節の該当シナリオでは、現状の黙殺挙動を「既知のバグ」として明記した上で
特性テストとして固定し、意図せぬ挙動変化（リグレッション）だけを検知できるようにする。
実際の修正は、スモークテスト整備完了後に別 issue として起票・対応する。

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

| ケースID | シナリオ | 検証内容 |
|---|---|---|
| SMOKE-11 | `UPDATE` 文 | `Unsupported statement type: update` エラーになること（C-1、意図通りの挙動） |
| SMOKE-12 | `DELETE` 文 | `Unsupported statement type: delete` エラーになること（C-1、意図通りの挙動） |
| SMOKE-13 | `ALTER TABLE` 文 | `Unsupported statement type: alter` エラーになること（C-1、意図通りの挙動） |
| SMOKE-14 | `INNER JOIN` を含む `SELECT` | エラーにならず、`FROM` 句の先頭テーブルのみを対象として実行される現状の挙動を固定する（C-2、**既知のバグ**。修正待ちである旨をテストコメントに明記し、対応する別 issue が起票され次第リンクを追記する） |
| SMOKE-15 | 複合 `WHERE`（`AND`/`OR`）を含む `SELECT` | エラーにならず、`WHERE` 句自体が無視され全件が対象になる（フィルタなし）現状の挙動を固定する（C-2、既知のバグ） |
| SMOKE-16 | `GROUP BY`/`ORDER BY`/`LIMIT` を含む `SELECT` | 該当句が無視され、素の `SELECT`（列指定＋`WHERE`のみ）として処理される現状の挙動を固定する（C-2、既知のバグ。実装時に `node-sql-parser` の実際の AST を確認し想定通りかを検証すること） |

## 6. 各シナリオの共通検証観点

シナリオごとに、以下の観点をすべて検証する（該当する場合のみ）。

- 最終 `DBState`（テーブル・行・`filteredOut`・`version`）
- `diffStates` が生成する `AnimationEvent[]` の種類・順序
- `App.tsx` の `run()` が生成するログ行相当の文字列（文の要約）
- エラーメッセージの文字列内容
- エラー発生時、後続の文が実行されないこと

## 7. 将来の SQL 構文拡張時の運用

`UPDATE`/`DELETE`/`JOIN`/複合 `WHERE`/`GROUP BY` 等に対応する際は、5節の該当ケースを
更新する。特に C-2 区分（SMOKE-14〜16）は「バグを固定した特性テスト」であるため、
対応する機能が実装された時点で、該当ケースを「正常系として妥当な挙動」を検証する
テストへ書き換える（詳細は [smoke-test-design.md](./smoke-test-design.md) 4節を参照）。
