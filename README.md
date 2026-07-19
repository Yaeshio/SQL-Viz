# SQL Visualizer

SQL 文を入力すると、テーブルの生成・行の追加・`SELECT` によるフィルタ／ハイライトを
アニメーションとして可視化するクライアントサイドのみの SQL プロトタイプツールです。

サーバーや永続化層は持たず、すべてブラウザ内で完結します。SQL は実際には
[PGlite](https://pglite.dev/)（WebAssembly にコンパイルされた本物の
PostgreSQL）に対して実行され、その意味で「おもちゃの DB」ではなく本物の
Postgres がブラウザタブ内だけで動いています。`DBState` はレイアウト／差分／
アニメーションを駆動するために、PGlite へクエリして都度再構築される
スナップショットです。実行された SQL の前後で DB 状態を比較（diff）し、
その差分をアニメーションイベント列に変換して再生する「状態 diff 駆動」の
アーキテクチャを採用しています。

詳細な設計意図・構文サポートのロードマップは
[`docs/Sql animation tool spec .md`](docs/Sql%20animation%20tool%20spec%20.md) を参照してください。
本 README は、その仕様書をベースに **現時点で実装済みの挙動** をまとめたものです。
対応SQL文の範囲がなぜこう選定されているかは
[`docs/user-stories.md`](docs/user-stories.md) を参照してください。

## できること（現在の実装）

- `CREATE TABLE` — テーブルをキャンバス上にフェードインで生成
- `INSERT INTO ... VALUES (...)` — 行を1件ずつアニメーション付きで追加
- 単純な `SELECT col, ... FROM table [WHERE col <op> value]`
  - 条件に一致しない行はキャンバス上でフェードアウト（配列から削除ではなく `filteredOut` フラグの反転）
  - 前回の `WHERE` で除外されていた行が再び一致すればフェードインで復帰
  - 選択されたカラムをハイライト表示
- 複数の SQL 文をセミコロン区切りで一括入力し、1文ずつ順番にアニメーション再生
- パースエラー時はエラーメッセージを表示し、直前の状態を保持（ロールバック）
- 実行中（アニメーション再生中）は実行ボタンを無効化し、状態の競合を防止

### 現時点でのスコープ外

- `AND` / `OR` / `LIKE` / `IN` / `BETWEEN` などを含む複合 `WHERE`
- `JOIN`（カンマ区切りの複数テーブル指定を含む）
- `UPDATE` / `DELETE` / `ALTER TABLE`
- 集計（`GROUP BY`/`HAVING`）・整列（`ORDER BY`）・`LIMIT`・`DISTINCT`
- サブクエリ・`UNION`・`WITH`句（CTE）・トランザクション
- `CREATE TABLE ... AS SELECT` / `IF NOT EXISTS`、`PRIMARY KEY`/`INDEX`/`FOREIGN KEY`
  等の制約定義
- `INSERT ... SELECT` / `ON DUPLICATE KEY UPDATE`
- 集約関数・エイリアス付き `SELECT` 列（例: `COUNT(*)`）

これらは対応していない構文として書くと `Unsupported statement type: ...` または
`Unsupported clause: ...` という明示的なエラーになります（黙って無視されたり
不完全な結果を返したりすることはありません）。今後は
`docs/Sql animation tool spec .md` の対応フェーズ表（Phase 2〜4）に沿って
拡張していく想定です。

## 技術スタック

| 分類 | 選定 |
|---|---|
| フレームワーク | React + TypeScript + Vite |
| スタイリング | Tailwind CSS |
| SQL 実行エンジン | [`@electric-sql/pglite`](https://pglite.dev/)（PostgreSQL の WebAssembly ビルド。ブラウザ内で本物の Postgres として動作） |
| SQL パーサー | [`node-sql-parser`](https://www.npmjs.com/package/node-sql-parser)（対応構文かどうかの事前検証・分類のみを行い、実行自体は PGlite が担う） |
| アニメーション | [Framer Motion](https://www.framer.com/motion/) |
| 描画方式 | SVG |
| アイコン | [lucide-react](https://lucide.dev/) |

## アーキテクチャ

SQL 文字列は「文分割 → 事前検証 → 実行（PGlite）→ スナップショット再構築 →
レイアウト → 差分 → アニメーション」のパイプラインを1文ずつ順番に通過します
（`src/hooks/useSqlRunner.ts` の `run()` が駆動）。

```
SQL文字列
   ↓
[0] pglite/splitStatements.ts — クォート／コメントを考慮して
                  セミコロン区切りの文字列を1文ずつに分割する
   ↓
[1] parser.ts   — node-sql-parser で AST 化し、対応構文かどうかを
                  事前検証・分類する「ゲート」。ParsedCreate / ParsedInsert /
                  ParsedSelect に絞り込むが、実行自体は行わない
   ↓
[2] pglite/engine.ts — PgEngine.run() が生の SQL 文字列をそのまま
                  db.query() でブラウザ内の実 PostgreSQL（PGlite）に対して
                  実行する。型不一致・制約違反・WHERE 評価はすべて本物の
                  Postgres の挙動そのもの（エラーも Postgres のネイティブな
                  文言がそのまま UI に出る）
   ↓
[3] PgEngine.snapshotAfter() — PGlite へクエリし直して DBState を
                  再構築する。テーブルごとの ctid → 安定行ID のマップで
                  文をまたいだ行の同一性を保つ。SELECT の場合はここで
                  該当行を削除せず filteredOut フラグを反転させるだけ
                  （フェードアウト演出のための設計は PGlite 導入後も同じ）
   ↓
[4] layout.ts   — layoutTables() がキャンバス幅に応じて各テーブルへ
                  グリッド状の x/y 座標を割り当てる（無変更）
   ↓
[5] diff.ts     — diffStates(old, next) が新旧の DBState を比較し、
                  順序付き AnimationEvent[] を生成する（無変更）
   ↓
[6] hooks/useSqlRunner.ts + hooks/useAnimationPlayer.ts
                — playEvents() がイベントを順に処理し、React state を
                  更新しながら components/canvas/Canvas.tsx（framer-motion）
                  でアニメーション再生（無変更）
```

[3]までが PGlite 導入（Issue #8）で置き換わった「前半部分」で、[4]以降の
レイアウト・差分・アニメーション再生の「後半部分」は導入前から変更されて
いません。`hooks/useSqlRunner.ts` は `PgEngine` のインスタンスを1つだけ
保持し続け（アプリのセッション中は使い回す）、初回の SQL 実行時に PGlite の
WASM 起動（コールドスタート）を待ちます。詳細は「セットアップ」節を参照
してください。

ドメインモデルは [`src/types.ts`](src/types.ts) を単一の情報源（single source of truth）
としています（PGlite 導入前後で無変更）。UI層（状態管理・プレゼンテーション）の構成は
下記「ディレクトリ構成」を参照してください。ルーティングは
[`docs/routing-decision.md`](docs/routing-decision.md) の通り今回は導入していません。

## セットアップ

```bash
npm install
npm run dev
```

デフォルトで `http://localhost:5173` にて開発サーバーが起動します。テキストエリアに
SQL を入力し「Run SQL」を押すと、右側のキャンバスでアニメーションが再生されます。

初回の「Run SQL」実行時は、ブラウザ内で PGlite（WASM 版 PostgreSQL）が
起動するまでの数秒間、Run ボタンが無効化され「エンジン読込中…」と表示
されます。これは PGlite の初回コールドスタートによるもので、`npm install`
や `npm run dev` 自体に追加の手順は必要ありません。

## コマンド

| コマンド | 説明 |
|---|---|
| `npm install` | 依存関係のインストール |
| `npm run dev` | Vite の開発サーバーを起動 |
| `npm run build` | 本番用ビルド（`vite build`） |
| `npm run preview` | 本番ビルドのプレビュー |
| `npm run lint` | ESLint 実行 |
| `npm run typecheck` | `tsc --noEmit -p tsconfig.app.json` |
| `npm test` | Vitest によるユニットテスト実行（`tests/`） |
| `npm run test:watch` | Vitest をウォッチモードで実行 |

`npm test` はテストごとに実際の PGlite（WASM PostgreSQL）インスタンスを
起動するため、純粋な JS ロジックのみをテストしていた頃より実行時間が
長くなっています（`vitest.config.ts` で `testTimeout: 30000` を設定）。

## ディレクトリ構成

```
src/
  App.tsx           # 画面全体の構成ルート（フック呼び出し＋コンポーネント合成）
  parser.ts         # SQL → AST → Parsed* 型への事前検証・分類（実行はしない）
  reducer.ts        # DBState の空状態生成・ディープコピー・型正規化のヘルパー
                     # （PgEngine が内部で使用。旧 applyCreateTable/applyInsert/
                     #  applySelect は Issue #8（PGlite導入）で削除済み）
  layout.ts         # テーブル同士のグリッドレイアウト計算
  diff.ts           # 新旧 DBState の差分 → AnimationEvent[]
  types.ts          # ドメインモデルの単一の情報源
  pglite/
    engine.ts        # PgEngine — 実PostgreSQL（PGlite/WASM）に対する実行と
                      # DBStateスナップショットの再構築を担う実行エンジン本体
    splitStatements.ts # セミコロン区切りのSQL文字列を1文ずつに分割
  constants/
    sampleSql.ts    # 初期表示用のサンプルSQL
  hooks/
    useSqlRunner.ts       # PgEngineの保持・SQL実行パイプラインの駆動
    useAnimationPlayer.ts # アニメーション再生タイミング制御
  lib/
    canvasLayout.ts # テーブル内部（列/行のy座標・セル切り詰め・viewBox）の純粋計算
  components/
    layout/         # ヘッダー・キャンバスペイン等の画面全体レイアウト部品
    sql-editor/      # SQLエディタペイン・実行ログパネル
    canvas/          # SVG + framer-motion によるテーブル/行の描画
docs/
  Sql animation tool spec .md   # 元の仕様書（設計意図・将来ロードマップ）
  routing-decision.md           # ルーティング非対応の決定と理由
tests/
  *.test.ts    # Vitest ユニットテスト
```

## 非機能要件・制約

- 外部・サーバーのデータベースへの接続は行わない。SQL は PGlite（ブラウザ
  タブ内で完結する WebAssembly 版 PostgreSQL）に対して実行され、ネットワーク
  通信を一切伴わない、という意味ですべてクライアントサイドで完結する
- 1テーブルあたりの表示行数は多量データの可視化を想定していない（プロトタイプ規模を想定）
- 対応 SQL は ANSI 標準に近いサブセットのみで、方言固有拡張（MySQL/PostgreSQL 独自構文など）は非対応
