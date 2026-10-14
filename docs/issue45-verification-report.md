# Issue #45 検証報告（一時ファイル）

> **本ドキュメントは 2026-10-13 に実施した Issue #45（テーブル間リレーション（外部キー）の
> モデル化とキャンバス描画）の検証記録であり、恒久的な仕様書ではない。レビュー後は削除して
> 差し支えない。**

## 方針とスコープの変更

Issue の記述（`PRIMARY KEY` は非スコープ）のまま FK を実装すると、スキーマ保存と両立しないことが
調査で分かった。ユーザー判断により **`PRIMARY KEY`/`UNIQUE` のパース許可と DDL 出力をスコープに
戻し**、リレーション周りのバグ対策を優先した（Issue #45 にコメント済み）。あわせて、
`ON DELETE`/`ON UPDATE`/`MATCH` は黙って通すのをやめ `Unsupported clause` として拒否する
（ユーザー確認済み。現状は列レベルだと素通しで、PG 側で CASCADE が効くが `DBState` が連鎖削除を
追跡できずキャンバスと DB が食い違うため）。

## 実機（PGlite）で再現した問題

| # | 内容 | 結果 |
|---|---|---|
| 1 | 参照先列が PK/UNIQUE でない FK | `there is no unique constraint matching given keys for referenced table` で CREATE 失敗 |
| 2 | 現行 `generateDdl` で `id INT PRIMARY KEY` を Save → Reload | PK が脱落し、元の DB なら `duplicate key value violates unique constraint "users_pkey"` で拒否される重複 INSERT が通る（既存の潜在バグ） |
| 3 | FK だけ DDL に足して PK を出さない | Reload が #1 で失敗。最初のエラーで止まるため `users` だけ作られ `posts` が作られない |
| 4 | `DROP TABLE a CASCADE` | パーサーを通り、PG は参照元の FK 制約だけを消して列は残す（→ `DBState` 側で `references` の掃除が必要） |
| 5 | `CREATE TABLE Users` のように大文字小文字が混在するテーブル名の DDL 出力 | 実装中に発見。カタログへの問い合わせだけ小文字化されておらず、列も PK も 0 件の `CREATE TABLE "users" (\n\n);` が出力され、参照先を失った FK だけが残る（FK が無くても列・PK が落ちる既存バグ） |

## 対応内容（段階ごとに1コミット）

- **段階1（51f84f3）**: パーサーが列レベル/表レベルの `FOREIGN KEY` を `Column.references` に変換
  （単一列のみ）。`PRIMARY KEY`/`UNIQUE`（複合可）は素通しで明示許可。`ON DELETE`/`ON UPDATE`・
  `MATCH`・複数列 FK・スキーマ修飾・同一列への FK 二重指定は拒否。`generateDdl` が `pg_constraint`
  から `PRIMARY KEY`/`UNIQUE`/`FOREIGN KEY` を表レベル制約として出力し、保存→Reload が往復する。
- **段階2（c9adfb1）**: `Relation`/`DBState.relations`。真実の源は `Column.references` で、
  `deriveRelations()` が導出する。`drop` では他テーブルの列に残る `references` を外す
  （外さないと、CASCADE で消した親を作り直したとき存在しない FK が復活する）。
- **段階3（d6879b2）**: `relation_add`/`relation_remove` と、`diff.ts` の「カラム → リレーション →
  行」の順序（テーブルごとのループを2パスに分割）。`useAnimationPlayer` の `hiddenRelations`。
- **段階4（820a9e8）**: `RelationLayer`・`computeRelationGeometry()`。ドラッグへのライブ追従。
  受け入れハーネスに `C-relation` を追加。
- **DDL 修正（2fe2c40）**: 上記 #5（大文字小文字混在のテーブル名）。
- **段階5**: ギャラリーへ relation-add/relation-remove を追加、ドキュメント更新、本レポート。
  既存ギャラリー画像の更新は別コミット（下記）。

## 自動テスト

新規: `tests/engine.relation.test.ts`（19件）、`tests/reducer.relation.test.ts`（9件）、
`tests/diff.relation.test.ts`（6件）、`tests/events.relation.test.ts`（5件）。既存への追記:
`parser.test.ts`（FK/PK/UNIQUE の正常系・拒否系）、`ddlExport.test.ts`（DDL-06〜12。FK・複合 PK・
自己参照・大文字小文字混在のラウンドトリップ、Reload 後に PK/FK が効くこと）、
`canvasLayout.test.ts`（端点・辺の選択・自己参照・列欠落）、`queryApiPlugin.test.ts`
（FK 付き DDL のブートストラップが `GET /state` の `relations` に出る）。

`npm run typecheck` / `npm run lint` / `npm run build` / `npm test`（20ファイル・405件）すべて成功。
`npm test` の出力に `The build was canceled` が3回出るが、`queryApiIntegration.test.ts`（vite を
起動して終了させるテスト）単体でも同じ出力があり、今回の変更に由来しない
（main との比較はしていない）。

### テストが形だけでないことの確認（変異テスト）

| 変異 | 期待どおり落ちたテスト |
|---|---|
| `DROP` で他テーブルの列の `references` を外す処理を無効化 | `REL-ENG-10`・`REL-ENG-11` |
| `playEvents()` の `hiddenRelations` 事前登録を無効化 | 受け入れ `connector-is-drawn-after-its-tables-appear`（`connector appeared -0ms after the posts table`） |

どちらも元に戻して再度全件成功を確認した。

## 実ブラウザ（Docker + Playwright、`tools/acceptance-check`）

`node tools/acceptance-check/orchestrate-phase-c-relation.mjs`（6/6 成功）:

| シナリオ | 結果 |
|---|---|
| `connector-is-drawn-after-its-tables-appear` | `posts` の出現から 117ms 後にコネクタが DOM に追加された |
| `connector-endpoints-sit-on-the-column-rows` | 端点 `posts.user_id (312, 105)` → `users.id (264, 75)` が、`layout.ts` の定数から再計算したカラム行の中心と一致 |
| `connector-follows-the-table-while-dragging` | ボタンを離す前のドラッグ中に `y2` が 75 → 255 へ追従（ドロップ後も 255） |
| `dropping-the-child-removes-the-connector` | `DROP TABLE posts` でコネクタ 0 本 |
| `dropping-a-referenced-parent-is-rejected-by-postgres` | `DROP TABLE users` が PG の文言で拒否され、コネクタ 1 本・テーブル 2 枚のまま |
| `saved-ddl-keeps-constraints-and-restores-the-relation-on-a-fresh-load` | Save した `schema.sql` に `PRIMARY KEY ("id")` と `FOREIGN KEY ("user_id") REFERENCES "users" ("id")` があり、`page.reload()` 後の起動時自動ロードで FK が復元された |

回帰: `orchestrate-phase-b-drag.mjs`（4/4）、`orchestrate-phase-b.mjs`（パン・ズーム、6/6）も成功。
`orchestrate-phase-c-gallery.mjs` は 13/13 成功し、`relation-add`/`relation-remove` の画像
（4枚）を追加した。スクリーンショットを目視し、FK 側の丸 → 参照先側の矢じり、ドラッグ中の追従を確認した。

## 既存ギャラリー画像の更新（別コミット）

ギャラリーは全画像を再生成するため、既存19枚にもバイナリ差分が出た。確認したところ、
Issue #54 で生成された画像が Issue #51（区切り線の位置修正）より前のもので、`email` 行を
横切る古い区切り線が写っていた（再生成で現行コードの描画に揃っただけ）。FK の描画による変化では
ないので、リレーションの変更とは別コミットにした。

## 未検証・既知の制約

- **`npm run sql-studio` / Docker 版 sql-studio（Issue #31）の手動操作は未実施**。受け入れ
  ハーネスは同じ `spawnVite()` を使い Save→新規ロードまで確認したが、`docker/sql-studio` イメージ
  自体は再検証していない。
- アニメーションの**途中フレーム**（線が引かれていく過程、`relation_remove` の退場）は目視していない。
  `relation_remove` は `table_remove` と同じ dispatch で退場が始まり直列にならない（設計どおり）。
  DOM 上でコネクタが消えること、`relation_add` まで引かれないことのみ確認した。
- 同じ列を自己参照する FK（`y1 == y2`）は端点を縦に ±6px ずらして退化を避けている（`RELGEO-06`）が、
  実画面では確認していない。
- `PRIMARY KEY`/`UNIQUE` はモデル化・描画していない（バッジ等はスコープ外のまま）。
- DDL 出力は制約名を出さないため、`CONSTRAINT my_fk ...` と名前を付けても Save → Reload で PG の
  既定名（`posts_user_id_fkey`）になる。
- 引用符付きの大文字小文字混在の識別子（`"Users"`）は、エンジン全体が `quoteIdent()` で小文字化する
  既存の前提により、従来どおり正しく扱えない（今回は対象外）。
