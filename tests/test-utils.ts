import { PgEngine } from '../src/pglite/engine';
import { parseSql } from '../src/parser';
import type { AnimationEvent, AppMode, Column, ColumnType, DBState, Row, Table } from '../src/types';

const STRUCTURAL_TYPES = new Set(['create', 'alter', 'drop']);

const CANVAS_W = 800;

export const SAMPLE_CREATE_USERS = 'CREATE TABLE users (id INT, name VARCHAR(50))';

export function makeColumn(name: string, type: ColumnType): Column {
  return { name, type };
}

export function makeRow(id: string, values: Row['values'], filteredOut?: boolean): Row {
  return filteredOut === undefined ? { id, values } : { id, values, filteredOut };
}

export function makeTable(
  name: string,
  columns: Column[],
  rows: Row[],
  x = 0,
  y = 0,
  manuallyPositioned?: boolean,
): Table {
  return manuallyPositioned === undefined ? { name, columns, rows, x, y } : { name, columns, rows, x, y, manuallyPositioned };
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
 * SQL文字列の配列を、新規 PgEngine 上で順に実行し（各文字列内に複数文を
 * 含んでもよい）、文ごとに生成されたイベント列を返す。engine が
 * エラーを返した場合は throw し、それ以降の文は処理しない
 * （EVENT-07 のテストで使う挙動）。各リスト要素のモードは、先頭の文の種類
 * （CREATE/ALTER/DROPならdesign、それ以外ならexperiment）から自動判定する
 * ——このヘルパーはモードゲート自体ではなくparse→execute→diffのパイプライン
 * を検証するためのものであり、呼び出し側（events.test.ts）に手動でモードを
 * 指定させる意味がないため。returnToDesign()は呼ばないので、design文と
 * experiment文をまたいでも実験モードのデータはリセットされない。
 */
export async function runSqlStatements(sqlList: string[]): Promise<{ state: DBState; events: AnimationEvent[] }[]> {
  const engine = new PgEngine();
  const results: { state: DBState; events: AnimationEvent[] }[] = [];
  for (const sql of sqlList) {
    const { statements } = parseSql(sql);
    const mode: AppMode = statements[0] && STRUCTURAL_TYPES.has(statements[0].type) ? 'design' : 'experiment';
    const { results: stmtResults, parseError } = await engine.run(sql, CANVAS_W, mode);
    if (parseError) throw new Error(parseError);
    for (const r of stmtResults) {
      if (r.error) throw new Error(r.error);
      results.push({ state: r.state, events: r.events });
    }
  }
  return results;
}

/** state.order 上の全テーブルについて、layoutTables() 後の (x, y) ペアに重複がないか調べる。 */
export function hasOverlappingTablePositions(state: DBState): boolean {
  const seen = new Set<string>();
  for (const name of state.order) {
    const { x, y } = state.tables[name];
    const key = `${x},${y}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}
