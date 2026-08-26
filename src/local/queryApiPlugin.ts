import type { Connect, Plugin, ViteDevServer } from 'vite';
import type { ServerResponse } from 'node:http';
import type { AppMode } from '../types';
import { PgEngine } from '../pglite/engine.ts';
import { errorMessage, readDdlFile, readRequestBody, sendJson } from './httpUtils.ts';

// Matches useSqlRunner.ts's `canvasRef.current?.clientWidth ?? 800` fallback
// — this server has no real <canvas>, so it's always that fallback value,
// not an arbitrary new constant.
const CANVAS_WIDTH = 800;

function isAppMode(value: unknown): value is AppMode {
  return value === 'design' || value === 'experiment';
}

/** Vite dev-server plugin exposing the agent-facing SQL execution API
 * (Issue #27): POST /api/query, GET /api/query/state, GET /api/query/health,
 * POST /api/query/reset. Wraps a single, server-process-lifetime PgEngine
 * session — completely independent from the browser's own PGlite instance,
 * bootstrapped from (and, on reset, re-bootstrapped from) the same DDL file
 * scripts/openLocal.mjs was given at CLI startup. */
export function buildQueryApiPlugin(filePath: string): Plugin {
  const engine = new PgEngine();
  let queue: Promise<unknown> = Promise.resolve();
  let bootstrapDone = false;
  let bootstrapError: string | null = null;

  // Runs `task` after every previously-enqueued task settles (success or
  // failure), so a single PgEngine never executes two statements/resets
  // concurrently — this is what keeps its internal ctidMap etc. from
  // corrupting under rapid/overlapping requests from one agent.
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function resetAndBootstrap(): Promise<void> {
    engine.reset();
    bootstrapError = null;
    try {
      const content = await readDdlFile(filePath);
      // Runs even for an empty file: run() always calls ensureReady() before
      // checking whether there are statements to execute, so this still
      // drives the PGlite cold start GET /api/query/health reports on.
      const result = await engine.run(content, CANVAS_WIDTH, 'design');
      if (result.parseError) {
        bootstrapError = result.parseError;
      } else {
        const failed = result.results.find((r) => r.error);
        if (failed) bootstrapError = failed.error!;
      }
    } catch (err) {
      bootstrapError = errorMessage(err);
    } finally {
      bootstrapDone = true;
    }
  }

  async function handleRun(req: Connect.IncomingMessage, res: ServerResponse) {
    const raw = await readRequestBody(req);
    let body: { sql?: unknown; mode?: unknown };
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }
    if (typeof body.sql !== 'string') {
      sendJson(res, 400, { error: 'sql must be a string' });
      return;
    }
    if (!isAppMode(body.mode)) {
      sendJson(res, 400, { error: 'mode must be "design" or "experiment"' });
      return;
    }
    const sql = body.sql;
    const mode = body.mode;
    const result = await enqueue(() => engine.run(sql, CANVAS_WIDTH, mode));
    sendJson(res, 200, result);
  }

  return {
    name: 'sql-viz-query-api',
    configureServer(server: ViteDevServer) {
      bootstrapDone = false;
      void enqueue(resetAndBootstrap);

      server.middlewares.use('/api/query', async (req, res, next) => {
        const url = (req.url ?? '/').split('?')[0];
        try {
          if (req.method === 'POST' && url === '/') {
            await handleRun(req, res);
            return;
          }
          if (req.method === 'GET' && url === '/state') {
            sendJson(res, 200, { state: engine.getState() });
            return;
          }
          if (req.method === 'GET' && url === '/health') {
            sendJson(res, 200, { ready: bootstrapDone, error: bootstrapError });
            return;
          }
          if (req.method === 'POST' && url === '/reset') {
            bootstrapDone = false;
            await enqueue(resetAndBootstrap);
            sendJson(res, 200, { ok: bootstrapError === null, error: bootstrapError });
            return;
          }
          next();
        } catch (err) {
          sendJson(res, 500, { error: errorMessage(err) });
        }
      });
    },
  };
}
