import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connect } from 'vite';

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile }));

import { buildQueryApiPlugin, HISTORY_LIMIT } from '../src/local/queryApiPlugin';

// ここでの req.url は、Connect が '/api/query' のマウントプレフィックスを剥がした
// あとに渡すもの（Vite に同梱された connect のソースを読んで実装計画で確認済み）
// ——例: POST /api/query 自体には '/'、GET /api/query/state には '/state'。
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

function getHandler(filePath: string, options?: { quiet?: boolean }): Connect.NextHandleFunction {
  const use = vi.fn();
  const plugin = buildQueryApiPlugin(filePath, options);
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

async function getHistory(handler: Connect.NextHandleFunction) {
  const res = makeRes();
  await handler(makeReq('GET', '/history'), res as never, vi.fn());
  return JSON.parse(res.body).history;
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

    // 最初のを await せずに発火する——リクエストが直列化されていなければ、
    // reqB の ALTER が reqA の CREATE を追い越して
    // "relation race does not exist" で失敗しうる。
    await Promise.all([handler(reqA, resA as never, vi.fn()), handler(reqB, resB as never, vi.fn())]);

    expect(JSON.parse(resA.body).results[0].error).toBeUndefined();
    expect(JSON.parse(resB.body).results[0].error).toBeUndefined();
  });

  it('QUERY-API-11: GET /api/query/history — 初期状態は空配列', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const handler = getHandler('/abs/schema.sql');
    await waitForReady(handler);

    expect(await getHistory(handler)).toEqual([]);
  });

  it('QUERY-API-12: POST /api/query の成功/parseError/文エラーがそれぞれ履歴に記録される', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const handler = getHandler('/abs/schema.sql');
    await waitForReady(handler);

    await runSql(handler, 'CREATE TABLE users (id INT)', 'design');
    await runSql(handler, 'SELECT * FROM users', 'design'); // モードゲート違反 → parseError
    await runSql(handler, 'INSERT INTO ghost (id) VALUES (1)', 'experiment'); // Postgresエラー

    const history = await getHistory(handler);
    expect(history).toHaveLength(3);

    expect(history[0]).toMatchObject({
      seq: 1,
      sql: 'CREATE TABLE users (id INT)',
      mode: 'design',
      ok: true,
      statements: [{ label: 'CREATE TABLE users (1 cols)' }],
    });
    expect(typeof history[0].at).toBe('string');

    expect(history[1]).toMatchObject({
      seq: 2,
      ok: false,
      parseError: expect.stringContaining('is not allowed in design mode'),
      statements: [],
    });

    expect(history[2]).toMatchObject({ seq: 3, ok: false });
    expect(history[2].statements[0].error).toBeDefined();
  });

  it('QUERY-API-13: HISTORY_LIMIT を超えると最も古いエントリから破棄される（seqは再利用しない）', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const handler = getHandler('/abs/schema.sql');
    await waitForReady(handler);

    for (let i = 0; i < HISTORY_LIMIT + 1; i++) {
      await runSql(handler, 'SELECT 1', 'design'); // design中のselectはparseErrorになるだけで十分軽い
    }

    const history = await getHistory(handler);
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[0].seq).toBe(2); // seq=1は破棄され、再利用もされていない
    expect(history[history.length - 1].seq).toBe(HISTORY_LIMIT + 1);
  });

  it('QUERY-API-14: POST /api/query/reset を挟んでも履歴はクリアされない', async () => {
    readFile.mockResolvedValue('CREATE TABLE users (id INT);');
    const handler = getHandler('/abs/schema.sql');
    await waitForReady(handler);

    await runSql(handler, 'CREATE TABLE extra (id INT)', 'design');
    expect(await getHistory(handler)).toHaveLength(1);

    const resetRes = makeRes();
    await handler(makeReq('POST', '/reset'), resetRes as never, vi.fn());
    expect(JSON.parse(resetRes.body)).toEqual({ ok: true, error: null });

    const history = await getHistory(handler);
    expect(history).toHaveLength(1);
    expect(history[0].sql).toBe('CREATE TABLE extra (id INT)');
  });

  it('Issue #38: POST /api/query 成功時、mode・SQL全文付きでconsole.logへログを出す', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const handler = getHandler('/abs/schema.sql');
    await waitForReady(handler);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runSql(handler, 'CREATE TABLE users (id INT)', 'design');

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('design'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE users (id INT)'));
    logSpy.mockRestore();
  });

  it('Issue #38: parseError（モードゲート違反）時、console.errorへログを出す', async () => {
    readFile.mockResolvedValue('CREATE TABLE users (id INT);');
    const handler = getHandler('/abs/schema.sql');
    await waitForReady(handler);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runSql(handler, 'SELECT * FROM users', 'design');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM users'));
    errorSpy.mockRestore();
  });

  it('Issue #38: 文実行エラー時、console.errorへログを出す', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const handler = getHandler('/abs/schema.sql');
    await waitForReady(handler);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runSql(handler, 'INSERT INTO ghost (id) VALUES (1)', 'experiment');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO ghost (id) VALUES (1)'));
    errorSpy.mockRestore();
  });

  it('Issue #38: quiet: true のとき、成功時も失敗時もログを一切出さない', async () => {
    readFile.mockResolvedValue('CREATE TABLE users (id INT);');
    const handler = getHandler('/abs/schema.sql', { quiet: true });
    await waitForReady(handler);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runSql(handler, 'SELECT * FROM users', 'design'); // parseError側
    await runSql(handler, 'CREATE TABLE extra (id INT)', 'design'); // 成功側

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
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
