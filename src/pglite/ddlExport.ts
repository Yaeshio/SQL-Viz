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

/**
 * 与えられたテーブルの CREATE TABLE DDL を `order` の順で、DBState からではなく
 * PGlite の information_schema から生成する。そのため normalizeType() が丸めて
 * 落としてしまう精度（例: VARCHAR(50) の長さ）がエクスポートに残る
 * （mode-and-sql-scope-spec.md 3節）。制約（PK/FK/NOT NULL/DEFAULT）は同節のとおり
 * MVP スコープ外。
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

    const columnLines = rows.map((col) => `  ${quoteIdent(col.column_name)} ${formatColumnType(col)}`);
    statements.push(`CREATE TABLE ${quoteIdent(table)} (\n${columnLines.join(',\n')}\n);`);
  }

  return statements.join('\n\n');
}
