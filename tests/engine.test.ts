import { beforeEach, describe, expect, it } from 'vitest';
import { PgEngine } from '../src/pglite/engine';

const CANVAS_W = 800;

let engine: PgEngine;

beforeEach(() => {
  engine = new PgEngine();
});

describe('PgEngine — CREATE TABLE', () => {
  it('ENGINE-CREATE-01: 新規テーブルを追加し tables/order/version/lastSelect を更新する', async () => {
    const { results } = await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');
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
    await engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');
    const { results } = await engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');
    expect(results[0].error).toBe('relation "users" already exists');
  });
});

describe('PgEngine — INSERT', () => {
  it('ENGINE-INSERT-01: 正常な INSERT で行が末尾に追加され version が +1、lastSelect が null になる', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');
    const { results } = await engine.run("INSERT INTO users (id, name) VALUES (1, 'Alice')", CANVAS_W, 'experiment');
    expect(results[0].error).toBeUndefined();
    const next = results[0].state;
    expect(next.tables.users.rows).toHaveLength(1);
    expect(next.tables.users.rows[0].values).toEqual({ id: 1, name: 'Alice' });
    expect(next.version).toBe(2);
    expect(next.lastSelect).toBeNull();
  });

  it('ENGINE-INSERT-02: columns 省略時はテーブル定義のカラム順に値が割り当てられる', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');
    const { results } = await engine.run("INSERT INTO users VALUES (1, 'Alice')", CANVAS_W, 'experiment');
    expect(results[0].state.tables.users.rows[0].values).toEqual({ id: 1, name: 'Alice' });
  });

  it('ENGINE-INSERT-03: 未知のカラム名への INSERT は実PostgreSQLのエラーになる（旧実装は黙って無視していた）', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');
    const { results } = await engine.run("INSERT INTO users (id, ghost) VALUES (1, 'x')", CANVAS_W, 'experiment');
    expect(results[0].error).toBe('column "ghost" of relation "users" does not exist');
  });

  it('ENGINE-INSERT-04: 存在しないテーブルへの INSERT は実PostgreSQLのエラーになる', async () => {
    const { results } = await engine.run('INSERT INTO ghost (id) VALUES (1)', CANVAS_W, 'experiment');
    expect(results[0].error).toBe('relation "ghost" does not exist');
  });

  it('ENGINE-INSERT-05: columns 省略時に values がカラム数より少ないと、残りのカラムは NULL で埋められる（実PostgreSQLの正しい挙動）', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');
    const { results } = await engine.run('INSERT INTO users VALUES (1)', CANVAS_W, 'experiment');
    expect(results[0].error).toBeUndefined();
    expect(results[0].state.tables.users.rows[0].values).toEqual({ id: 1, name: null });
  });

  it('ENGINE-INSERT-06: columns 省略時に values がカラム数より多いと実PostgreSQLのエラーになる', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');
    const { results } = await engine.run("INSERT INTO users VALUES (1, 'Alice', 'extra')", CANVAS_W, 'experiment');
    expect(results[0].error).toBe('INSERT has more expressions than target columns');
  });

  it('ENGINE-INSERT-07 (issue #8 の核心): DATE カラムに日付以外の文字列を INSERT すると実PostgreSQLの型エラーになる', async () => {
    await engine.run('CREATE TABLE t (a INT, b VARCHAR(20), c TEXT, d BOOLEAN, e DATE)', CANVAS_W, 'design');
    const { results } = await engine.run(
      "INSERT INTO t (a, b, c, d, e) VALUES (1, 'x', 'y', true, 'not-a-date')",
      CANVAS_W,
      'experiment',
    );
    expect(results[0].error).toBe('invalid input syntax for type date: "not-a-date"');
  });

  it('ENGINE-INSERT-08: INT カラムに数値以外の文字列を INSERT すると実PostgreSQLの型エラーになる', async () => {
    await engine.run('CREATE TABLE t (a INT)', CANVAS_W, 'design');
    const { results } = await engine.run("INSERT INTO t (a) VALUES ('abc')", CANVAS_W, 'experiment');
    expect(results[0].error).toBe('invalid input syntax for type integer: "abc"');
  });

  it('ENGINE-INSERT-09: INT カラムへの小数値は実PostgreSQLの丸め規則に従って丸められる', async () => {
    await engine.run('CREATE TABLE t (a INT)', CANVAS_W, 'design');
    const { results } = await engine.run('INSERT INTO t (a) VALUES (1.9)', CANVAS_W, 'experiment');
    expect(results[0].error).toBeUndefined();
    expect(results[0].state.tables.t.rows[0].values).toEqual({ a: 2 });
  });

  it('ENGINE-INSERT-10: 各データ型（INT/VARCHAR/TEXT/BOOLEAN/DATE）とNULL値が正しく保持される', async () => {
    await engine.run('CREATE TABLE t (a INT, b VARCHAR(20), c TEXT, d BOOLEAN, e DATE)', CANVAS_W, 'design');
    const { results } = await engine.run(
      `INSERT INTO t (a, b, c, d, e) VALUES (1, 'x', 'y', true, '2024-01-01');
       INSERT INTO t (a, b, c, d, e) VALUES (NULL, NULL, NULL, NULL, NULL);`,
      CANVAS_W,
      'experiment',
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
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');
    await engine.run(
      "INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol')",
      CANVAS_W,
      'experiment',
    );
  }

  it('ENGINE-SELECT-01: WHERE なし（SELECT *）では全行の filteredOut が false になる', async () => {
    await seedUsers();
    const { results } = await engine.run('SELECT * FROM users', CANVAS_W, 'experiment');
    expect(results[0].error).toBeUndefined();
    expect(results[0].state.tables.users.rows.map((r) => r.filteredOut)).toEqual([false, false, false]);
  });

  it('ENGINE-SELECT-02: WHERE col = value で一致しない行のみ filteredOut になり、行自体は削除されない', async () => {
    await seedUsers();
    const { results } = await engine.run("SELECT * FROM users WHERE name = 'Bob'", CANVAS_W, 'experiment');
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
    const { results } = await engine.run(`SELECT * FROM users WHERE id ${op} ${value}`, CANVAS_W, 'experiment');
    expect(results[0].state.tables.users.rows.map((r) => r.filteredOut)).toEqual(expected);
  });

  it('ENGINE-SELECT-04: フィルタされた状態から WHERE なしで再実行するとフィルタが解除される', async () => {
    await seedUsers();
    const filtered = await engine.run('SELECT * FROM users WHERE id = 2', CANVAS_W, 'experiment');
    expect(filtered.results[0].state.tables.users.rows.map((r) => r.filteredOut)).toEqual([true, false, true]);
    const unfiltered = await engine.run('SELECT * FROM users', CANVAS_W, 'experiment');
    expect(unfiltered.results[0].state.tables.users.rows.map((r) => r.filteredOut)).toEqual([false, false, false]);
  });

  it('ENGINE-SELECT-05: 存在しないテーブルへの SELECT は実PostgreSQLのエラーになる', async () => {
    const { results } = await engine.run('SELECT * FROM ghost', CANVAS_W, 'experiment');
    expect(results[0].error).toBe('relation "ghost" does not exist');
  });

  it('ENGINE-SELECT-06: 存在しないカラムを指定した SELECT は実PostgreSQLのエラーになる（旧実装では検証されなかった）', async () => {
    await seedUsers();
    const { results } = await engine.run('SELECT ghost_col FROM users', CANVAS_W, 'experiment');
    expect(results[0].error).toBe('column "ghost_col" does not exist');
  });
});

describe('PgEngine — ALTER TABLE', () => {
  it('ENGINE-ALTER-01: ADD COLUMN で columns に追加され、既存行に NULL 値が入る', async () => {
    // ALTER自体はdesignモード専用文だが、この行はsnapshotAfter()のalter分岐が
    // 「今ある行にNULLを詰める」ことを検証するためのものであり、直前の
    // returnToDesign()呼び出しは意図的に省いている（呼べば行が消えてしまう）。
    // 実アプリのuseSqlRunnerは実験モード→設計モードの遷移で必ずreturnToDesign()
    // を挟むため、この呼び出し順自体は実際のUIフローでは起こり得ない。
    await engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');
    await engine.run('INSERT INTO users (id) VALUES (1)', CANVAS_W, 'experiment');
    const { results } = await engine.run('ALTER TABLE users ADD COLUMN name VARCHAR(50)', CANVAS_W, 'design');
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
    // ENGINE-ALTER-01と同様、returnToDesign()を意図的に挟んでいない（理由は同上）。
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');
    await engine.run("INSERT INTO users (id, name) VALUES (1, 'Alice')", CANVAS_W, 'experiment');
    const { results } = await engine.run('ALTER TABLE users DROP COLUMN name', CANVAS_W, 'design');
    expect(results[0].error).toBeUndefined();
    const next = results[0].state;
    expect(next.tables.users.columns).toEqual([{ name: 'id', type: 'INT' }]);
    expect(next.tables.users.rows[0].values).toEqual({ id: 1 });
  });

  it('ENGINE-ALTER-03: 既存カラムと同名の ADD COLUMN は実PostgreSQLのエラーになる', async () => {
    await engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');
    const { results } = await engine.run('ALTER TABLE users ADD COLUMN id INT', CANVAS_W, 'design');
    expect(results[0].error).toBe('column "id" of relation "users" already exists');
  });

  it('ENGINE-ALTER-04: 存在しないテーブルへの ALTER TABLE は実PostgreSQLのエラーになる', async () => {
    const { results } = await engine.run('ALTER TABLE ghost ADD COLUMN id INT', CANVAS_W, 'design');
    expect(results[0].error).toBe('relation "ghost" does not exist');
  });
});

describe('PgEngine — DROP TABLE', () => {
  it('ENGINE-DROP-01: tables/order からテーブルが削除され version が +1 になる', async () => {
    await engine.run('CREATE TABLE a (id INT)', CANVAS_W, 'design');
    await engine.run('CREATE TABLE b (id INT)', CANVAS_W, 'design');
    const { results } = await engine.run('DROP TABLE a', CANVAS_W, 'design');
    expect(results[0].error).toBeUndefined();
    const next = results[0].state;
    expect(next.tables.a).toBeUndefined();
    expect(next.order).toEqual(['b']);
    expect(next.version).toBe(3);
  });

  it('ENGINE-DROP-02: 存在しないテーブルへの DROP TABLE は実PostgreSQLのエラーになる', async () => {
    const { results } = await engine.run('DROP TABLE ghost', CANVAS_W, 'design');
    expect(results[0].error).toBe('table "ghost" does not exist');
  });
});

describe('PgEngine — UPDATE', () => {
  async function seedUsers() {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');
    await engine.run(
      "INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol')",
      CANVAS_W,
      'experiment',
    );
  }

  it('ENGINE-UPDATE-01: WHERE に一致する行だけ値が更新され、行の id は変化しない', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');
    const seeded = await engine.run(
      "INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol')",
      CANVAS_W,
      'experiment',
    );
    const bobId = seeded.results[0].state.tables.users.rows.find((r) => r.values.name === 'Bob')!.id;

    const { results } = await engine.run("UPDATE users SET name = 'Bobby' WHERE id = 2", CANVAS_W, 'experiment');
    expect(results[0].error).toBeUndefined();
    const next = results[0].state;
    expect(next.tables.users.rows).toHaveLength(3);
    const updated = next.tables.users.rows.find((r) => r.id === bobId)!;
    expect(updated.values).toEqual({ id: 2, name: 'Bobby' });
    expect(next.version).toBe(3);
  });

  it('ENGINE-UPDATE-02: WHERE を省略すると全行が更新される', async () => {
    await seedUsers();
    const { results } = await engine.run("UPDATE users SET name = 'Same'", CANVAS_W, 'experiment');
    expect(results[0].state.tables.users.rows.map((r) => r.values.name)).toEqual(['Same', 'Same', 'Same']);
  });

  it('ENGINE-UPDATE-03: SET に複数列を指定すると両方とも更新される', async () => {
    await engine.run('CREATE TABLE t (a INT, b INT)', CANVAS_W, 'design');
    await engine.run('INSERT INTO t (a, b) VALUES (1, 1)', CANVAS_W, 'experiment');
    const { results } = await engine.run('UPDATE t SET a = 9, b = 9 WHERE a = 1', CANVAS_W, 'experiment');
    expect(results[0].state.tables.t.rows[0].values).toEqual({ a: 9, b: 9 });
  });

  it('ENGINE-UPDATE-04: 存在しないカラムへの SET は実PostgreSQLのエラーになる', async () => {
    await seedUsers();
    const { results } = await engine.run("UPDATE users SET ghost = 'x' WHERE id = 1", CANVAS_W, 'experiment');
    expect(results[0].error).toBe('column "ghost" of relation "users" does not exist');
  });

  it('ENGINE-UPDATE-05: 型に合わない値への UPDATE は実PostgreSQLの型エラーになる', async () => {
    await seedUsers();
    const { results } = await engine.run("UPDATE users SET id = 'abc' WHERE id = 1", CANVAS_W, 'experiment');
    expect(results[0].error).toBe('invalid input syntax for type integer: "abc"');
  });
});

describe('PgEngine — DELETE', () => {
  async function seedUsers() {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');
    await engine.run(
      "INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol')",
      CANVAS_W,
      'experiment',
    );
  }

  it('ENGINE-DELETE-01: WHERE に一致する行だけが削除される', async () => {
    await seedUsers();
    const { results } = await engine.run('DELETE FROM users WHERE id = 2', CANVAS_W, 'experiment');
    expect(results[0].error).toBeUndefined();
    const next = results[0].state;
    expect(next.tables.users.rows).toHaveLength(2);
    expect(next.tables.users.rows.map((r) => r.values.name)).toEqual(['Alice', 'Carol']);
    expect(next.version).toBe(3);
  });

  it('ENGINE-DELETE-02: WHERE を省略すると全行が削除される', async () => {
    await seedUsers();
    const { results } = await engine.run('DELETE FROM users', CANVAS_W, 'experiment');
    expect(results[0].state.tables.users.rows).toEqual([]);
  });

  it('ENGINE-DELETE-03: 存在しないテーブルへの DELETE は実PostgreSQLのエラーになる', async () => {
    const { results } = await engine.run('DELETE FROM ghost', CANVAS_W, 'experiment');
    expect(results[0].error).toBe('relation "ghost" does not exist');
  });
});

describe('PgEngine — mode gate', () => {
  it('ENGINE-MODE-01: designモードでは SELECT が拒否され、どの文も実行されない', async () => {
    const { results, parseError } = await engine.run('SELECT * FROM users', CANVAS_W, 'design');
    expect(results).toEqual([]);
    expect(parseError).toBe('Statement type "select" is not allowed in design mode');
  });

  it('ENGINE-MODE-02: designモードでは INSERT/UPDATE/DELETE が拒否される', async () => {
    await engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');
    for (const sql of ["INSERT INTO users (id) VALUES (1)", 'UPDATE users SET id = 1', 'DELETE FROM users']) {
      const { parseError } = await engine.run(sql, CANVAS_W, 'design');
      expect(parseError).toMatch(/is not allowed in design mode/);
    }
  });

  it('ENGINE-MODE-03: experimentモードでは CREATE/ALTER/DROP が拒否される', async () => {
    for (const sql of ['CREATE TABLE users (id INT)', 'ALTER TABLE users ADD COLUMN x INT', 'DROP TABLE users']) {
      const { parseError } = await engine.run(sql, CANVAS_W, 'experiment');
      expect(parseError).toMatch(/is not allowed in experiment mode/);
    }
  });

  it('ENGINE-MODE-04: 複数文のうち1文でも許可されないとバッチ全体が拒否され、どの文も実行されない', async () => {
    const { results, parseError } = await engine.run(
      'CREATE TABLE users (id INT); SELECT * FROM users',
      CANVAS_W,
      'design',
    );
    expect(results).toEqual([]);
    expect(parseError).toBe('Statement type "select" is not allowed in design mode');

    // 何も実行されていないことを、同名テーブルの再CREATEが成功することで確認する
    const retry = await engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');
    expect(retry.results[0].error).toBeUndefined();
  });
});

describe('PgEngine — 実験モードからのリセット (returnToDesign)', () => {
  it('ENGINE-RESET-01: 一度も実験モードで実行していない場合は no-op で null を返す', async () => {
    await engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');
    const restored = await engine.returnToDesign();
    expect(restored).toBeNull();
  });

  it('ENGINE-RESET-02: 実験モードでの INSERT は設計モードに復帰すると取り消され、テーブル構造は保持される', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');
    const inserted = await engine.run("INSERT INTO users (id, name) VALUES (1, 'Alice')", CANVAS_W, 'experiment');
    expect(inserted.results[0].state.tables.users.rows).toHaveLength(1);

    const restored = await engine.returnToDesign();
    expect(restored?.tables.users.rows).toEqual([]);
    expect(restored?.tables.users.columns).toEqual([
      { name: 'id', type: 'INT' },
      { name: 'name', type: 'VARCHAR' },
    ]);
  });

  it('ENGINE-RESET-03: 同一実験セッション内の INSERT+UPDATE はまとめて取り消される', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');
    await engine.run("INSERT INTO users (id, name) VALUES (1, 'Alice')", CANVAS_W, 'experiment');
    const updated = await engine.run("UPDATE users SET name = 'Alicia' WHERE id = 1", CANVAS_W, 'experiment');
    expect(updated.results[0].state.tables.users.rows[0].values).toEqual({ id: 1, name: 'Alicia' });

    const restored = await engine.returnToDesign();
    expect(restored?.tables.users.rows).toEqual([]);
  });

  it('ENGINE-RESET-04: ロールバック後、新しい実験セッションで INSERT した行は正しく新規行として扱われる', async () => {
    await engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');
    await engine.run('INSERT INTO users (id) VALUES (1)', CANVAS_W, 'experiment');
    await engine.returnToDesign();

    const { results } = await engine.run('INSERT INTO users (id) VALUES (2)', CANVAS_W, 'experiment');
    expect(results[0].error).toBeUndefined();
    const rows = results[0].state.tables.users.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].values).toEqual({ id: 2 });
  });
});

describe('PgEngine — エラー後のソフトリカバリ (SAVEPOINT, Issue #36)', () => {
  it('ENGINE-SOFTRECOVER-01: 実験モードのエラー後、続けて送った正常な INSERT が成功する', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');

    const bad = await engine.run('INSERT INTO ghost (x) VALUES (1)', CANVAS_W, 'experiment');
    expect(bad.results[0].error).toBe('relation "ghost" does not exist');

    const good = await engine.run("INSERT INTO users (id, name) VALUES (1, 'Alice')", CANVAS_W, 'experiment');
    expect(good.results[0].error).toBeUndefined();
    expect(good.results[0].state.tables.users.rows).toHaveLength(1);
    expect(good.results[0].state.tables.users.rows[0].values).toEqual({ id: 1, name: 'Alice' });
  });

  it('ENGINE-SOFTRECOVER-02: 実験モードのエラー後、SELECT が transaction aborted にならず正常にフィルタする', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');
    await engine.run("INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob')", CANVAS_W, 'experiment');

    const bad = await engine.run('SELECT * FROM ghost', CANVAS_W, 'experiment');
    expect(bad.results[0].error).toBe('relation "ghost" does not exist');

    const sel = await engine.run('SELECT * FROM users WHERE id = 1', CANVAS_W, 'experiment');
    expect(sel.results[0].error).toBeUndefined();
    expect(sel.results[0].state.tables.users.rows.map((r) => r.filteredOut)).toEqual([false, true]);
  });

  it('ENGINE-SOFTRECOVER-03: 実験モードのエラー後、design モードの ALTER が成功する（再現手順5の回帰）', async () => {
    await engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');

    const bad = await engine.run('INSERT INTO ghost (x) VALUES (1)', CANVAS_W, 'experiment');
    expect(bad.results[0].error).toBe('relation "ghost" does not exist');

    const alter = await engine.run('ALTER TABLE users ADD COLUMN age INT', CANVAS_W, 'design');
    expect(alter.results[0].error).toBeUndefined();
    expect(alter.results[0].state.tables.users.columns).toEqual([
      { name: 'id', type: 'INT' },
      { name: 'age', type: 'INT' },
    ]);
  });

  it('ENGINE-SOFTRECOVER-04: 単一バッチ内でエラーが起きても先行文は残り、後続の run() が成功する', async () => {
    await engine.run('CREATE TABLE t (a INT)', CANVAS_W, 'design');

    const batch = await engine.run(
      'INSERT INTO t (a) VALUES (1); INSERT INTO t (b) VALUES (2); INSERT INTO t (a) VALUES (3)',
      CANVAS_W,
      'experiment',
    );
    expect(batch.results).toHaveLength(2);
    expect(batch.results[0].error).toBeUndefined();
    expect(batch.results[1].error).toBe('column "b" of relation "t" does not exist');

    const after = await engine.run('SELECT * FROM t', CANVAS_W, 'experiment');
    expect(after.results[0].error).toBeUndefined();
    expect(after.results[0].state.tables.t.rows.map((r) => r.values.a)).toEqual([1]);
  });

  it('ENGINE-SOFTRECOVER-05: エラーを挟んだ実験セッションも returnToDesign() で丸ごと巻き戻る', async () => {
    await engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');
    await engine.run('INSERT INTO users (id) VALUES (1)', CANVAS_W, 'experiment');

    const bad = await engine.run('INSERT INTO ghost (x) VALUES (1)', CANVAS_W, 'experiment');
    expect(bad.results[0].error).toBe('relation "ghost" does not exist');

    await engine.run('INSERT INTO users (id) VALUES (2)', CANVAS_W, 'experiment');

    const restored = await engine.returnToDesign();
    expect(restored?.tables.users.rows).toEqual([]);
    expect(restored?.tables.users.columns).toEqual([{ name: 'id', type: 'INT' }]);
  });
});

describe('PgEngine — setTablePosition（ドラッグでの手動配置, Issue #34）', () => {
  it('ENGINE-MOVE-01: 指定テーブルの x/y を更新し manuallyPositioned を true にする', async () => {
    await engine.run('CREATE TABLE a (id INT)', CANVAS_W, 'design');
    const next = engine.setTablePosition('a', 123, 456);
    expect(next.tables.a.x).toBe(123);
    expect(next.tables.a.y).toBe(456);
    expect(next.tables.a.manuallyPositioned).toBe(true);
    expect(engine.getState()).toBe(next);
  });

  it('ENGINE-MOVE-02: 存在しないテーブル名を渡した場合は何もせず現在の state をそのまま返す', async () => {
    await engine.run('CREATE TABLE a (id INT)', CANVAS_W, 'design');
    const before = engine.getState();
    const result = engine.setTablePosition('ghost', 1, 2);
    expect(result).toBe(before);
  });

  it('ENGINE-MOVE-03: ドラッグ後に別テーブルへ文を実行しても layoutTables() によって位置が上書きされない', async () => {
    await engine.run('CREATE TABLE a (id INT)', CANVAS_W, 'design');
    await engine.run('CREATE TABLE b (id INT)', CANVAS_W, 'design');
    engine.setTablePosition('a', 999, 888);

    const { results } = await engine.run('INSERT INTO b (id) VALUES (1)', CANVAS_W, 'experiment');
    const next = results[0].state;
    expect(next.tables.a.x).toBe(999);
    expect(next.tables.a.y).toBe(888);
    expect(next.tables.a.manuallyPositioned).toBe(true);
  });

  it('ENGINE-MOVE-04: experimentモード中にドラッグした位置は design モードへの復帰（returnToDesign）後も保持される', async () => {
    await engine.run('CREATE TABLE a (id INT)', CANVAS_W, 'design');
    await engine.run('INSERT INTO a (id) VALUES (1)', CANVAS_W, 'experiment'); // designCheckpoint を開く
    engine.setTablePosition('a', 111, 222);

    const restored = await engine.returnToDesign();
    expect(restored?.tables.a.x).toBe(111);
    expect(restored?.tables.a.y).toBe(222);
    expect(restored?.tables.a.manuallyPositioned).toBe(true);
    // データ側のロールバックは従来通り機能する（位置だけが例外的に保持される）
    expect(restored?.tables.a.rows).toEqual([]);
  });
});

describe('PgEngine — 累積状態とスナップショットの独立性', () => {
  it('ENGINE-IMMUT-01: 過去に返した StatementResult.state は後続の run() で書き換わらない', async () => {
    await engine.run('CREATE TABLE users (id INT, name VARCHAR(50))', CANVAS_W, 'design');
    const afterFirstInsert = (
      await engine.run("INSERT INTO users (id, name) VALUES (1, 'Alice')", CANVAS_W, 'experiment')
    ).results[0].state;
    const snapshot = structuredClone(afterFirstInsert);

    await engine.run("INSERT INTO users (id, name) VALUES (2, 'Bob')", CANVAS_W, 'experiment');

    expect(afterFirstInsert).toEqual(snapshot);
  });
});
