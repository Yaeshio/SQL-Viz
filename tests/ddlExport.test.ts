import { beforeEach, describe, expect, it } from 'vitest';
import { PgEngine } from '../src/pglite/engine';
import { generateDdl } from '../src/pglite/ddlExport';

const CANVAS_W = 800;

let engine: PgEngine;

beforeEach(() => {
  engine = new PgEngine();
});

describe('generateDdl', () => {
  it('DDL-01: 単一テーブルのカラム名・型・VARCHARの長さを保持したDDLを生成する', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');
    const ddl = await generateDdl(engine.getDb()!, ['users']);
    expect(ddl).toBe('CREATE TABLE "users" (\n  "id" INT,\n  "name" VARCHAR(50)\n);');
  });

  it('DDL-02: 複数テーブルは order で渡した順序通りに出力される', async () => {
    await engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');
    await engine.run('CREATE TABLE posts (id INT)', CANVAS_W, 'design');
    const ddl = await generateDdl(engine.getDb()!, ['posts', 'users']);
    const postsIndex = ddl.indexOf('CREATE TABLE "posts"');
    const usersIndex = ddl.indexOf('CREATE TABLE "users"');
    expect(postsIndex).toBeGreaterThanOrEqual(0);
    expect(usersIndex).toBeGreaterThan(postsIndex);
  });

  it('DDL-03: ALTER TABLE ADD/DROP COLUMN 後の状態が反映される', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');
    await engine.run('ALTER TABLE users ADD COLUMN age INT', CANVAS_W, 'design');
    await engine.run('ALTER TABLE users DROP COLUMN name', CANVAS_W, 'design');
    const ddl = await generateDdl(engine.getDb()!, ['users']);
    expect(ddl).toBe('CREATE TABLE "users" (\n  "id" INT,\n  "age" INT\n);');
  });

  it('DDL-04 (ラウンドトリップ): 生成したDDLを新しいPgEngineへ流し込むと同じDDLが再生成される', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');
    await engine.run('CREATE TABLE posts (id INT, title TEXT, published BOOLEAN, created DATE)', CANVAS_W, 'design');
    await engine.run('ALTER TABLE users ADD COLUMN age INT', CANVAS_W, 'design');
    const original = await generateDdl(engine.getDb()!, ['users', 'posts']);

    const roundTripEngine = new PgEngine();
    const { parseError } = await roundTripEngine.run(original, CANVAS_W, 'design');
    expect(parseError).toBeUndefined();
    const roundTripped = await generateDdl(roundTripEngine.getDb()!, ['users', 'posts']);

    expect(roundTripped).toBe(original);
  });

  it('DDL-05: テーブルが1つもない場合は空文字列を返す', async () => {
    await engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');
    const ddl = await generateDdl(engine.getDb()!, []);
    expect(ddl).toBe('');
  });
});
