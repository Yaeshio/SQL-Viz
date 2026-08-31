import type { Column, Row, Table } from '../types';
import { HEADER_H, ROW_H, COL_GAP, TABLE_H, TABLE_W } from '../layout';

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

export interface WorldBox {
  width: number;
  height: number;
}

/** Blank space (px, world units) kept around the table bounding box. The
 * pannable area is the bounding box plus this margin — react-zoom-pan-pinch's
 * `limitToBounds` then stops the pan at the SVG edge. */
export const WORLD_MARGIN = 240;

/** Minimum world size so a near-empty canvas still fills a sensible area. */
const MIN_WORLD_W = 800;
const MIN_WORLD_H = 500;

/** Computes the world-space size (the SVG's pixel width/height) that encloses
 * every table's real card rectangle plus `margin` of blank space, clamped to a
 * minimum. Pure geometry — the pan/zoom transform is applied on top of this by
 * Canvas.tsx. */
export function computeWorldBox(tables: Table[], margin: number = WORLD_MARGIN): WorldBox {
  const maxX = Math.max(0, ...tables.map((t) => t.x + TABLE_W));
  const maxY = Math.max(0, ...tables.map((t) => t.y + TABLE_H(t)));
  return {
    width: Math.max(maxX + margin, MIN_WORLD_W),
    height: Math.max(maxY + margin, MIN_WORLD_H),
  };
}

export interface FitTransform {
  scale: number;
  positionX: number;
  positionY: number;
}

export interface FitOptions {
  minScale?: number;
  /** Never zoom in past this when fitting (default 1 — don't magnify a small canvas). */
  maxScale?: number;
  /** Inset kept between the world box and the viewport edge, in screen px. */
  padding?: number;
}

/** Computes the react-zoom-pan-pinch transform ({scale, positionX, positionY})
 * that centers `world` inside `viewport` and scales it to fit within `padding`
 * of every edge. Pure geometry so it can be unit-tested and so the initial fit
 * and the "Fit" button share one code path (no dependency on the live SVG
 * bounding box or framer-motion's in-flight enter animation). */
export function computeFitTransform(
  viewport: { width: number; height: number },
  world: WorldBox,
  { minScale = 0.05, maxScale = 1, padding = 0 }: FitOptions = {},
): FitTransform {
  const availW = Math.max(1, viewport.width - padding * 2);
  const availH = Math.max(1, viewport.height - padding * 2);
  const raw = Math.min(availW / world.width, availH / world.height);
  const scale = Math.min(maxScale, Math.max(minScale, raw));
  return {
    scale,
    positionX: (viewport.width - world.width * scale) / 2,
    positionY: (viewport.height - world.height * scale) / 2,
  };
}

/** Clamps a pan offset so the world box (which already includes WORLD_MARGIN)
 * cannot be dragged past the viewport: when the scaled world is larger than the
 * viewport it must keep covering it; when smaller it must stay fully inside.
 * This is what enforces Issue #17's "can't pan beyond the bounding box + margin"
 * — react-zoom-pan-pinch runs with limitToBounds disabled (its bounds forbid the
 * letterboxing that "fit all tables" needs) and Canvas.tsx re-applies this on
 * every gesture-stop instead. Pure geometry. */
export function clampPan(
  transform: { scale: number; positionX: number; positionY: number },
  viewport: { width: number; height: number },
  world: WorldBox,
): { positionX: number; positionY: number } {
  const axis = (pos: number, content: number, view: number) => {
    const a = Math.min(0, view - content);
    const b = Math.max(0, view - content);
    return Math.min(b, Math.max(a, pos));
  };
  return {
    positionX: axis(transform.positionX, world.width * transform.scale, viewport.width),
    positionY: axis(transform.positionY, world.height * transform.scale, viewport.height),
  };
}
