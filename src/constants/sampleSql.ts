// textarea の初期内容は既定モード（'design'）に合わせる: CREATE TABLE は
// design モードが許可する唯一の文種（mode-and-sql-scope-spec.md 2節）。
// INSERT/SELECT の例の行はコメントアウトし、唯一の実文の前に（その末尾の
// ';' の後ではなく）置く。そうすることで splitStatements() がそれらを
// CREATE TABLE と同じセグメントへ畳み込み、コメントのみの末尾セグメントに
// ならない——さもないと parseSql() がそれを AST ノードの無い文と見なし、
// statements[0] でクラッシュする。
export const SAMPLE = `-- 実験モードに切り替えると、以下のようなINSERT/SELECTを試せます:
-- INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@db.dev');
-- SELECT name FROM users WHERE id > 1;
CREATE TABLE users (id INT, name VARCHAR(50), email VARCHAR(120));`;
