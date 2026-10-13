import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PgEngine } from '../src/pglite/engine';
import { generateDdl } from '../src/pglite/ddlExport';

const CANVAS_W = 800;

let engine: PgEngine;

beforeEach(() => {
  engine = new PgEngine();
});

// 各テストのPGliteインスタンスを解放する（Issue #71。解放しないと1個あたり約190MB残留する）。
afterEach(() => engine.close());

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
    try {
      const { parseError } = await roundTripEngine.run(original, CANVAS_W, 'design');
      expect(parseError).toBeUndefined();
      const roundTripped = await generateDdl(roundTripEngine.getDb()!, ['users', 'posts']);

      expect(roundTripped).toBe(original);
    } finally {
      await roundTripEngine.close();
    }
  });

  it('DDL-05: テーブルが1つもない場合は空文字列を返す', async () => {
    await engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');
    const ddl = await generateDdl(engine.getDb()!, []);
    expect(ddl).toBe('');
  });
});

/** 生成した DDL を新しい PgEngine へ流し込み、同じ DDL が再生成されることを確認する
 * （ラウンドトリップ）。成功すれば再生した engine を渡して `check` を呼ぶ。 */
async function roundTrip(
  ddl: string,
  order: string[],
  check?: (replayed: PgEngine) => Promise<void>,
): Promise<void> {
  const replayed = new PgEngine();
  try {
    const { results, parseError } = await replayed.run(ddl, CANVAS_W, 'design');
    expect(parseError).toBeUndefined();
    expect(results.find((r) => r.error)?.error).toBeUndefined();
    expect(await generateDdl(replayed.getDb()!, order)).toBe(ddl);
    await check?.(replayed);
  } finally {
    await replayed.close();
  }
}

describe('generateDdl — 制約（Issue #45）', () => {
  it('DDL-06: PRIMARY KEY / UNIQUE / FOREIGN KEY を表レベル制約として列定義の後に出力する', async () => {
    await engine.run('CREATE TABLE users (id INT PRIMARY KEY, email TEXT UNIQUE)', CANVAS_W, 'design');
    await engine.run('CREATE TABLE posts (id INT PRIMARY KEY, user_id INT REFERENCES users(id))', CANVAS_W, 'design');
    const ddl = await generateDdl(engine.getDb()!, ['users', 'posts']);
    expect(ddl).toBe(
      [
        'CREATE TABLE "users" (',
        '  "id" INT,',
        '  "email" TEXT,',
        '  PRIMARY KEY ("id"),',
        '  UNIQUE ("email")',
        ');',
        '',
        'CREATE TABLE "posts" (',
        '  "id" INT,',
        '  "user_id" INT,',
        '  PRIMARY KEY ("id"),',
        '  FOREIGN KEY ("user_id") REFERENCES "users" ("id")',
        ');',
      ].join('\n'),
    );
  });

  it('DDL-07 (ラウンドトリップ): FK 付きスキーマを保存→Reload しても同じ DDL が再生成される', async () => {
    await engine.run('CREATE TABLE users (id INT PRIMARY KEY, name TEXT)', CANVAS_W, 'design');
    await engine.run('CREATE TABLE posts (id INT PRIMARY KEY, user_id INT REFERENCES users(id))', CANVAS_W, 'design');
    const ddl = await generateDdl(engine.getDb()!, ['users', 'posts']);
    await roundTrip(ddl, ['users', 'posts']);
  });

  it('DDL-08 (ラウンドトリップ): 複合 PRIMARY KEY + 複数 FK の中間テーブルも往復できる', async () => {
    await engine.run('CREATE TABLE students (id INT PRIMARY KEY)', CANVAS_W, 'design');
    await engine.run('CREATE TABLE courses (id INT UNIQUE)', CANVAS_W, 'design');
    await engine.run(
      `CREATE TABLE enrollments (
         student_id INT, course_id INT,
         PRIMARY KEY (student_id, course_id),
         FOREIGN KEY (student_id) REFERENCES students(id),
         FOREIGN KEY (course_id) REFERENCES courses(id)
       )`,
      CANVAS_W,
      'design',
    );
    const order = ['students', 'courses', 'enrollments'];
    const ddl = await generateDdl(engine.getDb()!, order);
    expect(ddl).toContain('PRIMARY KEY ("student_id", "course_id")');
    expect(ddl).toContain('FOREIGN KEY ("student_id") REFERENCES "students" ("id")');
    expect(ddl).toContain('FOREIGN KEY ("course_id") REFERENCES "courses" ("id")');
    await roundTrip(ddl, order);
  });

  it('DDL-09 (ラウンドトリップ): 自己参照 FK も往復できる', async () => {
    await engine.run('CREATE TABLE emp (id INT PRIMARY KEY, mgr INT REFERENCES emp(id))', CANVAS_W, 'design');
    const ddl = await generateDdl(engine.getDb()!, ['emp']);
    expect(ddl).toContain('FOREIGN KEY ("mgr") REFERENCES "emp" ("id")');
    await roundTrip(ddl, ['emp']);
  });

  it('DDL-10: Reload 後も PRIMARY KEY が効いている（保存で PK が黙って脱落しない）', async () => {
    await engine.run('CREATE TABLE users (id INT PRIMARY KEY, name TEXT)', CANVAS_W, 'design');
    const ddl = await generateDdl(engine.getDb()!, ['users']);
    await roundTrip(ddl, ['users'], async (replayed) => {
      const { results } = await replayed.run("INSERT INTO users VALUES (1, 'a'), (1, 'dup')", CANVAS_W, 'experiment');
      expect(results[0].error).toMatch(/duplicate key/);
    });
  });

  it('DDL-11: Reload 後も FK が効いている（存在しない親を指す INSERT は拒否される）', async () => {
    await engine.run('CREATE TABLE users (id INT PRIMARY KEY)', CANVAS_W, 'design');
    await engine.run('CREATE TABLE posts (id INT, user_id INT REFERENCES users(id))', CANVAS_W, 'design');
    const ddl = await generateDdl(engine.getDb()!, ['users', 'posts']);
    await roundTrip(ddl, ['users', 'posts'], async (replayed) => {
      const { results } = await replayed.run('INSERT INTO posts VALUES (1, 99)', CANVAS_W, 'experiment');
      expect(results[0].error).toMatch(/foreign key constraint/);
    });
  });
});
