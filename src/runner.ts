import type { AnimationEvent, DBState } from './types';
import { parseSql } from './parser';
import { diffStates } from './diff';
import { layoutTables } from './layout';
import { applyCreateTable, applyInsert, applySelect, cloneState } from './reducer';

export interface StatementResult {
  label: string;
  state: DBState;
  events: AnimationEvent[];
  error?: string;
}

export interface RunResult {
  results: StatementResult[];
  parseError?: string;
}

/**
 * Runs the parse → apply → layout → diff pipeline for a (possibly multi-statement)
 * SQL string against initialState, mirroring App.tsx's run() exactly (same code path
 * used by the app and by smoke tests). Stops at the first statement that errors,
 * including that statement's result in `results` with `error` set.
 */
export function runPipeline(sql: string, initialState: DBState, canvasWidth: number): RunResult {
  const { statements, error: parseError } = parseSql(sql);
  if (parseError) return { results: [], parseError };

  const results: StatementResult[] = [];
  let current = initialState;

  for (const stmt of statements) {
    let next: DBState;
    let label: string;
    let error: string | undefined;

    if (stmt.type === 'create') {
      const res = applyCreateTable(current, stmt.table, stmt.columns);
      next = res.state;
      error = res.error;
      label = `CREATE TABLE ${stmt.table} (${stmt.columns.length} cols)`;
    } else if (stmt.type === 'insert') {
      let res: { state: DBState; error?: string } = { state: current };
      for (const row of stmt.rows) {
        res = applyInsert(res.state, stmt.table, stmt.columns, row);
        if (res.error) break;
      }
      next = res.state;
      error = res.error;
      label = `INSERT INTO ${stmt.table} (${stmt.rows.length} row${stmt.rows.length > 1 ? 's' : ''})`;
    } else {
      const res = applySelect(current, stmt.table, stmt.columns, stmt.where);
      next = res.state;
      error = res.error;
      const w = stmt.where ? ` WHERE ${stmt.where.column} ${stmt.where.operator} ${String(stmt.where.value)}` : '';
      label = `SELECT ${stmt.columns.join(', ')} FROM ${stmt.table}${w}`;
    }

    if (error) {
      results.push({ label, state: next, events: [], error });
      break;
    }

    next = layoutTables(cloneState(next), canvasWidth);
    const events = diffStates(current, next);
    results.push({ label, state: next, events });
    current = next;
  }

  return { results };
}
