import type { RefObject } from 'react';
import type { DBState } from '../../types';
import Canvas from '../canvas/Canvas';
import type { CanvasHighlight } from '../canvas/TableNode';

interface Props {
  canvasRef: RefObject<HTMLDivElement>;
  tableCount: number;
  state: DBState;
  appearingRows: Set<string>;
  filteringRows: Set<string>;
  highlight: CanvasHighlight | null;
}

export default function CanvasPane({ canvasRef, tableCount, state, appearingRows, filteringRows, highlight }: Props) {
  return (
    <section className="flex-1 min-w-0 relative bg-slate-950">
      <div className="absolute top-3 left-4 z-10 text-[11px] uppercase tracking-wider text-slate-500 pointer-events-none">
        Canvas
      </div>
      <div ref={canvasRef} className="absolute inset-0 overflow-auto">
        {tableCount === 0 ? (
          <div className="h-full w-full flex items-center justify-center text-slate-600 text-sm">
            Run a CREATE TABLE statement to begin.
          </div>
        ) : (
          <Canvas
            state={state}
            appearingRows={appearingRows}
            filteringRows={filteringRows}
            highlight={highlight}
          />
        )}
      </div>
    </section>
  );
}
