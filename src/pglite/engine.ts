import type { PGlite } from '@electric-sql/pglite';
import type { AnimationEvent, DBState, Row } from '../types';
import { parseSql, type Parsed } from '../parser';
import { diffStates } from '../diff';
import { layoutTables } from '../layout';
import { cloneState, emptyState } from '../reducer';
import { splitStatements } from './splitStatements';

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

function quoteIdent(name: string): string {
  return `"${name.toLowerCase().replace(/"/g, '""')}"`;
}

function normalizeValue(v: unknown): string | number | boolean | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v === undefined) return null;
  return v as string | number | boolean | null;
}

function formatPgError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function buildLabel(stmt: Parsed): string {
  if (stmt.type === 'create') {
    return `CREATE TABLE ${stmt.table} (${stmt.columns.length} cols)`;
  }
  if (stmt.type === 'insert') {
    return `INSERT INTO ${stmt.table} (${stmt.rows.length} row${stmt.rows.length > 1 ? 's' : ''})`;
  }
  const w = stmt.where ? ` WHERE ${stmt.where.column} ${stmt.where.operator} ${String(stmt.where.value)}` : '';
  return `SELECT ${stmt.columns.join(', ')} FROM ${stmt.table}${w}`;
}

/**
 * Stateful execution engine backed by a real PGlite (WASM PostgreSQL) instance.
 * Every accepted statement is actually executed against Postgres, so type errors,
 * constraint violations, and WHERE-clause evaluation all reflect genuine
 * PostgreSQL behavior instead of a hand-rolled JS reimplementation. The instance
 * itself is the accumulated database state; DBState snapshots are derived from
 * it after each statement purely to drive layout/diff/animation.
 */
export class PgEngine {
  private db: PGlite | null = null;
  private readyPromise: Promise<void> | null = null;
  private ctidMaps = new Map<string, Map<string, string>>();
  private rowSeq = 0;
  private lastState: DBState = emptyState();

  isReady(): boolean {
    return this.db !== null;
  }

  ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        const { PGlite } = await import('@electric-sql/pglite');
        const db = new PGlite();
        await db.waitReady;
        this.db = db;
      })();
    }
    return this.readyPromise;
  }

  reset(): void {
    this.db = null;
    this.readyPromise = null;
    this.ctidMaps = new Map();
    this.rowSeq = 0;
    this.lastState = emptyState();
  }

  private newRowId(): string {
    return `r${(this.rowSeq++).toString(36)}`;
  }

  async run(sql: string, canvasWidth: number): Promise<RunResult> {
    await this.ensureReady();
    const db = this.db!;

    const rawStatements = splitStatements(sql);
    if (rawStatements.length === 0) return { results: [] };

    // Pre-flight gate: classify + validate every statement against the
    // supported-subset allowlist before executing any of them, mirroring the
    // previous all-or-nothing parseError behavior.
    const parsed: { raw: string; stmt: Parsed }[] = [];
    for (const raw of rawStatements) {
      const { statements, error } = parseSql(raw);
      if (error) return { results: [], parseError: error };
      parsed.push({ raw, stmt: statements[0] });
    }

    const results: StatementResult[] = [];
    let current = this.lastState;

    for (const { raw, stmt } of parsed) {
      const label = buildLabel(stmt);

      try {
        await db.query(raw);
      } catch (e) {
        results.push({ label, state: current, events: [], error: formatPgError(e) });
        break;
      }

      const next = await this.snapshotAfter(stmt, current);
      const laidOut = layoutTables(next, canvasWidth);
      const events = diffStates(current, laidOut);
      results.push({ label, state: laidOut, events });
      current = laidOut;
    }

    this.lastState = current;
    return { results };
  }

  private async snapshotAfter(stmt: Parsed, current: DBState): Promise<DBState> {
    const db = this.db!;

    if (stmt.type === 'create') {
      const next = cloneState(current);
      next.tables[stmt.table] = { name: stmt.table, columns: stmt.columns, rows: [], x: 0, y: 0 };
      next.order.push(stmt.table);
      next.lastSelect = null;
      next.version++;
      this.ctidMaps.set(stmt.table, new Map());
      return next;
    }

    if (stmt.type === 'insert') {
      const table = current.tables[stmt.table];
      const next = cloneState(current);
      const ctidMap = this.ctidMaps.get(stmt.table) ?? new Map<string, string>();
      this.ctidMaps.set(stmt.table, ctidMap);

      const colList = table.columns.map((c) => quoteIdent(c.name)).join(', ');
      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT ctid::text AS __ctid, ${colList} FROM ${quoteIdent(stmt.table)} ORDER BY ctid`,
      );
      const newRows: Row[] = rows.map((r) => {
        const ctid = String(r.__ctid);
        let id = ctidMap.get(ctid);
        if (!id) {
          id = this.newRowId();
          ctidMap.set(ctid, id);
        }
        const values: Row['values'] = {};
        for (const c of table.columns) values[c.name] = normalizeValue(r[c.name]);
        return { id, values };
      });

      next.tables[stmt.table] = { ...next.tables[stmt.table], rows: newRows };
      next.lastSelect = null;
      next.version++;
      return next;
    }

    // select: no data mutation, only recompute filteredOut against existing rows
    const table = current.tables[stmt.table];
    const next = cloneState(current);
    const ctidMap = this.ctidMaps.get(stmt.table) ?? new Map<string, string>();

    let matchedIds: Set<string> | null = null;
    if (stmt.where) {
      const { rows } = await db.query<{ __ctid: string }>(
        `SELECT ctid::text AS __ctid FROM ${quoteIdent(stmt.table)} WHERE ${quoteIdent(stmt.where.column)} ${stmt.where.operator} $1`,
        [stmt.where.value],
      );
      matchedIds = new Set(rows.map((r) => ctidMap.get(String(r.__ctid))).filter((id): id is string => !!id));
    }

    next.tables[stmt.table] = {
      ...next.tables[stmt.table],
      rows: table.rows.map((r) => ({ ...r, filteredOut: matchedIds ? !matchedIds.has(r.id) : false })),
    };
    next.lastSelect = { table: stmt.table, columns: stmt.columns, where: stmt.where };
    next.version++;
    return next;
  }
}
