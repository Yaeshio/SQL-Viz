/**
 * Splits a (possibly multi-statement) SQL string into individual raw statement
 * texts on top-level semicolons, skipping over semicolons that appear inside
 * quoted strings/identifiers or comments. Empty segments (blank input, trailing
 * semicolons, comment-only segments) are dropped from the result.
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
