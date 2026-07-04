import { describe, expect, it } from 'vitest';
import { parseSql } from '../src/parser';
import type { ParsedCreate, ParsedInsert, ParsedSelect } from '../src/parser';

describe('parseSql — CREATE TABLE', () => {
  it('テーブル名とカラム名・型を抽出する', () => {
    const { statements, error } = parseSql('CREATE TABLE users (id INT, name VARCHAR(50))');
    expect(error).toBeUndefined();
    expect(statements).toHaveLength(1);
    const stmt = statements[0] as ParsedCreate;
    expect(stmt.type).toBe('create');
    expect(stmt.table).toBe('users');
    expect(stmt.columns).toEqual([
      { name: 'id', type: 'INT' },
      { name: 'name', type: 'VARCHAR' },
    ]);
  });

  it.each([
    ['INT', 'INT'],
    ['VARCHAR(50)', 'VARCHAR'],
    ['CHAR(10)', 'VARCHAR'],
    ['TEXT', 'TEXT'],
    ['BOOLEAN', 'BOOLEAN'],
    ['DATE', 'DATE'],
    ['JSON', 'UNKNOWN'],
  ])('列の型 %s は %s に正規化される', (rawType, expected) => {
    const { statements } = parseSql(`CREATE TABLE t (a ${rawType})`);
    const stmt = statements[0] as ParsedCreate;
    expect(stmt.columns[0].type).toBe(expected);
  });

  it.each([
    ['IF NOT EXISTS', 'CREATE TABLE IF NOT EXISTS a (id INT)'],
    ['AS SELECT', 'CREATE TABLE a AS SELECT * FROM b'],
    ['INDEX定義', 'CREATE TABLE a (id INT, INDEX idx_id (id))'],
    ['FOREIGN KEY制約', 'CREATE TABLE a (id INT, FOREIGN KEY (id) REFERENCES b(id))'],
  ])('%s を含むCREATE TABLEはエラーになる', (_label, sql) => {
    const { statements, error } = parseSql(sql);
    expect(statements).toEqual([]);
    expect(error).toMatch(/^Unsupported clause: /);
  });
});

describe('parseSql — INSERT', () => {
  it('カラムリストを省略すると columns が null になる', () => {
    const { statements } = parseSql("INSERT INTO users VALUES (1, 'Alice')");
    const stmt = statements[0] as ParsedInsert;
    expect(stmt.type).toBe('insert');
    expect(stmt.table).toBe('users');
    expect(stmt.columns).toBeNull();
    expect(stmt.rows).toEqual([[1, 'Alice']]);
  });

  it('カラムリストを指定するとそのまま配列で保持される', () => {
    const { statements } = parseSql("INSERT INTO users (id, name) VALUES (1, 'Alice')");
    const stmt = statements[0] as ParsedInsert;
    expect(stmt.columns).toEqual(['id', 'name']);
  });

  it('複数行の VALUES を複数行として保持する', () => {
    const { statements } = parseSql("INSERT INTO users VALUES (1, 'Alice'), (2, 'Bob')");
    const stmt = statements[0] as ParsedInsert;
    expect(stmt.rows).toEqual([
      [1, 'Alice'],
      [2, 'Bob'],
    ]);
  });

  it('リテラル値を正しい JS の型に変換する（null/真偽値/数値/文字列）', () => {
    const { statements } = parseSql("INSERT INTO t (a,b,c,d) VALUES (1, 'x', true, null)");
    const stmt = statements[0] as ParsedInsert;
    expect(stmt.rows[0]).toEqual([1, 'x', true, null]);
  });

  it('INSERT ... SELECT はエラーになる（黙って0件挿入されない）', () => {
    const { statements, error } = parseSql('INSERT INTO a SELECT * FROM b');
    expect(statements).toEqual([]);
    expect(error).toBe('Unsupported clause: INSERT ... SELECT');
  });

  it('ON DUPLICATE KEY UPDATE はエラーになる', () => {
    const { statements, error } = parseSql("INSERT INTO a (id) VALUES (1) ON DUPLICATE KEY UPDATE id = 2");
    expect(statements).toEqual([]);
    expect(error).toMatch(/^Unsupported clause: /);
  });
});

describe('parseSql — SELECT', () => {
  it('SELECT * のとき columns が [\'*\'] になる', () => {
    const { statements } = parseSql('SELECT * FROM users');
    const stmt = statements[0] as ParsedSelect;
    expect(stmt.columns).toEqual(['*']);
    expect(stmt.where).toBeNull();
  });

  it('特定カラムを指定するとカラム名の配列になる', () => {
    const { statements } = parseSql('SELECT id, name FROM users');
    const stmt = statements[0] as ParsedSelect;
    expect(stmt.columns).toEqual(['id', 'name']);
  });

  it('単一の WHERE 比較を column/operator/value に分解する', () => {
    const { statements } = parseSql('SELECT name FROM users WHERE id > 1');
    const stmt = statements[0] as ParsedSelect;
    expect(stmt.where).toEqual({ column: 'id', operator: '>', value: 1 });
  });

  it.each([
    ['AND/ORを含む複合条件', "SELECT * FROM users WHERE id = 1 AND name = 'Alice'"],
    ['LIKE', "SELECT * FROM users WHERE name LIKE '%A%'"],
    ['IN', 'SELECT * FROM users WHERE id IN (1, 2, 3)'],
    ['BETWEEN', 'SELECT * FROM users WHERE id BETWEEN 1 AND 3'],
    ['IS NULL', 'SELECT * FROM users WHERE name IS NULL'],
    ['列同士の比較', 'SELECT * FROM users WHERE id = name'],
  ])('%s を含むWHEREはエラーになる', (_label, sql) => {
    const { statements, error } = parseSql(sql);
    expect(statements).toEqual([]);
    expect(error).toBe('Unsupported clause: WHERE');
  });

  it('JOINを含むSELECTはエラーになる', () => {
    const { statements, error } = parseSql('SELECT * FROM users JOIN orders ON users.id = orders.user_id');
    expect(statements).toEqual([]);
    expect(error).toBe('Unsupported clause: JOIN');
  });

  it('カンマ区切りの複数FROMテーブルはエラーになる', () => {
    const { statements, error } = parseSql('SELECT * FROM users, orders');
    expect(statements).toEqual([]);
    expect(error).toBe('Unsupported clause: JOIN');
  });

  it('FROM句のサブクエリはエラーになる', () => {
    const { statements, error } = parseSql('SELECT * FROM (SELECT * FROM users) t');
    expect(statements).toEqual([]);
    expect(error).toBe('Unsupported clause: subquery in FROM');
  });

  it('集約関数・エイリアス付き列はエラーになる', () => {
    const { statements, error } = parseSql('SELECT COUNT(*) FROM users');
    expect(statements).toEqual([]);
    expect(error).toBe('Unsupported clause: SELECT column expression');
  });

  it.each([
    ['UNION', 'SELECT id FROM users UNION SELECT id FROM orders'],
    ['DISTINCT', 'SELECT DISTINCT id FROM users'],
    ['HAVING', 'SELECT id FROM users HAVING id > 1'],
    ['GROUP BY', 'SELECT id FROM users GROUP BY id'],
    ['ORDER BY', 'SELECT id FROM users ORDER BY id'],
    ['LIMIT', 'SELECT id FROM users LIMIT 1'],
    ['WITH（CTE）', 'WITH x AS (SELECT id FROM users) SELECT id FROM x'],
  ])('%s を含むSELECTはエラーになる', (_label, sql) => {
    const { statements, error } = parseSql(sql);
    expect(statements).toEqual([]);
    expect(error).toMatch(/^Unsupported clause: /);
  });
});

describe('parseSql — 複数文の一括パース', () => {
  it('セミコロン区切りの複数文を順序通りに returns する', () => {
    const { statements, error } = parseSql(
      "CREATE TABLE users (id INT); INSERT INTO users VALUES (1); SELECT * FROM users;",
    );
    expect(error).toBeUndefined();
    expect(statements.map((s) => s.type)).toEqual(['create', 'insert', 'select']);
  });
});

describe('parseSql — エラー系', () => {
  it('構文として不正な文字列は Parse error を返す', () => {
    const { statements, error } = parseSql('SELEC * FROM users');
    expect(statements).toEqual([]);
    expect(error).toMatch(/^Parse error: /);
  });

  it.each(['UPDATE users SET id = 1 WHERE id = 2', 'DELETE FROM users WHERE id = 1'])(
    '非対応の文種 (%s) は Unsupported statement type を返す',
    (sql) => {
      const { statements, error } = parseSql(sql);
      expect(statements).toEqual([]);
      expect(error).toMatch(/^Unsupported statement type: /);
    },
  );
});
