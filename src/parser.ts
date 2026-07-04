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

/**
 * Thrown when a statement matches a supported statement type (create/insert/select)
 * but contains a clause/shape outside the supported subset. Caught in parseSql() and
 * turned into a top-level parse error, the same way an unsupported statement type is.
 * This is deliberately an allowlist (only the known-supported shape passes) rather than
 * a blocklist of named unsupported clauses, so constructs that were never enumerated
 * (e.g. UNION) fail loudly instead of being silently ignored.
 */
class UnsupportedClauseError extends Error {}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

function assertNoExtraClauses(node: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(node)) {
    if (allowed.has(key) || isEmpty(node[key])) continue;
    throw new UnsupportedClauseError(`Unsupported clause: ${key}`);
  }
}

function litValue(v: { type: string; value: unknown }): string | number | boolean | null {
  if (v.type === 'null') return null;
  if (v.type === 'bool' || v.type === 'boolean') return v.value === 'true' || v.value === true;
  if (v.type === 'number') return Number(v.value);
  // single_quote_string, double_quote_string, string, etc.
  return String(v.value);
}

const WHERE_OPERATORS = new Set(['=', '!=', '<>', '>', '<', '>=', '<=']);
const LITERAL_TYPES = new Set(['null', 'bool', 'boolean', 'number', 'single_quote_string', 'double_quote_string', 'string']);

function parseWhere(w: unknown): WhereClause | null {
  if (isEmpty(w)) return null;
  const node = w as { type?: string; operator?: string; left?: unknown; right?: unknown };
  const left = node.left as { type?: string; column?: string } | undefined;
  const right = node.right as { type?: string; value?: unknown } | undefined;
  const isSupportedComparison =
    node.type === 'binary_expr' &&
    !!node.operator &&
    WHERE_OPERATORS.has(node.operator) &&
    left?.type === 'column_ref' &&
    !!left.column &&
    !!right &&
    LITERAL_TYPES.has(right.type ?? '');
  if (!isSupportedComparison) {
    throw new UnsupportedClauseError('Unsupported clause: WHERE');
  }
  return {
    column: left!.column!,
    operator: node.operator!,
    value: litValue(right as { type: string; value: unknown }),
  };
}

const CREATE_ALLOWED_FIELDS = new Set(['type', 'keyword', 'table', 'create_definitions']);
const INSERT_ALLOWED_FIELDS = new Set(['type', 'table', 'columns', 'values', 'prefix']);
const SELECT_ALLOWED_FIELDS = new Set(['type', 'columns', 'from', 'where', 'into', 'options', 'collate']);

export function parseSql(sql: string): { statements: Parsed[]; error?: string } {
  let ast: unknown;
  try {
    ast = parser.parse(sql);
  } catch (e) {
    return { statements: [], error: `Parse error: ${(e as Error).message}` };
  }
  const list = Array.isArray(ast) ? ast : [ast];
  const out: Parsed[] = [];
  try {
    for (const item of list) {
      const root = (item as { ast?: unknown }).ast ?? item;
      // For multiple statements, .ast is itself an array of statement nodes
      const stmts = Array.isArray(root) ? root : [root];
      for (const snode of stmts) {
        const node = snode as Record<string, unknown> & { type?: string; keyword?: string };
        if (node.type === 'create' && node.keyword === 'table') {
          assertNoExtraClauses(node, CREATE_ALLOWED_FIELDS);
          const table = (snode as { table?: { table?: string }[] }).table?.[0]?.table;
          const defs = (snode as { create_definitions?: unknown[] }).create_definitions;
          if (!table || !defs) {
            throw new UnsupportedClauseError('Unsupported clause: CREATE TABLE');
          }
          const columns: Column[] = defs.map((d) => {
            const def = d as { resource?: string; column?: { column: string }; definition?: { dataType: string } };
            if (def.resource !== 'column') {
              throw new UnsupportedClauseError(`Unsupported clause: ${def.resource ?? 'create_definition'}`);
            }
            return { name: def.column!.column, type: normalizeType(def.definition!.dataType) };
          });
          out.push({ type: 'create', table, columns });
        } else if (node.type === 'insert') {
          assertNoExtraClauses(node, INSERT_ALLOWED_FIELDS);
          const table = (snode as { table?: { table?: string }[] }).table?.[0]?.table;
          const cols = (snode as { columns?: string[] }).columns ?? null;
          const valuesNode = (snode as { values?: { type?: string; values?: Array<{ value: { type: string; value: unknown }[] }> } }).values;
          if (valuesNode?.type !== 'values') {
            throw new UnsupportedClauseError('Unsupported clause: INSERT ... SELECT');
          }
          const values = valuesNode.values ?? [];
          const rows = values.map((row) => row.value.map((v) => litValue(v)));
          if (!table) {
            throw new UnsupportedClauseError('Unsupported clause: INSERT');
          }
          out.push({ type: 'insert', table, columns: cols, rows });
        } else if (node.type === 'select') {
          assertNoExtraClauses(node, SELECT_ALLOWED_FIELDS);
          const fromList = (snode as { from?: Array<{ table?: string; join?: string; expr?: unknown }> }).from;
          if (!fromList || fromList.length !== 1 || fromList[0].join) {
            throw new UnsupportedClauseError('Unsupported clause: JOIN');
          }
          const fromEntry = fromList[0];
          if (fromEntry.expr) {
            throw new UnsupportedClauseError('Unsupported clause: subquery in FROM');
          }
          const table = fromEntry.table;
          if (!table) {
            throw new UnsupportedClauseError('Unsupported clause: FROM');
          }
          const colsNode = (snode as { columns?: { expr: { type: string; column?: string } }[] }).columns ?? [];
          let colNames: string[];
          if (colsNode.length === 1 && colsNode[0].expr.type === 'star') {
            colNames = ['*'];
          } else {
            colNames = colsNode.map((c) => {
              if (c.expr.type !== 'column_ref' || !c.expr.column) {
                throw new UnsupportedClauseError('Unsupported clause: SELECT column expression');
              }
              return c.expr.column;
            });
          }
          const where = parseWhere((snode as { where?: unknown }).where);
          out.push({ type: 'select', table, columns: colNames, where });
        } else {
          throw new UnsupportedClauseError(`Unsupported statement type: ${node.type ?? 'unknown'}`);
        }
      }
    }
  } catch (e) {
    if (e instanceof UnsupportedClauseError) {
      return { statements: [], error: e.message };
    }
    throw e;
  }
  return { statements: out };
}
