# 設計/実験モード概念とSQL対応範囲 仕様書

このドキュメントは、[Issue #18「SQL文実行履歴保持機能の実装」](https://github.com/Yaeshio/SQL-Viz/issues/18)
M1〜M3で導入された「設計モード/実験モード」の概念と、モード別のSQL文許可
マトリクス、および関連するSQL対応範囲のスコープ決定をまとめたものである。

もともとこの内容は `docs/github-sync-spec.md`（GitHub連携によるスキーマ
永続化の仕様書）の一部（2〜4節・8節の一部）だったが、永続化方式が
Issue #26でローカルCLI経由のファイル同期へ移行し同ドキュメントが
[docs/local-cli-sync-spec.md](./local-cli-sync-spec.md) に置き換わった際、
モード概念・SQL対応範囲は永続化の transport（GitHub push か ローカルAPI
か）とは独立した内容であるため、本ドキュメントとして分離した。

`src/pglite/engine.ts`・`src/parser.ts`・`src/pglite/ddlExport.ts`・
`src/constants/sampleSql.ts` のコメントはこのドキュメントの節番号を参照
している。

## 1. モード概念

| | 設計モード（スキーマ編集） | 実験モード（クエリ実行） |
|---|---|---|
| 操作対象 | テーブル・カラム・リレーションの構造そのもの | 既存スキーマに対するSELECT等の読み取り操作 |
| 前提とする状態 | 「今から構造を変える」という明示的な意思 | 「今の構造は固定」という暗黙の前提 |
| 副作用の許容度 | 変更が即座に図・DDLに反映される（想定通り） | 試行錯誤の失敗（構文エラー等）が起きても構造に影響してはならない |
| 保存の単位 | `schema/ddl.sql` のスナップショット（[local-cli-sync-spec.md](./local-cli-sync-spec.md)） | なし（試行錯誤用） |

ここから導かれる2つのハード制約:

1. **実験モードでスキーマ構造が変化してはならない。** 実験モードで
   実行できるSQLは、既存の構造を前提とした読み書き（2節）に限られる。
2. **設計モードではクエリなどを実行できない。** 設計モードはテーブルや
   リレーションの作成などの設計機能に徹する。

**実験モードで行ったデータ変更（`INSERT`/`UPDATE`/`DELETE`）は、設計
モードに復帰した時点でリセットする。** 設計モードは常に正準なデータを
前提として構造編集を行うべきであり、実験モードでの試行錯誤の結果を
引き継がせない（`PgEngine.returnToDesign()` が実験モード中の全文を
乗せたPostgresトランザクションを `ROLLBACK` することで実現している。
`CLAUDE.md` のパイプライン説明・6節参照）。

## 2. モード別SQL文許可マトリクス

| 文種 | 設計モード | 実験モード |
|---|---|---|
| `CREATE TABLE` | ✅ | ❌ |
| `ALTER TABLE`（単一 `ADD COLUMN`/`DROP COLUMN` のみ、4節参照） | ✅ | ❌ |
| `DROP TABLE` | ✅ | ❌ |
| `SELECT` | ❌ | ✅ |
| `INSERT` | ❌ | ✅ |
| `UPDATE` | ❌ | ✅ |
| `DELETE` | ❌ | ✅ |

この許可マトリクスは、`parser.ts` が担う「文法として妥当な `CREATE`/
`ALTER`/`DROP`/`SELECT`/`INSERT`/`UPDATE`/`DELETE` か」という検証とは
**独立した、別レイヤーのゲート**である（`pglite/engine.ts` の
`MODE_ALLOWED_TYPES`）。前者は常に一定の許可リストでSQLの構文的妥当性を
検証し、後者は「今のモードでその文種が許されているか」を検証する。両方を
通過して初めて実行される。パース済みの全文が対象で、1文でも現在のモードで
許可されていなければ、どの文も実行せずパースエラーと同じ扱いで拒否する
（all-or-nothing）。

## 3. `schema/ddl.sql` の生成範囲

- **生成方式**: フルスナップショット（差分ではなく、都度ファイル全体を
  再生成して上書き）。生成元は `DBState`（`src/types.ts`）からの再構成
  ではなく、その時点でPGliteが保持する実スキーマ（`information_schema`）
  を正とする。`DBState.Column.type` は `normalizeType()` により型が
  丸められているため、`VARCHAR(50)` の長さなどの精度を落とさないため
  である（`src/pglite/ddlExport.ts` の `generateDdl()`）。
- **範囲**: テーブル定義（列名・型）に加え、`PRIMARY KEY`/`UNIQUE`/
  `FOREIGN KEY` を表レベル制約として `CREATE TABLE` 内の列定義の後に出力する
  （[Issue #45](https://github.com/Yaeshio/SQL-Viz/issues/45)）。Postgres は
  FK の参照先列に PK/UNIQUE を要求するため、これらを出さないと FK 付き
  スキーマの Reload が `there is no unique constraint matching given keys` で
  失敗する（かつ、従来は `id INT PRIMARY KEY` を保存すると PK が黙って脱落して
  いた）。制約名は出力せず、再生時に Postgres が付ける既定名に任せる。
  `NOT NULL`/`DEFAULT`/`CHECK` は引き続き対象外（5節）。
- **テーブルの並び順**: `DBState.order`（作成順）に従う。FK は作成時に参照先が
  既に存在することを要求し、参照されたテーブルは `CASCADE` なしでは `DROP` できない
  ため、作成順では参照先が必ず先に来る（トポロジカルソートは行わない）。

## 4. `ALTER TABLE` のMVPスコープ

対応するのは単一の `ADD COLUMN`/`DROP COLUMN` アクションのみ。以下は
対象外:

- `RENAME`（テーブル名・列名の変更）
- 列の型変更
- 複数アクションの同時指定（例: `ALTER TABLE t ADD COLUMN a INT, DROP
  COLUMN b`）

## 5. その他のSQL対応範囲スコープ外事項

- 制約定義のうち `NOT NULL`/`DEFAULT`/`CHECK` 等（3節）。`PRIMARY KEY`/
  `UNIQUE`/`FOREIGN KEY` は [Issue #45](https://github.com/Yaeshio/SQL-Viz/issues/45)
  でスコープ内とした（パース許可と DDL 出力。FK はさらにモデル化
  （`Column.references`/`DBState.relations`）とキャンバスのコネクタ描画まで）。
  #45 の範囲でも以下は対象外で、いずれも `Unsupported clause` として拒否する:
  複数列の FK、`ON DELETE`/`ON UPDATE`/`MATCH`（実行は PGlite だが `DBState` が
  連鎖削除された子行を追跡できず、キャンバスと DB が食い違うため）、スキーマ
  修飾の参照先、`ALTER TABLE` による FK 追加（4節）。PK/UNIQUE のモデル化・
  キャンバス描画（バッジ等）とリレーション線の自動レイアウト最適化も対象外。
  JOIN 結果クエリの実行・可視化は #48。
- `WHERE` は `SELECT`/`UPDATE`/`DELETE` いずれも単一の `<col> <op>
  <value>` 比較のみ対応（`AND`/`OR`、`JOIN` は非対応）。対応SQL文の
  全体像・選定理由は [`docs/user-stories.md`](./user-stories.md) を
  参照。

## 6. 参照

- [Issue #18](https://github.com/Yaeshio/SQL-Viz/issues/18)（モード概念・
  許可マトリクスの導入元、クローズ済み）
- 永続化方式（本ドキュメントとは独立）: [local-cli-sync-spec.md](./local-cli-sync-spec.md)
- 対応SQL文の全体像: [user-stories.md](./user-stories.md)
