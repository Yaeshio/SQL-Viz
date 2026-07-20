---
description: 開発サーバのUIをPlaywright(Docker)経由で実際に操作し、スクリーンショットで目視確認する
---

Issue #13 に基づき整備した `tools/visual-check/`（[README](../../tools/visual-check/README.md)参照）
を使って、実装結果を実際の画面で確認する。**これはE2Eテストではなく、目視確認専用ツール。**

引数 `$ARGUMENTS` は `check.mjs` にそのまま渡すオプション（例: `--wait-for "text=Run SQL" --click "text=Run SQL"`）。

## 手順

1. `npm run dev` が起動していなければバックグラウンドで起動し、準備できるまで待つ。
2. `docker build -t sql-viz-visual-check tools/visual-check`（キャッシュされていれば高速）。
3. `mkdir -p tools/visual-check/out` した上で以下を実行する：
   ```bash
   docker run --rm -v "$(pwd)/tools/visual-check/out:/app/out" sql-viz-visual-check \
     --url http://host.docker.internal:5173 \
     --out /app/out/screenshot.png \
     $ARGUMENTS
   ```
4. 標準出力のJSON（`ok`/`consoleErrors`）を確認し、`consoleErrors` が空でなければ内容を報告する。
5. `Read` ツールで `tools/visual-check/out/screenshot.png` を開き、実際の画面を目視確認する。
