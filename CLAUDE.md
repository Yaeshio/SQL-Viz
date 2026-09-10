# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## コマンド

- `npm install` — 依存関係のインストール
- `npm run dev` — Vite の開発サーバーを起動（デフォルトは `http://localhost:5173`）
- `npm run sql-studio -- <path/to/schema.sql>` — ローカルCLIモード。指定
  ファイルをサイレントに読み込み、Save/Reloadボタンでファイルと同期する
  （Issue #26、[docs/local-cli-sync-spec.md](docs/local-cli-sync-spec.md)参照。
  Node 22.6以上が必要）。リポジトリの clone / Node 構築なしで使う Docker 経由の
  起動手段もある（Issue #31、`docker build -f docker/sql-studio/Dockerfile
  -t sql-studio .` → `docker run --rm -p 127.0.0.1:5173:5173 -v "$(pwd):/workspace"
  --user "$(id -u):$(id -g)" sql-studio /workspace/<path>`。
  [docker/sql-studio/README.md](docker/sql-studio/README.md)、E2E検証は
  [docs/issue31-docker-e2e-runbook.md](docs/issue31-docker-e2e-runbook.md)）
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
JS ロジックで DB 状態を模していた）。ただし、ローカルCLIモード
（`npm run sql-studio -- <path>`、Issue #26）で起動した場合に限り、
スキーマファイルの読み書きを担う開発用ローカルサーバー（Vite dev server
へのプラグイン注入によるもので、`vite.config.ts` 自体は変更しない）が
付随する。Vercel本番デプロイは引き続きバックエンドを持たない静的SPAの
ままであり、この機能自体を持たない（詳細は
[docs/local-cli-sync-spec.md](docs/local-cli-sync-spec.md) を参照）。

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
7. `layout.ts` — `layoutTables()` が各テーブルへグリッド状の `x`/`y` を
   割り当てる（収まらなければ次の行に折り返す）。折り返し幅は Issue #17 以降
   ビューポート幅ではなく固定定数 `WORLD_W`（ワールド座標系。5列グリッド）で、
   ブラウザ（`useSqlRunner.ts`）とクエリAPIサーバー（`local/queryApiPlugin.ts`）の
   両方が同じ値を渡すため配置は決定的。`layoutTables()` のシグネチャ自体は
   `(state, wrapWidth)` のまま。
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
   `run()` はIssue #26でオプション引数
   `RunOptions`（`{ sql?: string; silent?: boolean }`）を受け取れるよう
   拡張されている（既存の引数なし呼び出しとは完全に後方互換）。
   `sql` 指定時はエディタの `sql` stateも同時に更新し、`silent: true` は
   実行ログへの書き込みのみを抑制する（アニメーションは通常通り再生する）。
   ローカルCLIモードの起動時サイレント自動ロード（後述）に使われる。

**描画** — `components/canvas/Canvas.tsx` は各テーブルを
`components/canvas/TableNode.tsx` として、`framer-motion`
（`motion.g`, `AnimatePresence`）を使った SVG の `<g>` で描画し、
データ行1件分は `components/canvas/TableRow.tsx` に切り出されている。
`App` から渡される `appearingRows` / `filteringRows` / `highlight` の
props に応じてアニメーションする。テーブルカード内部の列/行の y オフ
セット・セル文字列の切り詰めは `lib/canvasLayout.ts`
（`layout.ts` とは別の、テーブル**内部**描画専用の純粋関数群）が担う。
`layout.ts` は引き続きテーブル**同士**のグリッド配置（`TABLE_W`,
`HEADER_H`, `ROW_H`, `COL_GAP` 等の定数を含む）専用。

Issue #17 で `Canvas.tsx` は SVG を `react-zoom-pan-pinch` の
`<TransformWrapper>`/`<TransformComponent>` でラップし、キャンバスのパン・
ズームと「全テーブルにフィット」ボタン（`data-testid="fit-view-btn"`）を持つ。
SVG は `width/height` に `lib/canvasLayout.ts` の `computeWorldBox()`
（全テーブル外接矩形 + `WORLD_MARGIN`、最小 800×500）の実ピクセルサイズを持つ。
ジェスチャーはライブラリがラッパー `<div>` への CSS transform だけで処理する
ため SVG/テーブル木は再レンダリングされない。現在の transform は `onTransform`
で `CanvasPane` の `<section data-testid="canvas-pane">` に `data-canvas-scale`
/ `data-canvas-pan-x` / `data-canvas-pan-y` / `data-world-w` / `data-world-h`
として命令的に公開される（`setState` しない＝再レンダリングを起こさない。
`tools/acceptance-check/scenarios/phaseB-panzoom.mjs` の検証に使う）。

フィット／パン制限の挙動（Issue #17 レビュー反映）：フィットは
`computeFitTransform()`（純粋幾何）を `setTransform()` に渡す方式で、初期の
自動フィットと Fit ボタンで共有する。**自動フィットは起動時ストリーミング
ロード追従のみ**——ワールドサイズが変化しなくなって約1.2秒、あるいは最初の
手動パン/ズームで恒久停止し、以後の再フレーミングは Fit ボタン限定
（SQL を再実行してもカメラは動かない）。`limitToBounds` は無効化し
（「内容がビューポートを覆う」規則がフィット時のレターボックス表示を妨げるため）、
代わりにジェスチャー終了時に `clampPan()`（`KEEP_VISIBLE` 分だけワールドを
画面内に残す緩い制限）を再適用する。ホイールズームは `smooth` 無効・離散
ステップ（`smooth` はホイール deltaY を乗算し1ノッチで過剰にズームするため）。

Issue #34 で、キャンバス上のテーブルをヘッダー部分のドラッグで任意の位置に
再配置できるようにした（#17のパン・ズーム実装に依存する後続Issue）。
`types.ts` の `Table` に `manuallyPositioned?: boolean` を追加し、
`layout.ts` の `layoutTables()` はこのフラグが立ったテーブルをグリッド
計算から完全に除外する（x/yを一切書き換えない）。新規作成テーブルを含む
残りの自動配置テーブルは、手動配置テーブル分の空き枠を作らず詰めて
配置される（インデックスベース）だけでなく、各候補セルの実座標を手動配置
テーブル・このパスで既に確定した自動配置テーブルの実矩形とAABB判定し、
重なっていれば重ならなくなるまで下へ押し出す2パス目を持つ——手動配置は
連続座標の任意位置になり得るため、インデックスベースの詰め処理だけでは
新規テーブルが手動配置テーブルの実位置と衝突しうる（手動配置テーブルが
1つもなければこの2パス目は発動せず、#34以前と出力は完全に一致する）。

ドラッグでの位置変更は `PgEngine`（`pglite/engine.ts`）の
`setTablePosition(name, x, y)` が担う。`PgEngine.run()` は常に内部の
`this.lastState` を起点に次のスナップショットを作るため（ブラウザ側の
`useSqlRunner` の `state` とは別物）、ドラッグ確定時はReact側の
`dispatch` だけでなくこのメソッド経由で `this.lastState` 自体を
書き換えないと、次の文実行で `layoutTables()` に即座に上書きされて
消えてしまう。experimentモード中の `designCheckpoint`
（`returnToDesign()` がROLLBACK時に復元する退避スナップショット）にも
同じ変更を反映しており、位置はSQLデータ変更ではないため
experiment→design遷移のロールバック対象にはならない。`useSqlRunner` は
これを `moveTable(name, x, y)` として公開し、`App.tsx` →
`CanvasPane.tsx` → `Canvas.tsx` → `TableNode.tsx` へ素通しする。

ジェスチャー自体は `framer-motion` の `drag` prop ではなく素朴な
pointerイベントで実装している（`TableNode.tsx` の `motion.g` が
entry/exitアニメーションに既に `y` を使っているため）。ドラッグ起点は
テーブルのヘッダー（`className="sqlviz-drag-handle"`、
`data-testid="table-drag-handle"`）限定。キャンバスのパン操作
（`react-zoom-pan-pinch`）との切り分けは `event.stopPropagation()`
**ではなく**、`Canvas.tsx` の `TransformWrapper` に渡す
`panning={{ excluded: ['sqlviz-drag-handle'] }}` で行っている——
react-zoom-pan-pinchのパン開始判定は `window` への直接の `mousedown`
リスナー（Reactのイベント委譲とは無関係）で行われるため、Reactの
`pointerdown` ハンドラ内で `stopPropagation()` してもこのリスナーの
発火を防げない（実装時に受け入れチェックで実際に検出した）。
ドラッグ中のライブオフセットは `Canvas.tsx` のローカル state のみで
管理し（`window` への `pointermove`/`pointerup` リスナー、ドラッグ中の
テーブルのみ`memo`越しに再レンダリング）、`DBState`（および`PgEngine`
内部の複製）は `pointerup` で一度だけ `onMoveTable` 経由で更新される。
手動配置は現段階ではセッション限りで、`PgEngine.reset()`
（Resetボタン）やページリロードで消える。DDLファイルへの書き出し対象は
テーブル構造のみのまま変更していない。ALTER ADD/DROP COLUMNで手動配置
済みテーブルの高さが変わった場合の再配置要否はIssue本文の通り未決の
まま据え置いている（実装後の使用感確認待ち）。

`tools/acceptance-check/scenarios/phaseB-drag.mjs`
（`orchestrate-phase-b-drag.mjs`、`--phase=B-drag`）が実Chromiumで
ヘッダーのドラッグハンドルを操作し、位置の確定・スナップバックしない
こと・ドラッグ中はキャンバスのズームが変わらず非ドラッグテーブルが画面上で
静止していること（下記のパン変換補正）・ドラッグ後の別文実行で位置が
保持されつつ新規テーブルが重ならないこと・原点を跨いでドラッグしても
キャンバスが左・上方向へ伸び、かつ左上端テーブル自身はカーソルに追従する
こと（後述）を検証する
（`docs/alpha-phase-acceptance-criteria.md` フェーズB参照）。

ドラッグ実装当初、テーブル位置の確定処理（`Canvas.tsx`の`handleUp`）に
`Math.max(0, ...)`のクランプが入っており、左・上方向へのドラッグが
一切できず強制的に0へフィッティングされる問題があった。これを解消する
形で、`lib/canvasLayout.ts`の`WorldBox`（SVGの`viewBox`/`width`/`height`
を決める型）に`minX`/`minY`（ワールド座標系での左上端）を追加した。

最初の実装では「負のx/yを持つテーブルが実在する場合だけ」`minX`/`minY`を
0から動かす条件分岐にしていたが、これだと右・下方向（常に「最右/最下
テーブルの実端 + margin」として毎レンダー追従する）と体感が非対称になる
——テーブルが原点(0,0)へ実際に到達する**まで**は一切拡張が起こらず、
右・下のような「先回り」の余白が無い、というレビュー指摘を受けて設計を
修正した。`computeWorldBox()`は現在、**ワールド原点(0,0)を暗黙に含む
という前提そのものを持たない**：テーブルが1つも無い場合だけ`{minX:0,
minY:0, width:MIN_WORLD_W, height:MIN_WORLD_H}`の特別扱いをし、1つでも
あれば東西南北すべて「現在のテーブル群の実際の外接矩形（`Math.min`/
`Math.max`）± `WORLD_MARGIN`(96px)」という同一の式で計算する。実運用では
`layoutTables()`が非手動配置テーブルを常に`PAD`(24)基準のグリッドへ配置
するため、DBStateに1つでも自動配置テーブルが残っていれば原点付近も
引き続き外接矩形に含まれる——全テーブルを手動でどこか別の場所へドラッグ
し尽くした場合のみ、境界は実際にテーブルがある場所へタイトに追従する。
（`computeFitTransform`/`clampPan`は`<svg>`の`width`/`height`という
不透明なCSSボックスサイズしか見ておらず`viewBox`の中身には関知しない
ため無改修で済む。）

`Canvas.tsx`はドラッグ中のライブ位置（コミット前の`dragOffset`）を
含めた配列を`computeWorldBox()`へ渡すようにしており（`<TableNode>`へ
渡す配列自体は`memo`のため元の`state`参照のまま）、境界は常に「先頭
テーブルの端 ± margin」として毎レンダー再計算される——これにより
「テーブルが外縁に接触してから拡張する」のではなく「境界は常にテーブル
のmargin分先にありドラッグの1px目から連続的に育つ」という先回りの拡張
が、4方向とも同じ体感で、かつ閾値判定のような追加ロジック無しで実現
されている。SVGの`width`/`height`/`viewBox`はただの再レンダー時
attribute値でアニメーションは一切介在しないため、拡張時に「跳ね返る」
ような演出も存在しない。

ただしこの「ライブ位置を`computeWorldBox()`へ渡す」実装だけだと、左・上へ
ドラッグしたときの体感が右・下と非対称になる。左・上へドラッグすると
動かした当のテーブル自身が最左/最上になり`minX`/`minY`（＝SVGの`viewBox`
原点）がそのテーブルに1:1で追従する。一方 react-zoom-pan-pinch のパン変換
はヘッダードラッグ中は凍結（ヘッダーはパンジェスチャーから`excluded`）
されているため、原点シフトを吸収するものが無く、動かしたテーブルが画面上
でピン留めされ他のテーブルだけが逆方向へ流れて見える（右・下は`minX`/
`minY`が動かないのでこの問題は起きない）。対策として`Canvas.tsx`は
`useLayoutEffect`で、ドラッグ中に`world.minX`/`minY`が前レンダーから
変化したぶんだけパン変換を`setTransform(..., 0)`（アニメーション無し）で
即時ずらす——`screen(wx) = positionX + (wx - minX)·scale`なので、
`positionX`に`(minX_new - minX_old)·scale`を足せば動いていないワールド点は
画面上で静止する。結果、4方向どれも「掴んだテーブルはカーソルに追従し、
他のテーブル・背景は静止したままキャンバスが先回りで育つ」体感に揃う。
補正は`viewBox`変更と同じフレームで走る（`useLayoutEffect`）ためちらつき
は無く、`setTransform`は既存の`onTransform`経由で`data-canvas-pan-x/y`を
更新するだけで再レンダーは起こさない。ドロップ確定時のレンダーは最後の
ドラッグレンダーと同じ原点になるためジャンプしない。

SQL の対応範囲をさらに広げる場合（例：`JOIN`、複合 `WHERE`、`ALTER TABLE`
の `RENAME`/型変更/複数アクション同時指定など）、通常は `parser.ts`
（許可リストの拡張）、`pglite/engine.ts`（`snapshotAfter()` の文種別
ロジック）、そして新しいアニメーションイベントが必要であれば
`diff.ts`/`components/canvas/` にまたがって変更することになる。具体的な
拡張は Issue #35 を2ティアに分割した Issue #47（Medium：複合 `WHERE`／
`ALTER TABLE RENAME`／単一 `ALTER` 文での複数アクション。前提依存なし）と
Issue #48（Large：`JOIN`／`GROUP BY`・集約。`types.ts` のデータモデル
再設計が先決で、FK リレーション線描画の Issue #45 を前提依存とする）で
追跡している。

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

スキーマの永続化は、旧Issue #18で実装したGitHub PAT + Contents API直接push
方式から、Issue #26でローカルCLI経由のファイル同期方式（`npm run sql-studio
-- <path>`）へ移行済み。CLIが起動するローカルVite dev serverに
`GET`/`POST /api/schema` を提供するプラグインを注入し、アプリはそのAPIへの
読み書きに徹する（`git add`/`commit`/`push`の自動化は行わない）。旧方式の
GitHub認証層（`src/github/`, `useGitHubSettings.ts`, `GitHubSettingsPanel`）
はIssue #26で削除済み。GitHub認証UXの改善を検討していたIssue #23は前提が
消滅しクローズ、`query-examples.md`昇格フローのIssue #24もスコープ外化し
クローズ済み。仕様は
[docs/local-cli-sync-spec.md](docs/local-cli-sync-spec.md)、実装詳細は
[docs/local-cli-sync-design.md](docs/local-cli-sync-design.md) を参照。

Issue #27 で、`npm run sql-studio` のサーバープロセスに常駐する `PgEngine`
（`src/local/queryApiPlugin.ts`）を、ブラウザを介さずエージェントが
プログラム的に操作できる `POST /api/query`（`{sql, mode}` →
`PgEngine.run()` の `RunResult` をほぼそのままJSON化）、
`GET /api/query/state`（実行なしで現在の `DBState` を返す）、
`GET /api/query/health`（コールドスタート完了判定）、
`POST /api/query/reset`（起動時ブートストラップ直後の状態へ即座に戻す
破壊的操作）として公開した。CLI版は `node scripts/query.mjs "<SQL>"`
（stdin対応、`--mode=`指定、`RunResult` のJSONのみをstdoutに出力。
`npm run query --`経由だとnpmのバナーがstdoutに混入するため、エージェント
用途では`npm run --silent query --`かnode直接呼び出しを使うこと）。
サーバー側セッションはブラウザ側の未保存キャンバス状態とは
リアルタイム同期しない、完全に独立した`PgEngine`インスタンス。詳細仕様は
[docs/agent-query-api-spec.md](docs/agent-query-api-spec.md) を参照。

Issue #37 で、`POST /api/query` の実行履歴（成功/失敗問わず、`{seq, sql,
mode, at, ok, parseError?, statements[]}` の要約。`DBState` は持たない、
上限200件でFIFO破棄）を `queryApiPlugin.ts` のクロージャローカル state
（`PgEngine` 自体には持たせない——起動時ブートストラップDDLの実行を履歴に
混入させないため）として保持し、`GET /api/query/history` で公開した。CLI に
`--history`（一覧をJSON出力）と `--replay=<seq>`（履歴の `sql`/`mode` を
そのまま再送。`--history`・`--replay`・位置引数SQLは相互排他）を追加。
履歴は監査ログとして扱い `POST /api/query/reset` ではクリアしない（消えるのは
プロセス終了時のみ）。

Issue #33 で、Issue #27のクエリAPI/CLIとIssue #32の`verify`起動モードを
組み合わせ、エージェントが改修提案ドキュメント（変更前後のスキーマ抜粋・
検証に使ったクエリ例）を書き出すワークフローを整備した。新規APIエンド
ポイントやUIは追加せず、`verify`モードで起動したsql-studioに対しエージェント
がクエリAPI/CLIで変更を試行し、結果を自身のセッション内に保持したうえで
ファイルシステムへ直接書き出す。書き出し先は固定せず、対象プロジェクト
（`<path/to/schema.sql>`が属するリポジトリ）ごとにユーザーと相談して都度
決める（旧Issue #24で見送った「アプリが自動で`query-examples.md`へ書き込む」
方式とは異なる）。`scripts/openLocal.mjs`の起動時バナーには、SQL-Viz自身の
ローカルチェックアウトがなくても参照できるよう、このワークフロー仕様書への
GitHub URLが常に印字される。詳細は
[docs/agent-proposal-workflow-spec.md](docs/agent-proposal-workflow-spec.md)
を参照。

Issue #31 で、上記 `npm run sql-studio` と同一エントリ（`scripts/openLocal.mjs`）を
Docker コンテナからも起動できるようにした（`docker/sql-studio/Dockerfile`。
レジストリ公開はせずローカル `docker build` のみ、`npm test`/CI 非組み込み）。
`vite.config.ts` は無改修で、`spawnVite` に `host`/`cacheDir` 引数を足し、
`main()` が `SQL_STUDIO_HOST`（Docker では `0.0.0.0`）/ `SQL_STUDIO_CACHE_DIR`
（`--user` 実行でも Vite の依存事前バンドルキャッシュを書けるよう `/tmp` 配下）
環境変数を読む——いずれも既定は現状挙動のため既存経路は無改修。LAN 到達不能性は
Docker 経路では利用者の `docker run -p 127.0.0.1:5173:5173` 指定に委ねられる。
E2E 検証は既存の `tools/acceptance-check/scenarios/*.mjs` を無改修で
`docker run ... sql-studio` に対して実行する手順書
[docs/issue31-docker-e2e-runbook.md](docs/issue31-docker-e2e-runbook.md)
（検証用リポジトリは `tools/acceptance-check/fixtures/make-e2e-target-repo.mjs`
で決定論的に生成）で行う。詳細は
[docker/sql-studio/README.md](docker/sql-studio/README.md) を参照。

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

## 受け入れテストハーネス（Docker+Playwright、自動判定）

`tools/acceptance-check/`は、visual-check（目視確認専用）とは別に、実際の
ファイルI/O・UI操作を自動でpass/fail判定する受け入れテストハーネスである。
`npm test`・CIには組み込まれていない（visual-checkと同じ方針）。使い方は
[tools/acceptance-check/README.md](tools/acceptance-check/README.md)を参照。
各フェーズ（Phase A/B/C）が「完了」とみなされる具体的な受け入れ基準は
[docs/alpha-phase-acceptance-criteria.md](docs/alpha-phase-acceptance-criteria.md)
を参照。

同ハーネス内の `orchestrate-phase-c-gallery.mjs`（`--phase=C-gallery`、Issue #54）だけは
pass/fail判定ではなく、[docs/animation-gallery.md](docs/animation-gallery.md) 用の
「実行前→実行後」スクリーンショット（`docs/assets/animation/*.png`、約20枚）を
決定論的に**生成する**のが主目的。SQL対応がIssue #47/#48で拡大し新しい
`AnimationEvent`・表示挙動が入るたびに、`scenarios/phaseC-gallery.mjs` の `STEPS` へ
操作を追加して再実行し、`docs/animation-gallery.md` と画像を更新する。

## CI/CD

`main` 向け PR と `main` への push を対象に、GitHub Actions
（[.github/workflows/ci.yml](.github/workflows/ci.yml)）が
`typecheck` / `lint` / `test` / `build` を実行する（E2E 等の重量級テストは
対象外、Issue #10）。`main` には branch protection rule が設定されており、
この CI（job: `build-and-check`）が成功しないとマージできない。

デプロイ（CD）は GitHub Actions では行わず、Vercel のネイティブ Git 連携に
委ねている（PR ごとの Preview Deployment、`main` マージ時の Production
Deployment はいずれも Vercel 側が自動で行う）。

## 実装計画の中間成果物の扱い（CLI版Claude Code）

CLI版Claude CodeのPlanモード（`/plan`）が生成する計画ファイルは、ハーネス側の
仕様により常に `~/.claude/plans/`（リポジトリ外・ユーザーのホームディレクトリ
配下）に保存される。この場所はCLAUDE.mdの指示では変更できないが、元々リポジトリ
の外側にあるためGit追跡とは無関係であり、特別な対応は不要である。

一方、Planモードを介さない実装メモ・設計メモ（例：承認済みプランを元に作業を
進める際の作業用コピーやチェックリスト）をリポジトリ内に書き出す場合は、
`.claude/local-plans/` に置く。このディレクトリは `.gitignore` で除外された
非永続の作業用スペースであり、`docs/`配下の恒久的な意思決定記録
（`routing-decision.md`等）とは役割が異なる。

- **ライフサイクル**: 対応する作業（Issue/PRのマージなど）が完了したら、
  Claude自身が `rm` で当該ファイルを削除する。追跡対象外ファイルの削除であり、
  「Git安全プロトコル」上の破壊的操作の確認対象にはならない。
- **例外（重要な意思決定の保存）**: 計画に大規模な変更を伴う意思決定が含まれる
  場合は、削除前にその要約を (a) 関連するGitHub Issue/PRへのコメント、または
  (b) `docs/`配下の恒久ドキュメントとして残してから削除する。

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
