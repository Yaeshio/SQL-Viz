#!/usr/bin/env node
import { createServer } from 'vite';
import { exec } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildApiPlugin } from '../src/local/apiPlugin.ts';
import { buildQueryApiPlugin } from '../src/local/queryApiPlugin.ts';

const USAGE =
  'Usage: npm run sql-studio -- <path/to/schema.sql> [--mode=author|verify] [--save-dir=<path>] [--quiet]\n' +
  '  --save-dir is only valid together with --mode=verify.\n' +
  '  --quiet suppresses the terminal logging of schema saves and SQL executions.';
const DEFAULT_URL = 'http://127.0.0.1:5173/';
const DEFAULT_VERIFY_SAVE_DIR = path.join(os.tmpdir(), 'sql-viz-verify-saves');

export function resolveDdlPath(arg, cwd = process.cwd()) {
  return path.isAbsolute(arg) ? arg : path.resolve(cwd, arg);
}

/** scripts/query.mjs の parseArgs と同じ方針: `--mode=` / `--save-dir=` を
 * プレフィックス一致で argv から抜き出し、それ以外は位置引数（DDL ファイルの
 * パス）として扱う。`mode` の既定は 'author'（現状の無制限な挙動）。
 * `saveDir` は未指定のとき undefined のままにしておくことで、`main()` が
 * 「未指定」と「明示的に既定値を指定」を区別できるようにする。
 * `--quiet`（Issue #38）は query.mjs の `--history` と同じ値なしブールフラグ。 */
export function parseArgs(argv) {
  let mode = 'author';
  let saveDir;
  let quiet = false;
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--mode=')) {
      mode = arg.slice('--mode='.length);
    } else if (arg.startsWith('--save-dir=')) {
      saveDir = arg.slice('--save-dir='.length);
    } else if (arg === '--quiet') {
      quiet = true;
    } else {
      positional.push(arg);
    }
  }
  return { filePathArg: positional[0], mode, saveDir, quiet };
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

/** Vite の dev サーバーを（`vite` CLI バイナリではなく）JS API 経由で起動する。
 * これにより localApiPlugin をこのスクリプトだけから注入でき、vite.config.ts
 * 自体はローカルモードを一切知らなくて済む。createServer() は引き続き
 * vite.config.ts を自動ロードし、このインライン設定をそこへマージする
 * （configFile を false にはしていない）ため、あちらの react() 等はそのまま
 * 動き続ける。
 *
 * `host` の既定は '127.0.0.1'（仕様 §5: LAN から到達不能）。Docker の
 * エントリポイント（Issue #31）は SQL_STUDIO_HOST 経由でこれを '0.0.0.0' に
 * 上書きし、`docker run -p` でサーバーへ到達できるようにする。その場合の
 * LAN 非到達性は、利用者がポートを `-p 127.0.0.1:5173:5173` として公開する
 * ことに委ねられる。
 * `cacheDir` の既定は Vite 自身のもの（`node_modules/.vite`）。Docker イメージは
 * SQL_STUDIO_CACHE_DIR 経由でこれを誰でも書けるパスへ向け、非 root の
 * `docker run --user` でも依存事前バンドルのキャッシュを書けるようにする。
 * @param {{ filePath: string, port?: number, mode?: 'author' | 'verify', saveDir?: string, host?: string, cacheDir?: string, quiet?: boolean }} opts */
export async function spawnVite({
  filePath,
  port,
  mode = 'author',
  saveDir = undefined,
  host = '127.0.0.1',
  cacheDir = undefined,
  quiet = false,
}) {
  process.env.VITE_LOCAL_FILE = 'true';
  process.env.VITE_STARTUP_MODE = mode;
  const server = await createServer({
    plugins: [
      buildApiPlugin(filePath, { readOnly: mode === 'verify', saveDir, quiet }),
      buildQueryApiPlugin(filePath, { quiet }),
    ],
    server: { host, port, open: false },
    ...(cacheDir ? { cacheDir } : {}),
  });
  await server.listen();
  return server;
}

export async function main(argv = process.argv.slice(2)) {
  const { filePathArg, mode, saveDir, quiet } = parseArgs(argv);
  if (!filePathArg || (mode !== 'author' && mode !== 'verify') || (saveDir !== undefined && mode !== 'verify')) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
    return;
  }

  const filePath = resolveDdlPath(filePathArg);
  const resolvedSaveDir = mode === 'verify' ? (saveDir ?? DEFAULT_VERIFY_SAVE_DIR) : undefined;
  // VITE_ プレフィックスの付かない環境変数: ここで消費するだけで、ブラウザ
  // バンドルへは一切公開しない。docker/sql-studio/Dockerfile が設定する。
  // 通常の `npm run sql-studio` 経路では未設定なので spawnVite の既定値が効く。
  const host = process.env.SQL_STUDIO_HOST || undefined;
  const cacheDir = process.env.SQL_STUDIO_CACHE_DIR || undefined;
  const server = await spawnVite({ filePath, mode, saveDir: resolvedSaveDir, host, cacheDir, quiet });
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
