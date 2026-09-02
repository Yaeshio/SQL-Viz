import { useRef } from 'react';
import type { DBState } from '../../types';
import Canvas from '../canvas/Canvas';
import type { CanvasHighlight } from '../canvas/TableNode';

interface Props {
  tableCount: number;
  state: DBState;
  appearingRows: Set<string>;
  filteringRows: Set<string>;
  updatingRows: Set<string>;
  appearingColumns: Set<string>;
  highlight: CanvasHighlight | null;
  onMoveTable: (name: string, x: number, y: number) => void;
}

export default function CanvasPane({
  tableCount,
  state,
  appearingRows,
  filteringRows,
  updatingRows,
  appearingColumns,
  highlight,
  onMoveTable,
}: Props) {
  const paneRef = useRef<HTMLElement>(null);

  return (
    <section
      ref={paneRef}
      data-testid="canvas-pane"
      className="flex-1 min-w-0 relative bg-slate-950 overflow-hidden"
    >
      <div className="absolute top-3 left-4 z-10 text-[11px] uppercase tracking-wider text-slate-500 pointer-events-none">
        Canvas
      </div>
      {tableCount === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center text-slate-600 text-sm">
          Run a CREATE TABLE statement to begin.
        </div>
      ) : (
        <Canvas
          paneRef={paneRef}
          state={state}
          appearingRows={appearingRows}
          filteringRows={filteringRows}
          updatingRows={updatingRows}
          appearingColumns={appearingColumns}
          highlight={highlight}
          onMoveTable={onMoveTable}
        />
      )}
    </section>
  );
}
