import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFile, getRepo, GitHubApiError, putFile } from '../src/github/client';

function jsonResponse(status: number, body: unknown, statusText = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getRepo', () => {
  it('GITHUB-CLIENT-01: 正しいURL・ヘッダーでGETし、default_branchをdefaultBranchとして返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { default_branch: 'main' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getRepo('octocat', 'hello-world', 'tok123');

    expect(result).toEqual({ defaultBranch: 'main' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/octocat/hello-world');
    expect(init.headers.Authorization).toBe('Bearer tok123');
    expect(init.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('GITHUB-CLIENT-03: 非2xxでGitHubApiErrorを投げる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { message: 'Bad credentials' })));
    await expect(getRepo('octocat', 'hello-world', 'bad-token')).rejects.toMatchObject({
      status: 401,
      message: 'Bad credentials',
    });
  });
});

describe('getFile', () => {
  it('GITHUB-CLIENT-02: 404のときnullを返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { message: 'Not Found' })));
    const result = await getFile('octocat', 'hello-world', 'schema/ddl.sql', 'main', 'tok123');
    expect(result).toBeNull();
  });

  it('shaを含むファイル情報を返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { sha: 'abc123' })));
    const result = await getFile('octocat', 'hello-world', 'schema/ddl.sql', 'main', 'tok123');
    expect(result).toEqual({ sha: 'abc123' });
  });
});

describe('putFile', () => {
  it('GITHUB-CLIENT-04: 新規ファイル時はshaなしでPUTする', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { message: 'Not Found' })) // getFile
      .mockResolvedValueOnce(jsonResponse(201, {})); // PUT
    vi.stubGlobal('fetch', fetchMock);

    await putFile('octocat', 'hello-world', 'schema/ddl.sql', 'CREATE TABLE users ();', 'Update ddl', 'main', 'tok123');

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.github.com/repos/octocat/hello-world/contents/schema/ddl.sql');
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body);
    expect(body.sha).toBeUndefined();
    expect(body.branch).toBe('main');
    expect(body.message).toBe('Update ddl');
  });

  it('GITHUB-CLIENT-05: 既存ファイル時はgetFileで取得したshaを含めてPUTする', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { sha: 'existing-sha' })) // getFile
      .mockResolvedValueOnce(jsonResponse(200, {})); // PUT
    vi.stubGlobal('fetch', fetchMock);

    await putFile('octocat', 'hello-world', 'schema/ddl.sql', 'CREATE TABLE users ();', 'Update ddl', 'main', 'tok123');

    const [, init] = fetchMock.mock.calls[1];
    const body = JSON.parse(init.body);
    expect(body.sha).toBe('existing-sha');
  });

  it('GITHUB-CLIENT-06: 日本語を含む本文が正しくUTF-8安全にbase64化される', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { message: 'Not Found' }))
      .mockResolvedValueOnce(jsonResponse(201, {}));
    vi.stubGlobal('fetch', fetchMock);

    await putFile('octocat', 'hello-world', 'query-examples.md', '# 日本語クエリ例', 'Update', 'main', 'tok123');

    const [, init] = fetchMock.mock.calls[1];
    const body = JSON.parse(init.body);
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0)));
    expect(decoded).toBe('# 日本語クエリ例');
  });

  it('PUT自体が失敗するとGitHubApiErrorを投げる', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { message: 'Not Found' }))
      .mockResolvedValueOnce(jsonResponse(409, { message: 'Conflict' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      putFile('octocat', 'hello-world', 'schema/ddl.sql', 'x', 'Update', 'main', 'tok123'),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });
});
