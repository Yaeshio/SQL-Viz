import type { Plugin, ViteDevServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errorMessage, readDdlFile, readRequestBody, sendJson } from './httpUtils.ts';

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
            const content = await readDdlFile(filePath);
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
