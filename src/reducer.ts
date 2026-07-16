import type { ColumnType, DBState } from './types';

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

export { emptyState, cloneState, normalizeType };
