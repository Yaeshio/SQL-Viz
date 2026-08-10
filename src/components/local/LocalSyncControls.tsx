import { Loader2, RefreshCw, Save, XCircle } from 'lucide-react';
import type { SyncStatus } from '../../hooks/useLocalSync';

export interface LocalSyncControlsProps {
  isLocal: boolean;
  saveStatus: SyncStatus;
  reloadStatus: SyncStatus;
  saveDisabled: boolean;
  onSave: () => void;
  onReload: () => void;
}

/** Replaces the GitHub settings gear (Issue #26): renders nothing outside
 * local CLI mode, so the hosted/Vercel build never shows any of this. */
export default function LocalSyncControls({
  isLocal,
  saveStatus,
  reloadStatus,
  saveDisabled,
  onSave,
  onReload,
}: LocalSyncControlsProps) {
  if (!isLocal) return null;

  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={onReload}
        disabled={reloadStatus.kind === 'pending'}
        aria-label="ファイルから再読み込み"
        title="ファイルから再読み込み"
        className="flex items-center justify-center w-7 h-7 rounded-md border border-slate-700 hover:border-slate-500 hover:bg-slate-800 transition text-slate-300 disabled:opacity-40 disabled:hover:bg-transparent"
      >
        {reloadStatus.kind === 'pending' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
      </button>
      <button
        onClick={onSave}
        disabled={saveDisabled || saveStatus.kind === 'pending'}
        data-testid="save-to-file-btn"
        aria-label="ファイルへ保存"
        title="ファイルへ保存"
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-700 hover:border-slate-500 hover:bg-slate-800 transition text-slate-300 text-xs disabled:opacity-40 disabled:hover:bg-transparent"
      >
        {saveStatus.kind === 'pending' ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
        Save
      </button>
      {saveStatus.kind === 'error' && (
        <span className="flex items-center gap-1 text-[11px] text-rose-400" role="alert">
          <XCircle size={12} /> {saveStatus.message}
        </span>
      )}
      {reloadStatus.kind === 'error' && (
        <span className="flex items-center gap-1 text-[11px] text-rose-400" role="alert">
          <XCircle size={12} /> {reloadStatus.message}
        </span>
      )}
    </div>
  );
}
