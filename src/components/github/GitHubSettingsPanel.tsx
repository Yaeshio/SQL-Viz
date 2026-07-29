import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Github, CheckCircle2, XCircle, Loader2, UploadCloud } from 'lucide-react';
import type { PGlite } from '@electric-sql/pglite';
import type { AppMode } from '../../types';
import { getRepo, GitHubApiError, type GitHubSettings } from '../../github/client';
import { pushSchema } from '../../github/pushSchema';

interface Props {
  open: boolean;
  onClose: () => void;
  settings: GitHubSettings;
  onSettingsChange: (settings: GitHubSettings) => void;
  mode: AppMode;
  order: string[];
  getDb: () => PGlite | null;
}

type ConnectionStatus =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'success'; defaultBranch: string }
  | { kind: 'error'; message: string };

type PushStatus = { kind: 'idle' } | { kind: 'pushing' } | { kind: 'success' } | { kind: 'error'; message: string };

const inputClass =
  'w-full px-2.5 py-1.5 rounded-md bg-slate-800 border border-slate-700 text-slate-100 text-xs font-mono focus:outline-none focus:border-sky-500';

function errorMessage(e: unknown): string {
  return e instanceof GitHubApiError ? e.message : e instanceof Error ? e.message : 'Unknown error';
}

/** Settings panel for M5 (github-sync-design.md 10節): PAT/owner/repo/branch
 * input, a connection test (getRepo), and the schema push action. Query
 * example promotion (M6) is out of scope here. */
export default function GitHubSettingsPanel({ open, onClose, settings, onSettingsChange, mode, order, getDb }: Props) {
  const [connection, setConnection] = useState<ConnectionStatus>({ kind: 'idle' });
  const [push, setPush] = useState<PushStatus>({ kind: 'idle' });

  const update = (patch: Partial<GitHubSettings>) => onSettingsChange({ ...settings, ...patch });

  const canTest = Boolean(settings.token && settings.owner && settings.repo);
  const canPush = canTest && mode === 'design' && order.length > 0;

  const handleTest = async () => {
    setConnection({ kind: 'testing' });
    try {
      const { defaultBranch } = await getRepo(settings.owner, settings.repo, settings.token);
      setConnection({ kind: 'success', defaultBranch });
    } catch (e) {
      setConnection({ kind: 'error', message: errorMessage(e) });
    }
  };

  const handlePush = async () => {
    const db = getDb();
    if (!db) return;
    setPush({ kind: 'pushing' });
    try {
      await pushSchema(db, order, settings);
      setPush({ kind: 'success' });
    } catch (e) {
      setPush({ kind: 'error', message: errorMessage(e) });
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 bg-slate-950/60 z-40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            className="fixed top-0 right-0 h-full w-96 bg-slate-900 border-l border-slate-800 z-50 flex flex-col"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'tween', duration: 0.2 }}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                <Github size={16} className="text-sky-400" /> GitHub連携
              </div>
              <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-auto px-4 py-4 space-y-4 text-sm">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Personal Access Token</label>
                <input
                  type="password"
                  value={settings.token}
                  onChange={(e) => update({ token: e.target.value })}
                  placeholder="github_pat_..."
                  className={inputClass}
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  対象リポジトリに限定したfine-grained PAT（Contentsの読み書き権限のみ）を推奨します。classic
                  PAT（repoスコープ全体）は推奨しません。
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Owner</label>
                  <input value={settings.owner} onChange={(e) => update({ owner: e.target.value })} placeholder="octocat" className={inputClass} />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Repo</label>
                  <input value={settings.repo} onChange={(e) => update({ repo: e.target.value })} placeholder="my-repo" className={inputClass} />
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-500 mb-1">Branch</label>
                <input value={settings.branch} onChange={(e) => update({ branch: e.target.value })} placeholder="main" className={inputClass} />
              </div>

              <button
                onClick={handleTest}
                disabled={!canTest || connection.kind === 'testing'}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-700 hover:border-slate-500 hover:bg-slate-800 transition text-slate-300 text-xs disabled:opacity-40 disabled:hover:bg-transparent"
              >
                {connection.kind === 'testing' && <Loader2 size={13} className="animate-spin" />}
                接続テスト
              </button>
              {connection.kind === 'success' && (
                <p className="flex items-center gap-1.5 text-[11px] text-emerald-400">
                  <CheckCircle2 size={13} /> 接続成功（デフォルトブランチ: {connection.defaultBranch}）
                </p>
              )}
              {connection.kind === 'error' && (
                <p className="flex items-center gap-1.5 text-[11px] text-rose-400">
                  <XCircle size={13} /> {connection.message}
                </p>
              )}

              <div className="pt-3 border-t border-slate-800">
                <button
                  onClick={handlePush}
                  disabled={!canPush || push.kind === 'pushing'}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-sky-500 hover:bg-sky-400 transition text-slate-950 text-xs font-medium disabled:opacity-40 disabled:hover:bg-sky-500"
                >
                  {push.kind === 'pushing' ? <Loader2 size={13} className="animate-spin" /> : <UploadCloud size={13} />}
                  スキーマをプッシュ
                </button>
                {mode !== 'design' && (
                  <p className="mt-1.5 text-[11px] text-slate-500">スキーマのプッシュは設計モードでのみ実行できます。</p>
                )}
                {push.kind === 'success' && (
                  <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-emerald-400">
                    <CheckCircle2 size={13} /> schema/ddl.sql をプッシュしました
                  </p>
                )}
                {push.kind === 'error' && (
                  <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-rose-400">
                    <XCircle size={13} /> {push.message}
                  </p>
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
