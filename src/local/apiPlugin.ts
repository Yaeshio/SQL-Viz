import type { Plugin, ViteDevServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { errorMessage, readDdlFile, readRequestBody, sendJson } from './httpUtils.ts';

export interface ApiPluginOptions {
  /** verify mode: reject POST /api/schema instead of overwriting the target
   * file. POST /api/schema/verify-save stays available regardless of this
   * flag — its destination is a separate, server-fixed directory, not the
   * target file, so it carries none of the risk readOnly guards against. */
  readOnly?: boolean;
  /** Directory POST /api/schema/verify-save writes into. Only meaningful
   * when the frontend actually calls that endpoint (verify mode); callers
   * that never enable verify mode may omit it. */
  saveDir?: string;
}

/** Inserts a timestamp before the original file's extension, e.g.
 * "ddl.sql" + 2026-08-26T12:34:56 -> "ddl.2026-08-26T12-34-56.sql". Colons
 * are replaced since they're invalid in filenames on Windows. `now` is
 * injectable for tests. */
export function buildVerifySaveFilename(originalFilePath: string, now: Date = new Date()): string {
  const ext = extname(originalFilePath);
  const stem = basename(originalFilePath, ext);
  const timestamp = now.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
  return `${stem}.${timestamp}${ext}`;
}

/** Vite dev-server plugin exposing GET/POST /api/schema (and, for verify
 * mode, POST /api/schema/verify-save), scoped to a single file path fixed at
 * plugin-construction time (CLI startup) — the path is never accepted from
 * the request, to avoid an arbitrary-file-write vulnerability. Binding the
 * server to 127.0.0.1 is the caller's responsibility
 * (scripts/openLocal.mjs), not this plugin's. */
export function buildApiPlugin(filePath: string, options: ApiPluginOptions = {}): Plugin {
  const { readOnly = false, saveDir } = options;
  return {
    name: 'sql-viz-local-api',
    configureServer(server: ViteDevServer) {
      // Connect's use(mountpath, fn) matches any URL starting with
      // mountpath and rewrites req.url to be relative to it, so both
      // "/api/schema" and "/api/schema/verify-save" land in this one
      // handler — subpath is what tells them apart.
      server.middlewares.use('/api/schema', async (req, res, next) => {
        const subpath = req.url === '/' || !req.url ? '' : req.url;
        try {
          if (subpath === '' && req.method === 'GET') {
            const content = await readDdlFile(filePath);
            sendJson(res, 200, { content });
            return;
          }

          if (subpath === '' && req.method === 'POST') {
            if (readOnly) {
              sendJson(res, 403, { ok: false, error: '検証モードのため保存できません' });
              return;
            }
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

          if (subpath === '/verify-save' && req.method === 'POST') {
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
            const targetDir = saveDir ?? dirname(filePath);
            const savedPath = join(targetDir, buildVerifySaveFilename(filePath));
            await mkdir(targetDir, { recursive: true });
            await writeFile(savedPath, body.content, 'utf-8');
            sendJson(res, 200, { ok: true, path: savedPath });
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
