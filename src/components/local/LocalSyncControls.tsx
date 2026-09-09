import { CheckCircle2, Loader2, RefreshCw, Save, ShieldAlert, XCircle } from 'lucide-react';
import type { SyncStatus } from '../../hooks/useLocalSync';

export interface LocalSyncControlsProps {
  isLocal: boolean;
  /** sql-studio が --mode=verify で起動されたとき true: Save は対象ファイルを
   * もう上書きせず、サーバーが選んだ別のパスへエクスポートする
   * （App.tsx の handleSave / localSync.verifySave 参照）。 */
  verifyMode: boolean;
  saveStatus: SyncStatus;
  reloadStatus: SyncStatus;
  saveDisabled: boolean;
  onSave: () => void;
  onReload: () => void;
}

/** GitHub 設定の歯車を置き換えるもの（Issue #26）: ローカル CLI モード以外では
 * 何も描画しないため、ホスティング/Vercel ビルドではこれが一切表示されない。 */
export default function LocalSyncControls({
  isLocal,
  verifyMode,
  saveStatus,
  reloadStatus,
  saveDisabled,
  onSave,
  onReload,
}: LocalSyncControlsProps) {
  if (!isLocal) return null;

  const saveLabel = verifyMode ? '一時ファイルへ保存（検証モード）' : 'ファイルへ保存';

  return (
    <div className="flex items-center gap-1.5">
      {verifyMode && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-amber-700/60 bg-amber-950/40 text-[11px] text-amber-400"
          title="対象スキーマファイルへは保存されません"
        >
          <ShieldAlert size={11} /> 検証モード
        </span>
      )}
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
        aria-label={saveLabel}
        title={saveLabel}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-700 hover:border-slate-500 hover:bg-slate-800 transition text-slate-300 text-xs disabled:opacity-40 disabled:hover:bg-transparent"
      >
        {saveStatus.kind === 'pending' ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
        Save
      </button>
      {saveStatus.kind === 'success' && saveStatus.path && (
        <span className="flex items-center gap-1 text-[11px] text-emerald-400" role="status">
          <CheckCircle2 size={12} /> 保存先: {saveStatus.path}
        </span>
      )}
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
