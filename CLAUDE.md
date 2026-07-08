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

SQLパイプラインの純粋ロジック層（`types.ts`/`parser.ts`/`reducer.ts`/
`layout.ts`/`diff.ts`/`runner.ts`）は `src/` 直下にフラット配置（`tests/`
配下のテストが相対パスで直接importするため）。UI層は責務ごとに以下へ
分割されている（Issue #4 のリファクタリングによる）：

- `src/hooks/` — 状態管理・副作用（`useSqlRunner`, `useAnimationPlayer`）
- `src/components/` — プレゼンテーション（JSX/Tailwind）。`layout/`（画面
  全体のレイアウト部品）、`sql-editor/`（SQLエディタペイン）、`canvas/`
  （キャンバス描画）に領域ごとのサブフォルダを持つ
- `src/lib/` — ビュー層専用の純粋計算（`canvasLayout.ts`）
- `src/constants/` — 静的データ（サンプルSQL文字列など）

`App.tsx` は `main.tsx` から直接マウントされるエントリ/構成ルートとして
`src/` 直下に残り、上記フックとコンポーネントを呼び出すだけの薄い
コンポーネントになっている。

**ドメインモデル** — `types.ts` が唯一の情報源（single source of truth）。
`Table`（name、`Column[]`、`Row[]`、グリッド上の `x`/`y`）、`DBState`
（`tables` レコード、レイアウト/反復順を保持する `order` 配列、
`lastSelect`、`version` カウンタ）、`AnimationEvent`（`table_appear`,
`row_add`, `row_filter`, `row_unfilter`, `select_highlight`）。

**パース → 適用 → レイアウト → 差分 → アニメーション のパイプライン**
（`hooks/useSqlRunner.ts` の `run()` が駆動し、SQL 文ごとに1回、順番に
実行される）：
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
5. `hooks/useSqlRunner.ts` の `run()` が文ごとに
   `hooks/useAnimationPlayer.ts` の `playEvents()` を呼び出す。
   `playEvents()` はこのイベント列を順に処理し、`appearingRows` /
   `filteringRows` / `highlight` という React の state を更新しながら
   `await delay(ms)` を挟んでアニメーションのタイムラインを構築し、
   完了後に次の文へ進む。

**描画** — `components/canvas/Canvas.tsx` は各テーブルを
`components/canvas/TableNode.tsx` として、`framer-motion`
（`motion.g`, `AnimatePresence`）を使った SVG の `<g>` で描画し、
データ行1件分は `components/canvas/TableRow.tsx` に切り出されている。
`App` から渡される `appearingRows` / `filteringRows` / `highlight` の
props に応じてアニメーションする。テーブルカード内部の列/行の y オフ
セット・セル文字列の切り詰め・SVG viewBox の計算は `lib/canvasLayout.ts`
（`layout.ts` とは別の、テーブル**内部**描画専用の純粋関数群）が担う。
`layout.ts` は引き続きテーブル**同士**のグリッド配置（`TABLE_W`,
`HEADER_H`, `ROW_H`, `COL_GAP` 等の定数を含む）専用。

SQL の対応範囲を広げる場合（例：`UPDATE`、`JOIN`、複合 `WHERE` など）、
通常は `parser.ts`（AST → `Parsed*` 型への変換）、`reducer.ts`
（適用ロジック）、そして新しいアニメーションイベントが必要であれば
`diff.ts`/`components/canvas/` にまたがって変更することになる。

`@supabase/supabase-js` は依存関係として存在するが、現時点では
`src/` 内のどこからも利用されていない。

ルーティング（AppRouter構成）は Issue #4 で検討したが導入を見送った。
理由・再検討条件は [docs/routing-decision.md](docs/routing-decision.md)
を参照。

## Git / GitHub 運用上の注意

本リポジトリは **Public** かつ GitHub CLI（`gh`）で認証済みの状態で作業される。
以下の破壊的・不可逆な操作は、ユーザーからの明示的な指示がない限り実行しない：

- `git push --force` / `--force-with-lease`（特に `main` ブランチへの force push）
- `git reset --hard`、`git clean -f`、`git checkout -- .` / `git restore .`
- コミット済み（特にpush済み）のコミットの `git commit --amend`
- ブランチの削除（`git branch -D` 等）
- `gh repo delete`、`gh repo edit --visibility`（公開範囲の変更）
- Issue/PRのクローズや削除、他者のコメントの編集・削除
- `--no-verify` によるフック無視、`--no-gpg-sign` 等の署名回避

`git push`、`gh pr create`、`gh issue create` はリポジトリが Public であるため
即座に一般公開される。実行前に差分・内容を確認し、意図しないファイル
（例：ルート直下に生成されがちな検証用スクリプト）が含まれていないか
チェックすること。

## デザインの方針

プロジェクトの元々のスキャフォールディング用プロンプト（`.bolt/prompt`）より：
- Tailwind CSS のクラスとアイコンには `lucide-react` を使うこと
  （`App.tsx` および `src/components/` 配下で既に一貫して使われている）。
- 明確な必要性がない限り、新たな UI/テーマ/アイコン系パッケージを
  追加しないこと。
- ありきたり（cookie-cutter）ではなく、洗練された・プロダクション
  品質の UI を目指すこと。
