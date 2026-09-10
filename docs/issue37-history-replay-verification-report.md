# Issue #37 実行履歴・再実行(replay)機能 手動検証報告（一時ファイル）

> **本ドキュメントは 2026-09-10 に実施した Issue #37（クエリCLI/APIへの実行履歴・
> 再実行機能）の実装後の手動検証の一回限りの実施記録であり、恒久的な仕様書ではない。**
> レビュー後・PRマージ後は削除して差し支えない
> （恒久仕様書は [docs/agent-query-api-spec.md](agent-query-api-spec.md)、
> 過去のIssue #27検証記録と同じ体裁）。

## 検証条件

- 対象: `GET /api/query/history`（新規）、CLI `--history` / `--replay=<seq>`（新規、
  `scripts/query.mjs`）、`POST /api/query/reset` との相互作用
- 対象ブランチ: `issue-37-query-history-replay`
- 実行環境: スクラッチ領域の `schema.sql`（`CREATE TABLE users (id INT, name
  VARCHAR(50));` のみ）で `npm run sql-studio` を起動。リポジトリ内の追跡対象
  ファイルは検証中変更していない（`git status` で確認済み）。
- 自動テスト: `tests/queryApiPlugin.test.ts`（QUERY-API-11〜14）、
  `tests/query.test.ts`（QUERY-CLI-15〜26）、`tests/queryApiIntegration.test.ts`
  （QUERY-INT-05/06）を追加。各ファイル単体で `npx vitest run` がグリーン。
  `npm run typecheck` / `npm run lint` / `npm run build` もパス。
  （`npm test` 全体はこの環境ではPGliteインスタンス多数同時起動でOOM killされる
  ため、影響を受ける3ファイルを個別実行して確認した。）

## 実施したシナリオと結果

1. 起動直後 `node scripts/query.mjs --history` → `{"history":[]}`（空配列）
2. `CREATE TABLE orders (...)`（design）→ exit 0。続けて `--history` を見ると
   `seq:1, mode:"design", ok:true, statements:[{label:"CREATE TABLE orders (2 cols)"}]`、
   `at` はISO 8601文字列。`DBState` はエントリに含まれない（仕様通り）
3. `--mode=experiment` で `INSERT` → `seq:2, ok:true`
4. `--mode=experiment` で `SELECT id FROM orders WHERE total > 100` → `seq:3, ok:true`
5. `--mode=experiment` で `INSERT INTO ghost (x) VALUES (1)`（存在しないテーブル）→
   exit 1、`--history` に `seq:4, ok:false,
   statements:[{label:..., error:'relation "ghost" does not exist'}]`
6. `--replay=3 --mode=design` → 記録済みの `mode:"experiment"` が使われ（`--mode=design`
   は無視）、SELECT が experiment セッションで再実行され exit 0。replay自体も
   新エントリ `seq:5` として記録される
7. `--replay=99`（履歴に無いseq）→ stderr `No history entry with seq=99`、exit 3
   （サーバーには履歴取得のGETのみ、`POST /api/query` は行かない）
8. `--replay=abc`（非整数）→ stderr `Invalid --replay: must be a positive integer.`
   ＋ USAGE、exit 3、ネットワークアクセスなし
9. `node scripts/query.mjs "SELECT 1" --history` および `... "SELECT 1" --replay=1`
   → stderr `--history, --replay, and inline SQL are mutually exclusive.` ＋ USAGE、
   exit 3、ネットワークアクセスなし
10. `POST /api/query/reset` → `{"ok":true,"error":null}`。直後に
    `GET /api/query/state` の `order` が `["users"]`（ブートストラップ状態、
    `orders` は消失）。一方 `--history` は `count:5, seqs:1,2,3,4,5` のまま
    **クリアされていない**（決定事項1の通り）

## ドキュメント通りに動いたか

| 観点 | 結果 |
|---|---|
| `GET /api/query/history` のレスポンス形式（`seq`/`sql`/`mode`/`at`/`ok`/`parseError?`/`statements[]`、`DBState`非含有） | Pass |
| `seq` が1から単調増加、成功/parseError/文エラーで `ok` と `statements` が正しく分岐 | Pass |
| CLI `--history`（1行コンパクトJSON、stdoutのみ） | Pass |
| CLI `--replay=<seq>`（記録済み sql/mode を再送、`--mode=` は無視） | Pass |
| `--history`/`--replay`/位置引数SQL の相互排他（exit 3、ネットワークアクセス前に弾く） | Pass |
| `--replay` の非正整数・存在しないseq のエラー（exit 3） | Pass |
| `POST /api/query/reset` を跨いで履歴が保持される（DB状態はリセットされる） | Pass |
| 起動時ブートストラップDDLの実行が履歴に混入しない | Pass（`schema.sql` の `CREATE TABLE users` は履歴に出ない） |

## 発見された不具合・仕様との齟齬

なし。実装・自動テスト・仕様書（`docs/agent-query-api-spec.md` 更新分）・
`CLAUDE.md` 更新分の記述と、実機の挙動が一致した。

`HISTORY_LIMIT`（200件）を超えた際のFIFO破棄と `seq` 非再利用は
`tests/queryApiPlugin.test.ts` QUERY-API-13 で自動検証済み（手動では200回
送信は行っていない）。

## 後処理

- dev server プロセス（pid 15161）を `kill` で終了。
- `git status` で追跡対象の変更が意図した7ファイル
  （`CLAUDE.md`, `docs/agent-query-api-spec.md`, `scripts/query.mjs`,
  `src/local/queryApiPlugin.ts`, `tests/*` ×3）のみであることを確認。
