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

/** Blank space (px, world units) kept around the table bounding box, so the
 * "Fit" view has a little breathing room and there is somewhere to pan to. */
export const WORLD_MARGIN = 96;

/** Minimum px of the world box that clampPan() keeps on screen on each axis at
 * the pan limit. Larger than WORLD_MARGIN so at least a sliver of a real table
 * (not just the blank margin) always stays visible. */
export const KEEP_VISIBLE = 140;

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

/** Clamps a pan offset so the world box can't be dragged (almost) off screen:
 * at the limit, `keepVisible` px of the scaled world box stays inside the
 * viewport on each axis. This is a *loose* bound — within it the view moves
 * freely, so there is no snap-back right at the content edge — while still
 * enforcing Issue #17's "can't pan past the bounding box + margin" (you can
 * never lose the canvas entirely). react-zoom-pan-pinch runs with
 * limitToBounds disabled (its bounds forbid the letterboxing that "fit all
 * tables" needs); Canvas.tsx re-applies this on gesture-stop instead. Pure
 * geometry. */
export function clampPan(
  transform: { scale: number; positionX: number; positionY: number },
  viewport: { width: number; height: number },
  world: WorldBox,
  keepVisible: number = KEEP_VISIBLE,
): { positionX: number; positionY: number } {
  const axis = (pos: number, content: number, view: number) => {
    const keep = Math.min(keepVisible, content, view);
    const min = keep - content; // world's far edge stays `keep` inside the near viewport edge
    const max = view - keep; // world's near edge stays `keep` inside the far viewport edge
    if (min > max) return (view - content) / 2; // viewport smaller than 2*keep — just center
    return Math.min(max, Math.max(min, pos));
  };
  return {
    positionX: axis(transform.positionX, world.width * transform.scale, viewport.width),
    positionY: axis(transform.positionY, world.height * transform.scale, viewport.height),
  };
}
