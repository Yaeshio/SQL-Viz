import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs, readStdin, runQuery } from '../scripts/query.mjs';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body } as Response;
}

function fakeStdin(text: string, isTTY: boolean): typeof process.stdin {
  return {
    isTTY,
    [Symbol.asyncIterator]: async function* () {
      if (text) yield Buffer.from(text, 'utf-8');
    },
  } as unknown as typeof process.stdin;
}

async function withStdin<T>(stream: typeof process.stdin, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'stdin', original);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parseArgs', () => {
  it('QUERY-CLI-01: positional引数を結合し、mode/urlは既定値になる', () => {
    expect(parseArgs(['SELECT', '*', 'FROM', 'users'])).toEqual({
      sqlArg: 'SELECT * FROM users',
      mode: 'design',
      url: 'http://127.0.0.1:5173',
    });
  });

  it('QUERY-CLI-02: --mode=/--url= を解析し、positionalから除外する', () => {
    expect(parseArgs(['SELECT 1', '--mode=experiment', '--url=http://127.0.0.1:5199'])).toEqual({
      sqlArg: 'SELECT 1',
      mode: 'experiment',
      url: 'http://127.0.0.1:5199',
    });
  });

  it('QUERY-CLI-03: positional引数なし → sqlArg は null', () => {
    expect(parseArgs(['--mode=experiment']).sqlArg).toBeNull();
  });
});

describe('readStdin', () => {
  it('QUERY-CLI-04: ストリームの内容をUTF-8文字列として結合する', async () => {
    const content = await readStdin(fakeStdin('CREATE TABLE t (id INT);', false));
    expect(content).toBe('CREATE TABLE t (id INT);');
  });
});

describe('runQuery', () => {
  it('QUERY-CLI-05: 成功 → exitCode 0、stdoutにRunResultのJSONのみ', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: [{ label: 'x', state: {}, events: [] }] }));
    const result = await runQuery({ sql: 'SELECT 1', mode: 'design', url: 'http://127.0.0.1:5173', fetchImpl });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout!.trim())).toEqual({ results: [{ label: 'x', state: {}, events: [] }] });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:5173/api/query',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ sql: 'SELECT 1', mode: 'design' }),
      }),
    );
  });

  it('QUERY-CLI-06: parseErrorありのレスポンス → exitCode 1', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: [], parseError: 'Unsupported statement type' }));
    const result = await runQuery({ sql: 'JOIN x', mode: 'design', url: 'http://127.0.0.1:5173', fetchImpl });
    expect(result.exitCode).toBe(1);
  });

  it('QUERY-CLI-07: results[].errorありのレスポンス → exitCode 1', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [{ label: 'x', state: {}, events: [], error: 'relation "ghost" does not exist' }] }));
    const result = await runQuery({ sql: 'INSERT INTO ghost VALUES (1)', mode: 'experiment', url: 'http://127.0.0.1:5173', fetchImpl });
    expect(result.exitCode).toBe(1);
  });

  it('QUERY-CLI-08: fetch自体が例外 → exitCode 2', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await runQuery({ sql: 'SELECT 1', mode: 'design', url: 'http://127.0.0.1:1', fetchImpl });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Could not reach');
  });

  it('QUERY-CLI-09: サーバーが非2xx応答 → exitCode 3', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(400, { error: 'sql must be a string' }));
    const result = await runQuery({ sql: 'SELECT 1', mode: 'design', url: 'http://127.0.0.1:5173', fetchImpl });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('sql must be a string');
  });
});

describe('main', () => {
  it('QUERY-CLI-10: positional引数のSQL → 成功時にexit(0)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: [] })));

    await main(['SELECT 1']);

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('"results"'));
  });

  it('QUERY-CLI-11: 不正な --mode → ネットワークアクセスせずexit(3)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await main(['SELECT 1', '--mode=bogus']);

    expect(exitSpy).toHaveBeenCalledWith(3);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --mode'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('QUERY-CLI-12: 引数なし・対話的TTY → ハングせず即座にexit(3)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await withStdin(fakeStdin('', true), () => main([]));

    expect(exitSpy).toHaveBeenCalledWith(3);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('QUERY-CLI-13: 引数なし・パイプされたstdin → stdinのSQLを実行する', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: [] })));

    await withStdin(fakeStdin('CREATE TABLE t (id INT);', false), () => main([]));

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('QUERY-CLI-14: 引数なし・空のstdin → exit(3)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await withStdin(fakeStdin('   ', false), () => main([]));

    expect(exitSpy).toHaveBeenCalledWith(3);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('No SQL provided'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
