import type { DBState, Table } from './types';

export const TABLE_W = 240;
export const HEADER_H = 36;
export const ROW_H = 30;
export const COL_GAP = 16;
export const TABLE_GAP_X = 48;
export const TABLE_GAP_Y = 56;
export const PAD = 24;

/** Fixed wrap width for the world coordinate system (Issue #17). Table
 * positions are laid out against this constant, not the live viewport width,
 * so the canvas can be panned/zoomed without tables reflowing and so the
 * browser and the query-API server produce identical layouts. Sized for a
 * 5-column grid: floor((WORLD_W - PAD) / (TABLE_W + TABLE_GAP_X)) === 5. */
export const WORLD_W = 1680;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** AABB overlap test, inflated by half the standard table gaps so an
 * auto-placed table keeps its usual breathing room around an obstacle
 * instead of merely not touching it. */
function rectsOverlap(a: Rect, b: Rect): boolean {
  const mx = TABLE_GAP_X / 2;
  const my = TABLE_GAP_Y / 2;
  return a.x < b.x + b.w + mx && a.x + a.w + mx > b.x && a.y < b.y + b.h + my && a.y + a.h + my > b.y;
}

/**
 * Assign x/y positions to tables in a flowing grid. Tables flagged
 * `manuallyPositioned` (Issue #34 — user has dragged them) are left
 * untouched and excluded from the grid computation entirely; the remaining
 * (auto) tables, including newly created ones, tighten around the gap they'd
 * otherwise leave. Each auto table's grid candidate is then nudged straight
 * down, one table at a time in `state.order` order, until it no longer
 * overlaps any manually-positioned table or any auto table already placed
 * earlier in this same pass — so a new table never spawns on top of a table
 * the user has dragged off-grid. With no manually-positioned tables present
 * this nudge never triggers, so output is unchanged from before Issue #34.
 */
export function layoutTables(state: DBState, canvasW: number): DBState {
  const cols = Math.max(1, Math.floor((canvasW - PAD) / (TABLE_W + TABLE_GAP_X)));
  const autoNames = state.order.filter((name) => !state.tables[name].manuallyPositioned);

  const rowCount = Math.ceil(autoNames.length / cols);
  const rowHeights = new Array(rowCount).fill(0);
  autoNames.forEach((name, i) => {
    const row = Math.floor(i / cols);
    rowHeights[row] = Math.max(rowHeights[row], TABLE_H(state.tables[name]));
  });
  const rowY: number[] = [];
  let acc = PAD;
  for (let r = 0; r < rowCount; r++) {
    rowY[r] = acc;
    acc += rowHeights[r] + TABLE_GAP_Y;
  }

  const obstacles: Rect[] = state.order
    .filter((name) => state.tables[name].manuallyPositioned)
    .map((name) => {
      const t = state.tables[name];
      return { x: t.x, y: t.y, w: TABLE_W, h: TABLE_H(t) };
    });

  autoNames.forEach((name, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const h = TABLE_H(state.tables[name]);
    const rect: Rect = { x: PAD + col * (TABLE_W + TABLE_GAP_X), y: rowY[row], w: TABLE_W, h };
    while (obstacles.some((o) => rectsOverlap(rect, o))) {
      rect.y += TABLE_GAP_Y + h;
    }
    state.tables[name].x = rect.x;
    state.tables[name].y = rect.y;
    obstacles.push(rect);
  });

  return state;
}

export function TABLE_H(t: Table): number {
  return HEADER_H + t.columns.length * ROW_H + t.rows.length * ROW_H + COL_GAP;
}
