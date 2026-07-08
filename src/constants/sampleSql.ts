export const SAMPLE = `CREATE TABLE users (id INT, name VARCHAR(50), email VARCHAR(120));

INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@db.dev');
INSERT INTO users (id, name, email) VALUES (2, 'Bob', 'bob@db.dev');
INSERT INTO users (id, name, email) VALUES (3, 'Carol', 'carol@db.dev');

SELECT name FROM users WHERE id > 1;`;
