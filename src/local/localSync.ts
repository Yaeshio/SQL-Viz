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

/** author: 現状の無制限な挙動（Save は対象ファイルを直接上書きする）。
 * verify: 対象ファイルへは決して書き込まず、Save は代わりにサーバーが選んだ
 * 別のパスへエクスポートする（saveSchemaAs 参照）。セッションレベルの AppMode
 * （'design'/'experiment'）とは独立——これは起動時に CLI フラグで決まる軸であり、
 * PGlite の実行ゲートではない。 */
export type StartupMode = 'author' | 'verify';

/** scripts/openLocal.mjs の `spawnVite()` が dev サーバー起動時に
 * VITE_LOCAL_FILE を注入したときだけ true——Vercel / ホスティングビルドでは
 * そのビルドが CLI を通らないため決して true にならない。 */
export function isLocalMode(): boolean {
  return Boolean(import.meta.env.VITE_LOCAL_FILE);
}

/** spawnVite() が `--mode=` から設定するビルド時フラグ VITE_STARTUP_MODE を
 * 読む。未設定時は 'author' を既定とし（ホスティングビルド、またはフラグ無しで
 * 起動した CLI）、openLocal.mjs 自身の既定と一致させる。 */
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

/** saveSchema() の verify モード版: 対象ファイルを上書きする代わりに、その外側の
 * サーバーが選んだパスへ書き込む（apiPlugin.ts の /api/schema/verify-save 参照）。 */
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
