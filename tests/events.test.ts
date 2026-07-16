import { describe, expect, it } from 'vitest';
import { runSqlStatements } from './test-utils';

describe('イベント生成層（SQL → parser → PGlite実行 → diffStates の統合テスト）', () => {
  it('EVENT-01: CREATE TABLE のみでは table_appear のみ発生する（row_add は発生しない）', async () => {
    const results = await runSqlStatements(['CREATE TABLE users (id INT, name VARCHAR(50))']);
    expect(results).toHaveLength(1);
    expect(results[0].events).toEqual([{ kind: 'table_appear', table: 'users' }]);
  });

  it('EVENT-02: CREATE TABLE 後に複数行の INSERT を行うと、各文の結果に対応するイベントが出る', async () => {
    const results = await runSqlStatements([
      'CREATE TABLE users (id INT, name VARCHAR(50))',
      "INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob')",
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].events).toEqual([{ kind: 'table_appear', table: 'users' }]);

    const rows = results[1].state.tables.users.rows;
    expect(rows).toHaveLength(2);
    expect(results[1].events).toEqual([
      { kind: 'row_add', table: 'users', rowId: rows[0].id, index: 0 },
      { kind: 'row_add', table: 'users', rowId: rows[1].id, index: 1 },
    ]);
  });

  it('EVENT-03: 既存データに対する INSERT 1件では追加した1行分の row_add のみ発生する（table_appear は発生しない）', async () => {
    const results = await runSqlStatements([
      'CREATE TABLE users (id INT, name VARCHAR(50))',
      "INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob')",
      "INSERT INTO users (id, name) VALUES (3, 'Carol')",
    ]);
    expect(results).toHaveLength(3);
    const rows = results[2].state.tables.users.rows;
    expect(rows).toHaveLength(3);
    const newRow = rows[2];
    expect(results[2].events).toEqual([{ kind: 'row_add', table: 'users', rowId: newRow.id, index: 2 }]);
  });

  it('EVENT-04: INSERT 後の SELECT ... WHERE ... では条件に合わない行の row_filter と select_highlight が発生する', async () => {
    const results = await runSqlStatements([
      'CREATE TABLE users (id INT, name VARCHAR(50))',
      "INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol')",
      'SELECT name FROM users WHERE id > 1',
    ]);
    const rows = results[1].state.tables.users.rows;
    const nonMatching = rows.find((r) => r.values.id === 1)!;
    expect(results[2].events).toEqual([
      { kind: 'row_filter', table: 'users', rowId: nonMatching.id },
      { kind: 'select_highlight', table: 'users', columns: ['name'] },
    ]);
  });

  it('EVENT-05: フィルタされた状態から WHERE なしで再度 SELECT すると row_unfilter と select_highlight が発生する', async () => {
    const results = await runSqlStatements([
      'CREATE TABLE users (id INT, name VARCHAR(50))',
      "INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol')",
      'SELECT name FROM users WHERE id > 1',
      'SELECT * FROM users',
    ]);
    const rows = results[1].state.tables.users.rows;
    const previouslyFiltered = rows.find((r) => r.values.id === 1)!;
    expect(results[3].events).toEqual([
      { kind: 'row_unfilter', table: 'users', rowId: previouslyFiltered.id },
      { kind: 'select_highlight', table: 'users', columns: ['*'] },
    ]);
  });

  it('EVENT-06: CREATE → INSERT → SELECT の3文連続実行で、文ごとに独立したイベント列が累積した状態の上に生成される', async () => {
    const results = await runSqlStatements([
      'CREATE TABLE users (id INT, name VARCHAR(50))',
      "INSERT INTO users (id, name) VALUES (1, 'Alice')",
      'SELECT * FROM users',
    ]);
    expect(results).toHaveLength(3);
    expect(results[0].events).toEqual([{ kind: 'table_appear', table: 'users' }]);
    expect(results[1].events).toHaveLength(1);
    expect(results[1].events[0].kind).toBe('row_add');
    expect(results[2].events).toEqual([{ kind: 'select_highlight', table: 'users', columns: ['*'] }]);

    // 各文の結果が前の文の結果に累積していること
    expect(results[2].state.tables.users.rows).toHaveLength(1);
    expect(results[2].state.version).toBe(3);
  });

  it('EVENT-07: 途中の文でエラーとなる場合（存在しないテーブルへの INSERT）はそれ以降の文が処理されない', async () => {
    await expect(
      runSqlStatements([
        'CREATE TABLE users (id INT)',
        'INSERT INTO ghost (id) VALUES (1)',
        'INSERT INTO users (id) VALUES (2)',
      ]),
    ).rejects.toThrow();
  });
});
