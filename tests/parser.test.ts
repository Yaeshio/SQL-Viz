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

  it('AND/OR を含む複合条件はエラーにならず where が null になる', () => {
    const { statements, error } = parseSql('SELECT * FROM users WHERE id = 1 AND name = \'Alice\'');
    expect(error).toBeUndefined();
    const stmt = statements[0] as ParsedSelect;
    expect(stmt.where).toBeNull();
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
