import { parseSql } from '../src/parser';
import { applyCreateTable, applyInsert, applySelect, emptyState } from '../src/reducer';
import { diffStates } from '../src/diff';
import type { AnimationEvent, Column, ColumnType, DBState, Row, Table } from '../src/types';

export const SAMPLE_CREATE_USERS = 'CREATE TABLE users (id INT, name VARCHAR(50))';

export function makeColumn(name: string, type: ColumnType): Column {
  return { name, type };
}

export function makeRow(id: string, values: Row['values'], filteredOut?: boolean): Row {
  return filteredOut === undefined ? { id, values } : { id, values, filteredOut };
}

export function makeTable(name: string, columns: Column[], rows: Row[], x = 0, y = 0): Table {
  return { name, columns, rows, x, y };
}

export function makeState(tables: Table[], order?: string[], lastSelect: DBState['lastSelect'] = null): DBState {
  return {
    tables: Object.fromEntries(tables.map((t) => [t.name, t])),
    order: order ?? tables.map((t) => t.name),
    lastSelect,
    version: 0,
  };
}

/**
 * SQL文字列の配列を順に実行し、文ごとに生成されたイベント列を返す。
 * layoutTables() は挟まない（diffStates は x/y 座標を参照しないため）。
 * apply* 系がエラーを返した場合は throw し、それ以降の文は処理しない
 * （EVENT-07 のテストで使う挙動）。
 */
export function runSqlStatements(sqlList: string[]): { state: DBState; events: AnimationEvent[] }[] {
  let current = emptyState();
  const results: { state: DBState; events: AnimationEvent[] }[] = [];
  for (const sql of sqlList) {
    const { statements, error } = parseSql(sql);
    if (error) throw new Error(error);
    for (const stmt of statements) {
      let next: DBState;
      if (stmt.type === 'create') {
        const result = applyCreateTable(current, stmt.table, stmt.columns);
        if (result.error) throw new Error(result.error);
        next = result.state;
      } else if (stmt.type === 'insert') {
        next = current;
        for (const row of stmt.rows) {
          const result = applyInsert(next, stmt.table, stmt.columns, row);
          if (result.error) throw new Error(result.error);
          next = result.state;
        }
      } else {
        const result = applySelect(current, stmt.table, stmt.columns, stmt.where);
        if (result.error) throw new Error(result.error);
        next = result.state;
      }
      results.push({ state: next, events: diffStates(current, next) });
      current = next;
    }
  }
  return results;
}
