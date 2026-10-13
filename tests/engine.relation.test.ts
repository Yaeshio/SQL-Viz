import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PgEngine } from '../src/pglite/engine';
import type { DBState, Relation } from '../src/types';

const CANVAS_W = 800;

let engine: PgEngine;

beforeEach(() => {
  engine = new PgEngine();
});

// 各テストのPGliteインスタンスを解放する（Issue #71。解放しないと1個あたり約190MB残留する）。
afterEach(() => engine.close());

const USERS = 'CREATE TABLE users (id INT PRIMARY KEY, name TEXT)';
const POSTS = 'CREATE TABLE posts (id INT PRIMARY KEY, user_id INT REFERENCES users(id))';

async function design(sql: string) {
  const { results, parseError } = await engine.run(sql, CANVAS_W, 'design');
  expect(parseError).toBeUndefined();
  return results[results.length - 1];
}

const USERS_POSTS_RELATION: Relation = {
  id: 'posts.user_id->users.id',
  fromTable: 'posts',
  fromColumn: 'user_id',
  toTable: 'users',
  toColumn: 'id',
};

describe('PgEngine — 外部キーのリレーション（Issue #45）', () => {
  it('REL-ENG-01: 列レベルの REFERENCES が Column.references と DBState.relations になる', async () => {
    await design(USERS);
    const result = await design(POSTS);
    expect(result.error).toBeUndefined();
    expect(result.state.tables.posts.columns).toEqual([
      { name: 'id', type: 'INT' },
      { name: 'user_id', type: 'INT', references: { table: 'users', column: 'id' } },
    ]);
    expect(result.state.relations).toEqual([USERS_POSTS_RELATION]);
  });

  it('REL-ENG-02: 表レベルの FOREIGN KEY（名前付き）も同じ relations になる', async () => {
    await design(USERS);
    const result = await design(
      'CREATE TABLE posts (id INT PRIMARY KEY, user_id INT, CONSTRAINT fk_u FOREIGN KEY (user_id) REFERENCES users(id))',
    );
    expect(result.state.relations).toEqual([USERS_POSTS_RELATION]);
  });

  it('REL-ENG-03: 1つの CREATE で複数の FK を持つと relations は列順に並ぶ', async () => {
    await design('CREATE TABLE a (id INT PRIMARY KEY)');
    await design('CREATE TABLE b (id INT UNIQUE)');
    const result = await design('CREATE TABLE c (a_id INT REFERENCES a(id), b_id INT REFERENCES b(id))');
    expect(result.state.relations.map((r) => r.id)).toEqual(['c.a_id->a.id', 'c.b_id->b.id']);
  });

  it('REL-ENG-04: 自己参照の FK は fromTable と toTable が同じ relation になる', async () => {
    const result = await design('CREATE TABLE emp (id INT PRIMARY KEY, mgr INT REFERENCES emp(id))');
    expect(result.error).toBeUndefined();
    expect(result.state.relations).toEqual([
      { id: 'emp.mgr->emp.id', fromTable: 'emp', fromColumn: 'mgr', toTable: 'emp', toColumn: 'id' },
    ]);
  });

  it('REL-ENG-05: 参照先の表名・列名は大文字小文字を畳んで実在する名前へ正規化される', async () => {
    await design('CREATE TABLE Users (Id INT PRIMARY KEY)');
    const result = await design('CREATE TABLE posts (user_id INT REFERENCES USERS(ID))');
    expect(result.error).toBeUndefined();
    expect(result.state.tables.posts.columns[0].references).toEqual({ table: 'Users', column: 'Id' });
    expect(result.state.relations).toEqual([
      { id: 'posts.user_id->Users.Id', fromTable: 'posts', fromColumn: 'user_id', toTable: 'Users', toColumn: 'Id' },
    ]);
  });

  it('REL-ENG-06: 参照先列が PK/UNIQUE でない FK は PG のエラーで失敗し、状態は変わらない', async () => {
    await design('CREATE TABLE a (id INT)');
    const result = await design('CREATE TABLE b (a_id INT REFERENCES a(id))');
    expect(result.error).toMatch(/no unique constraint matching given keys/);
    expect(result.state.tables.b).toBeUndefined();
    expect(result.state.relations).toEqual([]);
  });

  it('REL-ENG-07: 存在しない表への FK は PG のエラーで失敗する', async () => {
    const result = await design('CREATE TABLE b (a_id INT REFERENCES ghost(id))');
    expect(result.error).toMatch(/relation "ghost" does not exist/);
    expect(result.state.relations).toEqual([]);
  });

  it('REL-ENG-08: 参照されている親の DROP は CASCADE なしでは失敗し、relations は残る', async () => {
    await design(USERS);
    await design(POSTS);
    const result = await design('DROP TABLE users');
    expect(result.error).toMatch(/other objects depend on it/);
    expect(result.state.tables.users).toBeDefined();
    expect(result.state.relations).toEqual([USERS_POSTS_RELATION]);
  });

  it('REL-ENG-09: 子テーブルの DROP で relation が消える', async () => {
    await design(USERS);
    await design(POSTS);
    const result = await design('DROP TABLE posts');
    expect(result.state.relations).toEqual([]);
    expect(result.events).toEqual(expect.arrayContaining([{ kind: 'table_remove', table: 'posts' }]));
  });

  it('REL-ENG-10: DROP TABLE 親 CASCADE で relation が消え、子の列の references も外れる', async () => {
    await design(USERS);
    await design(POSTS);
    const result = await design('DROP TABLE users CASCADE');
    expect(result.error).toBeUndefined();
    expect(result.state.relations).toEqual([]);
    expect(result.state.tables.posts.columns[1]).toEqual({ name: 'user_id', type: 'INT' });
  });

  it('REL-ENG-11: CASCADE で消した親を作り直しても、存在しない FK は復活しない', async () => {
    await design(USERS);
    await design(POSTS);
    await design('DROP TABLE users CASCADE');
    const result = await design(USERS);
    expect(result.state.relations).toEqual([]);
  });

  it('REL-ENG-12: FK 列の DROP COLUMN で relation が消える', async () => {
    await design(USERS);
    await design(POSTS);
    const result = await design('ALTER TABLE posts DROP COLUMN user_id');
    expect(result.error).toBeUndefined();
    expect(result.state.relations).toEqual([]);
  });

  it('REL-ENG-13: 参照されている列の DROP COLUMN は PG のエラーで失敗し、relation は残る', async () => {
    await design(USERS);
    await design(POSTS);
    const result = await design('ALTER TABLE users DROP COLUMN id');
    expect(result.error).toMatch(/other objects depend on it/);
    expect(result.state.relations).toEqual([USERS_POSTS_RELATION]);
  });

  it('REL-ENG-14: 無関係な ALTER ADD COLUMN では relations が保たれる', async () => {
    await design(USERS);
    await design(POSTS);
    const result = await design('ALTER TABLE posts ADD COLUMN title TEXT');
    expect(result.state.relations).toEqual([USERS_POSTS_RELATION]);
  });

  it('REL-ENG-15: 列レベルの ON DELETE CASCADE は拒否され、何も実行されない', async () => {
    await design(USERS);
    const { results, parseError } = await engine.run(
      'CREATE TABLE posts (id INT, user_id INT REFERENCES users(id) ON DELETE CASCADE)',
      CANVAS_W,
      'design',
    );
    expect(parseError).toMatch(/^Unsupported clause: /);
    expect(results).toEqual([]);
    expect(engine.getState().tables.posts).toBeUndefined();
  });

  it('REL-ENG-16: experiment モードの FK 違反 INSERT は PG のエラーになり、後続の文は実行できる', async () => {
    await design(USERS);
    await design(POSTS);
    const bad = await engine.run('INSERT INTO posts VALUES (1, 99)', CANVAS_W, 'experiment');
    expect(bad.results[0].error).toMatch(/foreign key constraint/);
    const ok = await engine.run("INSERT INTO users VALUES (1, 'a')", CANVAS_W, 'experiment');
    expect(ok.results[0].error).toBeUndefined();
    const child = await engine.run('INSERT INTO posts VALUES (1, 1)', CANVAS_W, 'experiment');
    expect(child.results[0].error).toBeUndefined();
    expect(child.results[0].state.relations).toEqual([USERS_POSTS_RELATION]);
  });

  it('REL-ENG-17: experiment → design の returnToDesign() 後も relations が保たれる', async () => {
    await design(USERS);
    await design(POSTS);
    await engine.run("INSERT INTO users VALUES (1, 'a')", CANVAS_W, 'experiment');
    const restored = await engine.returnToDesign();
    expect(restored?.relations).toEqual([USERS_POSTS_RELATION]);
  });

  it('REL-ENG-18: setTablePosition() の後も relations が保たれる', async () => {
    await design(USERS);
    await design(POSTS);
    const moved = engine.setTablePosition('posts', 500, 300);
    expect(moved.relations).toEqual([USERS_POSTS_RELATION]);
    expect(engine.getState().relations).toEqual([USERS_POSTS_RELATION]);
  });

  it('REL-ENG-19: 過去に返した state.relations は後続の run() で書き換わらない', async () => {
    await design(USERS);
    const afterPosts = await design(POSTS);
    const snapshot: DBState = structuredClone(afterPosts.state);
    await design('CREATE TABLE comments (id INT, post_id INT REFERENCES posts(id))');
    await design('DROP TABLE comments');
    expect(afterPosts.state).toEqual(snapshot);
  });
});
