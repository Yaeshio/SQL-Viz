import type { PGlite } from '@electric-sql/pglite';
import type { AnimationEvent, AppMode, DBState, Row, WhereClause } from '../types';
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

/** github-sync-spec.md 3節の許可マトリクス。design/experimentは相互排他で、
 * 一方が構造(CREATE/ALTER/DROP)、他方がデータ(SELECT/INSERT/UPDATE/DELETE)を担う。 */
const MODE_ALLOWED_TYPES: Record<AppMode, ReadonlySet<Parsed['type']>> = {
  design: new Set(['create', 'alter', 'drop']),
  experiment: new Set(['select', 'insert', 'update', 'delete']),
};

interface DesignCheckpoint {
  ctidMaps: Map<string, Map<string, string>>;
  lastState: DBState;
  rowSeq: number;
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
  if (stmt.type === 'alter') {
    return stmt.action === 'add'
      ? `ALTER TABLE ${stmt.table} ADD COLUMN ${stmt.column.name}`
      : `ALTER TABLE ${stmt.table} DROP COLUMN ${stmt.column}`;
  }
  if (stmt.type === 'drop') {
    return `DROP TABLE ${stmt.table}`;
  }
  if (stmt.type === 'update') {
    const w = stmt.where ? ` WHERE ${stmt.where.column} ${stmt.where.operator} ${String(stmt.where.value)}` : '';
    return `UPDATE ${stmt.table} SET ${stmt.set.map((s) => s.column).join(', ')}${w}`;
  }
  if (stmt.type === 'delete') {
    const w = stmt.where ? ` WHERE ${stmt.where.column} ${stmt.where.operator} ${String(stmt.where.value)}` : '';
    return `DELETE FROM ${stmt.table}${w}`;
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
  private inExperimentTx = false;
  private designCheckpoint: DesignCheckpoint | null = null;

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
    this.inExperimentTx = false;
    this.designCheckpoint = null;
  }

  private newRowId(): string {
    return `r${(this.rowSeq++).toString(36)}`;
  }

  private cloneCtidMaps(): Map<string, Map<string, string>> {
    const copy = new Map<string, Map<string, string>>();
    for (const [table, inner] of this.ctidMaps) copy.set(table, new Map(inner));
    return copy;
  }

  /**
   * Undoes every data change (INSERT/UPDATE/DELETE) made since experiment
   * mode was entered, via a plain Postgres ROLLBACK of the transaction opened
   * on first experiment-mode statement. Structural statements are never
   * allowed in experiment mode (mode gate in run()), so a ROLLBACK can never
   * discard schema changes here. No-ops if experiment mode was never entered
   * (or already returned from) since the last reset/init.
   */
  async returnToDesign(): Promise<DBState | null> {
    if (!this.inExperimentTx || !this.designCheckpoint) return null;
    const db = this.db!;
    await db.query('ROLLBACK');
    const { ctidMaps, lastState, rowSeq } = this.designCheckpoint;
    this.ctidMaps = ctidMaps;
    this.lastState = lastState;
    this.rowSeq = rowSeq;
    this.inExperimentTx = false;
    this.designCheckpoint = null;
    return lastState;
  }

  /**
   * Resolves which stable row ids a WHERE clause matches, via the same
   * ctid-lookup pattern used by SELECT. For UPDATE/DELETE this MUST be called
   * before the raw statement executes: Postgres assigns an updated row a new
   * physical ctid, so matching afterward would misidentify updated rows as
   * newly-inserted ones instead of preserving their stable id. Returns null
   * to mean "no WHERE clause, all rows match" (mirrors SELECT's matchedIds).
   */
  private async resolveMatchedIds(db: PGlite, table: string, where: WhereClause | null): Promise<Set<string> | null> {
    if (!where) return null;
    const ctidMap = this.ctidMaps.get(table) ?? new Map<string, string>();
    const { rows } = await db.query<{ __ctid: string }>(
      `SELECT ctid::text AS __ctid FROM ${quoteIdent(table)} WHERE ${quoteIdent(where.column)} ${where.operator} $1`,
      [where.value],
    );
    return new Set(rows.map((r) => ctidMap.get(String(r.__ctid))).filter((id): id is string => !!id));
  }

  async run(sql: string, canvasWidth: number, mode: AppMode): Promise<RunResult> {
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

    // Mode gate: a second, independent allowlist on top of the syntax gate
    // above (github-sync-spec.md 3節). All-or-nothing, same shape as a parse
    // error: one disallowed statement type rejects the whole batch untouched.
    const allowedTypes = MODE_ALLOWED_TYPES[mode];
    const disallowed = parsed.find(({ stmt }) => !allowedTypes.has(stmt.type));
    if (disallowed) {
      return {
        results: [],
        parseError: `Statement type "${disallowed.stmt.type}" is not allowed in ${mode} mode`,
      };
    }

    // Lazily open the experiment transaction on the first experiment-mode
    // statement actually executed, not on the mode toggle itself, so flipping
    // modes without running anything stays a no-op. Everything done in
    // experiment mode (across any number of Run clicks) accumulates in this
    // one uncommitted transaction until returnToDesign() rolls it back.
    if (mode === 'experiment' && !this.inExperimentTx) {
      this.designCheckpoint = {
        ctidMaps: this.cloneCtidMaps(),
        lastState: this.lastState,
        rowSeq: this.rowSeq,
      };
      await db.query('BEGIN');
      this.inExperimentTx = true;
    }

    const results: StatementResult[] = [];
    let current = this.lastState;

    for (const { raw, stmt } of parsed) {
      const label = buildLabel(stmt);

      let matchedIds: Set<string> | null = null;
      if (stmt.type === 'update' || stmt.type === 'delete') {
        try {
          matchedIds = await this.resolveMatchedIds(db, stmt.table, stmt.where);
        } catch (e) {
          results.push({ label, state: current, events: [], error: formatPgError(e) });
          break;
        }
      }

      try {
        await db.query(raw);
      } catch (e) {
        results.push({ label, state: current, events: [], error: formatPgError(e) });
        break;
      }

      const next = await this.snapshotAfter(stmt, current, matchedIds);
      const laidOut = layoutTables(next, canvasWidth);
      const events = diffStates(current, laidOut);
      results.push({ label, state: laidOut, events });
      current = laidOut;
    }

    this.lastState = current;
    return { results };
  }

  private async snapshotAfter(stmt: Parsed, current: DBState, matchedIds: Set<string> | null = null): Promise<DBState> {
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

    if (stmt.type === 'drop') {
      const next = cloneState(current);
      delete next.tables[stmt.table];
      next.order = next.order.filter((name) => name !== stmt.table);
      this.ctidMaps.delete(stmt.table);
      if (next.lastSelect?.table === stmt.table) next.lastSelect = null;
      next.version++;
      return next;
    }

    if (stmt.type === 'alter') {
      const next = cloneState(current);
      const table = next.tables[stmt.table];
      if (stmt.action === 'add') {
        const column = stmt.column;
        next.tables[stmt.table] = {
          ...table,
          columns: [...table.columns, column],
          rows: table.rows.map((r) => ({ ...r, values: { ...r.values, [column.name]: null } })),
        };
      } else {
        const columnName = stmt.column;
        next.tables[stmt.table] = {
          ...table,
          columns: table.columns.filter((c) => c.name !== columnName),
          rows: table.rows.map((r) => {
            const values = { ...r.values };
            delete values[columnName];
            return { ...r, values };
          }),
        };
      }
      next.lastSelect = null;
      next.version++;
      return next;
    }

    if (stmt.type === 'update') {
      const table = current.tables[stmt.table];
      const next = cloneState(current);
      const setEntries = stmt.set.map((s) => [s.column, s.value] as const);
      next.tables[stmt.table] = {
        ...next.tables[stmt.table],
        rows: table.rows.map((r) =>
          matchedIds === null || matchedIds.has(r.id)
            ? { ...r, values: { ...r.values, ...Object.fromEntries(setEntries) } }
            : r,
        ),
      };
      next.lastSelect = null;
      next.version++;
      return next;
    }

    if (stmt.type === 'delete') {
      const next = cloneState(current);
      const ctidMap = this.ctidMaps.get(stmt.table);
      const rows = current.tables[stmt.table].rows.filter((r) => !(matchedIds === null || matchedIds.has(r.id)));
      next.tables[stmt.table] = { ...next.tables[stmt.table], rows };
      if (ctidMap) {
        for (const [ctid, id] of ctidMap) {
          if (matchedIds === null || matchedIds.has(id)) ctidMap.delete(ctid);
        }
      }
      next.lastSelect = null;
      next.version++;
      return next;
    }

    // select: no data mutation, only recompute filteredOut against existing rows
    const table = current.tables[stmt.table];
    const next = cloneState(current);
    const filterMatchedIds = await this.resolveMatchedIds(db, stmt.table, stmt.where);

    next.tables[stmt.table] = {
      ...next.tables[stmt.table],
      rows: table.rows.map((r) => ({ ...r, filteredOut: filterMatchedIds ? !filterMatchedIds.has(r.id) : false })),
    };
    next.lastSelect = { table: stmt.table, columns: stmt.columns, where: stmt.where };
    next.version++;
    return next;
  }
}
