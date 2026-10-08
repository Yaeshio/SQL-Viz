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

この環境には Docker が無く（WSL Integration が無効）、`tools/visual-check/` は実行できなかった。
代わりに、ブラウザの Reset ボタン（`useSqlRunner.reset()` → `PgEngine.reset()`）が通るのと
同じエンジン操作を、Node（型ストリップ）から `src/pglite/engine.ts` を直接 import する
スクラッチスクリプトで再現した。段階1・段階2の各時点で、以下のすべてが成功した。

- A. コールドスタート中に Reset → 古い初期化は `db` に代入されずに解放され
  （`closed === true`）、次の Run は新しいインスタンスで成功する。
- B. 複数文の `run()` の実行中に Reset → `run()` は全文エラー無く完走し、旧インスタンスは
  その決着後に解放される（実行中は `closed === false`）。
- C. Run → Reset → 同じ `CREATE TABLE` を Run → `already exists` にならない（新しい空の DB）。
- D. experiment モードで INSERT 後に Reset → `returnToDesign()` は `null` を返し、新しい
  インスタンスへ `ROLLBACK` を送らない。
- E. 一度も起動していないエンジンの `close()` を2回呼んでも何も起きない。

## 補足

- `queryApiIntegration.test.ts` の実行中に出る esbuild の `✘ [ERROR] The build was canceled`
  は、main でも同じく出ている既存の出力で、テストの成否には影響しない。
- 対象外とした既存の競合: Reset した時点で実行中だった `run()` が、終了後に `lastState` を
  書き戻す問題。本 Issue 以前からあり、本 PR では手を入れていない。
