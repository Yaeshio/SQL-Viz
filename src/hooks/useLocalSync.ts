import { useCallback, useState } from 'react';
import { fetchSchema, getStartupMode, isLocalMode, saveSchema, saveSchemaAs, type StartupMode } from '../local/localSync';

export type SyncStatus =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'success'; path?: string }
  | { kind: 'error'; message: string };

export interface UseLocalSyncResult {
  isLocal: boolean;
  startupMode: StartupMode;
  saveStatus: SyncStatus;
  reloadStatus: SyncStatus;
  save: (ddl: string) => Promise<void>;
  /** save() の verify モード版: 対象ファイルを上書きする代わりに、サーバーが
   * 選んだパスへエクスポートする。 */
  verifySave: (ddl: string) => Promise<void>;
  /** 成功時は取得した DDL を返す（呼び出し側が run() に渡す）。失敗時は null——
   * エラーは表示用に reloadStatus が保持する。 */
  reload: () => Promise<string | null>;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Unknown error';
}

/** src/local/localSync.ts の fetchSchema/saveSchema を薄く包む state ラッパー。
 * isLocal はレンダーごとに isLocalMode()（実行時に変わるものではなく、ビルド時の
 * 環境フラグ）から一度読む。そのため LocalSyncControls は CLI モード外では自身を
 * 完全に隠せる。 */
export function useLocalSync(): UseLocalSyncResult {
  const [saveStatus, setSaveStatus] = useState<SyncStatus>({ kind: 'idle' });
  const [reloadStatus, setReloadStatus] = useState<SyncStatus>({ kind: 'idle' });

  const save = useCallback(async (ddl: string) => {
    setSaveStatus({ kind: 'pending' });
    try {
      await saveSchema(ddl);
      setSaveStatus({ kind: 'success' });
    } catch (e) {
      setSaveStatus({ kind: 'error', message: errorMessage(e) });
    }
  }, []);

  const verifySave = useCallback(async (ddl: string) => {
    setSaveStatus({ kind: 'pending' });
    try {
      const { path } = await saveSchemaAs(ddl);
      setSaveStatus({ kind: 'success', path });
    } catch (e) {
      setSaveStatus({ kind: 'error', message: errorMessage(e) });
    }
  }, []);

  const reload = useCallback(async (): Promise<string | null> => {
    setReloadStatus({ kind: 'pending' });
    try {
      const content = await fetchSchema();
      setReloadStatus({ kind: 'success' });
      return content;
    } catch (e) {
      setReloadStatus({ kind: 'error', message: errorMessage(e) });
      return null;
    }
  }, []);

  return { isLocal: isLocalMode(), startupMode: getStartupMode(), saveStatus, reloadStatus, save, verifySave, reload };
}
