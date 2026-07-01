export type ColumnType = 'INT' | 'VARCHAR' | 'TEXT' | 'BOOLEAN' | 'DATE' | 'UNKNOWN';

export interface Column {
  name: string;
  type: ColumnType;
}

export interface Row {
  id: string;
  values: Record<string, string | number | boolean | null>;
  /** true when filtered out by the most recent SELECT WHERE clause */
  filteredOut?: boolean;
}

export interface Table {
  name: string;
  columns: Column[];
  rows: Row[];
  /** grid position assigned by layout engine */
  x: number;
  y: number;
}

export interface DBState {
  tables: Record<string, Table>;
  /** ordered list of table names for layout */
  order: string[];
  /** the last executed statement, used to drive SELECT highlighting */
  lastSelect: {
    table: string;
    columns: string[]; // empty = all columns (SELECT *)
    where: WhereClause | null;
  } | null;
  /** monotonically increasing version, bumped on every applied statement */
  version: number;
}

export interface WhereClause {
  column: string;
  operator: string;
  value: string | number | boolean | null;
}

export type AnimationEvent =
  | { kind: 'table_appear'; table: string }
  | { kind: 'row_add'; table: string; rowId: string; index: number }
  | { kind: 'row_filter'; table: string; rowId: string }
  | { kind: 'row_unfilter'; table: string; rowId: string }
  | { kind: 'select_highlight'; table: string; columns: string[] };
