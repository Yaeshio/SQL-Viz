import { describe, expect, it } from 'vitest';
import { applyCreateTable, applyInsert, applySelect, emptyState } from '../src/reducer';
import type { DBState } from '../src/types';
import { makeColumn, makeRow, makeState, makeTable } from './test-utils';

const idCol = makeColumn('id', 'INT');
const nameCol = makeColumn('name', 'VARCHAR');

describe('applyCreateTable', () => {
  it('REDUCER-CREATE-01: 新規テーブルを追加し tables/order/version/lastSelect を更新する', () => {
    const state = emptyState();
    const { state: next, error } = applyCreateTable(state, 'users', [idCol, nameCol]);
    expect(error).toBeUndefined();
    expect(next.tables.users.columns).toEqual([idCol, nameCol]);
    expect(next.tables.users.rows).toEqual([]);
    expect(next.order).toEqual(['users']);
    expect(next.version).toBe(state.version + 1);
    expect(next.lastSelect).toBeNull();
  });

  it('REDUCER-CREATE-02: 既存と同名のテーブルはエラーになり state が変化しない', () => {
    const state = makeState([makeTable('users', [idCol], [])]);
    const { state: next, error } = applyCreateTable(state, 'users', [idCol, nameCol]);
    expect(error).toBe('Table "users" already exists');
    expect(next).toBe(state);
  });
});

describe('applyInsert', () => {
  it('REDUCER-INSERT-01: 正常な INSERT で行が末尾に追加され version が +1、lastSelect が null になる', () => {
    const state = makeState([makeTable('users', [idCol, nameCol], [])]);
    const { state: next, error } = applyInsert(state, 'users', ['id', 'name'], [1, 'Alice']);
    expect(error).toBeUndefined();
    expect(next.tables.users.rows).toHaveLength(1);
    expect(next.tables.users.rows[0].values).toEqual({ id: 1, name: 'Alice' });
    expect(next.version).toBe(state.version + 1);
    expect(next.lastSelect).toBeNull();
  });

  it('REDUCER-INSERT-02: columns 省略時はテーブル定義のカラム順に値が割り当てられる', () => {
    const state = makeState([makeTable('users', [idCol, nameCol], [])]);
    const { state: next } = applyInsert(state, 'users', null, [1, 'Alice']);
    expect(next.tables.users.rows[0].values).toEqual({ id: 1, name: 'Alice' });
  });

  it('REDUCER-INSERT-03: 未知のカラム名は無視され、他のカラムは正しく設定される', () => {
    const state = makeState([makeTable('users', [idCol, nameCol], [])]);
    const { state: next, error } = applyInsert(state, 'users', ['id', 'ghost'], [1, 'ignored']);
    expect(error).toBeUndefined();
    expect(next.tables.users.rows[0].values).toEqual({ id: 1, name: null });
  });

  it('REDUCER-INSERT-04: 存在しないテーブルへの INSERT はエラーになる', () => {
    const state = emptyState();
    const { state: next, error } = applyInsert(state, 'ghost', null, [1]);
    expect(error).toBe('Table "ghost" does not exist');
    expect(next).toBe(state);
  });

  it('REDUCER-INSERT-05: columns と values の数が不一致だとエラーになる', () => {
    const state = makeState([makeTable('users', [idCol, nameCol], [])]);
    const { state: next, error } = applyInsert(state, 'users', ['id', 'name'], [1]);
    expect(error).toBe('Column count mismatch');
    expect(next).toBe(state);
  });
});

describe('applySelect', () => {
  const baseState = () =>
    makeState([
      makeTable('users', [idCol, nameCol], [
        makeRow('r0', { id: 1, name: 'Alice' }),
        makeRow('r1', { id: 2, name: 'Bob' }),
        makeRow('r2', { id: 3, name: 'Carol' }),
      ]),
    ]);

  it('REDUCER-SELECT-01: WHERE なし（SELECT *）では全行の filteredOut が false になる', () => {
    const { state: next, error } = applySelect(baseState(), 'users', ['*'], null);
    expect(error).toBeUndefined();
    expect(next.tables.users.rows.map((r) => r.filteredOut)).toEqual([false, false, false]);
  });

  it('REDUCER-SELECT-02: WHERE col = value で一致しない行のみ filteredOut になり、行自体は削除されない', () => {
    const { state: next } = applySelect(baseState(), 'users', ['*'], {
      column: 'name',
      operator: '=',
      value: 'Bob',
    });
    expect(next.tables.users.rows).toHaveLength(3);
    expect(next.tables.users.rows.map((r) => r.filteredOut)).toEqual([true, false, true]);
  });

  it.each([
    ['REDUCER-SELECT-03a', { column: 'id', operator: '=', value: 2 }, [true, false, true]],
    ['REDUCER-SELECT-03b', { column: 'id', operator: '!=', value: 2 }, [false, true, false]],
    ['REDUCER-SELECT-03c', { column: 'id', operator: '<>', value: 2 }, [false, true, false]],
    ['REDUCER-SELECT-03d', { column: 'id', operator: '>', value: 1 }, [true, false, false]],
    ['REDUCER-SELECT-03e', { column: 'id', operator: '<', value: 3 }, [false, false, true]],
    ['REDUCER-SELECT-03f', { column: 'id', operator: '>=', value: 2 }, [true, false, false]],
    ['REDUCER-SELECT-03g', { column: 'id', operator: '<=', value: 2 }, [false, false, true]],
  ] as const)('%s: 各比較演算子が compareValue の仕様通りにフィルタする', (_id, where, expected) => {
    const { state: next } = applySelect(baseState(), 'users', ['*'], where);
    expect(next.tables.users.rows.map((r) => r.filteredOut)).toEqual(expected);
  });

  it('REDUCER-SELECT-04: フィルタされた状態から WHERE なしで再実行するとフィルタが解除される', () => {
    const filtered = applySelect(baseState(), 'users', ['*'], { column: 'id', operator: '=', value: 2 }).state;
    expect(filtered.tables.users.rows.map((r) => r.filteredOut)).toEqual([true, false, true]);
    const { state: next } = applySelect(filtered, 'users', ['*'], null);
    expect(next.tables.users.rows.map((r) => r.filteredOut)).toEqual([false, false, false]);
  });

  it('REDUCER-SELECT-05: 存在しないテーブルへの SELECT はエラーになる', () => {
    const state = emptyState();
    const { state: next, error } = applySelect(state, 'ghost', ['*'], null);
    expect(error).toBe('Table "ghost" does not exist');
    expect(next).toBe(state);
  });
});

describe('cloneState の不変性', () => {
  it('REDUCER-IMMUT-01: apply* 呼び出し前後で元の state が変更されない', () => {
    const state: DBState = makeState([
      makeTable('users', [idCol, nameCol], [makeRow('r0', { id: 1, name: 'Alice' })]),
    ]);
    const before = structuredClone(state);

    applyCreateTable(state, 'accounts', [idCol]);
    applyInsert(state, 'users', ['id', 'name'], [2, 'Bob']);
    applySelect(state, 'users', ['*'], { column: 'id', operator: '=', value: 1 });

    expect(state).toEqual(before);
  });
});
