import { Parser } from 'node-sql-parser';
import type { Column, WhereClause } from './types';
import { normalizeType } from './reducer';

const parser = new Parser();

export interface ParsedStatement {
  type: 'create' | 'insert' | 'select';
}

export interface ParsedCreate extends ParsedStatement {
  type: 'create';
  table: string;
  columns: Column[];
}

export interface ParsedInsert extends ParsedStatement {
  type: 'insert';
  table: string;
  columns: string[] | null;
  rows: (string | number | boolean | null)[][];
}

export interface ParsedSelect extends ParsedStatement {
  type: 'select';
  table: string;
  columns: string[]; // ['*'] for SELECT *
  where: WhereClause | null;
}

export type Parsed = ParsedCreate | ParsedInsert | ParsedSelect;

function litValue(v: { type: string; value: unknown }): string | number | boolean | null {
  if (v.type === 'null') return null;
  if (v.type === 'bool') return v.value === 'true' || v.value === true;
  if (v.type === 'number') return Number(v.value);
  // single_quote_string, double_quote_string, etc.
  return String(v.value);
}

function parseWhere(w: unknown): WhereClause | null {
  if (!w || typeof w !== 'object') return null;
  const node = w as { type?: string; operator?: string; left?: unknown; right?: unknown };
  if (node.type !== 'binary_expr' || !node.operator) return null;
  const left = node.left as { type?: string; column?: string };
  const right = node.right as { type?: string; value?: unknown };
  if (left?.type !== 'column_ref' || !left.column) return null;
  return {
    column: left.column,
    operator: node.operator,
    value: right ? litValue(right as { type: string; value: unknown }) : null,
  };
}

export function parseSql(sql: string): { statements: Parsed[]; error?: string } {
  let ast: unknown;
  try {
    ast = parser.parse(sql);
  } catch (e) {
    return { statements: [], error: `Parse error: ${(e as Error).message}` };
  }
  const list = Array.isArray(ast) ? ast : [ast];
  const out: Parsed[] = [];
  for (const item of list) {
    const root = (item as { ast?: unknown }).ast ?? item;
    // For multiple statements, .ast is itself an array of statement nodes
    const stmts = Array.isArray(root) ? root : [root];
    for (const snode of stmts) {
      const node = snode as { type?: string; keyword?: string };
      if (node.type === 'create' && node.keyword === 'table') {
        const table = (snode as { table?: { table?: string }[] }).table?.[0]?.table;
        const defs = (snode as { create_definitions?: unknown[] }).create_definitions;
        if (!table || !defs) continue;
        const columns: Column[] = defs
          .filter((d) => (d as { resource?: string }).resource === 'column')
          .map((d) => {
            const def = d as { column: { column: string }; definition: { dataType: string } };
            return { name: def.column.column, type: normalizeType(def.definition.dataType) };
          });
        out.push({ type: 'create', table, columns });
      } else if (node.type === 'insert') {
        const table = (snode as { table?: { table?: string }[] }).table?.[0]?.table;
        const cols = (snode as { columns?: string[] }).columns ?? null;
        const valuesNode = (snode as { values?: { values?: Array<{ value: { type: string; value: unknown }[] }> } }).values;
        const values = valuesNode?.values ?? [];
        const rows = values.map((row) => row.value.map((v) => litValue(v)));
        if (!table) continue;
        out.push({ type: 'insert', table, columns: cols, rows });
      } else if (node.type === 'select') {
        const table = (snode as { from?: { table?: string }[] }).from?.[0]?.table;
        const cols = (snode as { columns?: { expr: { type: string; column?: string } }[] }).columns ?? [];
        const colNames = cols.some((c) => c.expr.type === 'star')
          ? ['*']
          : (cols.map((c) => c.expr.column).filter(Boolean) as string[]);
        const where = parseWhere((snode as { where?: unknown }).where);
        if (!table) continue;
        out.push({ type: 'select', table, columns: colNames, where });
      } else {
        return { statements: [], error: `Unsupported statement type: ${node.type ?? 'unknown'}` };
      }
    }
  }
  return { statements: out };
}
