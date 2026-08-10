import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createServer } = vi.hoisted(() => ({ createServer: vi.fn() }));
vi.mock('vite', () => ({ createServer }));

const { buildApiPlugin } = vi.hoisted(() => ({
  buildApiPlugin: vi.fn((filePath: string) => ({ name: 'sql-viz-local-api', filePath })),
}));
vi.mock('../src/local/apiPlugin', () => ({ buildApiPlugin }));

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({ exec }));

import { main, openBrowser, resolveDdlPath, spawnVite } from '../scripts/openLocal.mjs';

const ORIGINAL_VITE_LOCAL_FILE = process.env.VITE_LOCAL_FILE;

beforeEach(() => {
  createServer.mockReset();
  buildApiPlugin.mockClear();
  exec.mockReset();
  delete process.env.VITE_LOCAL_FILE;
});

afterEach(() => {
  if (ORIGINAL_VITE_LOCAL_FILE === undefined) {
    delete process.env.VITE_LOCAL_FILE;
  } else {
    process.env.VITE_LOCAL_FILE = ORIGINAL_VITE_LOCAL_FILE;
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
  it('CLI-04: VITE_LOCAL_FILEをenv指定し、buildApiPluginを注入してvite devサーバを起動する', async () => {
    const listen = vi.fn().mockResolvedValue(undefined);
    const fakeServer = { listen, resolvedUrls: { local: ['http://127.0.0.1:5199/'] }, printUrls: vi.fn() };
    createServer.mockResolvedValueOnce(fakeServer);

    const server = await spawnVite({ filePath: '/abs/schema.sql', port: 5199 });

    expect(process.env.VITE_LOCAL_FILE).toBe('true');
    expect(buildApiPlugin).toHaveBeenCalledWith('/abs/schema.sql');
    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: [{ name: 'sql-viz-local-api', filePath: '/abs/schema.sql' }],
        server: expect.objectContaining({ host: '127.0.0.1', port: 5199, open: false }),
      }),
    );
    expect(listen).toHaveBeenCalledTimes(1);
    expect(server).toBe(fakeServer);
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

    expect(buildApiPlugin).toHaveBeenCalledWith(expect.stringContaining('/schema/ddl.sql'));
    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining('http://127.0.0.1:5173/'),
      expect.any(Function),
    );
  });
});
