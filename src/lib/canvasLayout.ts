import type { Column, Row, Table } from '../types';
import { HEADER_H, ROW_H, COL_GAP, TABLE_W } from '../layout';

export interface TableInnerLayout {
  colRows: { col: Column; y: number }[];
  dataRows: { row: Row; y: number }[];
  height: number;
}

/** Computes the y offsets of a table card's column-definition rows and data
 * rows, plus the card's total height. */
export function computeTableInnerLayout(table: Table): TableInnerLayout {
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
  return { colRows, dataRows, height };
}

export interface RowCellLayout {
  columnName: string;
  /** x position of the divider line preceding this cell, or null for the first column. */
  dividerX: number | null;
  textX: number;
  display: string;
  isNull: boolean;
}

/** Computes per-cell x positions and truncated display text for one data row. */
export function computeRowCells(columns: Column[], row: Row): RowCellLayout[] {
  const cellPad = 8;
  const colW = (TABLE_W - cellPad * 2) / columns.length;
  const maxChars = Math.max(1, Math.floor(colW / 6.5) - 1);
  return columns.map((c, i) => {
    const val = row.values[c.name];
    const isNull = val === null;
    const raw = isNull ? 'NULL' : String(val);
    const display = raw.length > maxChars ? raw.slice(0, maxChars - 1) + '…' : raw;
    return {
      columnName: c.name,
      dividerX: i > 0 ? cellPad + i * colW : null,
      textX: cellPad + i * colW + 6,
      display,
      isNull,
    };
  });
}

export interface CanvasViewBox {
  width: number;
  height: number;
}

/** Computes the SVG viewBox size that encloses all tables, with a minimum canvas size. */
export function computeCanvasViewBox(tables: Table[]): CanvasViewBox {
  const maxX = Math.max(0, ...tables.map((t) => t.x + TABLE_W)) + 24;
  const maxY = Math.max(0, ...tables.map((t) => t.y + 200)) + 24;
  return { width: Math.max(maxX, 800), height: Math.max(maxY, 500) };
}
