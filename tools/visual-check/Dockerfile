# エージェント目視確認専用ツール（Issue #13）。テストスイートではない。
# 公式イメージにChromium/Firefox/WebKitと必要なOS依存・フォント（日本語含む）が
# 事前installされているため、ホスト側にroot権限での依存インストールが一切不要になる。
# タグは package.json の "playwright" バージョンと必ず一致させること。
FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY check.mjs ./

ENTRYPOINT ["node", "check.mjs"]
