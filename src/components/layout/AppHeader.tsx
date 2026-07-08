import { Database, Trash2 } from 'lucide-react';

interface Props {
  tableCount: number;
  rowCount: number;
  onReset: () => void;
}

export default function AppHeader({ tableCount, rowCount, onReset }: Props) {
  return (
    <header className="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-slate-900/60 backdrop-blur">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-sky-500/15 border border-sky-500/30 flex items-center justify-center">
          <Database size={18} className="text-sky-400" />
        </div>
        <div>
          <h1 className="text-sm font-semibold tracking-tight">SQL Visualizer</h1>
          <p className="text-[11px] text-slate-500 -mt-0.5">CREATE · INSERT · SELECT — animated</p>
        </div>
      </div>
      <div className="flex items-center gap-4 text-xs text-slate-400">
        <span><span className="text-slate-500">tables</span> <span className="font-mono text-slate-200">{tableCount}</span></span>
        <span><span className="text-slate-500">rows</span> <span className="font-mono text-slate-200">{rowCount}</span></span>
        <button
          onClick={onReset}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-700 hover:border-slate-500 hover:bg-slate-800 transition text-slate-300"
        >
          <Trash2 size={13} /> Reset
        </button>
      </div>
    </header>
  );
}
