# SQLアニメーション可視化ツール 仕様書（Bolt.newプロトタイプ用）

## 1. 概要

SQL文字列を入力すると、テーブル生成・リレーション描画・クエリ実行の過程をアニメーションとして可視化するWebツール。入力されたSQLの前後でDB状態の差分を計算し、その差分をアニメーションイベント列に変換して再生する「状態diff駆動」アーキテクチャを採用する。

## 2. 目的・プロトタイプのゴール

- SQL文字列 → アニメーション、というコアロジックが動くことを実証する
- CREATE TABLE / INSERT / 簡易SELECT（WHERE・JOIN）が可視化できる状態を最初のマイルストーンとする
- UIの作り込みより、パーサー→状態diff→イベント→描画のパイプラインが機能することを優先する

## 3. 技術スタック

| 分類 | 選定 | 理由 |
|---|---|---|
| フレームワーク | React + TypeScript + Vite | Bolt.newの標準構成、型安全性を確保 |
| スタイリング | Tailwind CSS | Bolt.newとの相性が良く高速に実装できる |
| SQLパーサー | `node-sql-parser` | ブラウザ動作可能、CREATE/INSERT/SELECT/UPDATE/DELETEを広くカバー |
| アニメーション | Framer Motion | React宣言的にトランジション・レイアウトアニメーションを扱える |
| 状態管理 | React `useReducer` + Context（軽量なため外部ライブラリ不要） | プロトタイプ規模では十分 |
| 描画方式 | SVG（テーブル・リレーション線・行の描画） | 線のアニメーションや座標計算がしやすい |

## 4. システムアーキテクチャ

```
SQL文字列
   ↓
[1] パーサー（node-sql-parser） → AST
   ↓
[2] 状態diff計算（旧DBState と 新DBState を比較）
   ↓
[3] アニメーションイベントキュー生成
   ↓
[4] レンダラー（SVG + Framer Motion）が順次再生
```

DBStateは「永続的なスキーマ・データの状態」を表すオブジェクトとしてアプリ全体で1つ保持し、SQL実行のたびに更新する。SELECT文だけは状態を更新せず、一時的な処理パイプラインとして別ロジックで扱う（詳細は6章）。

## 5. データモデル定義（TypeScript）

```typescript
interface Column {
  id: string;
  name: string;
  type: string;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  references?: { table: string; column: string };
}

interface TableSchema {
  id: string;
  name: string;
  columns: Column[];
  position: { x: number; y: number };
}

interface Relation {
  id: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

interface RowData {
  id: string;
  tableId: string;
  values: Record<string, string | number | null>;
}

interface DBState {
  tables: Record<string, TableSchema>;
  relations: Relation[];
  rows: Record<string, RowData[]>; // key: tableId
}
```

## 6. アニメーションイベント仕様

```typescript
type AnimationEvent =
  | { type: "CREATE_TABLE"; table: TableSchema; duration: number }
  | { type: "DROP_TABLE"; tableId: string; duration: number }
  | { type: "ADD_COLUMN"; tableId: string; column: Column; duration: number }
  | { type: "REMOVE_COLUMN"; tableId: string; columnId: string; duration: number }
  | { type: "DRAW_RELATION"; relation: Relation; duration: number }
  | { type: "REMOVE_RELATION"; relationId: string; duration: number }
  | { type: "INSERT_ROW"; tableId: string; row: RowData; duration: number }
  | { type: "UPDATE_ROW"; tableId: string; rowId: string; changes: Record<string, unknown>; duration: number }
  | { type: "DELETE_ROW"; tableId: string; rowId: string; duration: number }
  | { type: "HIGHLIGHT_ROWS"; tableId: string; rowIds: string[]; duration: number }
  | { type: "FILTER_ROWS"; tableId: string; matchedRowIds: string[]; duration: number }
  | { type: "MATCH_ROWS"; pairs: Array<{ fromRowId: string; toRowId: string }>; duration: number }
  | { type: "MERGE_ROWS"; resultTableId: string; rows: RowData[]; duration: number }
  | { type: "GROUP_ROWS"; tableId: string; groups: Record<string, string[]>; duration: number }
  | { type: "SORT_ROWS"; tableId: string; orderedRowIds: string[]; duration: number }
  | { type: "PROJECT_COLUMNS"; tableId: string; keepColumnIds: string[]; duration: number };
```

コア関数のシグネチャ：

```typescript
function visualizeSQL(
  sql: string,
  currentState: DBState
): { newState: DBState; events: AnimationEvent[] };
```

- DDL/DML（CREATE/ALTER/DROP/INSERT/UPDATE/DELETE）: `currentState`を実際に更新し、diffからイベントを生成する
- DQL（SELECT）: `currentState`は変更せず、句（FROM→JOIN→WHERE→GROUP BY→SELECT→ORDER BY）を順にイベント化した一時的な処理列を生成する

## 7. 対応SQL構文と優先度（実装フェーズ）

| フェーズ | 対応構文 | 備考 |
|---|---|---|
| Phase 1（MVP） | `CREATE TABLE`, `INSERT INTO`, 単純`SELECT`（列指定・`WHERE`のみ） | パイプライン全体の疎通確認が目的 |
| Phase 2 | `UPDATE`, `DELETE`, `INNER JOIN` | DML一式＋最小限のJOIN |
| Phase 3 | `LEFT/RIGHT JOIN`, `GROUP BY`, `ORDER BY`, `LIMIT` | 集計・整列系 |
| Phase 4 | `ALTER TABLE`, サブクエリ, `UNION`, トランザクション | 発展的な構文 |

方言固有構文（MySQL/PostgreSQL独自拡張など）は非対応とし、ANSI標準に近いサブセットのみサポートする旨を明記する。

Phase 1の範囲がなぜこの構文に絞って選定されたか、想定ユーザーとその目的については
[user-stories.md](./user-stories.md) を参照。

## 8. UI構成（画面レイアウト）

```
┌─────────────┬───────────────────────────────┐
│             │                                 │
│  SQLエディタ  │       キャンバス（SVG描画エリア）    │
│  ・テキスト   │   テーブル / リレーション線 / 行が    │
│    エリア    │   ここでアニメーションする           │
│  ・実行ボタン │                                 │
│             │                                 │
├─────────────┴───────────────────────────────┤
│  再生コントロール：再生 / 一時停止 / ステップ実行 / 速度調整  │
└───────────────────────────────────────────────┘
```

- 左ペイン：SQL入力欄と実行ボタン。サンプルSQL（CREATE TABLE→INSERT→SELECT の一連の流れ）をワンクリックで挿入できるプリセットボタンも用意する
- 中央キャンバス：テーブルは自動レイアウト（新規テーブルは空いているグリッド位置に配置。将来的にリレーションに応じた配置最適化を検討）
- 下部：イベントキューを1つずつ再生するコントロール（デバッグ・学習用途で有用）

## 9. 非機能要件・制約

- 実DBへの接続は行わない。すべてクライアントサイドの仮想状態（DBState）上で完結させる
- SQLパーサーが失敗した場合はエラーメッセージを表示し、直前の状態を保持する（ロールバック）
- アニメーション再生中はSQL実行ボタンを無効化し、状態の競合を防ぐ
- 1テーブルあたりの表示行数は初期実装では10行程度を目安に制限する（大量データの可視化は将来課題）

## 10. Bolt.new向け初期実装プロンプト（叩き台）

以下をBolt.newに貼り付けて初期スキャフォールドを生成する想定。

```
React + TypeScript + Vite + Tailwind CSSで、SQL文を実行するとテーブル生成やクエリ処理を
アニメーションで可視化するWebアプリのプロトタイプを作ってください。

- 左にSQLエディタ（テキストエリアと実行ボタン）、右にSVGベースのキャンバスを配置
- node-sql-parserでSQLをパースし、CREATE TABLE / INSERT INTO / 単純なSELECT（WHERE句のみ）
  に対応する
- アプリ全体でDBState（テーブル定義・リレーション・行データ）をuseReducerで管理する
- SQL実行のたびに旧DBStateと新DBStateを比較し、差分をアニメーションイベント配列に変換する
- イベントはFramer Motionを使って順番に再生する（テーブル出現、行の追加、WHERE条件に
  合わない行のフェードアウトなど）
- まずはCREATE TABLE users (id, name, email) → INSERT INTO users ... →
  SELECT name FROM users WHERE ... という一連の流れが動くことを目標にする
```

## 11. 今後の検討事項（本仕様書スコープ外）

- テーブル配置の自動レイアウトアルゴリズム（力学モデル的な配置）
- JOIN種別ごとのベン図的な差分表現
- トランザクション（BEGIN/COMMIT/ROLLBACK）の可視化
- 大量データを扱う際の省略表示・ページネーション