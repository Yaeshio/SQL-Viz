import type { Column, ColumnType, DBState, Row, WhereClause } from './types';

let rowSeq = 0;
const newRowId = () => `r${(rowSeq++).toString(36)}`;

const emptyState = (): DBState => ({
  tables: {},
  order: [],
  lastSelect: null,
  version: 0,
});

const cloneState = (s: DBState): DBState => ({
  tables: Object.fromEntries(
    Object.entries(s.tables).map(([k, t]) => [
      k,
      { ...t, columns: t.columns.map((c) => ({ ...c })), rows: t.rows.map((r) => ({ ...r, values: { ...r.values } })) },
    ]),
  ),
  order: [...s.order],
  lastSelect: s.lastSelect ? { ...s.lastSelect, columns: [...s.lastSelect.columns] } : null,
  version: s.version,
});

const normalizeType = (raw: string | undefined): ColumnType => {
  if (!raw) return 'UNKNOWN';
  const u = raw.toUpperCase();
  if (u.startsWith('INT')) return 'INT';
  if (u.startsWith('VARCHAR') || u.startsWith('CHAR')) return 'VARCHAR';
  if (u.startsWith('TEXT')) return 'TEXT';
  if (u.startsWith('BOOL')) return 'BOOLEAN';
  if (u.startsWith('DATE')) return 'DATE';
  return 'UNKNOWN';
};

// ---- Statement application (pure, returns new state) ----

export interface ApplyResult {
  state: DBState;
  error?: string;
}

export function applyCreateTable(state: DBState, name: string, columns: Column[]): ApplyResult {
  if (state.tables[name]) return { state, error: `Table "${name}" already exists` };
  const next = cloneState(state);
  next.tables[name] = { name, columns, rows: [], x: 0, y: 0 };
  next.order.push(name);
  next.lastSelect = null;
  next.version++;
  return { state: next };
}

export function applyInsert(
  state: DBState,
  table: string,
  columns: string[] | null,
  values: (string | number | boolean | null)[],
): ApplyResult {
  const t = state.tables[table];
  if (!t) return { state, error: `Table "${table}" does not exist` };
  const cols = columns ?? t.columns.map((c) => c.name);
  if (values.length !== cols.length) return { state, error: `Column count mismatch` };
  const rowValues: Row['values'] = {};
  t.columns.forEach((c) => (rowValues[c.name] = null));
  cols.forEach((c, i) => {
    if (!t.columns.some((tc) => tc.name === c)) return;
    rowValues[c] = values[i];
  });
  const next = cloneState(state);
  next.tables[table].rows.push({ id: newRowId(), values: rowValues });
  next.lastSelect = null;
  next.version++;
  return { state: next };
}

function compareValue(a: unknown, op: string, b: string | number | boolean | null): boolean {
  switch (op) {
    case '=':
      return String(a) === String(b);
    case '!=':
    case '<>':
      return String(a) !== String(b);
    case '>':
      return Number(a) > Number(b);
    case '<':
      return Number(a) < Number(b);
    case '>=':
      return Number(a) >= Number(b);
    case '<=':
      return Number(a) <= Number(b);
    default:
      return false;
  }
}

export function applySelect(
  state: DBState,
  table: string,
  columns: string[],
  where: WhereClause | null,
): ApplyResult {
  const t = state.tables[table];
  if (!t) return { state, error: `Table "${table}" does not exist` };
  const next = cloneState(state);
  // reset filter flags on all rows of this table
  next.tables[table].rows = next.tables[table].rows.map((r) => ({ ...r, filteredOut: false }));
  if (where) {
    next.tables[table].rows = next.tables[table].rows.map((r) => ({
      ...r,
      filteredOut: !compareValue(r.values[where.column], where.operator, where.value),
    }));
  }
  next.lastSelect = { table, columns, where };
  next.version++;
  return { state: next };
}

export { emptyState, cloneState, normalizeType };
