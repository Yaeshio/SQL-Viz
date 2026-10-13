-- Fixture for tools/acceptance-check/scenarios/phaseC-relation.mjs (Issue #45).
-- Two small tables with one foreign key (posts.user_id -> users.id) so the initial
-- fit sits at scale=1 (same reasoning as phaseB-drag-schema.sql). The referenced
-- column is a PRIMARY KEY because Postgres rejects an FK to a non-unique column.
-- CREATE-only: the startup auto-load runs in design mode.
CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(50));
CREATE TABLE posts (id INT PRIMARY KEY, user_id INT REFERENCES users(id), title TEXT);
