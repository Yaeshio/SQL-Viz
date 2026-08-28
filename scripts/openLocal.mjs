#!/usr/bin/env node
import { createServer } from 'vite';
import { exec } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildApiPlugin } from '../src/local/apiPlugin.ts';
import { buildQueryApiPlugin } from '../src/local/queryApiPlugin.ts';

const USAGE =
  'Usage: npm run sql-studio -- <path/to/schema.sql> [--mode=author|verify] [--save-dir=<path>]\n' +
  '  --save-dir is only valid together with --mode=verify.';
const DEFAULT_URL = 'http://127.0.0.1:5173/';
const DEFAULT_VERIFY_SAVE_DIR = path.join(os.tmpdir(), 'sql-viz-verify-saves');

export function resolveDdlPath(arg, cwd = process.cwd()) {
  return path.isAbsolute(arg) ? arg : path.resolve(cwd, arg);
}

/** Mirrors scripts/query.mjs's parseArgs: `--mode=`/`--save-dir=` are pulled
 * out of argv by prefix match, everything else is positional (the DDL file
 * path). `mode` defaults to 'author' (today's unrestricted behavior);
 * `saveDir` stays undefined when unset so `main()` can tell "not provided"
 * apart from "explicitly set to the default". */
export function parseArgs(argv) {
  let mode = 'author';
  let saveDir;
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--mode=')) {
      mode = arg.slice('--mode='.length);
    } else if (arg.startsWith('--save-dir=')) {
      saveDir = arg.slice('--save-dir='.length);
    } else {
      positional.push(arg);
    }
  }
  return { filePathArg: positional[0], mode, saveDir };
}

export function openBrowser(url, platform = process.platform) {
  const cmd =
    platform === 'darwin'
      ? `open "${url}"`
      : platform === 'win32'
        ? `cmd /c start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.warn(`ブラウザを自動起動できませんでした。手動で開いてください: ${url}`);
    }
  });
}

/** Boots Vite's dev server via the JS API (not the `vite` CLI binary), so
 * that localApiPlugin can be injected purely from this script — vite.config.ts
 * itself never has to know about local-mode. createServer() still auto-loads
 * vite.config.ts and merges this inline config into it (configFile isn't set
 * to false), so react() etc. from that file keep working unchanged.
 *
 * `host` defaults to '127.0.0.1' (spec §5: unreachable from the LAN). The
 * Docker entrypoint (Issue #31) overrides it to '0.0.0.0' via SQL_STUDIO_HOST
 * so `docker run -p` can reach the server; LAN-unreachability then depends on
 * the operator publishing the port as `-p 127.0.0.1:5173:5173`.
 * `cacheDir` defaults to Vite's own (`node_modules/.vite`); the Docker image
 * points it at a world-writable path via SQL_STUDIO_CACHE_DIR so a non-root
 * `docker run --user` can still write the dep-optimize cache.
 * @param {{ filePath: string, port?: number, mode?: 'author' | 'verify', saveDir?: string, host?: string, cacheDir?: string }} opts */
export async function spawnVite({
  filePath,
  port,
  mode = 'author',
  saveDir = undefined,
  host = '127.0.0.1',
  cacheDir = undefined,
}) {
  process.env.VITE_LOCAL_FILE = 'true';
  process.env.VITE_STARTUP_MODE = mode;
  const server = await createServer({
    plugins: [buildApiPlugin(filePath, { readOnly: mode === 'verify', saveDir }), buildQueryApiPlugin(filePath)],
    server: { host, port, open: false },
    ...(cacheDir ? { cacheDir } : {}),
  });
  await server.listen();
  return server;
}

export async function main(argv = process.argv.slice(2)) {
  const { filePathArg, mode, saveDir } = parseArgs(argv);
  if (!filePathArg || (mode !== 'author' && mode !== 'verify') || (saveDir !== undefined && mode !== 'verify')) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
    return;
  }

  const filePath = resolveDdlPath(filePathArg);
  const resolvedSaveDir = mode === 'verify' ? (saveDir ?? DEFAULT_VERIFY_SAVE_DIR) : undefined;
  // Non-VITE_-prefixed env vars: consumed here, never exposed to the browser
  // bundle. Set by docker/sql-studio/Dockerfile; unset on the normal
  // `npm run sql-studio` path so spawnVite's defaults apply.
  const host = process.env.SQL_STUDIO_HOST || undefined;
  const cacheDir = process.env.SQL_STUDIO_CACHE_DIR || undefined;
  const server = await spawnVite({ filePath, mode, saveDir: resolvedSaveDir, host, cacheDir });
  server.printUrls();
  console.log(
    '改修提案ドキュメントの書き方: https://github.com/Yaeshio/SQL-Viz/blob/main/docs/agent-proposal-workflow-spec.md',
  );
  if (resolvedSaveDir) {
    console.log(`検証モードで起動しました。別名保存の保存先: ${resolvedSaveDir}`);
  }
  const url = server.resolvedUrls?.local[0] ?? DEFAULT_URL;
  openBrowser(url);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
