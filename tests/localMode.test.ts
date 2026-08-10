import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSchema, isLocalMode, saveSchema } from '../src/local/localSync';

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
