import { describe, expect, it } from 'vitest';
import { diffStates } from '../src/diff';
import { relationId } from '../src/reducer';
import type { Column, Relation } from '../src/types';
import { makeColumn, makeRow, makeState, makeTable } from './test-utils';

const idCol = makeColumn('id', 'INT');
const fkCol: Column = { ...makeColumn('user_id', 'INT'), references: { table: 'users', column: 'id' } };

const rel = (fromTable: string, fromColumn: string, toTable: string, toColumn: string): Relation => ({
  id: relationId(fromTable, fromColumn, toTable, toColumn),
  fromTable,
  fromColumn,
  toTable,
  toColumn,
});
const postsToUsers = rel('posts', 'user_id', 'users', 'id');

describe('diffStates — リレーション（Issue #45）', () => {
  it('DIFF-REL-01: 新規テーブルと同時に FK が現れると table_appear の後に relation_add が発生する', () => {
    const old = makeState([makeTable('users', [idCol], [])]);
    const next = makeState(
      [makeTable('users', [idCol], []), makeTable('posts', [idCol, fkCol], [])],
      undefined,
      null,
      [postsToUsers],
    );
    expect(diffStates(old, next)).toEqual([
      { kind: 'table_appear', table: 'posts' },
      { kind: 'relation_add', relationId: postsToUsers.id },
    ]);
  });

  it('DIFF-REL-02: 子テーブルの削除では table_remove の後に relation_remove が発生する', () => {
    const old = makeState(
      [makeTable('users', [idCol], []), makeTable('posts', [idCol, fkCol], [])],
      undefined,
      null,
      [postsToUsers],
    );
    const next = makeState([makeTable('users', [idCol], [])]);
    expect(diffStates(old, next)).toEqual([
      { kind: 'table_remove', table: 'posts' },
      { kind: 'relation_remove', relationId: postsToUsers.id },
    ]);
  });

  it('DIFF-REL-03: FK 列の DROP COLUMN では column_drop の後に relation_remove が発生する', () => {
    const users = makeTable('users', [idCol], []);
    const old = makeState([users, makeTable('posts', [idCol, fkCol], [])], undefined, null, [postsToUsers]);
    const next = makeState([users, makeTable('posts', [idCol], [])]);
    expect(diffStates(old, next)).toEqual([
      { kind: 'column_drop', table: 'posts', column: 'user_id' },
      { kind: 'relation_remove', relationId: postsToUsers.id },
    ]);
  });

  it('DIFF-REL-04: relations が変わらなければリレーションのイベントは発生しない', () => {
    const tables = () => [makeTable('users', [idCol], []), makeTable('posts', [idCol, fkCol], [])];
    const old = makeState(tables(), undefined, null, [postsToUsers]);
    const next = makeState(tables(), undefined, null, [{ ...postsToUsers }]);
    expect(diffStates(old, next)).toEqual([]);
  });

  it('DIFF-REL-05: 同じ diff 内では relation_remove → relation_add の順に出る', () => {
    const tagFk: Column = { ...makeColumn('tag_id', 'INT'), references: { table: 'tags', column: 'id' } };
    const tagRel = rel('posts', 'tag_id', 'tags', 'id');
    const users = makeTable('users', [idCol], []);
    const tags = makeTable('tags', [idCol], []);
    const old = makeState([users, tags, makeTable('posts', [idCol, fkCol], [])], undefined, null, [postsToUsers]);
    const next = makeState([users, tags, makeTable('posts', [idCol, tagFk], [])], undefined, null, [tagRel]);
    expect(diffStates(old, next)).toEqual([
      { kind: 'column_add', table: 'posts', column: 'tag_id' },
      { kind: 'column_drop', table: 'posts', column: 'user_id' },
      { kind: 'relation_remove', relationId: postsToUsers.id },
      { kind: 'relation_add', relationId: tagRel.id },
    ]);
  });

  it('DIFF-REL-06: リレーションのイベントはカラムの変化より後ろ・行のイベントより前に出る', () => {
    const old = makeState(
      [makeTable('a', [idCol], [makeRow('x', { id: 1 })]), makeTable('b', [idCol], [])],
      undefined,
      null,
      [],
    );
    const bToA = rel('b', 'a_id', 'a', 'id');
    const next = makeState(
      [
        makeTable('a', [idCol], [makeRow('x', { id: 1 }), makeRow('y', { id: 2 })]),
        makeTable('b', [idCol, { ...makeColumn('a_id', 'INT'), references: { table: 'a', column: 'id' } }], []),
      ],
      undefined,
      null,
      [bToA],
    );
    expect(diffStates(old, next)).toEqual([
      { kind: 'column_add', table: 'b', column: 'a_id' },
      { kind: 'relation_add', relationId: bToA.id },
      { kind: 'row_add', table: 'a', rowId: 'y', index: 1 },
    ]);
  });
});
