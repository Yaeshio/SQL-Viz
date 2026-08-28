# sql-studio Docker イメージ

`npm run sql-studio -- <path>`（[docs/local-cli-sync-spec.md](../../docs/local-cli-sync-spec.md)、
Issue #26/#32）を、SQL-Viz リポジトリの clone や Node 環境構築なしで使うための
**追加の**起動手段（Issue #31）。既存の `npm run sql-studio` 経路は置き換えず維持される。

- レジストリ（GHCR 等）へは公開しない。各マシンでローカル `docker build` する。
- `npm test`・CI には組み込まない（[tools/visual-check](../../tools/visual-check/README.md)・
  [tools/acceptance-check](../../tools/acceptance-check/README.md) と同じ方針）。

## ビルド

ビルドコンテキストはリポジトリルート（`src/`・`vite.config.ts` 等一式が必要）:

```bash
docker build -f docker/sql-studio/Dockerfile -t sql-studio .
```

## 起動

```bash
docker run --rm \
  -p 127.0.0.1:5173:5173 \
  -v "$(pwd):/workspace" \
  --user "$(id -u):$(id -g)" \
  sql-studio /workspace/db/schema.sql
```

ブラウザで `http://127.0.0.1:5173/` を開く（コンテナ内には `xdg-open` が無いため
自動オープンはされず、起動ログに URL が表示される）。

### `--mode=verify`（検証モード）

```bash
mkdir -p verify-saves
docker run --rm \
  -p 127.0.0.1:5173:5173 \
  -v "$(pwd):/workspace" \
  --user "$(id -u):$(id -g)" \
  sql-studio /workspace/db/schema.sql --mode=verify --save-dir=/workspace/verify-saves
```

## オプションの注意点

| 指定 | 理由 |
|---|---|
| `-p 127.0.0.1:5173:5173` | **`-p 5173:5173` にしないこと。** コンテナ内のサーバーは `0.0.0.0` にバインドされる（`docker run -p` を届かせるため）。LAN の他ホストから到達不能にする責任は、この `127.0.0.1:` プレフィックス付きポート公開に移っている（[docs/local-cli-sync-spec.md](../../docs/local-cli-sync-spec.md) §5）。 |
| `-v "$(pwd):/workspace"` | スキーマファイルを含むディレクトリを bind mount する。Save/Reload はこのマウント先の実ファイルに対して行われる。 |
| スキーマパスは**コンテナ内の絶対パス** | `docker run ... sql-studio /workspace/db/schema.sql` のように渡す。相対パスはコンテナの `WORKDIR`（`/app`）基準に解決されてしまう。親ディレクトリが無くても Save 時に `mkdir -p` される。 |
| `--user "$(id -u):$(id -g)"` | Linux ホストで、Save が書き出すファイルが root 所有になるのを防ぐ。イメージは固定 UID を持たず、実行時オプションで対応する。 |

## エージェント向けクエリ API/CLI（Issue #27）

`-p 127.0.0.1:5173:5173` で公開すれば、ホストから通常どおり使える:

```bash
node scripts/query.mjs "SELECT 1" --url=http://127.0.0.1:5173
curl -s http://127.0.0.1:5173/api/query/health
```

起動ログには常に改修提案ドキュメントの書き方
（[docs/agent-proposal-workflow-spec.md](../../docs/agent-proposal-workflow-spec.md)）
への URL が印字される。

## 環境変数

`docker/sql-studio/Dockerfile` が設定し、`scripts/openLocal.mjs` の `main()` が読む
（いずれも `VITE_` プレフィックスなし = ブラウザバンドルには載らない）:

| 変数 | 既定（イメージ） | 用途 |
|---|---|---|
| `SQL_STUDIO_HOST` | `0.0.0.0` | Vite dev サーバーのバインド先。非 Docker 経路では未設定 → `127.0.0.1`。 |
| `SQL_STUDIO_CACHE_DIR` | `/tmp/sql-viz-vite-cache` | Vite の依存事前バンドルキャッシュ先。`--user` で非 root 実行しても書けるよう `/tmp` 配下へ逃がす。非 Docker 経路では未設定 → Vite 既定（`node_modules/.vite`）。 |

## E2E 検証

このイメージの受け入れ確認手順は
[docs/issue31-docker-e2e-runbook.md](../../docs/issue31-docker-e2e-runbook.md)
（CLI エージェントがそのまま実行できる粒度の手順書）にある。
