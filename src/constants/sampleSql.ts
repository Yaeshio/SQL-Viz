// Default textarea contents match the default mode ('design'): CREATE TABLE
// is the only statement type design mode allows (mode-and-sql-scope-spec.md 2節).
// The INSERT/SELECT example lines are commented out and placed before the
// only real statement (not after its trailing ';') so splitStatements()
// folds them into the same segment as CREATE TABLE instead of becoming a
// comment-only trailing segment of their own — parseSql() would otherwise
// see that as a statement with no AST node and crash on statements[0].
export const SAMPLE = `-- 実験モードに切り替えると、以下のようなINSERT/SELECTを試せます:
-- INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@db.dev');
-- SELECT name FROM users WHERE id > 1;
CREATE TABLE users (id INT, name VARCHAR(50), email VARCHAR(120));`;
