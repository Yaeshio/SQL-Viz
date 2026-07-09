import { motion } from 'framer-motion';
import type { Row, Table } from '../../types';
import { ROW_H, TABLE_W } from '../../layout';
import { computeRowCells } from '../../lib/canvasLayout';

interface Props {
  table: Table;
  row: Row;
  y: number;
  appearing: boolean;
  filtering: boolean;
}

export default function TableRow({ table, row, y, appearing, filtering }: Props) {
  const dimmed = row.filteredOut;
  return (
    <motion.g
      initial={appearing ? { opacity: 0, x: -24, y, scale: 0.9 } : false}
      animate={{
        opacity: dimmed ? 0.18 : 1,
        x: 0,
        y,
        scale: 1,
      }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={{ duration: filtering ? 0.6 : 0.35, ease: 'easeOut' }}
    >
      <rect x={6} y={2} width={TABLE_W - 12} height={ROW_H - 4} rx={5} fill="#1e293b" />
      {computeRowCells(table.columns, row).map((cell) => (
        <g key={cell.columnName}>
          {cell.dividerX !== null && (
            <line
              x1={cell.dividerX}
              y1={2}
              x2={cell.dividerX}
              y2={ROW_H - 2}
              stroke="#334155"
              strokeWidth={1}
            />
          )}
          <text
            x={cell.textX}
            y={ROW_H / 2 + 4}
            fill={dimmed ? '#475569' : cell.isNull ? '#64748b' : '#e2e8f0'}
            fontSize={11}
            fontFamily="ui-monospace, monospace"
          >
            {cell.display}
          </text>
        </g>
      ))}
    </motion.g>
  );
}
