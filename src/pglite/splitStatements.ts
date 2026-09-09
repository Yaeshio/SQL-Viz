/**
 * （複数文かもしれない）SQL 文字列を、トップレベルのセミコロンで個々の生の文
 * テキストへ分割する。クォートされた文字列/識別子やコメントの中に現れる
 * セミコロンはスキップする。空のセグメント（空入力、末尾のセミコロン、
 * コメントのみのセグメント）は結果から除外される。
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }

    if (ch === '-' && next === '-') {
      let j = sql.indexOf('\n', i);
      if (j === -1) j = n;
      current += sql.slice(i, j);
      i = j;
      continue;
    }

    if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      const j = close === -1 ? n : close + 2;
      current += sql.slice(i, j);
      i = j;
      continue;
    }

    if (ch === ';') {
      statements.push(current);
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }
  statements.push(current);

  return statements.map((s) => s.trim()).filter((s) => s.length > 0);
}
