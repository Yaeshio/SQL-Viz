import { beforeEach, describe, expect, it } from 'vitest';
import { PgEngine } from '../src/pglite/engine';

const CANVAS_W = 800;

let engine: PgEngine;

beforeEach(() => {
  engine = new PgEngine();
});

describe('PgEngine — CREATE TABLE', () => {
  it('ENGINE-CREATE-01: 新規テーブルを追加し tables/order/version/lastSelect を更新する', async () => {
    const { results } = await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W);
    expect(results).toHaveLength(1);
    expect(results[0].error).toBeUndefined();
    const next = results[0].state;
    expect(next.tables.users.columns).toEqual([
      { name: 'id', type: 'INT' },
      { name: 'name', type: 'VARCHAR' },
    ]);
    expect(next.tables.users.rows).toEqual([]);
    expect(next.order).toEqual(['users']);
    expect(next.version).toBe(1);
    expect(next.lastSelect).toBeNull();
  });

  it('ENGINE-CREATE-02: 既存と同名のテーブルは実PostgreSQLのエラーになる', async () => {
    await engine.run('CREATE TABLE users (id INT)', CANVAS_W);
    const { results } = await engine.run('CREATE TABLE users (id INT)', CANVAS_W);
    expect(results[0].error).toBe('relation "users" already exists');
  });
});

describe('PgEngine — INSERT', () => {
  it('ENGINE-INSERT-01: 正常な INSERT で行が末尾に追加され version が +1、lastSelect が null になる', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W);
    const { results } = await engine.run("INSERT INTO users (id, name) VALUES (1, 'Alice')", CANVAS_W);
    expect(results[0].error).toBeUndefined();
    const next = results[0].state;
    expect(next.tables.users.rows).toHaveLength(1);
    expect(next.tables.users.rows[0].values).toEqual({ id: 1, name: 'Alice' });
    expect(next.version).toBe(2);
    expect(next.lastSelect).toBeNull();
  });

  it('ENGINE-INSERT-02: columns 省略時はテーブル定義のカラム順に値が割り当てられる', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W);
    const { results } = await engine.run("INSERT INTO users VALUES (1, 'Alice')", CANVAS_W);
    expect(results[0].state.tables.users.rows[0].values).toEqual({ id: 1, name: 'Alice' });
  });

  it('ENGINE-INSERT-03: 未知のカラム名への INSERT は実PostgreSQLのエラーになる（旧実装は黙って無視していた）', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W);
    const { results } = await engine.run("INSERT INTO users (id, ghost) VALUES (1, 'x')", CANVAS_W);
    expect(results[0].error).toBe('column "ghost" of relation "users" does not exist');
  });

  it('ENGINE-INSERT-04: 存在しないテーブルへの INSERT は実PostgreSQLのエラーになる', async () => {
    const { results } = await engine.run('INSERT INTO ghost (id) VALUES (1)', CANVAS_W);
    expect(results[0].error).toBe('relation "ghost" does not exist');
  });

  it('ENGINE-INSERT-05: columns 省略時に values がカラム数より少ないと、残りのカラムは NULL で埋められる（実PostgreSQLの正しい挙動）', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W);
    const { results } = await engine.run('INSERT INTO users VALUES (1)', CANVAS_W);
    expect(results[0].error).toBeUndefined();
    expect(results[0].state.tables.users.rows[0].values).toEqual({ id: 1, name: null });
  });

  it('ENGINE-INSERT-06: columns 省略時に values がカラム数より多いと実PostgreSQLのエラーになる', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W);
    const { results } = await engine.run("INSERT INTO users VALUES (1, 'Alice', 'extra')", CANVAS_W);
    expect(results[0].error).toBe('INSERT has more expressions than target columns');
  });

  it('ENGINE-INSERT-07 (issue #8 の核心): DATE カラムに日付以外の文字列を INSERT すると実PostgreSQLの型エラーになる', async () => {
    await engine.run(
      'CREATE TABLE t (a INT, b VARCHAR(20), c TEXT, d BOOLEAN, e DATE)',
      CANVAS_W,
    );
    const { results } = await engine.run(
      "INSERT INTO t (a, b, c, d, e) VALUES (1, 'x', 'y', true, 'not-a-date')",
      CANVAS_W,
    );
    expect(results[0].error).toBe('invalid input syntax for type date: "not-a-date"');
  });

  it('ENGINE-INSERT-08: INT カラムに数値以外の文字列を INSERT すると実PostgreSQLの型エラーになる', async () => {
    await engine.run('CREATE TABLE t (a INT)', CANVAS_W);
    const { results } = await engine.run("INSERT INTO t (a) VALUES ('abc')", CANVAS_W);
    expect(results[0].error).toBe('invalid input syntax for type integer: "abc"');
  });

  it('ENGINE-INSERT-09: INT カラムへの小数値は実PostgreSQLの丸め規則に従って丸められる', async () => {
    await engine.run('CREATE TABLE t (a INT)', CANVAS_W);
    const { results } = await engine.run('INSERT INTO t (a) VALUES (1.9)', CANVAS_W);
    expect(results[0].error).toBeUndefined();
    expect(results[0].state.tables.t.rows[0].values).toEqual({ a: 2 });
  });

  it('ENGINE-INSERT-10: 各データ型（INT/VARCHAR/TEXT/BOOLEAN/DATE）とNULL値が正しく保持される', async () => {
    await engine.run('CREATE TABLE t (a INT, b VARCHAR(20), c TEXT, d BOOLEAN, e DATE)', CANVAS_W);
    const { results } = await engine.run(
      `INSERT INTO t (a, b, c, d, e) VALUES (1, 'x', 'y', true, '2024-01-01');
       INSERT INTO t (a, b, c, d, e) VALUES (NULL, NULL, NULL, NULL, NULL);`,
      CANVAS_W,
    );
    expect(results.every((r) => !r.error)).toBe(true);
    const final = results[results.length - 1].state;
    expect(final.tables.t.columns).toEqual([
      { name: 'a', type: 'INT' },
      { name: 'b', type: 'VARCHAR' },
      { name: 'c', type: 'TEXT' },
      { name: 'd', type: 'BOOLEAN' },
      { name: 'e', type: 'DATE' },
    ]);
    const [row1, row2] = final.tables.t.rows;
    expect(row1.values).toEqual({ a: 1, b: 'x', c: 'y', d: true, e: '2024-01-01' });
    expect(row2.values).toEqual({ a: null, b: null, c: null, d: null, e: null });
  });
});

describe('PgEngine — SELECT', () => {
  async function seedUsers() {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W);
    await engine.run(
      "INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol')",
      CANVAS_W,
    );
  }

  it('ENGINE-SELECT-01: WHERE なし（SELECT *）では全行の filteredOut が false になる', async () => {
    await seedUsers();
    const { results } = await engine.run('SELECT * FROM users', CANVAS_W);
    expect(results[0].error).toBeUndefined();
    expect(results[0].state.tables.users.rows.map((r) => r.filteredOut)).toEqual([false, false, false]);
  });

  it('ENGINE-SELECT-02: WHERE col = value で一致しない行のみ filteredOut になり、行自体は削除されない', async () => {
    await seedUsers();
    const { results } = await engine.run("SELECT * FROM users WHERE name = 'Bob'", CANVAS_W);
    const rows = results[0].state.tables.users.rows;
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.filteredOut)).toEqual([true, false, true]);
  });

  it.each([
    ['ENGINE-SELECT-03a', '=', 2, [true, false, true]],
    ['ENGINE-SELECT-03b', '!=', 2, [false, true, false]],
    ['ENGINE-SELECT-03c', '<>', 2, [false, true, false]],
    ['ENGINE-SELECT-03d', '>', 1, [true, false, false]],
    ['ENGINE-SELECT-03e', '<', 3, [false, false, true]],
    ['ENGINE-SELECT-03f', '>=', 2, [true, false, false]],
    ['ENGINE-SELECT-03g', '<=', 2, [false, false, true]],
  ] as const)('%s: 各比較演算子が実PostgreSQLの評価通りにフィルタする', async (_id, op, value, expected) => {
    await seedUsers();
    const { results } = await engine.run(`SELECT * FROM users WHERE id ${op} ${value}`, CANVAS_W);
    expect(results[0].state.tables.users.rows.map((r) => r.filteredOut)).toEqual(expected);
  });

  it('ENGINE-SELECT-04: フィルタされた状態から WHERE なしで再実行するとフィルタが解除される', async () => {
    await seedUsers();
    const filtered = await engine.run('SELECT * FROM users WHERE id = 2', CANVAS_W);
    expect(filtered.results[0].state.tables.users.rows.map((r) => r.filteredOut)).toEqual([true, false, true]);
    const unfiltered = await engine.run('SELECT * FROM users', CANVAS_W);
    expect(unfiltered.results[0].state.tables.users.rows.map((r) => r.filteredOut)).toEqual([false, false, false]);
  });

  it('ENGINE-SELECT-05: 存在しないテーブルへの SELECT は実PostgreSQLのエラーになる', async () => {
    const { results } = await engine.run('SELECT * FROM ghost', CANVAS_W);
    expect(results[0].error).toBe('relation "ghost" does not exist');
  });

  it('ENGINE-SELECT-06: 存在しないカラムを指定した SELECT は実PostgreSQLのエラーになる（旧実装では検証されなかった）', async () => {
    await seedUsers();
    const { results } = await engine.run('SELECT ghost_col FROM users', CANVAS_W);
    expect(results[0].error).toBe('column "ghost_col" does not exist');
  });
});

describe('PgEngine — 累積状態とスナップショットの独立性', () => {
  it('ENGINE-IMMUT-01: 過去に返した StatementResult.state は後続の run() で書き換わらない', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W);
    const afterFirstInsert = (await engine.run("INSERT INTO users (id, name) VALUES (1, 'Alice')", CANVAS_W))
      .results[0].state;
    const snapshot = structuredClone(afterFirstInsert);

    await engine.run("INSERT INTO users (id, name) VALUES (2, 'Bob')", CANVAS_W);

    expect(afterFirstInsert).toEqual(snapshot);
  });
});
