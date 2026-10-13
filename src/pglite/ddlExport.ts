import type { PGlite } from '@electric-sql/pglite';
import { quoteIdent } from './engine';

interface InformationSchemaColumn {
  column_name: string;
  data_type: string;
  character_maximum_length: number | null;
}

function formatColumnType(col: InformationSchemaColumn): string {
  switch (col.data_type) {
    case 'character varying':
      return col.character_maximum_length !== null ? `VARCHAR(${col.character_maximum_length})` : 'VARCHAR';
    case 'integer':
      return 'INT';
    case 'text':
      return 'TEXT';
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'DATE';
    default:
      return col.data_type.toUpperCase();
  }
}

interface PgConstraint {
  contype: string;
  cols: string[];
  ref_table: string | null;
  ref_cols: string[] | null;
}

function formatConstraint(c: PgConstraint): string | null {
  const cols = c.cols.map(quoteIdent).join(', ');
  if (c.contype === 'p') return `PRIMARY KEY (${cols})`;
  if (c.contype === 'u') return `UNIQUE (${cols})`;
  if (c.contype === 'f' && c.ref_table && c.ref_cols) {
    return `FOREIGN KEY (${cols}) REFERENCES ${quoteIdent(c.ref_table)} (${c.ref_cols.map(quoteIdent).join(', ')})`;
  }
  return null;
}

/**
 * 与えられたテーブルの CREATE TABLE DDL を `order` の順で、DBState からではなく
 * PGlite のカタログ（information_schema / pg_constraint）から生成する。そのため
 * normalizeType() が丸めて落としてしまう精度（例: VARCHAR(50) の長さ）がエクスポートに
 * 残る（mode-and-sql-scope-spec.md 3節）。
 *
 * 制約は PRIMARY KEY / UNIQUE / FOREIGN KEY を表レベル制約として列定義の後に出力する
 * （Issue #45）。FK の参照先列は Postgres が PK/UNIQUE を要求するため、これらを出さないと
 * FK 付きスキーマの Reload が `there is no unique constraint matching given keys` で
 * 失敗する。制約名は出さず、再生時に Postgres が付ける既定名に任せる。NOT NULL / DEFAULT /
 * CHECK は引き続き対象外。
 *
 * `order` は呼び出し側（state.order）の作成順を前提とする。FK は作成時に参照先が既に
 * 存在することを要求し、参照されたテーブルは CASCADE なしでは DROP できないため、
 * 作成順では参照先が必ず先に来る——ここでトポロジカルソートはしない。
 */
export async function generateDdl(db: PGlite, order: string[]): Promise<string> {
  const statements: string[] = [];

  for (const table of order) {
    const { rows } = await db.query<InformationSchemaColumn>(
      `SELECT column_name, data_type, character_maximum_length
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table],
    );

    // attname::text で text[] にして、PGlite が JS 配列として返すようにする。
    const { rows: constraintRows } = await db.query<PgConstraint>(
      `SELECT con.contype::text AS contype,
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
                 FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols,
              fc.relname::text AS ref_table,
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
                 FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS ref_cols
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_class fc ON fc.oid = con.confrelid
       WHERE n.nspname = 'public' AND c.relname = $1 AND con.contype IN ('p', 'u', 'f')
       ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 ELSE 2 END, con.oid`,
      [table],
    );

    const columnLines = rows.map((col) => `  ${quoteIdent(col.column_name)} ${formatColumnType(col)}`);
    const constraintLines = constraintRows
      .map(formatConstraint)
      .filter((line): line is string => line !== null)
      .map((line) => `  ${line}`);
    statements.push(`CREATE TABLE ${quoteIdent(table)} (\n${[...columnLines, ...constraintLines].join(',\n')}\n);`);
  }

  return statements.join('\n\n');
}
