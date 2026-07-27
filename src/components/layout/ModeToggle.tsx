import { FlaskConical, Pencil } from 'lucide-react';
import type { AppMode } from '../../types';

interface Props {
  mode: AppMode;
  onChange: (mode: AppMode) => void;
  disabled: boolean;
}

const OPTIONS: { mode: AppMode; label: string; icon: typeof Pencil }[] = [
  { mode: 'design', label: '設計モード', icon: Pencil },
  { mode: 'experiment', label: '実験モード', icon: FlaskConical },
];

export default function ModeToggle({ mode, onChange, disabled }: Props) {
  return (
    <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-slate-800/60 border border-slate-700">
      {OPTIONS.map(({ mode: optionMode, label, icon: Icon }) => (
        <button
          key={optionMode}
          onClick={() => onChange(optionMode)}
          disabled={disabled || mode === optionMode}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition disabled:cursor-not-allowed ${
            mode === optionMode
              ? 'bg-sky-500 text-slate-950'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/60 disabled:opacity-50 disabled:hover:bg-transparent'
          }`}
        >
          <Icon size={13} /> {label}
        </button>
      ))}
    </div>
  );
}
