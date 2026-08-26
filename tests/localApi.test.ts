import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connect } from 'vite';

const { readFile, writeFile, mkdir } = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ readFile, writeFile, mkdir }));

import { buildApiPlugin, buildVerifySaveFilename } from '../src/local/apiPlugin';
import type { ApiPluginOptions } from '../src/local/apiPlugin';

function makeReq(method: string, body?: string, url = '/'): Connect.IncomingMessage {
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

function getHandler(filePath: string, options?: ApiPluginOptions): Connect.NextHandleFunction {
  const use = vi.fn();
  const plugin = buildApiPlugin(filePath, options);
  // configureServer is declared as an ObjectHook<ServerHook> in Vite's Plugin
  // type, but buildApiPlugin always assigns it a plain function. A fake
  // server exposing only `middlewares.use` is all that function needs.
  const configureServer = plugin.configureServer as unknown as (server: {
    middlewares: { use: typeof use };
  }) => void;
  configureServer({ middlewares: { use } });
  expect(use).toHaveBeenCalledTimes(1);
  const [path, handler] = use.mock.calls[0];
  expect(path).toBe('/api/schema');
  return handler as Connect.NextHandleFunction;
}

beforeEach(() => {
  readFile.mockReset();
  writeFile.mockReset();
  mkdir.mockReset();
});

describe('buildApiPlugin', () => {
  it('LOCAL-API-01: GET — ファイル存在 → { content } status 200', async () => {
    readFile.mockResolvedValueOnce('CREATE TABLE users (id INT);');
    const handler = getHandler('/abs/schema/ddl.sql');
    const res = makeRes();

    await handler(makeReq('GET'), res as never, vi.fn());

    expect(readFile).toHaveBeenCalledWith('/abs/schema/ddl.sql', 'utf-8');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ content: 'CREATE TABLE users (id INT);' });
  });

  it('LOCAL-API-02: GET — ファイル不在(ENOENT) → { content: "" } status 200', async () => {
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    readFile.mockRejectedValueOnce(enoent);
    const handler = getHandler('/abs/schema/ddl.sql');
    const res = makeRes();

    await handler(makeReq('GET'), res as never, vi.fn());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ content: '' });
  });

  it('GET — ENOENT以外のfs例外は500として返す', async () => {
    readFile.mockRejectedValueOnce(new Error('permission denied'));
    const handler = getHandler('/abs/schema/ddl.sql');
    const res = makeRes();

    await handler(makeReq('GET'), res as never, vi.fn());

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'permission denied' });
  });

  it('LOCAL-API-03: POST { content } → fs.writeFileが解決済みパスで呼ばれ { ok: true }', async () => {
    mkdir.mockResolvedValueOnce(undefined);
    writeFile.mockResolvedValueOnce(undefined);
    const handler = getHandler('/abs/schema/ddl.sql');
    const res = makeRes();

    await handler(makeReq('POST', JSON.stringify({ content: 'CREATE TABLE t (id INT);' })), res as never, vi.fn());

    expect(writeFile).toHaveBeenCalledWith('/abs/schema/ddl.sql', 'CREATE TABLE t (id INT);', 'utf-8');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('LOCAL-API-04: POST — fs.writeFileが例外 → { ok: false, error } status 500', async () => {
    mkdir.mockResolvedValueOnce(undefined);
    writeFile.mockRejectedValueOnce(new Error('disk full'));
    const handler = getHandler('/abs/schema/ddl.sql');
    const res = makeRes();

    await handler(makeReq('POST', JSON.stringify({ content: 'x' })), res as never, vi.fn());

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'disk full' });
  });

  it('LOCAL-API-05: POST — contentフィールドなし → status 400', async () => {
    const handler = getHandler('/abs/schema/ddl.sql');
    const res = makeRes();

    await handler(makeReq('POST', JSON.stringify({})), res as never, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('POST — 不正なJSONボディ → status 400', async () => {
    const handler = getHandler('/abs/schema/ddl.sql');
    const res = makeRes();

    await handler(makeReq('POST', 'not json'), res as never, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('LOCAL-API-06: buildApiPlugin(filePath) が name "sql-viz-local-api" のViteプラグインを返す', () => {
    const plugin = buildApiPlugin('/abs/schema/ddl.sql');
    expect(plugin.name).toBe('sql-viz-local-api');
  });

  it('/api/schema以外のメソッド(GET/POST以外)は next() に委譲する', async () => {
    const handler = getHandler('/abs/schema/ddl.sql');
    const res = makeRes();
    const next = vi.fn();

    await handler(makeReq('DELETE'), res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('readOnly: true のとき POST /api/schema は 403 を返し、fsへは一切書き込まない', async () => {
    const handler = getHandler('/abs/schema/ddl.sql', { readOnly: true });
    const res = makeRes();

    await handler(makeReq('POST', JSON.stringify({ content: 'CREATE TABLE t (id INT);' })), res as never, vi.fn());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: '検証モードのため保存できません' });
    expect(writeFile).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('readOnly: true でも GET /api/schema は従来通り動作する', async () => {
    readFile.mockResolvedValueOnce('CREATE TABLE users (id INT);');
    const handler = getHandler('/abs/schema/ddl.sql', { readOnly: true });
    const res = makeRes();

    await handler(makeReq('GET'), res as never, vi.fn());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ content: 'CREATE TABLE users (id INT);' });
  });

  it('POST /api/schema/verify-save → saveDir配下へ生成ファイル名で書き込み、{ ok: true, path } を返す', async () => {
    mkdir.mockResolvedValueOnce(undefined);
    writeFile.mockResolvedValueOnce(undefined);
    const handler = getHandler('/abs/schema/ddl.sql', { saveDir: '/abs/tmp/verify-saves' });
    const res = makeRes();

    await handler(
      makeReq('POST', JSON.stringify({ content: 'CREATE TABLE t (id INT);' }), '/verify-save'),
      res as never,
      vi.fn(),
    );

    expect(mkdir).toHaveBeenCalledWith('/abs/tmp/verify-saves', { recursive: true });
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenContent, writtenEncoding] = writeFile.mock.calls[0];
    expect(writtenPath).toMatch(/^\/abs\/tmp\/verify-saves\/ddl\..+\.sql$/);
    expect(writtenContent).toBe('CREATE TABLE t (id INT);');
    expect(writtenEncoding).toBe('utf-8');
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body) as { ok: boolean; path: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe(writtenPath);
  });

  it('POST /api/schema/verify-save は readOnly: false でも動作する（対象ファイルへの書き込みではないため）', async () => {
    mkdir.mockResolvedValueOnce(undefined);
    writeFile.mockResolvedValueOnce(undefined);
    const handler = getHandler('/abs/schema/ddl.sql', { readOnly: false, saveDir: '/abs/tmp/verify-saves' });
    const res = makeRes();

    await handler(makeReq('POST', JSON.stringify({ content: 'x' }), '/verify-save'), res as never, vi.fn());

    expect(res.statusCode).toBe(200);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('POST /api/schema/verify-save — contentフィールドなし → status 400', async () => {
    const handler = getHandler('/abs/schema/ddl.sql', { saveDir: '/abs/tmp/verify-saves' });
    const res = makeRes();

    await handler(makeReq('POST', JSON.stringify({}), '/verify-save'), res as never, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('saveDir未指定時のPOST /api/schema/verify-saveは対象ファイルと同じディレクトリへ書き込む', async () => {
    mkdir.mockResolvedValueOnce(undefined);
    writeFile.mockResolvedValueOnce(undefined);
    const handler = getHandler('/abs/schema/ddl.sql');
    const res = makeRes();

    await handler(makeReq('POST', JSON.stringify({ content: 'x' }), '/verify-save'), res as never, vi.fn());

    expect(mkdir).toHaveBeenCalledWith('/abs/schema', { recursive: true });
    const [writtenPath] = writeFile.mock.calls[0];
    expect(writtenPath).toMatch(/^\/abs\/schema\/ddl\..+\.sql$/);
  });
});

describe('buildVerifySaveFilename', () => {
  it('元ファイル名の拡張子の直前にタイムスタンプを挿入する（":" は "-" に置換）', () => {
    const now = new Date('2026-08-26T12:34:56.789Z');
    expect(buildVerifySaveFilename('/abs/schema/ddl.sql', now)).toBe('ddl.2026-08-26T12-34-56.sql');
  });

  it('拡張子のないファイル名でも動作する', () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    expect(buildVerifySaveFilename('/abs/schema/ddl', now)).toBe('ddl.2026-01-02T03-04-05');
  });
});
