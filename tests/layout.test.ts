import { describe, expect, it } from 'vitest';
import { HEADER_H, PAD, ROW_H, TABLE_GAP_X, TABLE_GAP_Y, TABLE_H, TABLE_W, layoutTables } from '../src/layout';
import { makeColumn, makeRow, makeState, makeTable } from './test-utils';

function tableWithShape(name: string, columnCount: number, rowCount: number) {
  const columns = Array.from({ length: columnCount }, (_, i) => makeColumn(`c${i}`, 'INT'));
  const rows = Array.from({ length: rowCount }, (_, i) => makeRow(`r${i}`, { id: i }));
  return makeTable(name, columns, rows);
}

describe('layoutTables — 列数と折り返し（非immutableな関数）', () => {
  it('LAYOUT-COLS-01: 全テーブルが1行に収まる十分な canvasW では横一列に並ぶ', () => {
    const state = makeState([
      tableWithShape('t0', 1, 0),
      tableWithShape('t1', 1, 0),
      tableWithShape('t2', 1, 0),
    ]);
    const canvasW = 900;
    const cols = Math.floor((canvasW - PAD) / (TABLE_W + TABLE_GAP_X));
    expect(cols).toBe(3);

    layoutTables(state, canvasW);

    expect(state.tables.t0.x).toBe(PAD);
    expect(state.tables.t1.x).toBe(PAD + (TABLE_W + TABLE_GAP_X));
    expect(state.tables.t2.x).toBe(PAD + 2 * (TABLE_W + TABLE_GAP_X));
    expect(state.tables.t0.y).toBe(PAD);
    expect(state.tables.t1.y).toBe(PAD);
    expect(state.tables.t2.y).toBe(PAD);
  });

  it('LAYOUT-COLS-02: 1行に収まらない狭い canvasW では col=i%cols, row=floor(i/cols) で折り返す', () => {
    const state = makeState([
      tableWithShape('t0', 1, 0),
      tableWithShape('t1', 1, 0),
      tableWithShape('t2', 1, 0),
    ]);
    const canvasW = 650;
    const cols = Math.floor((canvasW - PAD) / (TABLE_W + TABLE_GAP_X));
    expect(cols).toBe(2);

    layoutTables(state, canvasW);

    // t0: col0/row0, t1: col1/row0, t2: col0/row1
    expect(state.tables.t0.x).toBe(PAD);
    expect(state.tables.t1.x).toBe(PAD + (TABLE_W + TABLE_GAP_X));
    expect(state.tables.t2.x).toBe(PAD);
    expect(state.tables.t0.y).toBe(PAD);
    expect(state.tables.t1.y).toBe(PAD);
    expect(state.tables.t2.y).toBe(PAD + (TABLE_H(state.tables.t2) + TABLE_GAP_Y));
  });

  it('LAYOUT-COLS-03: テーブル1つ分より狭い極端な canvasW では列数が最低1にクランプされる', () => {
    const state = makeState([tableWithShape('t0', 1, 0), tableWithShape('t1', 1, 0)]);
    const canvasW = 10;

    layoutTables(state, canvasW);

    expect(state.tables.t0.x).toBe(PAD);
    expect(state.tables.t1.x).toBe(PAD);
    expect(state.tables.t0.y).toBe(PAD);
    expect(state.tables.t1.y).toBe(PAD + (TABLE_H(state.tables.t1) + TABLE_GAP_Y));
  });
});

describe('TABLE_H — テーブルの高さ計算', () => {
  it('LAYOUT-HEIGHT-01: HEADER_H + columns.length*ROW_H + rows.length*ROW_H + COL_GAP で決まる', () => {
    const t1 = tableWithShape('t1', 3, 2);
    const t2 = tableWithShape('t2', 1, 0);
    expect(TABLE_H(t1)).toBe(HEADER_H + 3 * ROW_H + 2 * ROW_H + 16);
    expect(TABLE_H(t2)).toBe(HEADER_H + 1 * ROW_H + 0 * ROW_H + 16);
  });
});

describe('layoutTables — 同一行内の高さ計算（特性テスト）', () => {
  it('LAYOUT-Y-01: 同じ行に並ぶテーブルは行内の最大高さに揃えて次の行が配置される（テーブル同士の重なり防止）', () => {
    const state = makeState([
      tableWithShape('t0', 1, 0),
      tableWithShape('t1', 1, 0),
      tableWithShape('short', 1, 0), // row1, col0
      tableWithShape('tall', 1, 5), // row1, col1
    ]);
    const canvasW = 650; // cols = 2
    layoutTables(state, canvasW);

    const shortH = TABLE_H(state.tables.short);
    const tallH = TABLE_H(state.tables.tall);
    expect(shortH).not.toBe(tallH);

    const row0H = TABLE_H(state.tables.t0);
    const expectedRow1Y = PAD + (row0H + TABLE_GAP_Y);
    expect(state.tables.short.y).toBe(expectedRow1Y);
    expect(state.tables.tall.y).toBe(expectedRow1Y);
    // 同じ行 (row=1) の y は一致する = 行内で最大高さに揃えて重なりを防いでいることの証拠
    expect(state.tables.short.y).toBe(state.tables.tall.y);
  });
});

describe('layoutTables — 非immutableな挙動', () => {
  it('LAYOUT-MUTATE-01: 引数の state.tables[name] を直接書き換えて返す（新しいオブジェクトは作らない）', () => {
    const state = makeState([tableWithShape('users', 2, 1)]);
    const tableRef = state.tables.users;
    expect(tableRef.x).toBe(0);
    expect(tableRef.y).toBe(0);

    const result = layoutTables(state, 900);

    expect(result).toBe(state);
    expect(tableRef).toBe(state.tables.users);
    expect(tableRef.x).toBe(PAD);
    expect(tableRef.y).toBe(PAD);
  });

  it('LAYOUT-EMPTY-01: state.order が空でもエラーにならず state がそのまま返る', () => {
    const state = makeState([]);
    const result = layoutTables(state, 900);
    expect(result).toBe(state);
    expect(result.order).toEqual([]);
  });
});
