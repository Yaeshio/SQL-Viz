import { describe, expect, it } from 'vitest';
import { parseSql } from '../src/parser';
import type { ParsedAlter, ParsedCreate, ParsedDelete, ParsedDrop, ParsedInsert, ParsedSelect, ParsedUpdate } from '../src/parser';

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

  it('ON CONFLICT ... DO UPDATE（upsert）はエラーになる', () => {
    const { statements, error } = parseSql('INSERT INTO a (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 2');
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

describe('parseSql — ALTER TABLE', () => {
  it('単一の ADD COLUMN を action/table/column に分解する', () => {
    const { statements, error } = parseSql('ALTER TABLE users ADD COLUMN age INT');
    expect(error).toBeUndefined();
    const stmt = statements[0] as ParsedAlter;
    expect(stmt).toEqual({ type: 'alter', action: 'add', table: 'users', column: { name: 'age', type: 'INT' } });
  });

  it('単一の DROP COLUMN を action/table/column に分解する', () => {
    const { statements, error } = parseSql('ALTER TABLE users DROP COLUMN age');
    expect(error).toBeUndefined();
    const stmt = statements[0] as ParsedAlter;
    expect(stmt).toEqual({ type: 'alter', action: 'drop', table: 'users', column: 'age' });
  });

  it.each([
    ['複数アクションの同時指定', 'ALTER TABLE users ADD COLUMN a INT, ADD COLUMN b INT'],
    ['ALTER COLUMN TYPE（型変更）', 'ALTER TABLE users ALTER COLUMN age TYPE TEXT'],
    ['ADD COLUMN への NOT NULL 制約', 'ALTER TABLE users ADD COLUMN age INT NOT NULL'],
    ['ADD COLUMN IF NOT EXISTS', 'ALTER TABLE users ADD COLUMN IF NOT EXISTS age INT'],
    ['DROP COLUMN IF EXISTS', 'ALTER TABLE users DROP COLUMN IF EXISTS age'],
    ['ALTER TABLE IF EXISTS', 'ALTER TABLE IF EXISTS users ADD COLUMN age INT'],
  ])('%s を含むALTER TABLEはエラーになる', (_label, sql) => {
    const { statements, error } = parseSql(sql);
    expect(statements).toEqual([]);
    expect(error).toMatch(/^Unsupported clause: /);
  });
});

describe('parseSql — DROP TABLE', () => {
  it('テーブル名を抽出する', () => {
    const { statements, error } = parseSql('DROP TABLE users');
    expect(error).toBeUndefined();
    const stmt = statements[0] as ParsedDrop;
    expect(stmt).toEqual({ type: 'drop', table: 'users' });
  });

  it.each([
    ['複数テーブル指定', 'DROP TABLE users, orders'],
    ['IF EXISTS', 'DROP TABLE IF EXISTS users'],
  ])('%s を含むDROP TABLEはエラーになる', (_label, sql) => {
    const { statements, error } = parseSql(sql);
    expect(statements).toEqual([]);
    expect(error).toMatch(/^Unsupported clause: /);
  });
});

describe('parseSql — UPDATE', () => {
  it('SET句とWHERE句を column/operator/value に分解する', () => {
    const { statements, error } = parseSql("UPDATE users SET name = 'Bob' WHERE id = 1");
    expect(error).toBeUndefined();
    const stmt = statements[0] as ParsedUpdate;
    expect(stmt.type).toBe('update');
    expect(stmt.table).toBe('users');
    expect(stmt.set).toEqual([{ column: 'name', value: 'Bob' }]);
    expect(stmt.where).toEqual({ column: 'id', operator: '=', value: 1 });
  });

  it('複数列のSETを配列として保持する', () => {
    const { statements } = parseSql('UPDATE users SET name = 1, age = 2 WHERE id = 1');
    const stmt = statements[0] as ParsedUpdate;
    expect(stmt.set).toEqual([
      { column: 'name', value: 1 },
      { column: 'age', value: 2 },
    ]);
  });

  it('WHEREを省略すると where が null になる（全行対象）', () => {
    const { statements } = parseSql('UPDATE users SET name = 1');
    const stmt = statements[0] as ParsedUpdate;
    expect(stmt.where).toBeNull();
  });

  it.each([
    ['SET右辺が式（列参照や演算を含む）', 'UPDATE users SET age = age + 1 WHERE id = 1'],
    ['複合WHERE（AND/OR）', "UPDATE users SET name = 'x' WHERE id = 1 AND age > 2"],
    ['FROM句', "UPDATE users SET name = 'x' FROM other WHERE users.id = other.id"],
    ['RETURNING句', "UPDATE users SET name = 'x' WHERE id = 1 RETURNING *"],
    ['WITH句（CTE）', "WITH x AS (SELECT 1) UPDATE users SET name = 'x'"],
  ])('%s を含むUPDATEはエラーになる', (_label, sql) => {
    const { statements, error } = parseSql(sql);
    expect(statements).toEqual([]);
    expect(error).toMatch(/^Unsupported clause: /);
  });
});

describe('parseSql — DELETE', () => {
  it('テーブル名とWHERE句を抽出する', () => {
    const { statements, error } = parseSql('DELETE FROM users WHERE id = 1');
    expect(error).toBeUndefined();
    const stmt = statements[0] as ParsedDelete;
    expect(stmt.type).toBe('delete');
    expect(stmt.table).toBe('users');
    expect(stmt.where).toEqual({ column: 'id', operator: '=', value: 1 });
  });

  it('WHEREを省略すると where が null になる（全行対象）', () => {
    const { statements } = parseSql('DELETE FROM users');
    const stmt = statements[0] as ParsedDelete;
    expect(stmt.where).toBeNull();
  });

  it.each([
    ['複合WHERE（AND/OR）', 'DELETE FROM users WHERE id = 1 AND age > 2'],
    ['RETURNING句', 'DELETE FROM users WHERE id = 1 RETURNING *'],
  ])('%s を含むDELETEはエラーになる', (_label, sql) => {
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

  it.each(['TRUNCATE TABLE users', 'GRANT SELECT ON users TO alice'])(
    '非対応の文種 (%s) は Unsupported statement type を返す',
    (sql) => {
      const { statements, error } = parseSql(sql);
      expect(statements).toEqual([]);
      expect(error).toMatch(/^Unsupported statement type: /);
    },
  );
});
