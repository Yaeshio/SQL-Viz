import { describe, expect, it } from 'vitest';
import { cloneState, deriveRelations, emptyState, relationId, resolveColumnReferences } from '../src/reducer';
import type { Column, Relation } from '../src/types';
import { makeColumn, makeState, makeTable } from './test-utils';

const idCol = makeColumn('id', 'INT');
const fk = (name: string, table: string, column: string): Column => ({
  ...makeColumn(name, 'INT'),
  references: { table, column },
});

describe('deriveRelations（Issue #45）', () => {
  it('REL-DERIVE-01: references を持つ列だけが relation になり、order 順 × 列順で並ぶ', () => {
    const state = makeState(
      [
        makeTable('users', [idCol], []),
        makeTable('posts', [idCol, fk('user_id', 'users', 'id')], []),
        makeTable('comments', [fk('post_id', 'posts', 'id'), fk('user_id', 'users', 'id')], []),
      ],
      ['users', 'posts', 'comments'],
    );
    expect(deriveRelations(state).map((r) => r.id)).toEqual([
      'posts.user_id->users.id',
      'comments.post_id->posts.id',
      'comments.user_id->users.id',
    ]);
  });

  it('REL-DERIVE-02: 参照先のテーブルまたは列が実在しないものは含めない', () => {
    const state = makeState([
      makeTable('posts', [fk('user_id', 'users', 'id'), fk('tag_id', 'tags', 'id')], []),
      makeTable('tags', [makeColumn('label', 'TEXT')], []),
    ]);
    expect(deriveRelations(state)).toEqual([]);
  });

  it('REL-DERIVE-03: relation の id は端点から決まる', () => {
    expect(relationId('posts', 'user_id', 'users', 'id')).toBe('posts.user_id->users.id');
  });

  it('REL-DERIVE-04: 空の state からは何も導出されない', () => {
    expect(deriveRelations(emptyState())).toEqual([]);
  });
});

describe('resolveColumnReferences（Issue #45）', () => {
  const existing = makeState([makeTable('Users', [makeColumn('Id', 'INT')], [])]).tables;

  it('REL-RESOLVE-01: 大文字小文字を畳んで実在する表名・列名へ正規化する', () => {
    const [col] = resolveColumnReferences([fk('u', 'users', 'id')], 'posts', existing);
    expect(col.references).toEqual({ table: 'Users', column: 'Id' });
  });

  it('REL-RESOLVE-02: 自己参照は同一 CREATE の列から解決する', () => {
    const columns = [makeColumn('Id', 'INT'), fk('mgr', 'EMP', 'id')];
    expect(resolveColumnReferences(columns, 'emp', {})[1].references).toEqual({ table: 'emp', column: 'Id' });
  });

  it('REL-RESOLVE-03: 解決できない参照は外す', () => {
    const [col] = resolveColumnReferences([fk('u', 'ghost', 'id')], 'posts', existing);
    expect(col).toEqual({ name: 'u', type: 'INT' });
  });

  it('REL-RESOLVE-04: references の無い列はそのまま返す', () => {
    const col = makeColumn('x', 'TEXT');
    expect(resolveColumnReferences([col], 'posts', existing)[0]).toBe(col);
  });
});

describe('cloneState — relations / references（Issue #45）', () => {
  it('REL-CLONE-01: relations と列の references は深いコピーで、複製側の変更が元に影響しない', () => {
    const relation: Relation = {
      id: 'posts.user_id->users.id',
      fromTable: 'posts',
      fromColumn: 'user_id',
      toTable: 'users',
      toColumn: 'id',
    };
    const original = makeState(
      [makeTable('users', [idCol], []), makeTable('posts', [fk('user_id', 'users', 'id')], [])],
      undefined,
      null,
      [relation],
    );
    const copy = cloneState(original);
    expect(copy).toEqual(original);

    copy.relations[0].toColumn = 'changed';
    copy.tables.posts.columns[0].references!.column = 'changed';
    expect(original.relations[0].toColumn).toBe('id');
    expect(original.tables.posts.columns[0].references!.column).toBe('id');
  });
});
