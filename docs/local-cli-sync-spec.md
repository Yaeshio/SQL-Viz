# ローカルCLI経由のファイル同期機能 仕様書

このドキュメントは [Issue #26「永続化方式をGitHub連携からローカルCLI経由の
ファイル同期へ移行する」](https://github.com/Yaeshio/SQL-Viz/issues/26)
に基づき、本機能が**何を・なぜ**実現するかを定義するものである。実装方法
（対象ファイル、モジュール構成）については
[local-cli-sync-design.md](./local-cli-sync-design.md) を参照。

旧・GitHub連携方式（PAT + Contents API直接push、Issue #18で実装）の仕様は
本機能への移行に伴い廃止された。旧仕様書は本ドキュメントで置き換えられて
おり、リポジトリ履歴からのみ参照できる。

## 1. 目的とスコープ

旧方式は GitHub Personal Access Token（PAT）をアプリ内に保存し、GitHub
Contents API へ直接 push することでスキーマを永続化していた。この方式には
以下の構造的なコストがあった。

- PATの入力・保存（`sessionStorage`）・スコープ案内などの認証層をアプリ内に
  持つ必要がある。
- 永続化先が「手動入力した owner/repo/branch」の別リポジトリに限定され、
  アプリのソースコードとスキーマ設計の保存先が分かれてしまう。

そこで、**CLIが起動するローカル Node/Vite プロセスが直接ファイルI/Oを行う
方式**に移行した。File System Access API（`showDirectoryPicker()` 等）は、
ブラウザの権限プロンプトがユーザーの明示的なクリックなしには得られず、
「ターミナルから起動すると自動でファイルを読み込む」という体験を実現
できないため不採用とした。

### 前提となる判断

- Vercel にホスティングされる本番環境（不特定多数が使うブラウザ版）では
  ローカル Node プロセスを起動できないため、**スキーマの書き出し機能自体を
  持たないプロトタイプ/デモ用途に割り切る**（GitHub連携導入前の README の
  立て付けに回帰する）。実際の設計作業をしたいユーザーには、リポジトリを
  ローカルにインストールして CLI 経由で使うことを案内する。ホスティング版に
  簡易ダウンロードボタン等の代替エクスポート機能は追加しない。
- 「複数人がクラウド上で同時に設計する」ことはスコープに含めない
  （ローカル完結の方がシンプルで本ツールの性質に合うという判断）。
- CLI 自体は npm 公開せず、本リポジトリ内のローカルスクリプトとして提供する
  （`npm run sql-studio -- <path>`）。公開・バージョン管理の運用コストを
  避けるため。追加の起動手段として、リポジトリの clone や Node 環境構築なしで
  使えるよう **ローカル `docker build` した Docker イメージ**も提供する
  （Issue #31、`docker/sql-studio/Dockerfile`。レジストリ公開はしない）。
  既存の `npm run sql-studio` 経路は置き換えず維持し、Docker は上乗せの選択肢。
- アプリはファイルの書き込み/読み込みにのみ徹し、`git add`/`commit`/`push`
  は一切自動化しない。commit/push はユーザー自身の既存ワークフロー
  （VSCode/ターミナル）に委ねる。

## 2. 全体フロー

1. ユーザーがローカルでリポジトリを clone/インストール後、
   `npm run sql-studio -- schema/ddl.sql` のようなコマンドで起動する
   （`scripts/openLocal.mjs`）。
2. このスクリプトが Vite の JS API（`createServer()`）で dev サーバーを
   起動し、CLI引数で指定されたファイルパスに固定した
   ローカル専用API（3節）を注入する。`127.0.0.1` のみにバインドし、
   起動後に既定のブラウザで自動的に開く（失敗時はURLをコンソールに表示し、
   手動オープンを促す）。
3. ブラウザ側は起動時に `GET /api/schema` を叩き、内容が取得できれば
   （ローカルCLIモードとして動作していることの検知も兼ねる）、既存の
   SQL実行パイプラインへそのDDLを design モードでサイレントに（実行ログを
   表示せず）流し込み、キャンバスを復元する。ファイルが存在しない場合は
   エラーにせず空のキャンバスから開始する。
4. 「保存」操作は、`generateDdl()`（`src/pglite/ddlExport.ts`、GitHub非依存
   のため無改修で再利用）の出力を `POST /api/schema` に渡すだけで完結する。
   「再読み込み」操作は `GET /api/schema` の結果を通常モード（ログ表示あり）
   で design モードに流し込む。**ただし後述の起動時モードが `verify`
   （検証モード）の場合、「保存」操作は `POST /api/schema` ではなく
   `POST /api/schema/verify-save`（3節）を呼び、対象ファイルへは一切
   書き込まない。**「再読み込み」は verify モードでも通常通り対象ファイルを
   読み込む（読み取りは制限しない）。

### 2.1 起動時モード（Issue #32）

`npm run sql-studio -- <path>` は起動時に `--mode=author|verify` を指定
できる（未指定時は `author`）。既存の `AppMode`（`design`/`experiment`、
セッション内のDDL/DML実行権限ゲート）とは完全に独立した別軸であり、
命名衝突を避けるためこちらは `author`/`verify` と呼ぶ。

- **`author`（既定）**: 1〜4節で説明した既存の挙動そのまま。「保存」操作は
  対象ファイルへ無条件に上書き保存される。
- **`verify`**: 「既存スキーマを壊さずクエリを検証したいだけ」の起動を
  想定したモード。`GET /api/schema` による読み込みは通常通り行うが、
  対象ファイルへの書き込み（`POST /api/schema`）はUI側（Saveボタンの
  ラベル変更・ヘッダーバッジ表示）・サーバー側（`apiPlugin.ts` が403で
  拒否）の両方で禁止される（多重防御）。代わりに「保存」操作は
  `POST /api/schema/verify-save` を通じて、対象ファイルとは別の一時的な
  保存先（既定: OS一時ディレクトリ配下 `sql-viz-verify-saves/`。
  `--save-dir=<path>` で明示的に上書き可能。`--save-dir` は
  `--mode=verify` と併用時のみ有効）へ、元ファイル名＋タイムスタンプで
  自動生成したファイル名で書き出す。対象プロジェクトのマイグレーション
  用フォルダ等を汚染しないことが目的（ユーザーからのフィードバックに
  基づく設計判断）。この一時保存ファイルは、Reload や再起動時の自動読込
  対象には含まれない（読込経路は常にCLI起動時に固定された対象ファイル
  パスのまま）。

## 3. API仕様

ローカルCLIモードでのみ有効な、Vite dev サーバー上のミドルウェア。

- `GET /api/schema` → `{ content: string }`（ファイル不在時は `content: ""`、
  200で返す。エラー扱いにしない。`verify` モードでも制限されない）
- `POST /api/schema` + `{ content: string }` → ファイルを上書き保存し
  `{ ok: true }` を返す。失敗時は `{ ok: false, error: string }`（500）、
  リクエストボディが不正な場合は400を返す。**起動時モードが `verify` の
  場合は常に403 `{ ok: false, error: string }` を返し、書き込みを行わない。**
- `POST /api/schema/verify-save` + `{ content: string }`（Issue #32で追加）
  → 対象ファイルとは別に、サーバー側が構築時に固定した保存先ディレクトリ
  （2.1節）へ、サーバー側が生成したファイル名で新規保存し、
  `{ ok: true, path: string }`（実際に書き込んだ絶対パス）を返す。
  リクエストボディが不正な場合は400、書き込み失敗時は500。起動時モードに
  関わらず呼び出し自体は可能（対象ファイルへの書き込みではないため
  安全性上の制約はない）が、UIが実際にこのエンドポイントを呼ぶのは
  `verify` モード時のみ。

**ファイルパス・保存先ディレクトリ・生成ファイル名は、いずれもCLI起動時に
サーバー側で固定/生成され、リクエストパラメータとしては一切受け取らない。**
任意パス書き込み脆弱性を避けるための必須要件である。サーバーの
ネットワーク到達範囲（非Docker経路は `127.0.0.1` バインド、Docker経路は
ポート公開の指定に依存）については5節を参照。

`POST /api/schema`・`POST /api/schema/verify-save` はいずれも、実行時に
プレーンテキスト1行のログを`npm run sql-studio`のターミナルへ出力する
（Issue #38）。書き込み先の絶対パス・操作種別（通常保存/verify-save/
verifyモードでの拒否）・ISO8601タイムスタンプを含む。`GET /api/schema`は
ポーリングされうるためログ対象外。`npm run sql-studio -- <path> --quiet`で
この出力を抑制できる。

## 4. ホスティング版との違い

ローカルモードの検出は `VITE_LOCAL_FILE` というビルド時環境変数で行う
（`scripts/openLocal.mjs` が `createServer()` 呼び出し前にセットする）。
`npm run build`（Vercelのビルドコマンド）はこのスクリプトを経由しないため、
本番ビルドにはこのフラグが一切含まれず、ローカル同期UI（Save/Reloadボタン）
も本番ビルドには一切現れない。逆に言えば、ホスティング版は本機能導入前と
同じ「バックエンドや永続化を持たないクライアントのみのSPA」のままである
（`CLAUDE.md` 参照）。

## 5. セキュリティ考慮事項

- ファイルパスをCLI起動時の引数に限定し、リクエストから受け取らない
  （3節）。
- **非Docker経路（`npm run sql-studio`）**: サーバーを `127.0.0.1` のみに
  バインドし、LAN上の他ホストからアクセスできないようにする
  （`scripts/openLocal.mjs` の `spawnVite` が `host` を既定 `'127.0.0.1'` で固定）。
- **Docker経路（Issue #31）**: コンテナ内サーバーは `0.0.0.0` にバインドされる
  （`docker run -p` のポート公開を届かせるため。イメージの `SQL_STUDIO_HOST=0.0.0.0`）。
  したがってLAN到達不能性は、利用者が
  **`docker run -p 127.0.0.1:5173:5173`（`-p 5173:5173` ではなく）** と
  ループバック限定でポート公開することに委ねられる。誤って `-p 5173:5173` と
  すると `HostIp` が `0.0.0.0` になりLANから到達可能になる。詳細と検証手順は
  [docker/sql-studio/README.md](../docker/sql-studio/README.md) と
  [docs/issue31-docker-e2e-runbook.md](./issue31-docker-e2e-runbook.md) を参照。
- 保存対象はテーブル構造（DDL）のみであり、行データやPATのような機密情報を
  扱わない。旧方式で必要だった「PATの保存期間」等のセキュリティ考慮事項は
  本方式では発生しない（認証層自体が存在しない）。

## 6. 対象外

- 複数人がクラウド上で同時に設計する運用（1節）。
- ホスティング版（Vercel）への代替エクスポート機能の追加。
- `git add`/`commit`/`push` の自動化。
- クエリ例（`query-examples.md`）の永続化・昇格フロー（旧Issue #24で検討
  されたが、クエリ単体を永続化する必要性自体が低いと判断しクローズ済み）。
  なお、アプリ機能としてではなくエージェントの裁量による改修提案ドキュメント
  の書き出しについては、Issue #33 /
  [docs/agent-proposal-workflow-spec.md](./agent-proposal-workflow-spec.md)
  を参照（本節の対象外規定とは別の経路であり矛盾しない）。
- テーブル間のリレーション（外部キー）のモデル化・DDL出力（本機能導入前
  からのスコープ外）。

## 7. 参照

- [Issue #26](https://github.com/Yaeshio/SQL-Viz/issues/26)
- [Issue #31](https://github.com/Yaeshio/SQL-Viz/issues/31)（Docker 経由の起動手段）
- [Issue #38](https://github.com/Yaeshio/SQL-Viz/issues/38) — スキーマ保存
  操作のターミナルへのログ出力（`--quiet`で抑制可能）
- 実装詳細: [local-cli-sync-design.md](./local-cli-sync-design.md)
- Docker イメージ: [docker/sql-studio/README.md](../docker/sql-studio/README.md)、
  E2E 検証手順書: [docs/issue31-docker-e2e-runbook.md](./issue31-docker-e2e-runbook.md)
- 旧仕様（廃止・リポジトリ履歴のみ）: `docs/github-sync-spec.md`,
  `docs/github-sync-design.md`
