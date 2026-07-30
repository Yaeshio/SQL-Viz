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

- `src/hooks/` — 状態管理・副作用（`useSqlRunner`, `useAnimationPlayer`,
  `useAppMode`）
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
`table_remove`, `column_add`, `column_drop`, `row_add`, `row_remove`,
`row_update`, `row_filter`, `row_unfilter`, `select_highlight`）、
`AppMode`（`'design' | 'experiment'`。Issue #18 M3、次段落参照）。

**文分割 → 事前検証 → モードゲート → 実行(PGlite) → スナップショット再構築 →
レイアウト → 差分 → アニメーション のパイプライン**（`hooks/useSqlRunner.ts`
の `run()` が `pglite/engine.ts` の `PgEngine.run()` を呼び出して駆動し、SQL
文ごとに1回、順番に実行される）：
1. `pglite/splitStatements.ts` — `splitStatements()` がクォート／コメント
   を考慮しつつ、セミコロン区切りの生 SQL 文字列を1文ずつに分割する。
2. `parser.ts` — `parseSql()` が `node-sql-parser` で AST を生成し、
   `ParsedCreate` / `ParsedInsert` / `ParsedSelect` / `ParsedAlter`
   （`ADD COLUMN`/`DROP COLUMN` の単一アクションのみ）/ `ParsedDrop` /
   `ParsedUpdate` / `ParsedDelete` のいずれかに絞り込む「事前検証ゲート」。
   それ以外の文種・構文はすべてパースエラー（`Unsupported statement type`
   / `Unsupported clause`）になる。`SELECT`/`UPDATE`/`DELETE` の `WHERE` は
   単一の `<col> <op> <value>` 比較のみ対応（`AND`/`OR`、`JOIN` は非対応）。
   **ゲートを通過した文を実際に実行するのは PGlite であり、`parser.ts`
   自身は `DBState` を生成しない。**
3. `pglite/engine.ts` の `MODE_ALLOWED_TYPES` によるモードゲート（Issue #18
   M3）— `parser.ts` の構文ゲートとは独立した別レイヤーで、`design`
   モードでは `create`/`alter`/`drop`、`experiment` モードでは
   `select`/`insert`/`update`/`delete` のみを許可する。パース済みの全文が
   対象で、1文でも現在のモードで許可されていなければ、どの文も実行せず
   `parseError` を返す（構文エラー時と同じ all-or-nothing の挙動）。
4. `PgEngine.run()`（`pglite/engine.ts`）— ゲートを通過した生の SQL 文字列
   を `db.query()` でそのままブラウザ内の PGlite（実 PostgreSQL/WASM）に
   対して実行する。型不一致・制約違反・`WHERE` 評価は本物の Postgres の
   挙動そのものであり、失敗時は Postgres のネイティブなエラー文言
   （例: `relation "ghost" does not exist`）がそのまま UI に出る。
   `experiment` モードの最初の文実行時に `BEGIN` を遅延発行し、以降の
   `experiment` モード中の全文（複数回のRunをまたいでも）を同一の
   未コミットトランザクションに乗せる。
5. `PgEngine.snapshotAfter()`（同ファイル）— PGlite へクエリし直して
   `DBState` を再構築する。`create`/`insert`/`select` に加え、`alter`
   （`ADD COLUMN`/`DROP COLUMN`）・`drop`・`update`・`delete` の分岐も
   持つ（Issue #18 M1）。旧 `reducer.ts` の `applyCreateTable` /
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
6. `PgEngine.returnToDesign()`（同ファイル、Issue #18 M3）— `experiment`
   モードから `design` モードへ復帰する際に呼ばれ、`ROLLBACK` で
   `experiment` モード中の `INSERT`/`UPDATE`/`DELETE` をまとめて取り消す
   （テーブル構造自体は `design` モードでしか変更できないため影響しない）。
   `ROLLBACK` はDB側の物理行のみを戻すため、`ctidMap`/`lastState`/
   `rowSeq` は `experiment` モードに入る直前にアプリ側でスナップショット
   （`DesignCheckpoint`）しておき、ここで一緒に復元する。行データは
   `experiment` モードでしか作れずモード復帰のたびに必ずロールバックされる
   ため、行データがモード遷移をまたいで永続化される経路はスコープ上
   存在しない（永続化されるのはテーブル構造のみ）。
7. `layout.ts` — `layoutTables()` が、キャンバスの現在のピクセル幅を
   基準に各テーブルへグリッド状の `x`/`y` を割り当てる（収まらなければ
   次の行に折り返す）。PGlite 導入による変更なし。
8. `diff.ts` — `diffStates(old, next)` が変更前後の `DBState` を比較し、
   順序付きの `AnimationEvent[]` を生成する（新規テーブル → 削除テーブル
   → カラム追加/削除 → 新規行 → 削除行 → 値更新 → フィルタ/解除の変化 →
   SELECT ハイライトの順）。アニメーションを駆動しているのはこの差分で
   あり、状態遷移自体は即時かつ純粋である。
9. `hooks/useSqlRunner.ts` の `run()` が文ごとに
   `hooks/useAnimationPlayer.ts` の `playEvents()` を呼び出す。
   `playEvents()` はこのイベント列を順に処理し、`appearingRows` /
   `filteringRows` / `updatingRows` / `appearingColumns` / `highlight` と
   いう React の state を更新しながら `await delay(ms)` を挟んで
   アニメーションのタイムラインを構築し、完了後に次の文へ進む
   （`table_remove`/`row_remove`/`column_drop` は `framer-motion` の
   `AnimatePresence` によるアンマウント時の退場アニメーションに任せる
   ため、専用のstateを持たない）。`useSqlRunner.ts` は `PgEngine` の
   インスタンスを `useRef` で1つだけ保持し続け、初回実行時は
   `engine.ensureReady()`（`import('@electric-sql/pglite')` による遅延
   ロード → `new PGlite()` → `await db.waitReady`）を待つ間
   `initializing` state が `true` になる（Run ボタン無効化・
   「エンジン読込中…」表示、`components/sql-editor/SqlEditorPane.tsx`）。
   `engine.reset()` は PGlite インスタンスを破棄するため、次回実行時に
   再度コールドスタートが発生する。`useSqlRunner(initialSql, mode)` は
   `mode: AppMode`（`hooks/useAppMode.ts`、`App.tsx` が所有）を引数に取り、
   毎回の `PgEngine.run()` 呼び出しに転送する。`experiment → design` への
   遷移を検出する内部 `useEffect` が `PgEngine.returnToDesign()` を呼び、
   その差分を通常のアニメーションとして再生する（`modeTransitioning`
   stateがこの間 `true` になり、Run ボタンと `ModeToggle` を無効化する）。

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

SQL の対応範囲をさらに広げる場合（例：`JOIN`、複合 `WHERE`、`ALTER TABLE`
の `RENAME`/型変更/複数アクション同時指定など）、通常は `parser.ts`
（許可リストの拡張）、`pglite/engine.ts`（`snapshotAfter()` の文種別
ロジック）、そして新しいアニメーションイベントが必要であれば
`diff.ts`/`components/canvas/` にまたがって変更することになる。

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

GitHub連携によるSQL実行履歴保持機能は、旧Issue #18（M0〜M5：設計モード/
実験モードの切り替え、モードゲート、`schema/ddl.sql`生成、GitHub PAT設定・
プッシュ）の完了をもってクローズ済み。残るM6（`query-examples.md`昇格
フロー）はIssue #24へ、GitHub認証UXの改善（PAT直貼りからの移行検討）は
Issue #23へそれぞれ切り出されており、#23の方針確定後に#24へ着手する。
仕様は [docs/github-sync-spec.md](docs/github-sync-spec.md)、実装方針・
マイルストーン別の進捗は
[docs/github-sync-design.md](docs/github-sync-design.md) を参照。

## エージェント目視確認用ツール（Playwright）

`tools/visual-check/`（Issue #13）は、エージェントが `npm run dev` の画面を
実際に操作してスクリーンショットで確認するための補助ツールであり、
**テストスイートではない**（`npm test`・CIには組み込まれていない。E2Eテスト
導入を見送った `docs/smoke-test-spec.md` 3節の決定と矛盾しない）。Chromium
起動に必要なOS依存ライブラリの導入にroot権限が要る一方、本リポジトリの
`.claude/settings.json` は `sudo` を恒久的に禁止しているため、公式Playwright
Dockerイメージ上で実行することでホスト環境を汚染せずに動かす方式を採用して
いる。使い方は [tools/visual-check/README.md](tools/visual-check/README.md)
（もしくは `/visual-check` コマンド）を参照。

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
