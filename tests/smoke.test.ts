import { describe, expect, it } from 'vitest';
import { runPipeline } from '../src/runner';
import { emptyState } from '../src/reducer';
import { hasOverlappingTablePositions } from './test-utils';

const CANVAS_W = 800;

// App.tsx の SAMPLE 定数と同一のゴールデンシナリオ
const GOLDEN_SQL = `CREATE TABLE users (id INT, name VARCHAR(50), email VARCHAR(120));

INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@db.dev');
INSERT INTO users (id, name, email) VALUES (2, 'Bob', 'bob@db.dev');
INSERT INTO users (id, name, email) VALUES (3, 'Carol', 'carol@db.dev');

SELECT name FROM users WHERE id > 1;`;

describe('A. 正常系（実装済み機能の一気通貫シナリオ）', () => {
  it('SMOKE-01: ゴールデンシナリオ（CREATE→INSERT×3→SELECT）が一気通貫で実行される', () => {
    const { results, parseError } = runPipeline(GOLDEN_SQL, emptyState(), CANVAS_W);
    expect(parseError).toBeUndefined();
    expect(results).toHaveLength(5);
    expect(results.every((r) => !r.error)).toBe(true);

    expect(results[0].events).toEqual([{ kind: 'table_appear', table: 'users' }]);
    expect(results[1].events.map((e) => e.kind)).toEqual(['row_add']);
    expect(results[2].events.map((e) => e.kind)).toEqual(['row_add']);
    expect(results[3].events.map((e) => e.kind)).toEqual(['row_add']);

    const final = results[4].state;
    const rows = final.tables.users.rows;
    expect(rows).toHaveLength(3);
    const alice = rows.find((r) => r.values.id === 1)!;
    expect(alice.filteredOut).toBe(true);
    expect(rows.filter((r) => r.id !== alice.id).every((r) => r.filteredOut === false)).toBe(true);

    expect(results[4].events).toEqual([
      { kind: 'row_filter', table: 'users', rowId: alice.id },
      { kind: 'select_highlight', table: 'users', columns: ['name'] },
    ]);

    expect(hasOverlappingTablePositions(final)).toBe(false);
  });

  it('SMOKE-02: 複数テーブルにまたがるCREATE/INSERT/SELECTでも座標が重複しない', () => {
    const sql = `CREATE TABLE a (id INT);
CREATE TABLE b (id INT);
CREATE TABLE c (id INT);
INSERT INTO a (id) VALUES (1);
INSERT INTO b (id) VALUES (1);
INSERT INTO c (id) VALUES (1);
SELECT * FROM a;`;
    const { results, parseError } = runPipeline(sql, emptyState(), 700);
    expect(parseError).toBeUndefined();
    expect(results.every((r) => !r.error)).toBe(true);
    const final = results[results.length - 1].state;
    expect(final.order).toEqual(['a', 'b', 'c']);
    expect(hasOverlappingTablePositions(final)).toBe(false);
  });

  it('SMOKE-03: SELECT *（列指定なし）は columns が [\'*\'] として扱われ全列がハイライト対象になる', () => {
    const sql = `CREATE TABLE users (id INT, name VARCHAR(50));
INSERT INTO users (id, name) VALUES (1, 'Alice');
SELECT * FROM users;`;
    const { results, parseError } = runPipeline(sql, emptyState(), CANVAS_W);
    expect(parseError).toBeUndefined();
    const last = results[results.length - 1];
    expect(last.events).toContainEqual({ kind: 'select_highlight', table: 'users', columns: ['*'] });
  });

  it('SMOKE-04: WHERE付きSELECTの直後にWHEREなしSELECTを実行すると絞り込みが解除される', () => {
    const sql = `CREATE TABLE users (id INT, name VARCHAR(50));
INSERT INTO users (id, name) VALUES (1, 'Alice');
INSERT INTO users (id, name) VALUES (2, 'Bob');
SELECT * FROM users WHERE id > 1;
SELECT * FROM users;`;
    const { results, parseError } = runPipeline(sql, emptyState(), CANVAS_W);
    expect(parseError).toBeUndefined();

    const filteredResult = results[3];
    const alice = filteredResult.state.tables.users.rows.find((r) => r.values.id === 1)!;
    expect(filteredResult.events).toContainEqual({ kind: 'row_filter', table: 'users', rowId: alice.id });

    const unfilteredResult = results[4];
    expect(unfilteredResult.events).toContainEqual({ kind: 'row_unfilter', table: 'users', rowId: alice.id });
    expect(unfilteredResult.state.tables.users.rows.every((r) => r.filteredOut === false)).toBe(true);
  });

  it('SMOKE-05: 各データ型（INT/VARCHAR/TEXT/BOOLEAN/DATE）とNULL値が正しく保持される', () => {
    const sql = `CREATE TABLE t (a INT, b VARCHAR(20), c TEXT, d BOOLEAN, e DATE);
INSERT INTO t (a, b, c, d, e) VALUES (1, 'x', 'y', true, '2024-01-01');
INSERT INTO t (a, b, c, d, e) VALUES (NULL, NULL, NULL, NULL, NULL);`;
    const { results, parseError } = runPipeline(sql, emptyState(), CANVAS_W);
    expect(parseError).toBeUndefined();
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

describe('B. エラー系（実装済み機能に対する妥当なエラー）', () => {
  it('SMOKE-06: 存在しないテーブルへのINSERT/SELECTは "does not exist" エラーになる', () => {
    const insertResult = runPipeline('INSERT INTO ghost (id) VALUES (1)', emptyState(), CANVAS_W);
    expect(insertResult.parseError).toBeUndefined();
    expect(insertResult.results).toHaveLength(1);
    expect(insertResult.results[0].error).toBe('Table "ghost" does not exist');

    const selectResult = runPipeline('SELECT * FROM ghost', emptyState(), CANVAS_W);
    expect(selectResult.results[0].error).toBe('Table "ghost" does not exist');
  });

  it('SMOKE-07: 既存と同名のテーブルへのCREATE TABLEは "already exists" エラーになる', () => {
    const sql = `CREATE TABLE users (id INT);
CREATE TABLE users (id INT);`;
    const { results, parseError } = runPipeline(sql, emptyState(), CANVAS_W);
    expect(parseError).toBeUndefined();
    expect(results).toHaveLength(2);
    expect(results[1].error).toBe('Table "users" already exists');
  });

  it('SMOKE-08: columnsの数とVALUESの数が不一致なINSERTは "Column count mismatch" エラーになる', () => {
    // 明示的なカラムリストと VALUES の数不一致は node-sql-parser 自身が
    // パース時に検知してしまう（Parse error になる）ため、カラムリストを
    // 省略し、テーブル定義のカラム数と VALUES の数が食い違うケースで検証する。
    const sql = `CREATE TABLE users (id INT, name VARCHAR(50));
INSERT INTO users VALUES (1);`;
    const { results, parseError } = runPipeline(sql, emptyState(), CANVAS_W);
    expect(parseError).toBeUndefined();
    expect(results[1].error).toBe('Column count mismatch');
  });

  it('SMOKE-09: SQL構文として不正な文字列は "Parse error: ..." になる', () => {
    const { results, parseError } = runPipeline('SELECT FROM WHERE;;;', emptyState(), CANVAS_W);
    expect(results).toEqual([]);
    expect(parseError).toMatch(/^Parse error: /);
  });

  it('SMOKE-10: 複数文の途中でエラーが発生した場合、それ以降の文は実行されない', () => {
    const sql = `CREATE TABLE users (id INT);
INSERT INTO ghost (id) VALUES (1);
INSERT INTO users (id) VALUES (2);`;
    const { results, parseError } = runPipeline(sql, emptyState(), CANVAS_W);
    expect(parseError).toBeUndefined();
    expect(results).toHaveLength(2);
    expect(results[0].error).toBeUndefined();
    expect(results[1].error).toBe('Table "ghost" does not exist');
  });
});

describe('C. 未実装SQL構文（明示的にエラーになることを検証する）', () => {
  it('SMOKE-11: UPDATE文は "Unsupported statement type: update" エラーになる', () => {
    const { parseError } = runPipeline("UPDATE users SET name = 'x' WHERE id = 1", emptyState(), CANVAS_W);
    expect(parseError).toBe('Unsupported statement type: update');
  });

  it('SMOKE-12: DELETE文は "Unsupported statement type: delete" エラーになる', () => {
    const { parseError } = runPipeline('DELETE FROM users WHERE id = 1', emptyState(), CANVAS_W);
    expect(parseError).toBe('Unsupported statement type: delete');
  });

  it('SMOKE-13: ALTER TABLE文は "Unsupported statement type: alter" エラーになる', () => {
    const { parseError } = runPipeline('ALTER TABLE users ADD COLUMN age INT', emptyState(), CANVAS_W);
    expect(parseError).toBe('Unsupported statement type: alter');
  });

  it('SMOKE-14: INNER JOINを含むSELECTは "Unsupported clause: JOIN" エラーになる', () => {
    const { parseError } = runPipeline(
      'SELECT * FROM a INNER JOIN b ON a.id = b.id',
      emptyState(),
      CANVAS_W,
    );
    expect(parseError).toBe('Unsupported clause: JOIN');
  });

  it('SMOKE-15: 複合WHERE（AND/OR）を含むSELECTは "Unsupported clause: WHERE" エラーになる', () => {
    const { parseError } = runPipeline(
      'SELECT * FROM users WHERE id > 1 AND id < 10',
      emptyState(),
      CANVAS_W,
    );
    expect(parseError).toBe('Unsupported clause: WHERE');
  });

  it.each([
    ['GROUP BY', 'SELECT * FROM users GROUP BY id', 'groupby'],
    ['ORDER BY', 'SELECT * FROM users ORDER BY id', 'orderby'],
    ['LIMIT', 'SELECT * FROM users LIMIT 10', 'limit'],
    ['UNION', 'SELECT * FROM users UNION SELECT * FROM admins', '_next'],
  ])('SMOKE-16: %s を含むSELECTは対応するフィールド名でUnsupported clauseエラーになる', (_label, sql, field) => {
    const { parseError } = runPipeline(sql, emptyState(), CANVAS_W);
    expect(parseError).toBe(`Unsupported clause: ${field}`);
  });
});

describe('D. 複数回の実行(Run)をまたぐシナリオ', () => {
  it('SMOKE-17: CREATEのみのRunの後、別RunでINSERTのみを実行しても既存テーブルに行が追加される', () => {
    const first = runPipeline(
      'CREATE TABLE users (id INT, name VARCHAR(50));',
      emptyState(),
      CANVAS_W,
    );
    expect(first.parseError).toBeUndefined();
    expect(first.results.every((r) => !r.error)).toBe(true);
    const afterCreate = first.results[first.results.length - 1].state;

    const second = runPipeline(
      "INSERT INTO users (id, name) VALUES (1, 'Alice');",
      afterCreate,
      CANVAS_W,
    );
    expect(second.parseError).toBeUndefined();
    expect(second.results).toHaveLength(1);
    expect(second.results[0].error).toBeUndefined();
    expect(second.results[0].events.map((e) => e.kind)).toEqual(['row_add']);

    const final = second.results[0].state;
    expect(final.order).toEqual(['users']);
    expect(final.tables.users.rows).toHaveLength(1);
    expect(final.tables.users.rows[0].values).toEqual({ id: 1, name: 'Alice' });
  });
});
