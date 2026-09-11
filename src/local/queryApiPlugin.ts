import type { Connect, Plugin, ViteDevServer } from 'vite';
import type { ServerResponse } from 'node:http';
import type { AppMode } from '../types';
import { WORLD_W } from '../layout.ts';
import { PgEngine, type RunResult } from '../pglite/engine.ts';
import { errorMessage, logInfo, logWarn, readDdlFile, readRequestBody, sendJson } from './httpUtils.ts';

function isAppMode(value: unknown): value is AppMode {
  return value === 'design' || value === 'experiment';
}

export interface QueryApiPluginOptions {
  /** trueならこのプラグインのターミナルログ出力（Issue #38）を一切抑制する。
   * CLIの`--quiet`から配線される。 */
  quiet?: boolean;
}

/** GET /api/query/history（Issue #37）の1エントリ。DBState全体は持たず、
 * 人間/エージェントが「どれをreplayするか」を判断できる最小限の要約に留める。 */
export interface HistoryEntry {
  seq: number;
  sql: string;
  mode: AppMode;
  at: string;
  ok: boolean;
  parseError?: string;
  statements: { label: string; error?: string }[];
}

/** これを超えたら最も古いエントリから破棄する（メモリ上限）。seqはevictされても
 * 再利用しないため、replay時に見つからないseqは「古すぎて捨てられた」と判別できる。
 * テストがeviction境界を検証できるようexportする。 */
export const HISTORY_LIMIT = 200;

/** エージェント向けの SQL 実行 API（Issue #27）を公開する Vite dev サーバー
 * プラグイン: POST /api/query, GET /api/query/state, GET /api/query/health,
 * POST /api/query/reset, GET /api/query/history（Issue #37）。サーバープロセスの
 * 生存期間だけ生きる単一の PgEngine セッションをラップする——ブラウザ自身の PGlite
 * インスタンスとは完全に独立で、scripts/openLocal.mjs が CLI 起動時に渡されたのと
 * 同じ DDL ファイルからブートストラップされる（reset 時も同じファイルから
 * 再ブートストラップする）。 */
export function buildQueryApiPlugin(filePath: string, options: QueryApiPluginOptions = {}): Plugin {
  const { quiet = false } = options;
  const engine = new PgEngine();
  let queue: Promise<unknown> = Promise.resolve();
  let bootstrapDone = false;
  let bootstrapError: string | null = null;
  const history: HistoryEntry[] = [];
  let historySeq = 0;

  function recordHistory(sql: string, mode: AppMode, result: RunResult): void {
    history.push({
      seq: ++historySeq,
      sql,
      mode,
      at: new Date().toISOString(),
      ok: !result.parseError && !result.results.some((r) => r.error),
      ...(result.parseError ? { parseError: result.parseError } : {}),
      statements: result.results.map((r) => (r.error ? { label: r.label, error: r.error } : { label: r.label })),
    });
    if (history.length > HISTORY_LIMIT) history.shift();
  }

  /** POST /api/query の実行結果をターミナルへ1行出力する（Issue #38）。
   * recordHistory と異なり監査用の永続状態は持たず、その場でconsoleへ流すだけ。
   * SQL全文をそのまま出す（省略しない）——履歴機能（Issue #37）も全文を保持して
   * おり一貫性がある。 */
  function logQueryResult(sql: string, mode: AppMode, result: RunResult): void {
    if (result.parseError) {
      logWarn('query', `${mode} ${sql} → 拒否: ${result.parseError}`, quiet);
      return;
    }
    const failed = result.results.find((r) => r.error);
    if (failed) {
      logWarn('query', `${mode} ${sql} → エラー: ${failed.error}`, quiet);
      return;
    }
    logInfo('query', `${mode} ${sql} → OK`, quiet);
  }

  // 先にエンキューされたタスクがすべて決着（成功でも失敗でも）してから `task` を
  // 実行する。これにより単一の PgEngine が 2 つの文/リセットを同時に実行することが
  // 決してなくなる——1 エージェントからの高速/重複したリクエストのもとで内部の
  // ctidMap 等が壊れないのはこのおかげ。
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // 意図的に history/historySeq には一切触れない（Issue #37）: 履歴はDB状態とは
  // 独立した「このプロセスで何を実行したか」の監査ログであり、reset（破壊的DB
  // リセット）を跨いで残る唯一のセッション状態とする。
  async function resetAndBootstrap(): Promise<void> {
    engine.reset();
    bootstrapError = null;
    try {
      const content = await readDdlFile(filePath);
      // 空ファイルでも実行する: run() は実行すべき文があるか調べる前に必ず
      // ensureReady() を呼ぶため、これが GET /api/query/health の報告対象である
      // PGlite のコールドスタートを引き起こす。
      const result = await engine.run(content, WORLD_W, 'design');
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
    const result = await enqueue(() => engine.run(sql, WORLD_W, mode));
    recordHistory(sql, mode, result);
    logQueryResult(sql, mode, result);
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
          if (req.method === 'GET' && url === '/history') {
            sendJson(res, 200, { history });
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
