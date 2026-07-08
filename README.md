# SQL Visualizer

SQL 文を入力すると、テーブルの生成・行の追加・`SELECT` によるフィルタ／ハイライトを
アニメーションとして可視化するクライアントサイドのみの SQL プロトタイプツールです。

サーバーや永続化層は持たず、すべてブラウザ内のインメモリな「おもちゃの DB」上で完結します。
実行された SQL の前後で DB 状態を比較（diff）し、その差分をアニメーションイベント列に
変換して再生する「状態 diff 駆動」のアーキテクチャを採用しています。

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
| SQL パーサー | [`node-sql-parser`](https://www.npmjs.com/package/node-sql-parser) |
| アニメーション | [Framer Motion](https://www.framer.com/motion/) |
| 描画方式 | SVG |
| アイコン | [lucide-react](https://lucide.dev/) |

## アーキテクチャ

SQL 文字列は「パース → 適用 → レイアウト → 差分 → アニメーション」のパイプラインを
1文ずつ順番に通過します（`src/hooks/useSqlRunner.ts` の `run()` が駆動）。

```
SQL文字列
   ↓
[1] parser.ts   — node-sql-parser で AST 化し、
                  ParsedCreate / ParsedInsert / ParsedSelect に絞り込む
   ↓
[2] reducer.ts  — 純粋関数（applyCreateTable / applyInsert / applySelect）が
                  現在の DBState を受け取り新しい DBState を返す（不変更新）
   ↓
[3] layout.ts   — layoutTables() がキャンバス幅に応じて各テーブルへ
                  グリッド状の x/y 座標を割り当てる
   ↓
[4] diff.ts     — diffStates(old, next) が新旧の DBState を比較し、
                  順序付き AnimationEvent[] を生成する
   ↓
[5] hooks/useSqlRunner.ts + hooks/useAnimationPlayer.ts
                — playEvents() がイベントを順に処理し、React state を
                  更新しながら components/canvas/Canvas.tsx（framer-motion）
                  でアニメーション再生
```

ドメインモデルは [`src/types.ts`](src/types.ts) を単一の情報源（single source of truth）
としています。UI層（状態管理・プレゼンテーション）の構成は下記「ディレクトリ構成」を
参照してください。ルーティングは
[`docs/routing-decision.md`](docs/routing-decision.md) の通り今回は導入していません。

## セットアップ

```bash
npm install
npm run dev
```

デフォルトで `http://localhost:5173` にて開発サーバーが起動します。テキストエリアに
SQL を入力し「Run SQL」を押すと、右側のキャンバスでアニメーションが再生されます。

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

## ディレクトリ構成

```
src/
  App.tsx           # 画面全体の構成ルート（フック呼び出し＋コンポーネント合成）
  parser.ts         # SQL → AST → Parsed* 型への変換
  reducer.ts        # DBState への純粋な適用ロジック
  layout.ts         # テーブル同士のグリッドレイアウト計算
  diff.ts           # 新旧 DBState の差分 → AnimationEvent[]
  runner.ts         # parse→apply→layout→diff のパイプライン統合
  types.ts          # ドメインモデルの単一の情報源
  constants/
    sampleSql.ts    # 初期表示用のサンプルSQL
  hooks/
    useSqlRunner.ts       # DBState管理・SQL実行パイプラインの駆動
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

- 実データベースへの接続は行わない。すべてクライアントサイドの仮想状態上で完結する
- 1テーブルあたりの表示行数は多量データの可視化を想定していない（プロトタイプ規模を想定）
- 対応 SQL は ANSI 標準に近いサブセットのみで、方言固有拡張（MySQL/PostgreSQL 独自構文など）は非対応
