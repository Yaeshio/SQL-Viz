import { AnimatePresence } from 'framer-motion';
import type { DBState } from '../../types';
import { computeCanvasViewBox } from '../../lib/canvasLayout';
import TableNode from './TableNode';
import type { CanvasHighlight } from './TableNode';

interface Props {
  state: DBState;
  /** ids of rows that should currently animate in (added this tick) */
  appearingRows: Set<string>;
  /** ids of rows that should currently fade out (filtered this tick) */
  filteringRows: Set<string>;
  /** ids of rows whose values just changed (UPDATE) and should pulse */
  updatingRows: Set<string>;
  /** table+column keys (see columnKey()) that should currently animate in (ALTER ADD COLUMN this tick) */
  appearingColumns: Set<string>;
  /** table currently highlighted by SELECT, plus its projected columns */
  highlight: CanvasHighlight | null;
}

export default function Canvas({
  state,
  appearingRows,
  filteringRows,
  updatingRows,
  appearingColumns,
  highlight,
}: Props) {
  const tables = state.order.map((n) => state.tables[n]);
  const viewBox = computeCanvasViewBox(tables);
  return (
    <svg width="100%" height="100%" viewBox={`0 0 ${viewBox.width} ${viewBox.height}`} className="block">
      <defs>
        <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#1e293b" strokeWidth={0.5} />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#grid)" />
      <AnimatePresence>
        {tables.map((t) => (
          <TableNode
            key={t.name}
            table={t}
            appearingRows={appearingRows}
            filteringRows={filteringRows}
            updatingRows={updatingRows}
            appearingColumns={appearingColumns}
            highlight={highlight}
          />
        ))}
      </AnimatePresence>
    </svg>
  );
}
