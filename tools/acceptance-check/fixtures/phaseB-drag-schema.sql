-- Fixture for tools/acceptance-check/scenarios/phaseB-drag.mjs (Issue #34).
-- Two small tables so the initial fit sits at scale=1 (world smaller than the
-- 1280x800 Playwright viewport, and fitToContent() caps zoom-in at 1x) — a
-- drag's screen-px delta then equals its world-px delta, no scale conversion
-- needed in the scenario script. CREATE-only: the startup auto-load runs in
-- design mode, which rejects INSERT/UPDATE/DELETE.
CREATE TABLE t0 (id INT, name VARCHAR(50));
CREATE TABLE t1 (id INT, label VARCHAR(50));
