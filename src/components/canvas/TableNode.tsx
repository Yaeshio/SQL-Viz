import { memo } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Table } from '../../types';
import { HEADER_H, ROW_H, TABLE_W } from '../../layout';
import { computeTableInnerLayout } from '../../lib/canvasLayout';
import { getColumnTypeColor } from './tableTypeColors';
import { columnKey } from '../../hooks/useAnimationPlayer';
import TableRow from './TableRow';

export interface CanvasHighlight {
  table: string;
  columns: string[];
}

interface Props {
  table: Table;
  appearingRows: Set<string>;
  filteringRows: Set<string>;
  updatingRows: Set<string>;
  appearingColumns: Set<string>;
  highlight: CanvasHighlight | null;
  /** Header pointerdown → drag start (Issue #34). Owned by Canvas, which
   * tracks the drag itself; this only reports the gesture's origin. */
  onHeaderPointerDown?: (e: ReactPointerEvent, name: string) => void;
  /** Live world-space offset while this table is the one being dragged. */
  dragOffset?: { dx: number; dy: number };
  isDragging?: boolean;
}

function TableNode({
  table,
  appearingRows,
  filteringRows,
  updatingRows,
  appearingColumns,
  highlight,
  onHeaderPointerDown,
  dragOffset,
  isDragging,
}: Props) {
  const isHighlighted = highlight?.table === table.name;
  const projectedCols = highlight && highlight.columns[0] !== '*'
    ? new Set(highlight.columns)
    : null;

  const { colRows, dataRows, height } = computeTableInnerLayout(table);
  const x = table.x + (dragOffset?.dx ?? 0);
  const y = table.y + (dragOffset?.dy ?? 0);

  return (
    <motion.g
      initial={{ opacity: 0, scale: 0.85, y: -12 }}
      animate={{ opacity: 1, scale: isDragging ? 1.04 : 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.85, y: 12 }}
      transition={{ type: 'spring', stiffness: 220, damping: 22 }}
      style={{
        originX: `${table.x}px`,
        originY: `${table.y}px`,
        filter: isDragging ? 'drop-shadow(0 10px 18px rgba(0,0,0,0.55))' : undefined,
      }}
    >
      <g
        transform={`translate(${x}, ${y})`}
        data-testid="table-node"
        data-table-name={table.name}
        data-x={x}
        data-y={y}
      >
        {/* card */}
        <rect
          width={TABLE_W}
          height={height}
          rx={10}
          fill="#0f172a"
          stroke={isHighlighted ? '#38bdf8' : '#1e293b'}
          strokeWidth={isHighlighted ? 2 : 1}
        />
        {/* header — sole drag handle (Issue #34). react-zoom-pan-pinch's own
            pan gesture listens for "mousedown" on `window` directly
            (independent of this element's pointerdown propagation chain, so
            no stopPropagation here could ever block it) and skips its own
            handling when the event target matches its `panning.excluded`
            class list (Canvas.tsx) — that's what actually keeps this drag
            from also panning the canvas, not this handler. */}
        <g
          className="sqlviz-drag-handle"
          data-testid="table-drag-handle"
          data-table-name={table.name}
          onPointerDown={(e) => onHeaderPointerDown?.(e, table.name)}
          style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
        >
          <rect width={TABLE_W} height={HEADER_H} rx={10} fill="#1e293b" />
          <rect y={HEADER_H - 10} width={TABLE_W} height={10} fill="#1e293b" />
          <text
            x={14}
            y={HEADER_H / 2 + 5}
            fill="#e2e8f0"
            fontSize={15}
            fontWeight={700}
            fontFamily="ui-monospace, monospace"
          >
            {table.name}
          </text>
          <circle cx={TABLE_W - 16} cy={HEADER_H / 2} r={4} fill={isHighlighted ? '#38bdf8' : '#475569'} />
        </g>

        {/* column definitions */}
        <AnimatePresence>
          {colRows.map(({ col, y: cy }) => {
            const projected = projectedCols ? projectedCols.has(col.name) : false;
            const appearing = appearingColumns.has(columnKey(table.name, col.name));
            return (
              <motion.g
                key={col.name}
                initial={appearing ? { opacity: 0, x: -16, y: cy } : false}
                animate={{ opacity: 1, x: 0, y: cy }}
                exit={{ opacity: 0, x: 16 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
              >
                <text x={14} y={ROW_H / 2 + 4} fill="#cbd5e1" fontSize={12} fontFamily="ui-monospace, monospace">
                  {col.name}
                </text>
                <text
                  x={TABLE_W - 14}
                  y={ROW_H / 2 + 4}
                  fill={getColumnTypeColor(col.type)}
                  fontSize={10}
                  textAnchor="end"
                  fontFamily="ui-monospace, monospace"
                >
                  {col.type}
                </text>
                {projected && (
                  <rect x={6} y={4} width={TABLE_W - 12} height={ROW_H - 8} rx={4} fill="#38bdf8" opacity={0.08} />
                )}
              </motion.g>
            );
          })}
        </AnimatePresence>

        {/* separator */}
        <line x1={8} y1={height - ROW_H} x2={TABLE_W - 8} y2={height - ROW_H} stroke="#334155" strokeWidth={1} />

        {/* data rows */}
        <AnimatePresence>
          {dataRows.map(({ row, y: ry }) => (
            <TableRow
              key={row.id}
              table={table}
              row={row}
              y={ry}
              appearing={appearingRows.has(row.id)}
              filtering={filteringRows.has(row.id)}
              updating={updatingRows.has(row.id)}
            />
          ))}
        </AnimatePresence>
      </g>
    </motion.g>
  );
}

export default memo(TableNode);
