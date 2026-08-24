// Default import + runtime destructure (not a named import): node-sql-parser
// is a plain CJS package with no "exports" map, and Node's native ESM loader
// (used when scripts/openLocal.mjs runs outside Vite's bundler resolution)
// can't always statically detect named CJS exports the way Vite/esbuild does.
import pkg from 'node-sql-parser';
const { Parser } = pkg;
import type { Column, WhereClause } from './types';
import { normalizeType } from './reducer.ts';

const parser = new Parser();

export interface ParsedStatement {
  type: 'create' | 'insert' | 'select' | 'alter' | 'drop' | 'update' | 'delete';
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

export interface ParsedAlterAddColumn extends ParsedStatement {
  type: 'alter';
  action: 'add';
  table: string;
  column: Column;
}

export interface ParsedAlterDropColumn extends ParsedStatement {
  type: 'alter';
  action: 'drop';
  table: string;
  column: string;
}

export type ParsedAlter = ParsedAlterAddColumn | ParsedAlterDropColumn;

export interface ParsedDrop extends ParsedStatement {
  type: 'drop';
  table: string;
}

export interface ParsedUpdate extends ParsedStatement {
  type: 'update';
  table: string;
  set: { column: string; value: string | number | boolean | null }[];
  where: WhereClause | null;
}

export interface ParsedDelete extends ParsedStatement {
  type: 'delete';
  table: string;
  where: WhereClause | null;
}

export type Parsed = ParsedCreate | ParsedInsert | ParsedSelect | ParsedAlter | ParsedDrop | ParsedUpdate | ParsedDelete;

/**
 * Thrown when a statement matches a supported statement type (create/insert/select)
 * but contains a clause/shape outside the supported subset. Caught in parseSql() and
 * turned into a top-level parse error, the same way an unsupported statement type is.
 * This is deliberately an allowlist (only the known-supported shape passes) rather than
 * a blocklist of named unsupported clauses, so constructs that were never enumerated
 * (e.g. UNION) fail loudly instead of being silently ignored.
 */
class UnsupportedClauseError extends Error {}

/**
 * Under the PostgreSQL dialect, node-sql-parser represents several unset clauses
 * (DISTINCT, LIMIT) as populated-but-empty objects (e.g. `{ type: null }`,
 * `{ seperator: '', value: [] }`) rather than `null` as in the default dialect.
 * Recurse into plain objects/strings so these still count as empty for gating,
 * while an object with any genuinely populated field (e.g. an actual LIMIT
 * value) still correctly counts as non-empty.
 */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.every(isEmpty);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every(isEmpty);
  return false;
}

function assertNoExtraClauses(node: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(node)) {
    if (allowed.has(key) || isEmpty(node[key])) continue;
    throw new UnsupportedClauseError(`Unsupported clause: ${key}`);
  }
}

/**
 * Under the PostgreSQL dialect, node-sql-parser wraps identifier names (column_ref.column,
 * an INSERT column list entry) in a nested `{ value: '...' }` or `{ expr: { value: '...' } }`
 * shape instead of the flat string used elsewhere (e.g. the default dialect, or the `'*'`
 * of `SELECT *`). Unwrap either shape down to the plain identifier string.
 */
function identName(node: unknown): string {
  if (typeof node === 'string') return node;
  const obj = node as { expr?: unknown; value?: unknown };
  if (obj.expr !== undefined) return identName(obj.expr);
  return String(obj.value ?? '');
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
  const left = node.left as { type?: string; column?: unknown } | undefined;
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
    column: identName(left!.column),
    operator: node.operator!,
    value: litValue(right as { type: string; value: unknown }),
  };
}

const CREATE_ALLOWED_FIELDS = new Set(['type', 'keyword', 'table', 'create_definitions']);
const INSERT_ALLOWED_FIELDS = new Set(['type', 'table', 'columns', 'values', 'prefix']);
const SELECT_ALLOWED_FIELDS = new Set(['type', 'columns', 'from', 'where', 'into', 'options', 'collate']);
// MVPスコープは単一の ADD COLUMN / DROP COLUMN のみ（mode-and-sql-scope-spec.md 4節）。
// `if_exists`/`prefix`（ALTER TABLE IF EXISTS）はいずれも許可リストに含めないことで、
// 値が populate された場合に assertNoExtraClauses が Unsupported clause として拒否する。
const ALTER_ALLOWED_FIELDS = new Set(['type', 'keyword', 'table', 'expr']);
// `if_not_exists`/`if_exists`（列単位の IF NOT EXISTS/IF EXISTS）、`nullable`/`default_val`
// （NOT NULL 等の制約付与）はいずれも許可リストに含めない（同上の理由）。
const ALTER_ACTION_ALLOWED_FIELDS = new Set(['type', 'action', 'column', 'definition', 'resource', 'keyword']);
// `prefix`（DROP TABLE IF EXISTS）は許可リストに含めない。
const DROP_ALLOWED_FIELDS = new Set(['type', 'keyword', 'name']);
// `with`（CTE）/`from`（UPDATE ... FROM）/`returning` はいずれも許可リストに含めない。
const UPDATE_ALLOWED_FIELDS = new Set(['type', 'table', 'set', 'where']);
// `returning` は許可リストに含めない。`from` は DELETE FROM の対象テーブルを表す必須フィールド。
const DELETE_ALLOWED_FIELDS = new Set(['type', 'table', 'from', 'where']);

export function parseSql(sql: string): { statements: Parsed[]; error?: string } {
  let ast: unknown;
  try {
    ast = parser.parse(sql, { database: 'PostgreSQL' });
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
            const def = d as { resource?: string; column?: { column: unknown }; definition?: { dataType: string } };
            if (def.resource !== 'column') {
              throw new UnsupportedClauseError(`Unsupported clause: ${def.resource ?? 'create_definition'}`);
            }
            return { name: identName(def.column!.column), type: normalizeType(def.definition!.dataType) };
          });
          out.push({ type: 'create', table, columns });
        } else if (node.type === 'insert') {
          assertNoExtraClauses(node, INSERT_ALLOWED_FIELDS);
          const table = (snode as { table?: { table?: string }[] }).table?.[0]?.table;
          const colsRaw = (snode as { columns?: unknown[] }).columns ?? null;
          const cols = colsRaw ? colsRaw.map((c) => identName(c)) : null;
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
          const colsNode = (snode as { columns?: { expr: { type: string; column?: unknown } }[] }).columns ?? [];
          let colNames: string[];
          if (colsNode.length === 1 && colsNode[0].expr.type === 'star') {
            colNames = ['*'];
          } else {
            colNames = colsNode.map((c) => {
              if (c.expr.type !== 'column_ref' || !c.expr.column) {
                throw new UnsupportedClauseError('Unsupported clause: SELECT column expression');
              }
              return identName(c.expr.column);
            });
          }
          const where = parseWhere((snode as { where?: unknown }).where);
          out.push({ type: 'select', table, columns: colNames, where });
        } else if (node.type === 'alter' && node.keyword === 'table') {
          assertNoExtraClauses(node, ALTER_ALLOWED_FIELDS);
          const table = (snode as { table?: { table?: string }[] }).table?.[0]?.table;
          const expr = (snode as { expr?: unknown[] }).expr;
          if (!table || !expr || expr.length === 0) {
            throw new UnsupportedClauseError('Unsupported clause: ALTER TABLE');
          }
          if (expr.length > 1) {
            throw new UnsupportedClauseError('Unsupported clause: ALTER TABLE with multiple actions');
          }
          const action = expr[0] as Record<string, unknown> & {
            action?: string;
            resource?: string;
            column?: { column: unknown };
            definition?: { dataType: string };
          };
          assertNoExtraClauses(action, ALTER_ACTION_ALLOWED_FIELDS);
          if (action.resource !== 'column') {
            throw new UnsupportedClauseError(`Unsupported clause: ALTER TABLE ${action.resource ?? 'action'}`);
          }
          const columnName = identName(action.column!.column);
          if (action.action === 'add') {
            if (!action.definition) {
              throw new UnsupportedClauseError('Unsupported clause: ALTER TABLE add');
            }
            out.push({
              type: 'alter',
              action: 'add',
              table,
              column: { name: columnName, type: normalizeType(action.definition.dataType) },
            });
          } else if (action.action === 'drop') {
            out.push({ type: 'alter', action: 'drop', table, column: columnName });
          } else {
            throw new UnsupportedClauseError(`Unsupported clause: ALTER TABLE ${action.action ?? 'action'}`);
          }
        } else if (node.type === 'drop' && node.keyword === 'table') {
          assertNoExtraClauses(node, DROP_ALLOWED_FIELDS);
          const names = (snode as { name?: { table?: string }[] }).name;
          if (!names || names.length === 0 || !names[0].table) {
            throw new UnsupportedClauseError('Unsupported clause: DROP TABLE');
          }
          if (names.length > 1) {
            throw new UnsupportedClauseError('Unsupported clause: DROP TABLE with multiple tables');
          }
          out.push({ type: 'drop', table: names[0].table });
        } else if (node.type === 'update') {
          assertNoExtraClauses(node, UPDATE_ALLOWED_FIELDS);
          const table = (snode as { table?: { table?: string }[] }).table?.[0]?.table;
          const setList = (snode as { set?: { column: unknown; value: { type: string; value: unknown } }[] }).set;
          if (!table || !setList || setList.length === 0) {
            throw new UnsupportedClauseError('Unsupported clause: UPDATE');
          }
          const set = setList.map((s) => {
            if (!LITERAL_TYPES.has(s.value?.type ?? '')) {
              throw new UnsupportedClauseError('Unsupported clause: SET value');
            }
            return { column: identName(s.column), value: litValue(s.value) };
          });
          const updateWhere = parseWhere((snode as { where?: unknown }).where);
          out.push({ type: 'update', table, set, where: updateWhere });
        } else if (node.type === 'delete') {
          assertNoExtraClauses(node, DELETE_ALLOWED_FIELDS);
          const fromList = (snode as { from?: { table?: string }[] }).from;
          if (!fromList || fromList.length === 0 || !fromList[0].table) {
            throw new UnsupportedClauseError('Unsupported clause: DELETE FROM');
          }
          if (fromList.length > 1) {
            throw new UnsupportedClauseError('Unsupported clause: DELETE FROM with multiple tables');
          }
          const deleteWhere = parseWhere((snode as { where?: unknown }).where);
          out.push({ type: 'delete', table: fromList[0].table, where: deleteWhere });
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
