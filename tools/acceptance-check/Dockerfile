# フェーズ単位の受け入れテストハーネス（自動pass/fail判定）。tools/visual-check
# （エージェント目視確認専用）とは別ツールで、npm test・CIには組み込まれていない。
# 公式イメージにChromium等と必要なOS依存・フォント（日本語含む）が事前installされて
# いるため、ホスト側にroot権限での依存インストールが一切不要になる（tools/visual-check
# と同じ理由・同じ方式）。
# タグは package.json の "playwright" バージョンと必ず一致させること。
FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY run.mjs ./
COPY scenarios/ ./scenarios/

ENTRYPOINT ["node", "run.mjs"]
