import { describe, expect, it } from 'vitest';
import { splitStatements } from '../src/pglite/splitStatements';

describe('splitStatements', () => {
  it('SPLIT-01: セミコロン区切りの複数文を配列に分割する', () => {
    expect(splitStatements('CREATE TABLE a (id INT); INSERT INTO a VALUES (1);')).toEqual([
      'CREATE TABLE a (id INT)',
      'INSERT INTO a VALUES (1)',
    ]);
  });

  it('SPLIT-02: 末尾の連続セミコロンや空白は空文として無視される', () => {
    expect(splitStatements('SELECT FROM WHERE;;;')).toEqual(['SELECT FROM WHERE']);
  });

  it('SPLIT-03: 単一引用符文字列内のセミコロンは区切りとして扱われない', () => {
    expect(splitStatements("INSERT INTO a (b) VALUES ('x;y'); SELECT * FROM a;")).toEqual([
      "INSERT INTO a (b) VALUES ('x;y')",
      'SELECT * FROM a',
    ]);
  });

  it('SPLIT-04: 二重引用符識別子内のセミコロンは区切りとして扱われない', () => {
    expect(splitStatements('SELECT * FROM "weird;name";')).toEqual(['SELECT * FROM "weird;name"']);
  });

  it("SPLIT-05: エスケープされた引用符（''）を正しく読み飛ばす", () => {
    expect(splitStatements("SELECT 'it''s; fine' FROM a;")).toEqual(["SELECT 'it''s; fine' FROM a"]);
  });

  it('SPLIT-06: 行コメント（--）内のセミコロンは区切りとして扱われない', () => {
    expect(splitStatements('SELECT * FROM a; -- comment; with semicolons\nSELECT * FROM b;')).toEqual([
      'SELECT * FROM a',
      '-- comment; with semicolons\nSELECT * FROM b',
    ]);
  });

  it('SPLIT-07: ブロックコメント（/* */）内のセミコロンは区切りとして扱われない', () => {
    expect(splitStatements('SELECT * FROM a /* comment; here */; SELECT * FROM b;')).toEqual([
      'SELECT * FROM a /* comment; here */',
      'SELECT * FROM b',
    ]);
  });

  it('SPLIT-08: 空文字列・空白のみの入力は空配列になる', () => {
    expect(splitStatements('')).toEqual([]);
    expect(splitStatements('   \n\t ')).toEqual([]);
  });
});
