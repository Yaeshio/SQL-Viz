import { readFile } from 'node:fs/promises';
import type { Connect } from 'vite';
import type { ServerResponse } from 'node:http';

export async function readRequestBody(req: Connect.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reads a UTF-8 text file, treating ENOENT as "" rather than an error —
 * shared by GET /api/schema and the agent-query-API's startup/reset DDL
 * bootstrap (both need "missing file = empty content", not a failure). */
export async function readDdlFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}
