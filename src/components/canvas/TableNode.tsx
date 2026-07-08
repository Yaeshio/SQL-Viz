import { motion, AnimatePresence } from 'framer-motion';
import type { Table } from '../../types';
import { HEADER_H, ROW_H, TABLE_W } from '../../layout';
import { computeTableInnerLayout } from '../../lib/canvasLayout';
import { getColumnTypeColor } from './tableTypeColors';
import TableRow from './TableRow';

export interface CanvasHighlight {
  table: string;
  columns: string[];
}

interface Props {
  table: Table;
  appearingRows: Set<string>;
  filteringRows: Set<string>;
  highlight: CanvasHighlight | null;
}

export default function TableNode({ table, appearingRows, filteringRows, highlight }: Props) {
  const isHighlighted = highlight?.table === table.name;
  const projectedCols = highlight && highlight.columns[0] !== '*'
    ? new Set(highlight.columns)
    : null;

  const { colRows, dataRows, height } = computeTableInnerLayout(table);

  return (
    <motion.g
      initial={{ opacity: 0, scale: 0.85, y: -12 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 220, damping: 22 }}
      style={{ originX: `${table.x}px`, originY: `${table.y}px` }}
    >
      <g transform={`translate(${table.x}, ${table.y})`}>
        {/* card */}
        <rect
          width={TABLE_W}
          height={height}
          rx={10}
          fill="#0f172a"
          stroke={isHighlighted ? '#38bdf8' : '#1e293b'}
          strokeWidth={isHighlighted ? 2 : 1}
        />
        {/* header */}
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

        {/* column definitions */}
        {colRows.map(({ col, y: cy }) => {
          const projected = projectedCols ? projectedCols.has(col.name) : false;
          return (
            <g key={col.name} transform={`translate(0, ${cy})`}>
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
            </g>
          );
        })}

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
            />
          ))}
        </AnimatePresence>
      </g>
    </motion.g>
  );
}
