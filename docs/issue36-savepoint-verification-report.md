# Issue #36 SAVEPOINT ソフトリカバリ 検証報告（一時ファイル）

> **本ドキュメントは Issue #36（実験モードのSQLエラー後のトランザクション汚染）の
> 修正に対する一回限りの検証記録であり、恒久ドキュメントではない。**
> 恒久仕様は [docs/agent-query-api-spec.md](agent-query-api-spec.md)（4節「エラー発生時の
> セッション挙動」）が担う。レビュー後・一定期間後に削除して差し支えない
> （`docs/issue27-agent-blackbox-test-report.md` と同じ扱い）。

## 検証条件

- 検証日: 2026-09-07
- ブランチ: `feature/issue-36-savepoint-soft-recovery`（分岐元 `main` = `73b47a2`）
- 修正内容: `src/pglite/engine.ts` の `PgEngine.run()` で、実験トランザクションが
  開いている間は各文を `SAVEPOINT sqlviz_stmt` で包み、文の失敗時は
  `ROLLBACK TO SAVEPOINT` + `RELEASE` でその1文だけを巻き戻す。

## 1. 自動テスト

| コマンド | 結果 |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass（警告なし） |
| `npm test` | **289 passed / 15 files**（新規5+1件含む） |
| `npm run build` | 成功（既存の chunk サイズ警告のみ） |

新規テスト:
- `tests/engine.test.ts` — `ENGINE-SOFTRECOVER-01`〜`05`
  （エラー後の INSERT / SELECT / design ALTER 続行、バッチ内エラー、
  エラーを挟んだ `returnToDesign()` の全巻き戻し）
- `tests/queryApiIntegration.test.ts` — `QUERY-INT-04`
  （実サーバー往復で Issue 再現手順が汚染しないこと。恒久回帰ガード）

## 2. CLI 再現手順（Issue 本文の手順そのまま）

`npm run sql-studio -- <空の schema.sql>` を起動し `node scripts/query.mjs` で実行。

| # | コマンド（`--url` 略） | exit | 結果 |
|---|---|---|---|
| 2 | `--mode=design "CREATE TABLE users(id serial primary key, name text)"` | 0 | `table_appear`、`version:1` |
| 3 | `--mode=experiment "INSERT INTO ghost(x) VALUES (1)"` | 1 | `results[0].error: 'relation "ghost" does not exist'`（想定どおり） |
| 4 | `--mode=experiment "SELECT * FROM users"` | **0** | `error` なし、`select_highlight`。**修正前はここが `current transaction is aborted` で exit 1 だった** |
| 5 | `--mode=design "ALTER TABLE users ADD COLUMN age int"` | **0** | `column_add`、`version:3`。**修正前は同じく失敗していた（再現手順5）** |

## 3. Playwright によるブラウザ UI 検証

`tools/visual-check` の Docker Playwright イメージ（`sql-viz-visual-check`、
`mcr.microsoft.com/playwright:v1.61.1-noble`）上で、`npm run dev` の画面へ
SQL をタイプして Run する使い捨てスクリプトを実行（スクリプトはコミットしない。
恒久回帰ガードは `QUERY-INT-04`）。ブラウザ UI も `useSqlRunner` 経由で同一
`PgEngine` を使うため同じバグが再現する。

手順: ①設計モードで `CREATE TABLE users (id int, name text)` → ②実験モードへ切替 →
③`INSERT INTO ghost (x) VALUES (1)`（エラー）→ ④`SELECT * FROM users` →
⑤設計モードで `ALTER TABLE users ADD COLUMN age int`。

| ステップ | 修正前 | 修正後 |
|---|---|---|
| ③ INSERT INTO ghost | エラーボックス `relation "ghost" does not exist` | 同左（想定どおり） |
| ④ SELECT * FROM users | エラーボックス **`current transaction is aborted, commands ignored until end of transaction block`**、実行ログは "No statements run yet." のまま | **エラーボックスなし**、実行ログに `> SELECT * FROM users`、テーブルがハイライト表示 |
| ⑤ ALTER（design） | 成功（ブラウザは実験→設計の切替で `returnToDesign()` の `ROLLBACK` が走り汚染が解けるため。サーバー API にはこの経路が無いので手順5が刺さる） | 成功 |

`consoleErrors` は修正前後とも `react-zoom-pan-pinch` の既存 `ref` 警告のみで、
本修正に起因するエラーは無し。

スクリーンショット（ステップ④の修正前/後）は会話上でユーザーへ共有済み
（このリポジトリにはコミットしない）。

## 結論

- Issue #36 のトランザクション汚染は解消。実験モードのSQLエラー後も、
  同一モード・別モードを問わず後続リクエストがそのまま通る。`reset` 不要。
- 同一バッチ内でエラーが起きても、それ以前に成功した文の効果は維持される。
- `returnToDesign()` による実験データ全巻き戻しは従来どおり機能する。
