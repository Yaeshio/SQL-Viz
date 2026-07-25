import { describe, expect, it } from 'vitest';
import { diffStates } from '../src/diff';
import { makeColumn, makeRow, makeState, makeTable } from './test-utils';

const idCol = makeColumn('id', 'INT');

describe('diffStates', () => {
  it('DIFF-TABLE-01: 新規テーブルが order に追加されると table_appear が発生する', () => {
    const old = makeState([]);
    const next = makeState([makeTable('users', [idCol], [])]);
    expect(diffStates(old, next)).toEqual([{ kind: 'table_appear', table: 'users' }]);
  });

  it('DIFF-ROW-01: 既存テーブルに新しい行が追加されると row_add(index付き)が発生する', () => {
    const old = makeState([makeTable('users', [idCol], [makeRow('r0', { id: 1 })])]);
    const next = makeState([
      makeTable('users', [idCol], [makeRow('r0', { id: 1 }), makeRow('r1', { id: 2 })]),
    ]);
    expect(diffStates(old, next)).toEqual([
      { kind: 'row_add', table: 'users', rowId: 'r1', index: 1 },
    ]);
  });

  it('DIFF-ROW-02: 新規テーブル作成と同時に複数行を持つ場合、table_appear の後に全行分の row_add が続く', () => {
    const old = makeState([]);
    const next = makeState([
      makeTable('users', [idCol], [makeRow('r0', { id: 1 }), makeRow('r1', { id: 2 })]),
    ]);
    expect(diffStates(old, next)).toEqual([
      { kind: 'table_appear', table: 'users' },
      { kind: 'row_add', table: 'users', rowId: 'r0', index: 0 },
      { kind: 'row_add', table: 'users', rowId: 'r1', index: 1 },
    ]);
  });

  it('DIFF-TABLE-02: テーブルが order から消えると table_remove が発生する', () => {
    const old = makeState(
      [makeTable('a', [idCol], []), makeTable('b', [idCol], [])],
      ['a', 'b'],
    );
    const next = makeState([makeTable('b', [idCol], [])], ['b']);
    expect(diffStates(old, next)).toEqual([{ kind: 'table_remove', table: 'a' }]);
  });

  it('DIFF-COL-01: 既存テーブルにカラムが追加されると column_add が発生する', () => {
    const old = makeState([makeTable('t', [idCol], [])]);
    const next = makeState([makeTable('t', [idCol, makeColumn('age', 'INT')], [])]);
    expect(diffStates(old, next)).toEqual([{ kind: 'column_add', table: 't', column: 'age' }]);
  });

  it('DIFF-COL-02: 既存テーブルからカラムが削除されると column_drop が発生する', () => {
    const old = makeState([makeTable('t', [idCol, makeColumn('age', 'INT')], [])]);
    const next = makeState([makeTable('t', [idCol], [])]);
    expect(diffStates(old, next)).toEqual([{ kind: 'column_drop', table: 't', column: 'age' }]);
  });

  it('DIFF-COL-03: カラム追加で既存行がNULL埋めされても row_update は発生しない（ADD COLUMNの副作用と区別する）', () => {
    const old = makeState([makeTable('t', [idCol], [makeRow('r0', { id: 1 })])]);
    const next = makeState([
      makeTable('t', [idCol, makeColumn('age', 'INT')], [makeRow('r0', { id: 1, age: null })]),
    ]);
    expect(diffStates(old, next)).toEqual([{ kind: 'column_add', table: 't', column: 'age' }]);
  });

  it('DIFF-COL-04: カラム削除で既存行からキーが消えても row_update は発生しない（DROP COLUMNの副作用と区別する）', () => {
    const old = makeState([
      makeTable('t', [idCol, makeColumn('age', 'INT')], [makeRow('r0', { id: 1, age: 30 })]),
    ]);
    const next = makeState([makeTable('t', [idCol], [makeRow('r0', { id: 1 })])]);
    expect(diffStates(old, next)).toEqual([{ kind: 'column_drop', table: 't', column: 'age' }]);
  });

  it('DIFF-ROW-03: 既存の行が消えると row_remove が発生する', () => {
    const old = makeState([
      makeTable('t', [idCol], [makeRow('r0', { id: 1 }), makeRow('r1', { id: 2 })]),
    ]);
    const next = makeState([makeTable('t', [idCol], [makeRow('r0', { id: 1 })])]);
    expect(diffStates(old, next)).toEqual([{ kind: 'row_remove', table: 't', rowId: 'r1' }]);
  });

  it('DIFF-ROW-04: 同じidの行の値が変わると row_update が発生する', () => {
    const old = makeState([
      makeTable('t', [idCol, makeColumn('name', 'VARCHAR')], [makeRow('r0', { id: 1, name: 'Alice' })]),
    ]);
    const next = makeState([
      makeTable('t', [idCol, makeColumn('name', 'VARCHAR')], [makeRow('r0', { id: 1, name: 'Alicia' })]),
    ]);
    expect(diffStates(old, next)).toEqual([{ kind: 'row_update', table: 't', rowId: 'r0' }]);
  });

  it('DIFF-FILTER-01: filteredOut が false→true になると row_filter が発生する', () => {
    const old = makeState([makeTable('users', [idCol], [makeRow('r0', { id: 1 }, false)])]);
    const next = makeState([makeTable('users', [idCol], [makeRow('r0', { id: 1 }, true)])]);
    expect(diffStates(old, next)).toEqual([{ kind: 'row_filter', table: 'users', rowId: 'r0' }]);
  });

  it('DIFF-FILTER-02: filteredOut が true→false になると row_unfilter が発生する', () => {
    const old = makeState([makeTable('users', [idCol], [makeRow('r0', { id: 1 }, true)])]);
    const next = makeState([makeTable('users', [idCol], [makeRow('r0', { id: 1 }, false)])]);
    expect(diffStates(old, next)).toEqual([{ kind: 'row_unfilter', table: 'users', rowId: 'r0' }]);
  });

  it('DIFF-SELECT-01: next.lastSelect が設定されているとイベント列の末尾に select_highlight が付く', () => {
    const old = makeState([makeTable('users', [idCol], [])]);
    const next = makeState([makeTable('users', [idCol], [])], undefined, {
      table: 'users',
      columns: ['*'],
      where: null,
    });
    expect(diffStates(old, next)).toEqual([
      { kind: 'select_highlight', table: 'users', columns: ['*'] },
    ]);
  });

  it('DIFF-NOOP-01: old と next が同一内容なら空のイベント配列になる', () => {
    const old = makeState([makeTable('users', [idCol], [makeRow('r0', { id: 1 }, false)])]);
    const next = makeState([makeTable('users', [idCol], [makeRow('r0', { id: 1 }, false)])]);
    expect(diffStates(old, next)).toEqual([]);
  });

  it('DIFF-ORDER-01: 複数テーブルの変化が同時に起きても table_appear群→行の変化群→select_highlightの順序が保たれる', () => {
    const old = makeState([makeTable('a', [idCol], [makeRow('x', { id: 1 }, false)])]);
    const next = makeState(
      [
        makeTable('a', [idCol], [makeRow('x', { id: 1 }, true), makeRow('y', { id: 2 })]),
        makeTable('b', [idCol], [makeRow('z', { id: 3 })]),
      ],
      ['a', 'b'],
      { table: 'a', columns: ['*'], where: null },
    );

    expect(diffStates(old, next)).toEqual([
      { kind: 'table_appear', table: 'b' },
      { kind: 'row_add', table: 'a', rowId: 'y', index: 1 },
      { kind: 'row_filter', table: 'a', rowId: 'x' },
      { kind: 'row_add', table: 'b', rowId: 'z', index: 0 },
      { kind: 'select_highlight', table: 'a', columns: ['*'] },
    ]);
  });

  it('DIFF-ORDER-02: table_appear/table_remove、及びテーブルごとのcolumn_add/column_drop/row_add/row_remove/row_updateの順序が保たれる', () => {
    const old = makeState(
      [
        makeTable('a', [idCol, makeColumn('old_col', 'TEXT')], [
          makeRow('x', { id: 1, old_col: 'foo' }),
          makeRow('y', { id: 2, old_col: 'bar' }),
        ]),
        makeTable('b', [idCol], [makeRow('w', { id: 9 })]),
        makeTable('d', [idCol, makeColumn('val', 'INT')], [makeRow('p', { id: 5, val: 10 })]),
      ],
      ['a', 'b', 'd'],
    );
    const next = makeState(
      [
        makeTable('a', [idCol, makeColumn('new_col', 'TEXT')], [
          makeRow('x', { id: 1, new_col: null }),
          makeRow('z', { id: 3, new_col: 'baz' }),
        ]),
        makeTable('c', [idCol], []),
        makeTable('d', [idCol, makeColumn('val', 'INT')], [makeRow('p', { id: 5, val: 99 })]),
      ],
      ['a', 'c', 'd'],
    );

    expect(diffStates(old, next)).toEqual([
      { kind: 'table_appear', table: 'c' },
      { kind: 'table_remove', table: 'b' },
      { kind: 'column_add', table: 'a', column: 'new_col' },
      { kind: 'column_drop', table: 'a', column: 'old_col' },
      { kind: 'row_add', table: 'a', rowId: 'z', index: 1 },
      { kind: 'row_remove', table: 'a', rowId: 'y' },
      { kind: 'row_update', table: 'd', rowId: 'p' },
    ]);
  });
});
