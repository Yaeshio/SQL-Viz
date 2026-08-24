import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connect } from 'vite';

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile }));

import { buildQueryApiPlugin } from '../src/local/queryApiPlugin';

// req.url here is what Connect would deliver AFTER stripping the '/api/query'
// mount prefix (confirmed in the implementation plan by reading Vite's
// vendored connect source) — e.g. '/' for POST /api/query itself, '/state'
// for GET /api/query/state.
function makeReq(method: string, url: string, body?: string): Connect.IncomingMessage {
  async function* chunks() {
    if (body) yield Buffer.from(body, 'utf-8');
  }
  return { method, url, [Symbol.asyncIterator]: chunks } as unknown as Connect.IncomingMessage;
}

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}

function makeRes(): FakeRes {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(chunk) {
      this.body = chunk ?? '';
    },
  };
}

function getHandler(filePath: string): Connect.NextHandleFunction {
  const use = vi.fn();
  const plugin = buildQueryApiPlugin(filePath);
  const configureServer = plugin.configureServer as unknown as (server: {
    middlewares: { use: typeof use };
  }) => void;
  configureServer({ middlewares: { use } });
  expect(use).toHaveBeenCalledTimes(1);
  const [path, handler] = use.mock.calls[0];
  expect(path).toBe('/api/query');
  return handler as Connect.NextHandleFunction;
}

async function waitForReady(handler: Connect.NextHandleFunction, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const res = makeRes();
    await handler(makeReq('GET', '/health'), res as never, vi.fn());
    const { ready } = JSON.parse(res.body);
    if (ready) return;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for /api/query/health readiness');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function runSql(handler: Connect.NextHandleFunction, sql: string, mode: 'design' | 'experiment' = 'design') {
  const res = makeRes();
  await handler(makeReq('POST', '/', JSON.stringify({ sql, mode })), res as never, vi.fn());
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

beforeEach(() => {
  readFile.mockReset();
});

describe('buildQueryApiPlugin', () => {
  it('QUERY-API-01: buildQueryApiPlugin が name "sql-viz-query-api" のViteプラグインを返す', () => {
    readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const plugin = buildQueryApiPlugin('/abs/schema.sql');
    expect(plugin.name).toBe('sql-viz-query-api');
  });

  it('QUERY-API-02: 起動時ブートストラップ — 非空DDLの内容がGET /stateに反映される', async () => {
    readFile.mockResolvedValue('CREATE TABLE users (id INT, name VARCHAR(50));');
    const handler = getHandler('/abs/schema.sql');
    await waitForReady(handler);

    const res = makeRes();
    await handler(makeReq('GET', '/state'), res as never, vi.fn());
    const { state } = JSON.parse(res.body);
    expect(state.tables.users.columns).toEqual([
      { name: 'id', type: 'INT' },
      { name: 'name', type: 'VARCHAR' },
    ]);
  });

  it('QUERY-API-03: ファイル不在(ENOENT) — 空のDBStateからブートストラップする', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const handler = getHandler('/abs/schema.sql');
    await waitForReady(handler);

    const res = makeRes();
    await handler(makeReq('GET', '/state'), res as never, vi.fn());
    const { state } = JSON.parse(res.body);
    expect(state.order).toEqual([]);
  });

  it('QUERY-API-04: POST /api/query — 呼び出しをまたいで状態が蓄積する', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const handler = getHandler('/abs/schema.sql');
    await waitForReady(handler);

    const create = await runSql(handler, 'CREATE TABLE users (id INT, name VARCHAR(50))', 'design');
    expect(create.status).toBe(200);
    expect(create.body.results[0].error).toBeUndefined();

    const insert = await runSql(handler, "INSERT INTO users (id, name) VALUES (1, 'Alice')", 'experiment');
    expect(insert.status).toBe(200);
    expect(insert.body.results[0].error).toBeUndefined();

    const select = await runSql(handler, 'SELECT id, name FROM users', 'experiment');
    expect(select.status).toBe(200);
    const rows = select.body.results[0].state.tables.users.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].values).toEqual({ id: 1, name: 'Alice' });
  });

  it('QUERY-API-05: モードゲート違反 — design中にselectを送るとstatus 200 + parseError', async () => {
    readFile.mockResolvedValue('CREATE TABLE users (id INT);');
    const handler = getHandler('/abs/schema.sql');
    await waitForReady(handler);

    const { status, body } = await runSql(handler, 'SELECT * FROM users', 'design');
    expect(status).toBe(200);
    expect(body.parseError).toContain('is not allowed in design mode');
  });

  it('QUERY-API-06: 不正なJSONボディ → status 400', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const handler = getHandler('/abs/schema.sql');
    await waitForReady(handler);

    const res = makeRes();
    await handler(makeReq('POST', '/', 'not json'), res as never, vi.fn());
    expect(res.statusCode).toBe(400);
  });

  it('QUERY-API-07: sqlフィールドが文字列でない → status 400', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const handler = getHandler('/abs/schema.sql');
    await waitForReady(handler);

    const res = makeRes();
    await handler(makeReq('POST', '/', JSON.stringify({ sql: 123, mode: 'design' })), res as never, vi.fn());
    expect(res.statusCode).toBe(400);
  });

  it('QUERY-API-08: modeが design/experiment 以外 → status 400', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const handler = getHandler('/abs/schema.sql');
    await waitForReady(handler);

    const res = makeRes();
    await handler(makeReq('POST', '/', JSON.stringify({ sql: 'SELECT 1', mode: 'bogus' })), res as never, vi.fn());
    expect(res.statusCode).toBe(400);
  });

  it('QUERY-API-09: POST /api/query/reset — 起動時ブートストラップ直後の状態に戻る', async () => {
    readFile.mockResolvedValue('CREATE TABLE users (id INT);');
    const handler = getHandler('/abs/schema.sql');
    await waitForReady(handler);

    await runSql(handler, 'CREATE TABLE extra (id INT)', 'design');
    const beforeReset = makeRes();
    await handler(makeReq('GET', '/state'), beforeReset as never, vi.fn());
    expect(JSON.parse(beforeReset.body).state.order).toEqual(['users', 'extra']);

    const resetRes = makeRes();
    await handler(makeReq('POST', '/reset'), resetRes as never, vi.fn());
    expect(JSON.parse(resetRes.body)).toEqual({ ok: true, error: null });

    const afterReset = makeRes();
    await handler(makeReq('GET', '/state'), afterReset as never, vi.fn());
    expect(JSON.parse(afterReset.body).state.order).toEqual(['users']);
  });

  it('QUERY-API-10: 直列化 — 同時に投げても投入順に実行される', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const handler = getHandler('/abs/schema.sql');
    await waitForReady(handler);

    const resA = makeRes();
    const resB = makeRes();
    const reqA = makeReq('POST', '/', JSON.stringify({ sql: 'CREATE TABLE race (id INT)', mode: 'design' }));
    const reqB = makeReq('POST', '/', JSON.stringify({ sql: 'ALTER TABLE race ADD COLUMN note TEXT', mode: 'design' }));

    // Fired without awaiting the first — if requests were NOT serialized,
    // reqB's ALTER could race ahead of reqA's CREATE and fail with
    // "relation race does not exist".
    await Promise.all([handler(reqA, resA as never, vi.fn()), handler(reqB, resB as never, vi.fn())]);

    expect(JSON.parse(resA.body).results[0].error).toBeUndefined();
    expect(JSON.parse(resB.body).results[0].error).toBeUndefined();
  });

  it('/api/query以外のメソッド(GET/POST以外)は next() に委譲する', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const handler = getHandler('/abs/schema.sql');
    const res = makeRes();
    const next = vi.fn();

    await handler(makeReq('DELETE', '/'), res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
