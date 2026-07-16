import { Play, Terminal } from 'lucide-react';
import ExecutionLogPanel from './ExecutionLogPanel';

interface Props {
  sql: string;
  onSqlChange: (value: string) => void;
  error: string | null;
  playing: boolean;
  initializing: boolean;
  onRun: () => void;
  log: string[];
}

export default function SqlEditorPane({ sql, onSqlChange, error, playing, initializing, onRun, log }: Props) {
  return (
    <section className="w-[420px] shrink-0 flex flex-col border-r border-slate-800 bg-slate-900/40">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-500">
        <Terminal size={13} /> SQL Editor
      </div>
      <textarea
        value={sql}
        onChange={(e) => onSqlChange(e.target.value)}
        spellCheck={false}
        className="flex-1 w-full resize-none bg-transparent text-slate-200 font-mono text-[13px] leading-relaxed p-4 outline-none placeholder:text-slate-600"
        placeholder="Type SQL here…"
      />
      {error && (
        <div className="mx-4 mb-2 px-3 py-2 rounded-md bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs font-mono">
          {error}
        </div>
      )}
      <div className="p-3 border-t border-slate-800 flex items-center gap-2">
        <button
          onClick={onRun}
          disabled={playing || initializing}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-semibold text-sm transition"
        >
          <Play size={15} /> {initializing ? 'エンジン読込中…' : playing ? 'Running…' : 'Run SQL'}
        </button>
      </div>
      <ExecutionLogPanel log={log} />
    </section>
  );
}
