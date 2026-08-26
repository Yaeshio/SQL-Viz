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
  /** verify-mode counterpart to save(): exports to a server-chosen path
   * instead of overwriting the target file. */
  verifySave: (ddl: string) => Promise<void>;
  /** Returns the fetched DDL on success (caller feeds it to run()), or null
   * on failure — reloadStatus carries the error for display. */
  reload: () => Promise<string | null>;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Unknown error';
}

/** Thin state wrapper around src/local/localSync.ts's fetchSchema/saveSchema.
 * isLocal is read once per render from isLocalMode() (a build-time env flag,
 * not something that changes at runtime) so LocalSyncControls can hide
 * itself entirely outside CLI mode. */
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
