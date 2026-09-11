import type { Plugin, ViteDevServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { errorMessage, logInfo, logWarn, readDdlFile, readRequestBody, sendJson } from './httpUtils.ts';

export interface ApiPluginOptions {
  /** verify モード: 対象ファイルを上書きする代わりに POST /api/schema を拒否する。
   * POST /api/schema/verify-save はこのフラグに関わらず利用可能——その書き込み先は
   * 対象ファイルではなくサーバー側で固定された別ディレクトリなので、readOnly が
   * 防ごうとしているリスクを一切持たない。 */
  readOnly?: boolean;
  /** POST /api/schema/verify-save が書き込むディレクトリ。フロントエンドが実際に
   * そのエンドポイントを呼ぶ場合（verify モード）にのみ意味を持つ。verify モードを
   * 有効にしない呼び出し側は省略してよい。 */
  saveDir?: string;
  /** trueならこのプラグインのターミナルログ出力（Issue #38）を一切抑制する。
   * CLIの`--quiet`から配線される。 */
  quiet?: boolean;
}

/** 元ファイルの拡張子の前にタイムスタンプを挿入する。例:
 * "ddl.sql" + 2026-08-26T12:34:56 → "ddl.2026-08-26T12-34-56.sql"。コロンは
 * Windows のファイル名で不正なため置換する。`now` はテスト用に注入可能。 */
export function buildVerifySaveFilename(originalFilePath: string, now: Date = new Date()): string {
  const ext = extname(originalFilePath);
  const stem = basename(originalFilePath, ext);
  const timestamp = now.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
  return `${stem}.${timestamp}${ext}`;
}

/** GET/POST /api/schema（および verify モードでは POST /api/schema/verify-save）を
 * 公開する Vite dev サーバープラグイン。プラグイン構築時（CLI 起動時）に固定された
 * 単一のファイルパスにスコープされる——任意ファイル書き込みの脆弱性を避けるため、
 * パスをリクエストから受け取ることは決してない。サーバーを 127.0.0.1 に
 * バインドするのは呼び出し側（scripts/openLocal.mjs）の責務であり、このプラグインの
 * 責務ではない。 */
export function buildApiPlugin(filePath: string, options: ApiPluginOptions = {}): Plugin {
  const { readOnly = false, saveDir, quiet = false } = options;
  return {
    name: 'sql-viz-local-api',
    configureServer(server: ViteDevServer) {
      // Connect の use(mountpath, fn) は mountpath で始まる URL すべてに一致し、
      // req.url をそこからの相対パスへ書き換える。そのため "/api/schema" と
      // "/api/schema/verify-save" の両方がこの 1 つのハンドラへ届く——両者を
      // 区別するのが subpath。
      server.middlewares.use('/api/schema', async (req, res, next) => {
        const subpath = req.url === '/' || !req.url ? '' : req.url;
        try {
          if (subpath === '' && req.method === 'GET') {
            const content = await readDdlFile(filePath);
            sendJson(res, 200, { content });
            return;
          }

          if (subpath === '' && req.method === 'POST') {
            if (readOnly) {
              logWarn('schema', `拒否（検証モードのため保存できません）: ${filePath}`, quiet);
              sendJson(res, 403, { ok: false, error: '検証モードのため保存できません' });
              return;
            }
            const raw = await readRequestBody(req);
            let body: { content?: unknown };
            try {
              body = raw ? JSON.parse(raw) : {};
            } catch {
              sendJson(res, 400, { error: 'invalid JSON body' });
              return;
            }
            if (typeof body.content !== 'string') {
              sendJson(res, 400, { error: 'content must be a string' });
              return;
            }
            await mkdir(dirname(filePath), { recursive: true });
            await writeFile(filePath, body.content, 'utf-8');
            logInfo('schema', `保存: ${filePath}`, quiet);
            sendJson(res, 200, { ok: true });
            return;
          }

          if (subpath === '/verify-save' && req.method === 'POST') {
            const raw = await readRequestBody(req);
            let body: { content?: unknown };
            try {
              body = raw ? JSON.parse(raw) : {};
            } catch {
              sendJson(res, 400, { error: 'invalid JSON body' });
              return;
            }
            if (typeof body.content !== 'string') {
              sendJson(res, 400, { error: 'content must be a string' });
              return;
            }
            const targetDir = saveDir ?? dirname(filePath);
            const savedPath = join(targetDir, buildVerifySaveFilename(filePath));
            await mkdir(targetDir, { recursive: true });
            await writeFile(savedPath, body.content, 'utf-8');
            logInfo('schema', `verify-save: ${savedPath}`, quiet);
            sendJson(res, 200, { ok: true, path: savedPath });
            return;
          }

          next();
        } catch (err) {
          logWarn('schema', `エラー (${req.method} ${subpath || '/'}): ${errorMessage(err)}`, quiet);
          sendJson(res, 500, { ok: false, error: errorMessage(err) });
        }
      });
    },
  };
}
