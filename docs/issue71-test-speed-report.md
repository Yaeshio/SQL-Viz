# Issue #71 検証報告（一時ファイル）

> **本ドキュメントは 2026-10-08 に実施した Issue #71（テスト実行時間の短縮：PGlite の
> 解放と起動コストの削減）の検証記録であり、恒久的な仕様書ではない。レビュー後は削除して
> 差し支えない。**

## 対応内容（PR #72、段階ごとに1コミット）

- **段階1（e0a03a3）**: `PgEngine.close()` を追加し、`reset()` も旧インスタンスを解放する
  ようにした。旧インスタンスの `close()` は、実行中の `run()`/`returnToDesign()` と初期化の
  決着後まで遅らせる。queryApiPlugin はリセット時と `closeBundle` フック（`server.close()`
  時）でエンジンを解放する。テスト側は `afterEach`/`finally` で解放する。
- **段階2（7969287）**: `PgEngine.run()` の PGlite 起動を、パースゲートとモードゲートの通過後へ
  移した。queryApiPlugin のブートストラップは明示的に `ensureReady()` を呼ぶ。
- **段階3（aedd844）**: Vitest の globalSetup で初期化済みのテンプレートを1回だけ作る。
  setupFiles で `@electric-sql/pglite` を mock し、引数なしの `new PGlite()` がそれを
  `loadDataDir` として使うようにした。
- **段階4**: テストファイルの分割方針と、テンプレートの仕組みを CLAUDE.md に記載した。
  段階3で CI が18秒になり完了条件（40秒以下）を満たしたため、`engine.test.ts` は分割しない。
- **段階5**: 見送った。条件は「`queryApiIntegration.test.ts` が CI 上で所要時間を決める
  ファイルになっていること」だが、段階3時点で7.0秒と最長の `engine.test.ts`（15.7秒）を
  大きく下回り、条件を満たさなかった。

## CI の `npm test` ステップ時間（ubuntu-latest）

| 段階 | run | `npm test` ステップ | Vitest Duration | 各テスト時間の合計 |
|---|---|---|---|---|
| 基準（main 12e778b ほか） | 35206112331 / 34818463638 / 34604266589 | 102s / 95s / 103s | 101.7s（35206112331） | 254.1s |
| 段階1 | 37760693273 | 58s | 57.6s | 145.6s |
| 段階2 | 37761137552 | 91s | 90.0s | 219.0s |
| 段階3 | 37761638210 | **18s** | 17.5s | 41.1s |

段階2で遅くなったのは CI ランナーのばらつきによるもの。段階2の変更が影響しない
`ddlExport.test.ts`（ゲートで弾かれるテストが無い）も 6.9s → 12.4s と遅くなっており、
全ファイルが一様に約1.5倍遅くなっている。最終コミットで3回連続実行した結果は PR #72 の
本文に記録する。

### ファイル別（CI）

| ファイル | 基準（35206112331） | 段階3（37761638210） |
|---|---|---|
| `engine.test.ts`（56件） | 101.1s | 15.7s |
| `smoke.test.ts`（21件） | 47.3s | 5.0s |
| `queryApiPlugin.test.ts`（19件） | 44.5s | 6.3s |
| `events.test.ts`（12件） | 27.4s | 4.8s |
| `queryApiIntegration.test.ts`（6件） | 21.8s | 7.0s |
| `ddlExport.test.ts`（5件） | 11.9s | 2.2s |

## ローカル（WSL2 4コア/8GB、Node 24.14）での `npm test` 全体

最大 RSS は `/usr/bin/time -v` で計測した、最も大きい単一プロセスの値（KiB を GiB に換算）。

| | 結果 | Vitest Duration | 最大 RSS |
|---|---|---|---|
| main（2回） | 2回とも1件失敗（2回目の失敗は `queryApiPlugin.test.ts` の「Issue #38: POST /api/query 成功時…」の 30000ms タイムアウト。1回目は失敗したテスト名を記録していない） | 255.1s / 208.0s | 4.04GiB / 4.18GiB |
| 段階1 | 15ファイル・321件すべて成功 | 164.2s | 1.35GiB |
| 段階3 | 15ファイル・321件すべて成功 | 45.4s | 1.14GiB |

`engine.test.ts` を単独で実行した場合: 段階1で 109.1s → 段階3で 26.5s。

## ブラウザの Reset 経路の確認

### エンジン単体（Node、段階1・段階2の各時点）

ブラウザの Reset ボタン（`useSqlRunner.reset()` → `PgEngine.reset()`）が通るのと同じエンジン
操作を、Node（型ストリップ）から `src/pglite/engine.ts` を直接 import するスクラッチスクリプトで
再現した。以下のすべてが成功した。

- コールドスタート中に Reset → 古い初期化は `db` に代入されずに解放され（`closed === true`）、
  次の Run は新しいインスタンスで成功する。
- 複数文の `run()` の実行中に Reset → `run()` は全文エラー無く完走し、旧インスタンスは
  その決着後に解放される（実行中は `closed === false`）。
- Run → Reset → 同じ `CREATE TABLE` を Run → `already exists` にならない（新しい空の DB）。
- experiment モードで INSERT 後に Reset → `returnToDesign()` は `null` を返し、新しい
  インスタンスへ `ROLLBACK` を送らない。
- 一度も起動していないエンジンの `close()` を2回呼んでも何も起きない。

### 実ブラウザ（2026-10-08、ブランチ先頭 b86d12c）

`tools/visual-check/` の Docker イメージ（Playwright 1.61.1 / Chromium）を使い、スクラッチの
Playwright スクリプトを `--entrypoint node` で実行した（`tools/visual-check/` 自体は無改修）。
同じスクリプトを、別 worktree で起動した main（12e778b）の dev サーバーにも当てて比較した。

**`npm run dev`（Vercel 本番と同じ静的 SPA）** — ブランチ・main とも、console 確認を除く
16 項目すべて成功（console については末尾の既存の警告を参照）。

- A. 初回 Run で「エンジン読込中…」が表示され、CREATE TABLE が成功する。
- B. Run → Reset → Run: Reset でテーブルが消え（tables=0）、次の Run で再びコールドスタート
  が起き、同じ CREATE がエラーにならない。
- C. コールドスタート中に Reset → 画面はエラーにならず、その後 Reset → Run も正常。
- D. 実験モードで INSERT 2行 + SELECT（rows=2）→ Reset → 設計モードに戻り tables=0/rows=0 →
  同名テーブルを作り直せる。
- E. 実験モードで INSERT → 設計モードへ戻すと ROLLBACK され rows=0（`returnToDesign()`）。
- F. パースエラー・モード違反（設計モードの SELECT）がエラー表示され、その後の CREATE は成功。

main への1回目の実行では D の最後の CREATE が「エンジン読込中…」のまま 30 秒でタイムアウト
したが、D だけの切り出しと2回目の全体実行では main も成功しており、一過性の遅延と判断した。

**ローカルCLIモード（`npm run sql-studio -- <schema.sql>`、ブランチのみ）** — 3/3 項目成功。

- スキーマファイルの2テーブルが起動時に自動ロードされる。
- Reset → 新しい CREATE を Run → Save で、スキーマファイルが Reset 後のテーブルだけの DDL に
  書き換わる（Reset 後の現行インスタンスから DDL を生成できている）。
- SIGTERM を送ると、Vite の `server.close()`（→ プラグインの `closeBundle` → `engine.close()`）を
  経て 105ms で exit code 0 で終了し、エラー出力は無い。

**メモリ** — Run → Reset を8回繰り返し、各回の後に CDP で GC を2回かけてから Chromium
レンダラープロセスの RSS を測った（MiB）。

| | 読込直後 | 1回後 | 2回後 | 8回後 |
|---|---|---|---|---|
| main | 172 | 461 | 666 | 671 |
| ブランチ | 171 | 262 | 265 | 269 |

main も際限なく増えるわけではないが、Reset 後も約400MiB 多く保持し続ける。ブランチでは
Reset のたびに旧インスタンスが解放され、1インスタンス分で横ばいになる。

**既存の挙動として確認したこと（main と同じ、本 PR では変更していない）**

- コールドスタート中に Reset すると、実行中だった Run は新しいインスタンスでもう一度
  コールドスタートしてから完了する（テーブルが1つ残る）。この2回目の起動中は
  「エンジン読込中…」が表示されず、Run ボタンが一時的に押せる状態になる。Reset 後6秒間の
  ボタン表示の遷移は、ブランチと main の1回目の実行で同一（「エンジン読込中…(disabled) →
  Run SQL → Run SQL(disabled) → Running…(disabled) → Run SQL」）だった。
- console には、どのページ読込でも `react-zoom-pan-pinch` の `TransformComponent` に関する
  React の開発時警告（`` `ref` is not a prop ``）が1件ずつ出る。main でも同じで、本 PR の
  変更箇所とは無関係。

## 補足

- `queryApiIntegration.test.ts` の実行中に出る esbuild の `✘ [ERROR] The build was canceled`
  は、main でも同じく出ている既存の出力で、テストの成否には影響しない。
- 対象外とした既存の競合: Reset した時点で実行中だった `run()` が、終了後に `lastState` を
  書き戻す問題。本 Issue 以前からあり、本 PR では手を入れていない。
