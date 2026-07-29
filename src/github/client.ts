const API_BASE = 'https://api.github.com';

export interface GitHubSettings {
  token: string;
  owner: string;
  repo: string;
  branch: string;
}

export class GitHubApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

export async function getRepo(owner: string, repo: string, token: string): Promise<{ defaultBranch: string }> {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}`, { headers: authHeaders(token) });
  if (!res.ok) throw new GitHubApiError(res.status, await readErrorMessage(res));
  const body = (await res.json()) as { default_branch: string };
  return { defaultBranch: body.default_branch };
}

export async function getFile(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token: string,
): Promise<{ sha: string } | null> {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, {
    headers: authHeaders(token),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new GitHubApiError(res.status, await readErrorMessage(res));
  const body = (await res.json()) as { sha: string };
  return { sha: body.sha };
}

/** Resolves the target file's current sha internally (Contents API requires
 * it to update an existing file), so callers never need to think about it —
 * a brand-new file is simply PUT without one. */
export async function putFile(
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch: string,
  token: string,
): Promise<void> {
  const existing = await getFile(owner, repo, path, branch, token);
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: toBase64Utf8(content),
      branch,
      ...(existing ? { sha: existing.sha } : {}),
    }),
  });
  if (!res.ok) throw new GitHubApiError(res.status, await readErrorMessage(res));
}
