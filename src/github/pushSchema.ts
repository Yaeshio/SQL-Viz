import type { PGlite } from '@electric-sql/pglite';
import { generateDdl } from '../pglite/ddlExport';
import { putFile, type GitHubSettings } from './client';

const SCHEMA_PATH = 'schema/ddl.sql';

export async function pushSchema(db: PGlite, order: string[], settings: GitHubSettings): Promise<void> {
  const ddl = await generateDdl(db, order);
  await putFile(
    settings.owner,
    settings.repo,
    SCHEMA_PATH,
    ddl,
    `Update ${SCHEMA_PATH}`,
    settings.branch,
    settings.token,
  );
}
