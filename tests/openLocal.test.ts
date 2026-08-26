import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const { createServer } = vi.hoisted(() => ({ createServer: vi.fn() }));
vi.mock('vite', () => ({ createServer }));

const { buildApiPlugin } = vi.hoisted(() => ({
  buildApiPlugin: vi.fn((filePath: string) => ({ name: 'sql-viz-local-api', filePath })),
}));
vi.mock('../src/local/apiPlugin', () => ({ buildApiPlugin }));

const { buildQueryApiPlugin } = vi.hoisted(() => ({
  buildQueryApiPlugin: vi.fn((filePath: string) => ({ name: 'sql-viz-query-api', filePath })),
}));
vi.mock('../src/local/queryApiPlugin', () => ({ buildQueryApiPlugin }));

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({ exec }));

import { main, openBrowser, parseArgs, resolveDdlPath, spawnVite } from '../scripts/openLocal.mjs';

const ORIGINAL_VITE_LOCAL_FILE = process.env.VITE_LOCAL_FILE;
const ORIGINAL_VITE_STARTUP_MODE = process.env.VITE_STARTUP_MODE;

beforeEach(() => {
  createServer.mockReset();
  buildApiPlugin.mockClear();
  buildQueryApiPlugin.mockClear();
  exec.mockReset();
  delete process.env.VITE_LOCAL_FILE;
  delete process.env.VITE_STARTUP_MODE;
});

afterEach(() => {
  if (ORIGINAL_VITE_LOCAL_FILE === undefined) {
    delete process.env.VITE_LOCAL_FILE;
  } else {
    process.env.VITE_LOCAL_FILE = ORIGINAL_VITE_LOCAL_FILE;
  }
  if (ORIGINAL_VITE_STARTUP_MODE === undefined) {
    delete process.env.VITE_STARTUP_MODE;
  } else {
    process.env.VITE_STARTUP_MODE = ORIGINAL_VITE_STARTUP_MODE;
  }
});

describe('resolveDdlPath', () => {
  it('CLI-01: 相対パス → cwd基準の絶対パスに解決される', () => {
    expect(resolveDdlPath('schema/ddl.sql', '/home/user/project')).toBe('/home/user/project/schema/ddl.sql');
  });

  it('CLI-02: 絶対パス → そのまま返す', () => {
    expect(resolveDdlPath('/abs/path/schema.sql', '/home/user/project')).toBe('/abs/path/schema.sql');
  });
});

describe('parseArgs', () => {
  it('引数なし → filePathArg undefined, mode既定はauthor, saveDir未指定', () => {
    expect(parseArgs([])).toEqual({ filePathArg: undefined, mode: 'author', saveDir: undefined });
  });

  it('位置引数のみ → filePathArgに反映、mode既定はauthor', () => {
    expect(parseArgs(['schema/ddl.sql'])).toEqual({ filePathArg: 'schema/ddl.sql', mode: 'author', saveDir: undefined });
  });

  it('--mode=/--save-dir= を解析し、positionalから除外する', () => {
    expect(parseArgs(['schema/ddl.sql', '--mode=verify', '--save-dir=/tmp/x'])).toEqual({
      filePathArg: 'schema/ddl.sql',
      mode: 'verify',
      saveDir: '/tmp/x',
    });
  });
});

describe('openBrowser', () => {
  it('CLI-03: linuxではxdg-openを呼び出す', () => {
    openBrowser('http://127.0.0.1:5173/', 'linux');
    expect(exec).toHaveBeenCalledWith('xdg-open "http://127.0.0.1:5173/"', expect.any(Function));
  });

  it('macOSではopenを呼び出す', () => {
    openBrowser('http://127.0.0.1:5173/', 'darwin');
    expect(exec).toHaveBeenCalledWith('open "http://127.0.0.1:5173/"', expect.any(Function));
  });

  it('Windowsではcmd /c startを呼び出す', () => {
    openBrowser('http://127.0.0.1:5173/', 'win32');
    expect(exec).toHaveBeenCalledWith('cmd /c start "" "http://127.0.0.1:5173/"', expect.any(Function));
  });
});

describe('spawnVite', () => {
  it('CLI-04: VITE_LOCAL_FILE/VITE_STARTUP_MODEをenv指定し、buildApiPluginを注入してvite devサーバを起動する', async () => {
    const listen = vi.fn().mockResolvedValue(undefined);
    const fakeServer = { listen, resolvedUrls: { local: ['http://127.0.0.1:5199/'] }, printUrls: vi.fn() };
    createServer.mockResolvedValueOnce(fakeServer);

    const server = await spawnVite({ filePath: '/abs/schema.sql', port: 5199 });

    expect(process.env.VITE_LOCAL_FILE).toBe('true');
    expect(process.env.VITE_STARTUP_MODE).toBe('author');
    expect(buildApiPlugin).toHaveBeenCalledWith('/abs/schema.sql', { readOnly: false, saveDir: undefined });
    expect(buildQueryApiPlugin).toHaveBeenCalledWith('/abs/schema.sql');
    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: [
          { name: 'sql-viz-local-api', filePath: '/abs/schema.sql' },
          { name: 'sql-viz-query-api', filePath: '/abs/schema.sql' },
        ],
        server: expect.objectContaining({ host: '127.0.0.1', port: 5199, open: false }),
      }),
    );
    expect(listen).toHaveBeenCalledTimes(1);
    expect(server).toBe(fakeServer);
  });

  it('mode: "verify" + saveDir指定時、readOnly:trueかつそのsaveDirでbuildApiPluginを呼ぶ', async () => {
    const listen = vi.fn().mockResolvedValue(undefined);
    const fakeServer = { listen, resolvedUrls: { local: ['http://127.0.0.1:5199/'] }, printUrls: vi.fn() };
    createServer.mockResolvedValueOnce(fakeServer);

    await spawnVite({ filePath: '/abs/schema.sql', port: 5199, mode: 'verify', saveDir: '/tmp/x' });

    expect(process.env.VITE_STARTUP_MODE).toBe('verify');
    expect(buildApiPlugin).toHaveBeenCalledWith('/abs/schema.sql', { readOnly: true, saveDir: '/tmp/x' });
  });
});

describe('main', () => {
  it('CLI-05: ファイルパス引数なし → stderrにusage出力、exit code 1', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await main([]);

    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(createServer).not.toHaveBeenCalled();

    writeSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('引数ありのとき、パス解決 → vite起動 → ブラウザ起動の順に実行する', async () => {
    const listen = vi.fn().mockResolvedValue(undefined);
    const fakeServer = { listen, resolvedUrls: { local: ['http://127.0.0.1:5173/'] }, printUrls: vi.fn() };
    createServer.mockResolvedValueOnce(fakeServer);

    await main(['schema/ddl.sql']);

    expect(buildApiPlugin).toHaveBeenCalledWith(
      expect.stringContaining('/schema/ddl.sql'),
      { readOnly: false, saveDir: undefined },
    );
    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining('http://127.0.0.1:5173/'),
      expect.any(Function),
    );
  });

  it('不正な --mode → stderrにusage出力、exit code 1、viteは起動しない', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await main(['schema/ddl.sql', '--mode=bogus']);

    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(createServer).not.toHaveBeenCalled();

    writeSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('--save-dir を --mode=verify なしで指定 → stderrにusage出力、exit code 1', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await main(['schema/ddl.sql', '--save-dir=/tmp/x']);

    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(createServer).not.toHaveBeenCalled();

    writeSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('--mode=verify かつ --save-dir未指定 → os.tmpdir()配下の既定パスをsaveDirとしてspawnする', async () => {
    const listen = vi.fn().mockResolvedValue(undefined);
    const fakeServer = { listen, resolvedUrls: { local: ['http://127.0.0.1:5173/'] }, printUrls: vi.fn() };
    createServer.mockResolvedValueOnce(fakeServer);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['schema/ddl.sql', '--mode=verify']);

    const expectedSaveDir = path.join(os.tmpdir(), 'sql-viz-verify-saves');
    expect(buildApiPlugin).toHaveBeenCalledWith(expect.stringContaining('/schema/ddl.sql'), {
      readOnly: true,
      saveDir: expectedSaveDir,
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(expectedSaveDir));

    logSpy.mockRestore();
  });

  it('--mode=verify --save-dir=<path> → 指定したsaveDirでspawnする', async () => {
    const listen = vi.fn().mockResolvedValue(undefined);
    const fakeServer = { listen, resolvedUrls: { local: ['http://127.0.0.1:5173/'] }, printUrls: vi.fn() };
    createServer.mockResolvedValueOnce(fakeServer);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['schema/ddl.sql', '--mode=verify', '--save-dir=/tmp/custom-dir']);

    expect(buildApiPlugin).toHaveBeenCalledWith(expect.stringContaining('/schema/ddl.sql'), {
      readOnly: true,
      saveDir: '/tmp/custom-dir',
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('/tmp/custom-dir'));

    logSpy.mockRestore();
  });
});
