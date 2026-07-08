import { ChevronRight } from 'lucide-react';

interface Props {
  log: string[];
}

export default function ExecutionLogPanel({ log }: Props) {
  return (
    <div className="border-t border-slate-800 max-h-44 overflow-auto">
      <div className="px-4 py-2 text-[11px] uppercase tracking-wider text-slate-500 sticky top-0 bg-slate-900/80 backdrop-blur">Execution log</div>
      <div className="px-4 pb-3 space-y-1">
        {log.length === 0 && <p className="text-xs text-slate-600 font-mono">No statements run yet.</p>}
        {log.map((line, i) => (
          <div key={i} className="flex items-start gap-2 text-xs font-mono text-slate-400">
            <ChevronRight size={13} className="mt-0.5 text-sky-500 shrink-0" />
            <span>{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
