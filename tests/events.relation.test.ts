import { describe, expect, it } from 'vitest';
import { runSqlStatements } from './test-utils';

const USERS = 'CREATE TABLE users (id INT PRIMARY KEY, name TEXT)';
const POSTS = 'CREATE TABLE posts (id INT PRIMARY KEY, user_id INT REFERENCES users(id))';

describe('イベント生成層 — リレーション（Issue #45）', () => {
  it('EVENT-REL-01: FK 付きの CREATE TABLE では table_appear の後に relation_add が発生する', async () => {
    const results = await runSqlStatements([USERS, POSTS]);
    expect(results[1].events).toEqual([
      { kind: 'table_appear', table: 'posts' },
      { kind: 'relation_add', relationId: 'posts.user_id->users.id' },
    ]);
  });

  it('EVENT-REL-02: FK を持たない CREATE TABLE ではリレーションのイベントは発生しない', async () => {
    const results = await runSqlStatements([USERS]);
    expect(results[0].events).toEqual([{ kind: 'table_appear', table: 'users' }]);
  });

  it('EVENT-REL-03: 子テーブルの DROP TABLE では table_remove の後に relation_remove が発生する', async () => {
    const results = await runSqlStatements([USERS, POSTS, 'DROP TABLE posts']);
    expect(results[2].events).toEqual([
      { kind: 'table_remove', table: 'posts' },
      { kind: 'relation_remove', relationId: 'posts.user_id->users.id' },
    ]);
  });

  it('EVENT-REL-04: DROP TABLE 親 CASCADE では table_remove の後に relation_remove が発生する', async () => {
    const results = await runSqlStatements([USERS, POSTS, 'DROP TABLE users CASCADE']);
    expect(results[2].events).toEqual([
      { kind: 'table_remove', table: 'users' },
      { kind: 'relation_remove', relationId: 'posts.user_id->users.id' },
    ]);
  });

  it('EVENT-REL-05: FK 列の DROP COLUMN では column_drop の後に relation_remove が発生する', async () => {
    const results = await runSqlStatements([USERS, POSTS, 'ALTER TABLE posts DROP COLUMN user_id']);
    expect(results[2].events).toEqual([
      { kind: 'column_drop', table: 'posts', column: 'user_id' },
      { kind: 'relation_remove', relationId: 'posts.user_id->users.id' },
    ]);
  });
});
