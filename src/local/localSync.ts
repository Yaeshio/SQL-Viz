interface FetchSchemaResponse {
  content: string;
}

interface SaveSchemaResponse {
  error?: string;
}

interface SaveSchemaAsResponse {
  path?: string;
  error?: string;
}

/** author: today's unrestricted behavior (Save overwrites the target file
 * directly). verify: the target file is never written to; Save instead
 * exports to a separate, server-chosen path (see saveSchemaAs). Independent
 * of the session-level AppMode ('design'/'experiment') — this is a
 * startup-time, CLI-flag-driven axis, not a PGlite execution gate. */
export type StartupMode = 'author' | 'verify';

/** True only when scripts/openLocal.mjs's `spawnVite()` injected
 * VITE_LOCAL_FILE at dev-server startup — never true in a Vercel/hosted
 * build, since that build never runs through the CLI. */
export function isLocalMode(): boolean {
  return Boolean(import.meta.env.VITE_LOCAL_FILE);
}

/** Reads the build-time VITE_STARTUP_MODE flag set by spawnVite() from
 * `--mode=`. Defaults to 'author' when unset (hosted build, or CLI launched
 * without the flag), matching openLocal.mjs's own default. */
export function getStartupMode(): StartupMode {
  return import.meta.env.VITE_STARTUP_MODE === 'verify' ? 'verify' : 'author';
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

/** verify-mode counterpart to saveSchema(): writes to a server-chosen path
 * outside the target file (see apiPlugin.ts's /api/schema/verify-save)
 * instead of overwriting it. */
export async function saveSchemaAs(content: string): Promise<{ path: string }> {
  const res = await fetch('/api/schema/verify-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  const body = (await res.json().catch(() => ({}))) as SaveSchemaAsResponse;
  if (!res.ok || !body.path) {
    throw new Error(body.error ?? `POST /api/schema/verify-save failed: ${res.status}`);
  }
  return { path: body.path };
}
