# α版フェーズ別 受け入れ条件（Acceptance Criteria）

SQL-Vizのα版検証は「フェーズA: ワークフロー体験 → フェーズB: GUI体験 → フェーズC: SQL対応
拡大」の3段階で進める方針が決定済み（project memory `project_alpha_phasing.md`、
2026-08-22決定）。このドキュメントは、各フェーズの実装に着手する**前に**、「何をもって
そのフェーズが完了とみなせるか」をテスト可能な形で先に定義しておくためのものである。

対応する自動受け入れテストは
[tools/acceptance-check/](../tools/acceptance-check/)（Docker+Playwright、pass/fail自動判定、
`npm test`・CI非組み込み）に置く。ブラウザを介さない検証は `tests/`（vitest）側に置く。

## フェーズA: ワークフロー体験（#27 → #32 → #33 + #31）

目標体験: 「Docker起動 → エージェントがCLI経由で操作 → 開発者がレビュー」。

- **#31（sql-studioのDockerコンテナ化）** — issue本文の「検証方法」セクションが既に
  itemized ACとして機能している（`docker build`成功、bind mount経由での実ファイル
  Save/Reload、`--user`によるファイル所有権、LAN到達不可の確認、既存の非Docker起動の
  回帰確認）。**このタスクの範囲外**: `docker/sql-studio/Dockerfile` 自体の実装は含まない。
  前方互換性メモ: `tools/acceptance-check/orchestrate-phase-a.mjs` の `spawnVite()` 直接
  呼び出し部分は、#31実装後に `docker run ... sql-studio /workspace/schema.sql` への
  差し替えが可能なよう、シナリオ側（`run.mjs`/`scenarios/`）は「到達可能なURLとbind mount
  されたパス」だけに依存する設計にしてある。また、将来Dockerfile/entrypointを実装する
  際は、`scripts/openLocal.mjs`の起動時バナーが印字する`docs/agent-proposal-workflow-spec.md`
  （#33）へのURLポインタを維持すること（SQL-Viz自身のローカルチェックアウトを持たない
  Docker利用時でも、エージェントがワークフロー文書に到達できるようにするため）。
- **#27（エージェント向けSQL実行CLI/API）** — issueコメントに詳細なitemized AC checklistが
  既にある（`POST /api/query`、`GET /api/query/state`・`/health`、`POST /api/query/reset`、
  `npm run query --`のJSON専用stdout・exit code設計等）。このAPI/CLIはブラウザを一切
  介さないため、実装時の受け入れテストは `tools/acceptance-check` ではなく **`tests/`
  配下の実サブプロセス統合テスト**（`npm run sql-studio`を実起動し、実`fetch`でエンドポイントを
  叩く／`npm run query --`を実サブプロセスとして起動しstdout・exit codeを検証する）として
  追加すべき。現時点では未実装（今回は作らない）。
- **#32（author/verify起動モード）** — 実装済み。`--mode=author|verify`
  （既定は`author`、既存の`design`/`experiment`という`AppMode`とは独立した別軸）
  に加え、検証モードでも変更後スキーマを別名で永続化できるよう
  `--save-dir=<path>`（既定はOS一時ディレクトリ配下）と
  `POST /api/schema/verify-save` を追加した。`tools/acceptance-check/scenarios/
  phaseA-verify.mjs`（`orchestrate-phase-a.mjs`から`--phase=A-verify`として実行）が、
  (a) verifyモードでも既存スキーマがサイレント自動ロードされること、(b) Save が
  対象ファイルを変更せず`saveDir`へ別名保存されること、(c) `POST /api/schema`への
  直接アクセスが403で拒否され対象ファイルが変更されないこと、を実ファイルI/Oで検証する。
- **#33（改修提案・クエリ例ドキュメントのエージェント執筆ワークフロー）** — 実装済み。
  `docs/agent-proposal-workflow-spec.md`にワークフロー・テンプレートを定義した。
  書き出し先の配置場所は、SQL-Viz側に新規CLIフラグ・GUI設定を追加せず、対象
  プロジェクト（起動時に指定するスキーマファイルが属するリポジトリ）側で
  エージェントとユーザーが都度決める運用とした（要望が増えれば動的設定機能を
  別Issueとして検討する）。新規APIも新規UIも追加しない方針のため、自動テストは
  作らず、ドキュメントレビュー／手動ワークフロー確認（本仕様書の手順を実際に
  辿れるか）で検証する。

**今すぐ動く実証**: 上記のうち#31/#33は未実装だが、#27・#32は実装済みであり、その土台である
（クローズ済みの）#26のローカルファイル同期機能とあわせて、`tools/acceptance-check`の
`A-initial`/`A-restart`/`A-verify`シナリオが**既に実行可能**——任意の一時ディレクトリを作成し、
実際のファイル読み書き（コールドスタート・Save・外部編集からのReload・プロセス再起動時の
サイレント自動ロード・検証モードでの別名保存と書き込み拒否）を実ブラウザ・実ファイルシステムで
検証する。既存の`tests/localApi.test.ts`等はすべて`node:fs/promises`・`createServer`・`fetch`を
モックしており、実I/Oを通した往復検証はこちらが担う。

### フェーズA完了後の対応事項

2026-08-25、Issue #27（エージェント向けSQL実行CLI/API）に対して、実装を知らない
エージェントに公開仕様書（`docs/agent-query-api-spec.md`）のみを渡すブラックボックス
受け入れテストを実施したところ、以下2件が判明し、それぞれ新規Issueとして起票済み：

- [Issue #36](https://github.com/Yaeshio/SQL-Viz/issues/36) — `experiment`モードで
  SQLエラー発生後、`reset`するまでモードを問わず全リクエストが失敗し続ける
  トランザクション汚染バグ。「直前の失敗した文だけを取り消して続行する」機能の
  搭載を提案。
- [Issue #37](https://github.com/Yaeshio/SQL-Viz/issues/37) — 人間がCLI/APIを
  直接操作する場合の利便性向上として、クエリの実行履歴・再実行(replay)機能を提案。

両Issueとも**フェーズA（#27 → #32 → #33 + #31）が完了してから着手する**
（現在進行中のワークフロー体験実装を優先するため）。

2026-08-26、Issue #32（起動時モード）の手動確認時のフィードバックから、
[Issue #38](https://github.com/Yaeshio/SQL-Viz/issues/38)
（スキーマ保存・SQL実行のターミナルログ出力）を新規起票した。これは新機能
ではなく**UXの向上**（開発者・エージェント運用者への可観測性向上）が目的の
タスクであり、`#31`（sql-studioのDockerコンテナ化）を含むフェーズAの体験
整備が完了してから着手する（#36/#37と同様の扱い）。

また、**フェーズA完了時にはREADME等のドキュメントについても、その時点の実装を
正として棚卸し・更新を行う**（実装が先行し記述が追いついていない箇所がないか
確認する）方針とする。

## フェーズB: GUI体験（#17 → #34）

完了条件: 「パン・ズームとドラッグによるテーブル移動が両立して使えること」（#34は#17に
明示的に依存）。

- どちらのissueにも正式なAC checklistはまだ無く、提案セクションの記述が完了条件の代替になる。
- 想定するテスト種別: ブラウザでのポインタ/ホイール操作を伴うため、
  `tools/acceptance-check/scenarios/phaseB*.mjs`（Playwrightのポインタ/ホイールイベント
  シミュレーション）として追加する。
- **#17（パン・ズーム + Fitボタン）分は実装済み**: `scenarios/phaseB-panzoom.mjs` /
  `orchestrate-phase-b.mjs`。`Canvas.tsx` が公開する `data-canvas-scale` /
  `data-canvas-pan-x` / `data-canvas-pan-y` / `data-world-w` / `data-world-h` を
  アサーション対象にし、ピクセル比較は行わない。純粋幾何（`computeWorldBox` /
  `WORLD_W`）は `tests/canvasLayout.test.ts` / `tests/layout.test.ts`（vitest）で別途検証。
- #17本体に未決事項は無いため、#34（ドラッグ移動）とその未決事項（テーブルの
  リサイズ時に手動配置済みテーブルの再レイアウトが必要か）が解消される前に
  #17単体スコープで先行実装した（Issue #17 コメントの整理に従う）。#34分の
  アサーションはその未決事項の解消後に別モジュールで追加する。
- `docs/smoke-test-spec.md` §3のE2E見送り決定は「将来ドラッグ操作等でUI側状態が複雑化したら
  再検討する」と明記しており、#34はまさにその再検討トリガーに該当する。ただし、その再検討は
  `tests/`のvitestスイート/CIへPlaywrightを組み込むという結論には至らず、この
  `tools/acceptance-check`という別枠のDocker限定ハーネスで対応する（同ファイル§3末尾の
  補足参照）。

## フェーズC: SQL対応拡大（#35）

完了条件はブラウザを介さない——`parser.ts`/`pglite/engine.ts`のロジック層の話であるため、
`tools/acceptance-check`ではなく `tests/` 配下（vitest）で検証する。

- **Mediumティア**（複合WHERE、ALTER TABLE RENAME、単一ALTER文での複数アクション）:
  `tests/parser.test.ts`/`tests/engine.test.ts` の拡張が対象。あわせて
  `docs/smoke-test-spec.md` のSMOKE-14/15を「`Unsupported clause`エラーを期待」から
  「正常実行を期待」へ更新する（同ドキュメント4節に既に記載されている想定移行）。
- **Largeティア**（JOIN、GROUP BY/集約）: `DBState`/`Row`（1テーブル=1行セット前提）の
  データモデル再設計が先決であり、テストシナリオは未定義のまま据え置く。

## 参照

- [tools/acceptance-check/README.md](../tools/acceptance-check/README.md) — ハーネスの使い方
- [tools/visual-check/README.md](../tools/visual-check/README.md) — 目視確認専用ツール（別物）
- [docs/smoke-test-spec.md](./smoke-test-spec.md) — vitestスモークテスト方針・E2E見送りの経緯
- [docs/local-cli-sync-spec.md](./local-cli-sync-spec.md) — `#26`のローカルファイル同期API仕様
