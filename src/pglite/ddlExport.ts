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
 * Generates CREATE TABLE DDL for the given tables, in `order`, from PGlite's
 * information_schema — not from DBState — so precision that normalizeType()
 * rounds away (e.g. VARCHAR(50)'s length) survives the export
 * (mode-and-sql-scope-spec.md 3節). Constraints (PK/FK/NOT NULL/DEFAULT) are
 * out of MVP scope, matching the same section.
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
