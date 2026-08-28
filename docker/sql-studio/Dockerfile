# `npm run sql-studio` と同一エントリ（scripts/openLocal.mjs）を、任意プロジェクトの
# スキーマファイルに対してコンテナから起動するためのイメージ（Issue #31）。
#
# tools/visual-check・tools/acceptance-check と同じ方針で、npm test・CI には
# 組み込まない（手動ビルド・手動実行のみ）。使い方は同ディレクトリの README.md を参照。
#
# このCLIは `vite build` 済みの静的成果物ではなく Vite dev サーバー（createServer の
# JS API）をそのまま実行するため、src/・vite.config.ts・各種 config 一式がビルド時に
# 必要で、vite/typescript/tailwindcss 等 devDependencies も実行時に必須。
# → `npm ci --omit=dev` や `NODE_ENV=production` にしないこと（`Cannot find module
#   'vite'` で壊れる）。
#
# ベースは node:24-slim（.github/workflows/ci.yml の node-version、および
# local-cli-sync-design.md §2 が「動作確認済み」とする開発環境と一致させる）。
# node:22-slim だと同梱の npm 10.9.x が package-lock.json の解決に失敗する
# （`npm ci` が vitest 4 系の esbuild を "Missing from lock file" と誤判定する）。
# engines.node（package.json）の最小要件は ">=22.6"（型ストリッピング）で、
# node:24 はこれを満たす。
FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# `docker run --user "$(id -u):$(id -g)"`（bind mount ファイルをホストユーザー所有に
# 保つための推奨オプション）は任意 UID での実行になるため、プロセスが書き込む場所を
# すべて誰でも書き込み可能にしておく必要がある。書き込み先は2箇所だけ:
#   1) Vite が TS/ESM 版 vite.config を esbuild でバンドルする際に生成する一時ファイル
#      `vite.config.ts.timestamp-*.mjs`（設定ファイルと同じディレクトリ = /app 直下）。
#      → /app ディレクトリ自体を world-writable にする（配下のソース/node_modules は
#        root 所有・読み取り専用のまま）。
#   2) Vite の依存事前バンドルキャッシュ（既定は root 所有の node_modules/.vite）。
#      → world-writable な /tmp 配下へ逃がす（main() が SQL_STUDIO_CACHE_DIR を読む）。
RUN chmod 777 /app
ENV SQL_STUDIO_CACHE_DIR=/tmp/sql-viz-vite-cache

# コンテナ外（docker run -p）から到達可能にするため 0.0.0.0 にバインドする
# （非 Docker 経路の既定は 127.0.0.1 のまま）。LAN からの到達可否は、利用者が
# `docker run -p 127.0.0.1:5173:5173`（`-p 5173:5173` ではなく）を指定することに
# 委ねられる —— docs/local-cli-sync-spec.md §5 参照。
ENV SQL_STUDIO_HOST=0.0.0.0
EXPOSE 5173

# スキーマファイルのパスは `docker run ... sql-studio /workspace/db/schema.sql` の
# ように起動時引数で渡す（CMD で既定値を持たせない）。
ENTRYPOINT ["node", "scripts/openLocal.mjs"]
