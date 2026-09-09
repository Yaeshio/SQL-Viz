export type ColumnType = 'INT' | 'VARCHAR' | 'TEXT' | 'BOOLEAN' | 'DATE' | 'UNKNOWN';

/** design: 構造の編集（CREATE/ALTER/DROP TABLE）。experiment: 固定スキーマに
 * 対するデータのみの読み書き（SELECT/INSERT/UPDATE/DELETE）。 */
export type AppMode = 'design' | 'experiment';

export interface Column {
  name: string;
  type: ColumnType;
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

export interface DBState {
  tables: Record<string, Table>;
  /** レイアウト用に順序付けられたテーブル名のリスト */
  order: string[];
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
  | { kind: 'select_highlight'; table: string; columns: string[] };
