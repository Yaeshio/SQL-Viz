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
  されたパス」だけに依存する設計にしてある。
- **#27（エージェント向けSQL実行CLI/API）** — issueコメントに詳細なitemized AC checklistが
  既にある（`POST /api/query`、`GET /api/query/state`・`/health`、`POST /api/query/reset`、
  `npm run query --`のJSON専用stdout・exit code設計等）。このAPI/CLIはブラウザを一切
  介さないため、実装時の受け入れテストは `tools/acceptance-check` ではなく **`tests/`
  配下の実サブプロセス統合テスト**（`npm run sql-studio`を実起動し、実`fetch`でエンドポイントを
  叩く／`npm run query --`を実サブプロセスとして起動しstdout・exit codeを検証する）として
  追加すべき。現時点では未実装（今回は作らない）。
- **#32（design/verify起動モード）** — 未決事項（CLIフラグの命名方式、UIでの表示方法）が
  解消されていないため、具体的なシナリオはまだ書けない。解消され次第、
  「verifyモードでは`POST /api/schema`がUI・API両層で拒否されること」を検証する
  シナリオを`tools/acceptance-check`に追加する。
- **#33（改修提案・クエリ例ドキュメントのエージェント執筆ワークフロー）** — 新規APIも
  新規UIも追加しない方針の文書/ワークフロー整備issueのため、自動テストではなく
  ドキュメントレビュー／手動ワークフロー確認で検証する対象になる見込み。
  未決事項（ドキュメントの配置場所・テンプレート）が解消されるまで具体化しない。

**今すぐ動く実証**: 上記のうち#27/#31/#32/#33はいずれも未実装だが、その土台である
（クローズ済みの）#26のローカルファイル同期機能に対しては、`tools/acceptance-check`の
`A-initial`/`A-restart`シナリオが**既に実行可能**——任意の一時ディレクトリを作成し、
実際のファイル読み書き（コールドスタート・Save・外部編集からのReload・プロセス再起動時の
サイレント自動ロード）を実ブラウザ・実ファイルシステムで検証する。既存の`tests/localApi.test.ts`
等はすべて`node:fs/promises`・`createServer`・`fetch`をモックしており、実I/Oを通した
往復検証はこれが初めてとなる。

## フェーズB: GUI体験（#17 → #34）

完了条件: 「パン・ズームとドラッグによるテーブル移動が両立して使えること」（#34は#17に
明示的に依存）。

- どちらのissueにも正式なAC checklistはまだ無く、提案セクションの記述が完了条件の代替になる。
- 想定するテスト種別: ブラウザでのポインタ/ホイール操作を伴うため、将来
  `tools/acceptance-check/scenarios/phaseB*.mjs`（Playwrightのポインタ/ホイールイベント
  シミュレーション）として追加する見込み。
- 具体的なアサーションは、#34の未決事項（テーブルのリサイズ時に手動配置済みテーブルの
  再レイアウトが必要か）が解消されるまで書かない。
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
