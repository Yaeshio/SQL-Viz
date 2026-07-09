import type { DBState, Table } from './types';

export const TABLE_W = 240;
export const HEADER_H = 36;
export const ROW_H = 30;
export const COL_GAP = 16;
export const TABLE_GAP_X = 48;
export const TABLE_GAP_Y = 56;
export const PAD = 24;

/** Assign x/y positions to tables in a flowing grid. */
export function layoutTables(state: DBState, canvasW: number): DBState {
  const cols = Math.max(1, Math.floor((canvasW - PAD) / (TABLE_W + TABLE_GAP_X)));
  const rowCount = Math.ceil(state.order.length / cols);
  const rowHeights = new Array(rowCount).fill(0);
  state.order.forEach((name, i) => {
    const row = Math.floor(i / cols);
    rowHeights[row] = Math.max(rowHeights[row], TABLE_H(state.tables[name]));
  });
  const rowY: number[] = [];
  let acc = PAD;
  for (let r = 0; r < rowCount; r++) {
    rowY[r] = acc;
    acc += rowHeights[r] + TABLE_GAP_Y;
  }
  state.order.forEach((name, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    state.tables[name].x = PAD + col * (TABLE_W + TABLE_GAP_X);
    state.tables[name].y = rowY[row];
  });
  return state;
}

export function TABLE_H(t: Table): number {
  return HEADER_H + t.columns.length * ROW_H + t.rows.length * ROW_H + COL_GAP;
}
