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

describe('PgEngine — ALTER TABLE', () => {
  it('ENGINE-ALTER-01: ADD COLUMN で columns に追加され、既存行に NULL 値が入る', async () => {
    await engine.run('CREATE TABLE users (id INT)', CANVAS_W);
    await engine.run('INSERT INTO users (id) VALUES (1)', CANVAS_W);
    const { results } = await engine.run('ALTER TABLE users ADD COLUMN name VARCHAR(50)', CANVAS_W);
    expect(results[0].error).toBeUndefined();
    const next = results[0].state;
    expect(next.tables.users.columns).toEqual([
      { name: 'id', type: 'INT' },
      { name: 'name', type: 'VARCHAR' },
    ]);
    expect(next.tables.users.rows[0].values).toEqual({ id: 1, name: null });
    expect(next.version).toBe(3);
    expect(next.lastSelect).toBeNull();
  });

  it('ENGINE-ALTER-02: DROP COLUMN で columns から削除され、既存行の values からもキーが消える', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W);
    await engine.run("INSERT INTO users (id, name) VALUES (1, 'Alice')", CANVAS_W);
    const { results } = await engine.run('ALTER TABLE users DROP COLUMN name', CANVAS_W);
    expect(results[0].error).toBeUndefined();
    const next = results[0].state;
    expect(next.tables.users.columns).toEqual([{ name: 'id', type: 'INT' }]);
    expect(next.tables.users.rows[0].values).toEqual({ id: 1 });
  });

  it('ENGINE-ALTER-03: 既存カラムと同名の ADD COLUMN は実PostgreSQLのエラーになる', async () => {
    await engine.run('CREATE TABLE users (id INT)', CANVAS_W);
    const { results } = await engine.run('ALTER TABLE users ADD COLUMN id INT', CANVAS_W);
    expect(results[0].error).toBe('column "id" of relation "users" already exists');
  });

  it('ENGINE-ALTER-04: 存在しないテーブルへの ALTER TABLE は実PostgreSQLのエラーになる', async () => {
    const { results } = await engine.run('ALTER TABLE ghost ADD COLUMN id INT', CANVAS_W);
    expect(results[0].error).toBe('relation "ghost" does not exist');
  });
});

describe('PgEngine — DROP TABLE', () => {
  it('ENGINE-DROP-01: tables/order からテーブルが削除され version が +1 になる', async () => {
    await engine.run('CREATE TABLE a (id INT)', CANVAS_W);
    await engine.run('CREATE TABLE b (id INT)', CANVAS_W);
    const { results } = await engine.run('DROP TABLE a', CANVAS_W);
    expect(results[0].error).toBeUndefined();
    const next = results[0].state;
    expect(next.tables.a).toBeUndefined();
    expect(next.order).toEqual(['b']);
    expect(next.version).toBe(3);
  });

  it('ENGINE-DROP-02: 存在しないテーブルへの DROP TABLE は実PostgreSQLのエラーになる', async () => {
    const { results } = await engine.run('DROP TABLE ghost', CANVAS_W);
    expect(results[0].error).toBe('table "ghost" does not exist');
  });
});

describe('PgEngine — UPDATE', () => {
  async function seedUsers() {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W);
    await engine.run(
      "INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol')",
      CANVAS_W,
    );
  }

  it('ENGINE-UPDATE-01: WHERE に一致する行だけ値が更新され、行の id は変化しない', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W);
    const seeded = await engine.run(
      "INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol')",
      CANVAS_W,
    );
    const bobId = seeded.results[0].state.tables.users.rows.find((r) => r.values.name === 'Bob')!.id;

    const { results } = await engine.run("UPDATE users SET name = 'Bobby' WHERE id = 2", CANVAS_W);
    expect(results[0].error).toBeUndefined();
    const next = results[0].state;
    expect(next.tables.users.rows).toHaveLength(3);
    const updated = next.tables.users.rows.find((r) => r.id === bobId)!;
    expect(updated.values).toEqual({ id: 2, name: 'Bobby' });
    expect(next.version).toBe(3);
  });

  it('ENGINE-UPDATE-02: WHERE を省略すると全行が更新される', async () => {
    await seedUsers();
    const { results } = await engine.run("UPDATE users SET name = 'Same'", CANVAS_W);
    expect(results[0].state.tables.users.rows.map((r) => r.values.name)).toEqual(['Same', 'Same', 'Same']);
  });

  it('ENGINE-UPDATE-03: SET に複数列を指定すると両方とも更新される', async () => {
    await engine.run('CREATE TABLE t (a INT, b INT)', CANVAS_W);
    await engine.run('INSERT INTO t (a, b) VALUES (1, 1)', CANVAS_W);
    const { results } = await engine.run('UPDATE t SET a = 9, b = 9 WHERE a = 1', CANVAS_W);
    expect(results[0].state.tables.t.rows[0].values).toEqual({ a: 9, b: 9 });
  });

  it('ENGINE-UPDATE-04: 存在しないカラムへの SET は実PostgreSQLのエラーになる', async () => {
    await seedUsers();
    const { results } = await engine.run("UPDATE users SET ghost = 'x' WHERE id = 1", CANVAS_W);
    expect(results[0].error).toBe('column "ghost" of relation "users" does not exist');
  });

  it('ENGINE-UPDATE-05: 型に合わない値への UPDATE は実PostgreSQLの型エラーになる', async () => {
    await seedUsers();
    const { results } = await engine.run("UPDATE users SET id = 'abc' WHERE id = 1", CANVAS_W);
    expect(results[0].error).toBe('invalid input syntax for type integer: "abc"');
  });
});

describe('PgEngine — DELETE', () => {
  async function seedUsers() {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W);
    await engine.run(
      "INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol')",
      CANVAS_W,
    );
  }

  it('ENGINE-DELETE-01: WHERE に一致する行だけが削除される', async () => {
    await seedUsers();
    const { results } = await engine.run('DELETE FROM users WHERE id = 2', CANVAS_W);
    expect(results[0].error).toBeUndefined();
    const next = results[0].state;
    expect(next.tables.users.rows).toHaveLength(2);
    expect(next.tables.users.rows.map((r) => r.values.name)).toEqual(['Alice', 'Carol']);
    expect(next.version).toBe(3);
  });

  it('ENGINE-DELETE-02: WHERE を省略すると全行が削除される', async () => {
    await seedUsers();
    const { results } = await engine.run('DELETE FROM users', CANVAS_W);
    expect(results[0].state.tables.users.rows).toEqual([]);
  });

  it('ENGINE-DELETE-03: 存在しないテーブルへの DELETE は実PostgreSQLのエラーになる', async () => {
    const { results } = await engine.run('DELETE FROM ghost', CANVAS_W);
    expect(results[0].error).toBe('relation "ghost" does not exist');
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
