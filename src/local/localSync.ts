interface FetchSchemaResponse {
  content: string;
}

interface SaveSchemaResponse {
  error?: string;
}

/** True only when scripts/openLocal.mjs's `spawnVite()` injected
 * VITE_LOCAL_FILE at dev-server startup — never true in a Vercel/hosted
 * build, since that build never runs through the CLI. */
export function isLocalMode(): boolean {
  return Boolean(import.meta.env.VITE_LOCAL_FILE);
}

export async function fetchSchema(): Promise<string> {
  const res = await fetch('/api/schema');
  if (!res.ok) {
    throw new Error(`GET /api/schema failed: ${res.status}`);
  }
  const body = (await res.json()) as FetchSchemaResponse;
  return body.content;
}

export async function saveSchema(content: string): Promise<void> {
  const res = await fetch('/api/schema', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as SaveSchemaResponse;
  throw new Error(body.error ?? `POST /api/schema failed: ${res.status}`);
}
