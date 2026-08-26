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
 * @param {{ filePath: string, port?: number, mode?: 'author' | 'verify', saveDir?: string }} opts */
export async function spawnVite({ filePath, port, mode = 'author', saveDir = undefined }) {
  process.env.VITE_LOCAL_FILE = 'true';
  process.env.VITE_STARTUP_MODE = mode;
  const server = await createServer({
    plugins: [buildApiPlugin(filePath, { readOnly: mode === 'verify', saveDir }), buildQueryApiPlugin(filePath)],
    server: { host: '127.0.0.1', port, open: false },
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
  const server = await spawnVite({ filePath, mode, saveDir: resolvedSaveDir });
  server.printUrls();
  if (resolvedSaveDir) {
    console.log(`検証モードで起動しました。別名保存の保存先: ${resolvedSaveDir}`);
  }
  const url = server.resolvedUrls?.local[0] ?? DEFAULT_URL;
  openBrowser(url);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
