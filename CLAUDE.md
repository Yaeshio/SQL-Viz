# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## コマンド

- `npm install` — 依存関係のインストール
- `npm run dev` — Vite の開発サーバーを起動（デフォルトは `http://localhost:5173`）
- `npm run build` — 本番用ビルド（`vite build`）
- `npm run preview` — 本番ビルドのプレビュー
- `npm run lint` — プロジェクト全体への ESLint 実行
- `npm run typecheck` — `tsc --noEmit -p tsconfig.app.json`
- `npm test` — `vitest run`（`tests/**/*.test.ts` を実行）
- `npm run test:watch` — `vitest`（watch モード）

テストフレームワークは Vitest（`vitest.config.ts`）。テストは `tests/`
配下にフラット配置され、`src/` 直下の純粋ロジック層を相対パスで直接
import する。

## アーキテクチャ

本プロジェクトはバックエンドや永続化を持たないクライアントのみの
シングルページアプリで、テキストエリアに入力された SQL を
[PGlite](https://pglite.dev/)（WebAssembly にコンパイルされた本物の
PostgreSQL）に対してブラウザ内で実際に実行し、その DB 状態への影響を
アニメーションで見せる（Issue #8 で PGlite を導入。それ以前は手書きの
JS ロジックで DB 状態を模していた）。

SQLパイプラインの純粋ロジック層（`types.ts`/`parser.ts`/`reducer.ts`/
`layout.ts`/`diff.ts`）は `src/` 直下にフラット配置（`tests/`
配下のテストが相対パスで直接importするため）。旧 `runner.ts` は Issue #8
（PGlite導入）で削除され、新設の `src/pglite/`（`engine.ts`,
`splitStatements.ts`）がその役割を引き継いでいる——これはフラット配置の
意図的な例外で、PGlite 実行エンジン関連のコードをひとまとめにしている。
UI層は責務ごとに以下へ分割されている（Issue #4 のリファクタリングによる）：

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

**文分割 → 事前検証 → 実行(PGlite) → スナップショット再構築 → レイアウト →
差分 → アニメーション のパイプライン**（`hooks/useSqlRunner.ts` の `run()`
が `pglite/engine.ts` の `PgEngine.run()` を呼び出して駆動し、SQL 文ごとに
1回、順番に実行される）：
1. `pglite/splitStatements.ts` — `splitStatements()` がクォート／コメント
   を考慮しつつ、セミコロン区切りの生 SQL 文字列を1文ずつに分割する。
2. `parser.ts` — `parseSql()` が `node-sql-parser` で AST を生成し、
   `ParsedCreate` / `ParsedInsert` / `ParsedSelect` のいずれかに絞り込む
   「事前検証ゲート」。それ以外の文種はすべてパースエラー
   （`Unsupported statement type`）になる。`SELECT` は単一の
   `WHERE <col> <op> <value>` 比較のみ対応（`AND`/`OR`、`JOIN`、
   `UPDATE`/`DELETE` は非対応）。**ゲートを通過した文を実際に実行する
   のは PGlite であり、`parser.ts` 自身は `DBState` を生成しない。**
3. `PgEngine.run()`（`pglite/engine.ts`）— ゲートを通過した生の SQL 文字列
   を `db.query()` でそのままブラウザ内の PGlite（実 PostgreSQL/WASM）に
   対して実行する。型不一致・制約違反・`WHERE` 評価は本物の Postgres の
   挙動そのものであり、失敗時は Postgres のネイティブなエラー文言
   （例: `relation "ghost" does not exist`）がそのまま UI に出る。
4. `PgEngine.snapshotAfter()`（同ファイル）— PGlite へクエリし直して
   `DBState` を再構築する。旧 `reducer.ts` の `applyCreateTable` /
   `applyInsert` / `applySelect` はこの一部として置き換えられ、
   `reducer.ts` 自体は `emptyState` / `cloneState` / `normalizeType`
   というヘルパー関数のみが残っている（`cloneState` は変更前にテーブル/
   行をディープコピーする用途で `snapshotAfter()` から呼ばれる）。
   テーブルごとの `ctid → 安定行ID` のマップを保持することで、Postgres
   の物理的な `ctid` が変わっても文をまたいだ行の同一性を維持する。
   `SELECT` の場合は該当行を配列から除外するのではなく、PGlite へ
   `WHERE` 相当のクエリを投げて一致した `ctid` の集合を取得し、行ごとの
   `filteredOut` フラグを反転させるだけ——これにより、キャンバス側で
   行を「即座に消す」のではなく「フェードアウトさせる」アニメーションが
   可能になっている（この設計意図自体は PGlite 導入前後で変わっていない）。
5. `layout.ts` — `layoutTables()` が、キャンバスの現在のピクセル幅を
   基準に各テーブルへグリッド状の `x`/`y` を割り当てる（収まらなければ
   次の行に折り返す）。PGlite 導入による変更なし。
6. `diff.ts` — `diffStates(old, next)` が変更前後の `DBState` を比較し、
   順序付きの `AnimationEvent[]` を生成する（新規テーブル → 新規行 →
   フィルタ/解除の変化 → SELECT ハイライトの順）。アニメーションを
   駆動しているのはこの差分であり、状態遷移自体は即時かつ純粋である。
   PGlite 導入による変更なし。
7. `hooks/useSqlRunner.ts` の `run()` が文ごとに
   `hooks/useAnimationPlayer.ts` の `playEvents()` を呼び出す。
   `playEvents()` はこのイベント列を順に処理し、`appearingRows` /
   `filteringRows` / `highlight` という React の state を更新しながら
   `await delay(ms)` を挟んでアニメーションのタイムラインを構築し、
   完了後に次の文へ進む。PGlite 導入による変更なし。ただし
   `useSqlRunner.ts` は `PgEngine` のインスタンスを `useRef` で1つだけ
   保持し続けるようになり、初回実行時は `engine.ensureReady()`
   （`import('@electric-sql/pglite')` による遅延ロード → `new PGlite()`
   → `await db.waitReady`）を待つ間 `initializing` state が `true` になる
   （Run ボタン無効化・「エンジン読込中…」表示、
   `components/sql-editor/SqlEditorPane.tsx`）。`engine.reset()` は
   PGlite インスタンスを破棄するため、次回実行時に再度コールドスタート
   が発生する。

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
通常は `parser.ts`（許可リストの拡張）、`pglite/engine.ts`
（`snapshotAfter()` の文種別ロジック）、そして新しいアニメーションイベント
が必要であれば `diff.ts`/`components/canvas/` にまたがって変更することに
なる。

ビルド／テスト設定面の補足：`vite.config.ts` は `@electric-sql/pglite` を
`optimizeDeps.exclude` に指定している（WASM/ワーカーアセットを Vite の
依存事前バンドル対象から除外するため）。`vitest.config.ts` は
`testTimeout: 30000` を設定している（各テストが実際に PGlite インスタンス
を起動するため、純粋な JS ロジックのみのテストより低速になる）。

`@supabase/supabase-js` は依存関係として存在するが、現時点では
`src/` 内のどこからも利用されていない。

ルーティング（AppRouter構成）は Issue #4 で検討したが導入を見送った。
理由・再検討条件は [docs/routing-decision.md](docs/routing-decision.md)
を参照。

## CI/CD

`main` 向け PR と `main` への push を対象に、GitHub Actions
（[.github/workflows/ci.yml](.github/workflows/ci.yml)）が
`typecheck` / `lint` / `test` / `build` を実行する（E2E 等の重量級テストは
対象外、Issue #10）。`main` には branch protection rule が設定されており、
この CI（job: `build-and-check`）が成功しないとマージできない。

デプロイ（CD）は GitHub Actions では行わず、Vercel のネイティブ Git 連携に
委ねている（PR ごとの Preview Deployment、`main` マージ時の Production
Deployment はいずれも Vercel 側が自動で行う）。

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
