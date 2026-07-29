import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgEngine } from '../src/pglite/engine';
import { pushSchema } from '../src/github/pushSchema';

const CANVAS_W = 800;

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body } as Response;
}

let engine: PgEngine;

beforeEach(() => {
  engine = new PgEngine();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pushSchema', () => {
  it('PUSH-SCHEMA-01: generateDdl()の出力をschema/ddl.sqlとしてputFile相当のリクエストに渡す', async () => {
    const { results } = await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');
    expect(results[0].error).toBeUndefined();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { message: 'Not Found' })) // getFile
      .mockResolvedValueOnce(jsonResponse(201, {})); // PUT
    vi.stubGlobal('fetch', fetchMock);

    await pushSchema(engine.getDb()!, ['users'], { token: 'tok123', owner: 'octocat', repo: 'hello-world', branch: 'main' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [putUrl, putInit] = fetchMock.mock.calls[1];
    expect(putUrl).toBe('https://api.github.com/repos/octocat/hello-world/contents/schema/ddl.sql');
    expect(putInit.method).toBe('PUT');

    const body = JSON.parse(putInit.body);
    expect(body.branch).toBe('main');
    const ddl = new TextDecoder().decode(Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0)));
    expect(ddl).toBe('CREATE TABLE "users" (\n  "id" INT,\n  "name" VARCHAR(50)\n);');
  });
});
