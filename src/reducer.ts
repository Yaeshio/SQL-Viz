import type { Column, ColumnType, DBState, Relation, Table } from './types';

const emptyState = (): DBState => ({
  tables: {},
  order: [],
  relations: [],
  lastSelect: null,
  version: 0,
});

const cloneState = (s: DBState): DBState => ({
  tables: Object.fromEntries(
    Object.entries(s.tables).map(([k, t]) => [
      k,
      {
        ...t,
        columns: t.columns.map((c) => (c.references ? { ...c, references: { ...c.references } } : { ...c })),
        rows: t.rows.map((r) => ({ ...r, values: { ...r.values } })),
      },
    ]),
  ),
  order: [...s.order],
  relations: s.relations.map((r) => ({ ...r })),
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

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const relationId = (fromTable: string, fromColumn: string, toTable: string, toColumn: string): string =>
  `${fromTable}.${fromColumn}->${toTable}.${toColumn}`;

/** 列から `references` を外したコピーを返す。 */
const clearReference = (c: Column): Column => {
  const copy: Column = { ...c };
  delete copy.references;
  return copy;
};

/**
 * 各列の `references` を、PG が大文字小文字を畳んで解決した先の実在する表名・列名
 * （`existing` と、同一 CREATE 内の自己参照のための `columns`）へ正規化する。
 * 解決できない参照は外す（PGlite が先に FK を検証するので通常は起きない）。
 */
const resolveColumnReferences = (
  columns: Column[],
  tableName: string,
  existing: Record<string, Table>,
): Column[] =>
  columns.map((c) => {
    const ref = c.references;
    if (!ref) return c;
    let target: { key: string; columns: Column[] } | null = null;
    if (sameName(ref.table, tableName)) {
      target = { key: tableName, columns };
    } else {
      const key = Object.keys(existing).find((k) => sameName(k, ref.table));
      if (key) target = { key, columns: existing[key].columns };
    }
    const targetColumn = target?.columns.find((tc) => sameName(tc.name, ref.column));
    if (!target || !targetColumn) return clearReference(c);
    return { ...c, references: { table: target.key, column: targetColumn.name } };
  });

/**
 * `references` を持つ列から DBState.relations を導出する（Issue #45）。`order` 順 × 列順。
 * 参照先のテーブル・列が実在しないものは含めない。
 */
const deriveRelations = (s: Pick<DBState, 'tables' | 'order'>): Relation[] => {
  const relations: Relation[] = [];
  for (const fromTable of s.order) {
    for (const col of s.tables[fromTable].columns) {
      const ref = col.references;
      if (!ref) continue;
      const target = s.tables[ref.table];
      if (!target || !target.columns.some((tc) => tc.name === ref.column)) continue;
      relations.push({
        id: relationId(fromTable, col.name, ref.table, ref.column),
        fromTable,
        fromColumn: col.name,
        toTable: ref.table,
        toColumn: ref.column,
      });
    }
  }
  return relations;
};

export {
  emptyState,
  cloneState,
  normalizeType,
  sameName,
  relationId,
  clearReference,
  resolveColumnReferences,
  deriveRelations,
};
