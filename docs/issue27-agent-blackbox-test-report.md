# Issue #27 エージェント向けCLI/API ブラックボックス受け入れテスト報告（一時ファイル）

> **本ドキュメントは 2026-08-25 に実施した Issue #27（エージェント向けSQL実行CLI/API）の
> ブラックボックス受け入れテストの一回限りの実施記録であり、恒久的な仕様書ではない。**
> 恒久ドキュメントとしての更新対象ではなく、レビュー後は削除して差し支えない
> （関連: [docs/agent-query-api-spec.md](agent-query-api-spec.md) が恒久仕様書）。

## テスト条件

- 対象: Issue #27（`POST /api/query`, `GET /api/query/state`, `GET /api/query/health`,
  `POST /api/query/reset`, `scripts/query.mjs` CLI）
- 対象ブランチ: `test/phase-a-acceptance-harness`（コミット `619259f` 時点）
- 実施方法: 実装を一切知らない新規エージェントに、公開ドキュメント
  （`docs/agent-query-api-spec.md` と `package.json` の `scripts` セクションのみ）だけを渡し、
  `src/` 配下の実装ソース・`tests/` 配下の既存テスト・`CLAUDE.md` は非開示とした状態で、
  テストシナリオ自体もそのエージェントに自由に設計・実行させるブラックボックス方式。
  既存の自動テスト（`tests/queryApiPlugin.test.ts` 等）は実装者自身が書いたものであり
  重複するため、今回は「ドキュメントだけを頼りに初めて使うエージェント」の視点での検証を
  目的とした。
- 実行環境: スクラッチ領域の空DDLファイルで `npm run sql-studio` を起動
  （リポジトリ内の追跡対象ファイルは変更していないことを `git status --porcelain` で確認済み）。

## 実施したテストシナリオと結果

1. `GET /api/query/health` → `{"ready":true,"error":null}`（空DDLでの正常起動）
2. `GET /api/query/state` → 空の `DBState`（`tables:{}`, `order:[]`, `lastSelect:null`, `version:0`）
3. `design` モードで `CREATE TABLE users(...)` → 200、`table_appear` イベント、`version:1`
4. `design` モードで `INSERT` → 200 + `parseError: 'Statement type "insert" is not allowed in design mode'`
5. `experiment` モードで `INSERT`（2行）→ `row_add` イベント×2、`rowId: r0/r1`
6. `SELECT name, age FROM users WHERE age > 26` → `filteredOut` フラグと `lastSelect.columns` で絞り込み確認
7. `UPDATE ... WHERE name='Alice'`（事前に `GET /api/query/state` で旧値取得）→ `row_update` イベントのみ、新旧差分は含まれず（仕様通り）
8. `DELETE ... WHERE name='Bob'` → `row_remove` イベント、該当行は `state` から完全消失
9. 未対応構文（`JOIN`）→ `parseError: "Unsupported clause: JOIN"`
10. 存在しないテーブルへの `INSERT` → `StatementResult.error: 'relation "ghost" does not exist'`
11. 不正リクエスト各種（`sql` 欠如／型不正、`mode` 欠如／不正値、不正JSON）→ すべて 400 `{error: string}`
12. CLI: `node scripts/query.mjs "CREATE TABLE..."`（デフォルト design モード）→ exit 0
13. CLI: `--mode=experiment` フラグ、標準入力（`echo "..." | node scripts/query.mjs --mode=experiment`）の両方で成功
14. `npm run query -- "SELECT..."`（素のnpm）→ stdoutにnpmバナー混入、`JSON.parse` 失敗を実機再現
15. `npm run --silent query -- --mode=experiment "SELECT..."` → クリーンなJSONのみ、`JSON.parse` 成功
16. exit code確認: 正常系0／SQLエラー系1（stdoutにJSONは残る）／サーバー未起動2（`--url=http://127.0.0.1:59999`）／リクエスト不正3（SQL未指定・`--mode`不正）。メッセージはすべてstderr、stdoutは空を確認
17. `POST /api/query/reset` → 起動時ブートストラップへの復帰を `GET /api/query/state` で確認
18. ブートストラップDDLファイルに不正SQLを書いた状態で `reset` → `{"ok":false,"error":"Parse error: ..."}`、`health` にも同じ `error` が反映、`state` はクラッシュせず空DBStateにフォールバック
19. `ALTER TABLE ADD COLUMN` ／ `DROP TABLE`（design）も仕様通り動作
20. 番外: `GET /api/query`（想定外メソッド）→ 200でVite index.htmlのSPAフォールバックが返る（想定外の挙動として記録）

## ① ドキュメント通りに動いたか

| 観点 | 結果 |
|---|---|
| 起動→準備完了待ち→SQL実行→状態確認→リセットの一連の流れ | Pass |
| design/experimentモードの使い分け（モードゲート違反時の`parseError`文言含む） | Pass |
| エラーケース（不正入力400、未対応構文、存在しないテーブル操作） | Pass（メッセージ文言も仕様書の例と完全一致） |
| CLIの終了コード・stdout/stderr分離・npmバナー落とし穴 | Pass（4種の終了コードすべて再現、バナー問題も`--silent`での回避も再現確認） |

## ② 発見された不具合・仕様との齟齬

### 重大: エラー後のトランザクション汚染が未記載

`experiment` モードで一度Postgresエラー（例: 存在しないテーブルへのINSERT）が発生すると、
それ以降のリクエストは同じ `experiment` モードはもちろん、`mode: 'design'` に切り替えて
送っても**すべて** `"current transaction is aborted, commands ignored until end of
transaction block"` という生のPostgresエラーで失敗し続ける状態になることを確認した
（`ALTER`/`CREATE TABLE` ですら失敗する）。回復手段は `POST /api/query/reset`
（ブートストラップ状態への完全破壊的リセット）のみで、「直前の失敗した文だけ取り消して
続行する」ソフトな回復方法は存在しないように見える。

仕様書4節はエラー時に `StatementResult.error` が入ることは説明しているが、それが以降の
**全リクエスト**（モードをまたいでも）を `reset` 必須の状態に固定してしまう点には
一切触れていない。これを知らないエージェントは、エラー後に同じmodeで再試行したり
designモードに切り替えて回避しようとしたりする、無駄な試行錯誤をしうる。

### 軽微: 未定義メソッドへの応答

`GET /api/query`（POST以外のメソッド）は404/405ではなく200でVite開発サーバーのSPA
fallback（index.html）を返す。仕様書に明記された挙動ではないため不具合とまでは言えないが、
実装を知らないエージェントが誤ってGETを叩いた場合に「200が返ってきたのでリクエストは
通った」と誤解しかねない。

## ③ ドキュメントの分かりにくさ・改善余地

- 上記「トランザクション汚染」問題が未記載。「エラー発生後は必ず`reset`が必要になりうる」
  という注意書きがあると、エージェントが不要な試行錯誤をせずに済む。
- `SELECT *` 実行時の `lastSelect.columns` が `["*"]` という文字列そのものになる点が
  未記載。4節の「列は`lastSelect.columns`を用いて絞り込む」という規約は、`*` が来た場合に
  呼び出し側が「全列」と解釈すべきという一手間を明示していない。
- `POST /api/query/reset` が「起動時に渡したDDLファイルを**再読み込みして**再実行する」
  仕様は把握しづらい。実際にスクラッチファイルを一時的に不正なSQLへ書き換えて `reset` を
  叩いたところ `{"ok":false, "error":"Parse error..."}` が返り、`health` にも同じエラーが
  反映されることを確認した——この「再読み込みして失敗するケース」でもクラッシュせず空
  DBStateにフォールバックする挙動は仕様書に書かれていないが、実機では堅牢に振る舞った
  （ドキュメントより安全側の齟齬なので、余裕があれば明記してもよい）。
- それ以外は総じて仕様書の記述と実機の挙動が一字一句レベルで一致しており、迷う点は
  ほとんどなかった。

## 後処理・検証

- テスト役エージェントがdev serverプロセスを終了し、`GET /api/query/health` が
  fetch失敗になることで停止を確認。
- オーケストレーター側でも `git status --porcelain` が空であること、および
  `http://127.0.0.1:5173/api/query/health` へのfetchが失敗する（サーバー停止済み）ことを
  再確認済み。
