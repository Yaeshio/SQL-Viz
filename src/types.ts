export type ColumnType = 'INT' | 'VARCHAR' | 'TEXT' | 'BOOLEAN' | 'DATE' | 'UNKNOWN';

/** design: 構造の編集（CREATE/ALTER/DROP TABLE）。experiment: 固定スキーマに
 * 対するデータのみの読み書き（SELECT/INSERT/UPDATE/DELETE）。 */
export type AppMode = 'design' | 'experiment';

/** 外部キーの参照先（Issue #45）。単一列 FK のみ。 */
export interface ColumnReference {
  table: string;
  column: string;
}

export interface Column {
  name: string;
  type: ColumnType;
  /** この列が外部キーであるとき、その参照先。リレーションの真実の源はこれで、
   * DBState.relations はここから導出される（reducer.ts の deriveRelations）。 */
  references?: ColumnReference;
}

export interface Row {
  id: string;
  values: Record<string, string | number | boolean | null>;
  /** 直近の SELECT の WHERE 句によって絞り込みで除外されているとき true */
  filteredOut?: boolean;
}

export interface Table {
  name: string;
  columns: Column[];
  rows: Row[];
  /** manuallyPositioned でない限り、レイアウトエンジンが割り当てるグリッド位置 */
  x: number;
  y: number;
  /** ユーザーがこのテーブルを一度でもドラッグしたら true（Issue #34）。以降
   * layoutTables() はグリッド位置を再割り当てせず x/y をそのまま残す。 */
  manuallyPositioned?: boolean;
}

/** テーブル間の外部キー（Issue #45）。FK 側（from）から参照先（to）へ向かう。
 * 真実の源は各 Column.references で、DBState.relations はそこから導出される
 * （reducer.ts の deriveRelations）。 */
export interface Relation {
  /** `${fromTable}.${fromColumn}->${toTable}.${toColumn}`。端点から決まる決定的な id
   * なので、diff.ts が行の id と同様に old/next 間で照合できる。 */
  id: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface DBState {
  tables: Record<string, Table>;
  /** レイアウト用に順序付けられたテーブル名のリスト */
  order: string[];
  /** テーブル間の外部キー。`order` 順 × 列順で並ぶ */
  relations: Relation[];
  /** 直近に実行された SELECT 文。SELECT ハイライトの駆動に使う */
  lastSelect: {
    table: string;
    columns: string[]; // 空 = 全カラム（SELECT *）
    where: WhereClause | null;
  } | null;
  /** 単調増加するバージョン。適用された文ごとにインクリメントされる */
  version: number;
}

export interface WhereClause {
  column: string;
  operator: string;
  value: string | number | boolean | null;
}

export type AnimationEvent =
  | { kind: 'table_appear'; table: string }
  | { kind: 'table_remove'; table: string }
  | { kind: 'column_add'; table: string; column: string }
  | { kind: 'column_drop'; table: string; column: string }
  | { kind: 'row_add'; table: string; rowId: string; index: number }
  | { kind: 'row_remove'; table: string; rowId: string }
  | { kind: 'row_update'; table: string; rowId: string }
  | { kind: 'row_filter'; table: string; rowId: string }
  | { kind: 'row_unfilter'; table: string; rowId: string }
  | { kind: 'select_highlight'; table: string; columns: string[] }
  /** 外部キーのコネクタを引く / 消す（Issue #45）。`relationId` は Relation.id。 */
  | { kind: 'relation_add'; relationId: string }
  | { kind: 'relation_remove'; relationId: string };
