# visual-check（エージェント目視確認用ツール）

Issue #13 に基づき整備。**これはE2Eテストスイートではない。** `npm test` からは
呼び出されず、CIにも組み込まれていない。あくまでエージェント（Claude Code）が
`npm run dev` で起動した開発サーバのUIを実際に操作し、実装結果をスクリーンショットで
目視確認するための補助ツールである（`docs/smoke-test-spec.md` 3節でE2Eテストの導入は
見送るとした既存の決定と矛盾しない）。

## なぜDockerか

Playwrightのブラウザ本体はroot権限なしでダウンロードできるが、Chromiumの起動には
`libnss3`/`libnspr4`等のOS共有ライブラリが必要で、通常はroot権限（`apt-get install`）での
インストールが要る。本リポジトリの [.claude/settings.json](../../.claude/settings.json) は
`sudo` を恒久的に禁止しているため、過去のエージェントはこの環境整備に毎回失敗していた
（詳細はIssue #13参照）。

公式Dockerイメージ `mcr.microsoft.com/playwright` にはブラウザ本体・OS依存・
（日本語含む）フォントがすべて事前installされているため、**ホスト環境（このWSL
ディストリビューション）を一切汚染せずに**Playwrightを動かせる。

## 前提条件

- Docker Desktop がインストールされ、このWSLディストリビューションでWSL Integrationが
  有効化されていること（`docker version` が成功すること）。

## 使い方

```bash
# 1. 開発サーバを起動（別ターミナル or バックグラウンド）
npm run dev

# 2. イメージをビルド（初回のみ、以降はキャッシュされる）
docker build -t sql-viz-visual-check tools/visual-check

# 3. 実行（スクリーンショットはホスト側 tools/visual-check/out/ に出力される）
mkdir -p tools/visual-check/out
docker run --rm -v "$(pwd)/tools/visual-check/out:/app/out" sql-viz-visual-check \
  --url http://host.docker.internal:5173 \
  --wait-for "text=Run SQL" \
  --click "text=Run SQL" \
  --out /app/out/screenshot.png
```

標準出力に `{"ok": true, "consoleErrors": [...], "screenshot": "..."}` 形式のJSONが
出力される。`tools/visual-check/out/screenshot.png` を開いて実際の画面を確認する。

## CLIオプション（`check.mjs`）

| オプション | 既定値 | 説明 |
|---|---|---|
| `--url` | `http://host.docker.internal:5173` | Docker Desktopでは追加設定なしでホスト側の開発サーバに到達できる |
| `--out` | `/app/out/screenshot.png` | スクリーンショット出力パス（コンテナ内パス。ホストに見るには `-v` でマウントすること） |
| `--wait-for` | なし | スクリーンショット前に待機するセレクタ（Playwrightのセレクタ構文、例: `text=Run SQL`） |
| `--click` | なし | スクリーンショット前にクリックするセレクタ |
| `--full-page` | `false` | フルページスクリーンショットにするか |
| `--timeout` | `10000` | 各操作のタイムアウト（ミリ秒） |

## バージョン管理上の注意

`package.json` の `playwright` バージョンと `Dockerfile` のベースイメージタグ
（`v<version>-noble`）は必ず一致させること。ずれるとブラウザ起動時にバージョン不一致
エラーになる。
