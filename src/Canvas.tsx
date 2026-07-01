import { motion, AnimatePresence } from 'framer-motion';
import type { DBState, Table } from './types';
import { HEADER_H, ROW_H, TABLE_W, COL_GAP } from './layout';

interface Props {
  state: DBState;
  /** ids of rows that should currently animate in (added this tick) */
  appearingRows: Set<string>;
  /** ids of rows that should currently fade out (filtered this tick) */
  filteringRows: Set<string>;
  /** table currently highlighted by SELECT, plus its projected columns */
  highlight: { table: string; columns: string[] } | null;
}

const typeColor: Record<string, string> = {
  INT: '#3b82f6',
  VARCHAR: '#10b981',
  TEXT: '#10b981',
  BOOLEAN: '#f59e0b',
  DATE: '#8b5cf6',
  UNKNOWN: '#64748b',
};

function TableNode({
  table,
  appearingRows,
  filteringRows,
  highlight,
}: {
  table: Table;
  appearingRows: Set<string>;
  filteringRows: Set<string>;
  highlight: Props['highlight'];
}) {
  const isHighlighted = highlight?.table === table.name;
  const projectedCols = highlight && highlight.columns[0] !== '*'
    ? new Set(highlight.columns)
    : null;

  let y = HEADER_H;
  const colRows = table.columns.map((c) => {
    const cy = y;
    y += ROW_H;
    return { col: c, y: cy };
  });
  y += COL_GAP / 2;
  const dataRows = table.rows.map((r) => {
    const ry = y;
    y += ROW_H;
    return { row: r, y: ry };
  });

  const height = y;

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
                fill={typeColor[col.type] ?? '#64748b'}
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
        <line x1={8} y1={y - COL_GAP / 2 - ROW_H + COL_GAP / 2} x2={TABLE_W - 8} y2={y - COL_GAP / 2 - ROW_H + COL_GAP / 2} stroke="#334155" strokeWidth={1} />

        {/* data rows */}
        <AnimatePresence>
          {dataRows.map(({ row, y: ry }) => {
            const appearing = appearingRows.has(row.id);
            const filtering = filteringRows.has(row.id);
            const dimmed = row.filteredOut;
            return (
              <motion.g
                key={row.id}
                transform={`translate(0, ${ry})`}
                initial={appearing ? { opacity: 0, x: -24, scale: 0.9 } : false}
                animate={{
                  opacity: dimmed ? 0.18 : 1,
                  x: 0,
                  scale: 1,
                }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ duration: filtering ? 0.6 : 0.35, ease: 'easeOut' }}
              >
                <rect x={6} y={2} width={TABLE_W - 12} height={ROW_H - 4} rx={5} fill="#1e293b" />
                {(() => {
                  const cellPad = 8;
                  const colW = (TABLE_W - cellPad * 2) / table.columns.length;
                  const maxChars = Math.max(1, Math.floor(colW / 6.5) - 1);
                  return table.columns.map((c, i) => {
                    const val = row.values[c.name];
                    const display = val === null ? 'NULL' : String(val);
                    const truncated = display.length > maxChars ? display.slice(0, maxChars - 1) + '…' : display;
                    return (
                      <g key={c.name}>
                        {i > 0 && (
                          <line
                            x1={cellPad + i * colW}
                            y1={2}
                            x2={cellPad + i * colW}
                            y2={ROW_H - 2}
                            stroke="#334155"
                            strokeWidth={1}
                          />
                        )}
                        <text
                          x={cellPad + i * colW + 6}
                          y={ROW_H / 2 + 4}
                          fill={dimmed ? '#475569' : val === null ? '#64748b' : '#e2e8f0'}
                          fontSize={11}
                          fontFamily="ui-monospace, monospace"
                        >
                          {truncated}
                        </text>
                      </g>
                    );
                  });
                })()}
              </motion.g>
            );
          })}
        </AnimatePresence>
      </g>
    </motion.g>
  );
}

export default function Canvas({ state, appearingRows, filteringRows, highlight }: Props) {
  const tables = state.order.map((n) => state.tables[n]);
  const maxX = Math.max(0, ...tables.map((t) => t.x + TABLE_W)) + 24;
  const maxY = Math.max(0, ...tables.map((t) => t.y + 200)) + 24;
  return (
    <svg width="100%" height="100%" viewBox={`0 0 ${Math.max(maxX, 800)} ${Math.max(maxY, 500)}`} className="block">
      <defs>
        <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#1e293b" strokeWidth={0.5} />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#grid)" />
      {tables.map((t) => (
        <TableNode
          key={t.name}
          table={t}
          appearingRows={appearingRows}
          filteringRows={filteringRows}
          highlight={highlight}
        />
      ))}
    </svg>
  );
}
