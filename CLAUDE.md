# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## コマンド

- `npm install` — 依存関係のインストール
- `npm run dev` — Vite の開発サーバーを起動（デフォルトは `http://localhost:5173`）
- `npm run build` — 本番用ビルド（`vite build`）
- `npm run preview` — 本番ビルドのプレビュー
- `npm run lint` — プロジェクト全体への ESLint 実行
- `npm run typecheck` — `tsc --noEmit -p tsconfig.app.json`

テストフレームワークは設定されていない（`test` スクリプトも Jest/Vitest 等の
依存関係も無い）。利用可能な静的チェックは `typecheck` と `lint` のみ。

## アーキテクチャ

本プロジェクトはバックエンドや永続化を持たないクライアントのみの
シングルページアプリで、テキストエリアに入力された SQL をパースし、
インメモリのおもちゃのデータベースへの影響をアニメーションで見せる。
すべて `src/` 直下にフラットに配置されている（サブフォルダ無し）。

**ドメインモデル** — `types.ts` が唯一の情報源（single source of truth）。
`Table`（name、`Column[]`、`Row[]`、グリッド上の `x`/`y`）、`DBState`
（`tables` レコード、レイアウト/反復順を保持する `order` 配列、
`lastSelect`、`version` カウンタ）、`AnimationEvent`（`table_appear`,
`row_add`, `row_filter`, `row_unfilter`, `select_highlight`）。

**パース → 適用 → レイアウト → 差分 → アニメーション のパイプライン**
（`App.tsx` の `run()` が駆動し、SQL 文ごとに1回、順番に実行される）：
1. `parser.ts` — `parseSql()` が `node-sql-parser` で AST を生成し、
   `ParsedCreate` / `ParsedInsert` / `ParsedSelect` のいずれかに絞り込む。
   それ以外の文種はすべてパースエラー（`Unsupported statement type`）に
   なる。`SELECT` は単一の `WHERE <col> <op> <value>` 比較のみ対応
   （`AND`/`OR`、`JOIN`、`UPDATE`/`DELETE` は非対応）。
2. `reducer.ts` — 純粋関数（`applyCreateTable`, `applyInsert`,
   `applySelect`）が現在の `DBState` を受け取り `{ state, error? }` を
   返す。状態を直接書き換えることはなく、変更前に `cloneState` が
   テーブル/行をディープコピーする。`applySelect` は該当行を配列から
   除外するのではなく、行ごとの `filteredOut` フラグを反転させるだけ
   ——これにより、キャンバス側で行を「即座に消す」のではなく
   「フェードアウトさせる」アニメーションが可能になっている。
3. `layout.ts` — `layoutTables()` が、キャンバスの現在のピクセル幅を
   基準に各テーブルへグリッド状の `x`/`y` を割り当てる（収まらなければ
   次の行に折り返す）。
4. `diff.ts` — `diffStates(old, next)` が変更前後の `DBState` を比較し、
   順序付きの `AnimationEvent[]` を生成する（新規テーブル → 新規行 →
   フィルタ/解除の変化 → SELECT ハイライトの順）。アニメーションを
   駆動しているのはこの差分であり、状態遷移自体は即時かつ純粋である。
5. `App.tsx` の `playEvents()` がこのイベント列を順に処理し、
   `appearingRows` / `filteringRows` / `highlight` という React の
   state を更新しながら `await delay(ms)` を挟んでアニメーションの
   タイムラインを構築し、完了後に次の文へ進む。

**描画** — `Canvas.tsx` は各テーブルを `framer-motion`
（`motion.g`, `AnimatePresence`）を使った SVG の `<g>` として描画し、
`App` から渡される `appearingRows` / `filteringRows` / `highlight` の
props に応じてアニメーションする。`TableNode` は `layout.ts` の定数
（`HEADER_H`, `ROW_H`, `TABLE_W`, `COL_GAP`）を使い、各列/行の
y オフセットとテーブル全体の高さを自前で計算している。

SQL の対応範囲を広げる場合（例：`UPDATE`、`JOIN`、複合 `WHERE` など）、
通常は `parser.ts`（AST → `Parsed*` 型への変換）、`reducer.ts`
（適用ロジック）、そして新しいアニメーションイベントが必要であれば
`diff.ts`/`Canvas.tsx` にまたがって変更することになる。

`@supabase/supabase-js` は依存関係として存在するが、現時点では
`src/` 内のどこからも利用されていない。

## デザインの方針

プロジェクトの元々のスキャフォールディング用プロンプト（`.bolt/prompt`）より：
- Tailwind CSS のクラスとアイコンには `lucide-react` を使うこと
  （`App.tsx`/`Canvas.tsx` で既に一貫して使われている）。
- 明確な必要性がない限り、新たな UI/テーマ/アイコン系パッケージを
  追加しないこと。
- ありきたり（cookie-cutter）ではなく、洗練された・プロダクション
  品質の UI を目指すこと。
