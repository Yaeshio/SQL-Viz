import type { Connect, Plugin, ViteDevServer } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ServerResponse } from 'node:http';

async function readRequestBody(req: Connect.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Vite dev-server plugin exposing GET/POST /api/schema, scoped to a single
 * file path fixed at plugin-construction time (CLI startup) — the path is
 * never accepted from the request, to avoid an arbitrary-file-write
 * vulnerability. Binding the server to 127.0.0.1 is the caller's
 * responsibility (scripts/openLocal.mjs), not this plugin's. */
export function buildApiPlugin(filePath: string): Plugin {
  return {
    name: 'sql-viz-local-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/schema', async (req, res, next) => {
        try {
          if (req.method === 'GET') {
            let content = '';
            try {
              content = await readFile(filePath, 'utf-8');
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            }
            sendJson(res, 200, { content });
            return;
          }

          if (req.method === 'POST') {
            const raw = await readRequestBody(req);
            let body: { content?: unknown };
            try {
              body = raw ? JSON.parse(raw) : {};
            } catch {
              sendJson(res, 400, { error: 'invalid JSON body' });
              return;
            }
            if (typeof body.content !== 'string') {
              sendJson(res, 400, { error: 'content must be a string' });
              return;
            }
            await mkdir(dirname(filePath), { recursive: true });
            await writeFile(filePath, body.content, 'utf-8');
            sendJson(res, 200, { ok: true });
            return;
          }

          next();
        } catch (err) {
          sendJson(res, 500, { ok: false, error: errorMessage(err) });
        }
      });
    },
  };
}
