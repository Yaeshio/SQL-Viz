import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSchema, getStartupMode, isLocalMode, saveSchema, saveSchemaAs } from '../src/local/localSync';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('isLocalMode', () => {
  it('LOCAL-MODE-01: VITE_LOCAL_FILEが非空文字列のときtrue', () => {
    vi.stubEnv('VITE_LOCAL_FILE', 'true');
    expect(isLocalMode()).toBe(true);
  });

  it('LOCAL-MODE-02: undefinedまたは空文字列のときfalse', () => {
    vi.stubEnv('VITE_LOCAL_FILE', '');
    expect(isLocalMode()).toBe(false);

    vi.stubEnv('VITE_LOCAL_FILE', undefined);
    expect(isLocalMode()).toBe(false);
  });
});

describe('getStartupMode', () => {
  it('LOCAL-MODE-07: VITE_STARTUP_MODEが"verify"のときverifyを返す', () => {
    vi.stubEnv('VITE_STARTUP_MODE', 'verify');
    expect(getStartupMode()).toBe('verify');
  });

  it('LOCAL-MODE-08: 未設定または"verify"以外のときauthorを返す', () => {
    vi.stubEnv('VITE_STARTUP_MODE', undefined);
    expect(getStartupMode()).toBe('author');

    vi.stubEnv('VITE_STARTUP_MODE', 'author');
    expect(getStartupMode()).toBe('author');

    vi.stubEnv('VITE_STARTUP_MODE', 'bogus');
    expect(getStartupMode()).toBe('author');
  });
});

describe('fetchSchema', () => {
  it('LOCAL-MODE-03: GET 200時にcontent文字列を返す', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { content: 'CREATE TABLE t (id INT);' }));
    vi.stubGlobal('fetch', fetchMock);

    const content = await fetchSchema();

    expect(fetchMock).toHaveBeenCalledWith('/api/schema');
    expect(content).toBe('CREATE TABLE t (id INT);');
  });

  it('LOCAL-MODE-04: レスポンスnot ok時に例外をthrowする', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(500, { ok: false, error: 'boom' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSchema()).rejects.toThrow();
  });
});

describe('saveSchema', () => {
  it('LOCAL-MODE-05: POST { content: ddl } を送信し ok: true で解決する', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(saveSchema('CREATE TABLE t (id INT);')).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/schema');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ content: 'CREATE TABLE t (id INT);' });
  });

  it('LOCAL-MODE-06: ok: false時にサーバエラーメッセージをthrowする', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(500, { ok: false, error: 'disk full' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(saveSchema('CREATE TABLE t (id INT);')).rejects.toThrow('disk full');
  });
});

describe('saveSchemaAs', () => {
  it('LOCAL-MODE-09: POST /api/schema/verify-save を送信し、成功時に { path } で解決する', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true, path: '/tmp/sql-viz-verify-saves/ddl.x.sql' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(saveSchemaAs('CREATE TABLE t (id INT);')).resolves.toEqual({
      path: '/tmp/sql-viz-verify-saves/ddl.x.sql',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/schema/verify-save');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ content: 'CREATE TABLE t (id INT);' });
  });

  it('LOCAL-MODE-10: not ok時にサーバエラーメッセージをthrowする', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(403, { ok: false, error: '検証モードのため保存できません' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(saveSchemaAs('CREATE TABLE t (id INT);')).rejects.toThrow('検証モードのため保存できません');
  });
});
