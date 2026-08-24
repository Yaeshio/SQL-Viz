#!/usr/bin/env node
import { createServer } from 'vite';
import { exec } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildApiPlugin } from '../src/local/apiPlugin.ts';
import { buildQueryApiPlugin } from '../src/local/queryApiPlugin.ts';

const USAGE = 'Usage: npm run sql-studio -- <path/to/schema.sql>';
const DEFAULT_URL = 'http://127.0.0.1:5173/';

export function resolveDdlPath(arg, cwd = process.cwd()) {
  return path.isAbsolute(arg) ? arg : path.resolve(cwd, arg);
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
 * to false), so react() etc. from that file keep working unchanged. */
export async function spawnVite({ filePath, port }) {
  process.env.VITE_LOCAL_FILE = 'true';
  const server = await createServer({
    plugins: [buildApiPlugin(filePath), buildQueryApiPlugin(filePath)],
    server: { host: '127.0.0.1', port, open: false },
  });
  await server.listen();
  return server;
}

export async function main(argv = process.argv.slice(2)) {
  const arg = argv[0];
  if (!arg) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
    return;
  }

  const filePath = resolveDdlPath(arg);
  const server = await spawnVite({ filePath });
  server.printUrls();
  const url = server.resolvedUrls?.local[0] ?? DEFAULT_URL;
  openBrowser(url);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
