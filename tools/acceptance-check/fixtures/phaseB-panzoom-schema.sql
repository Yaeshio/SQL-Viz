-- Fixture for tools/acceptance-check/scenarios/phaseB-panzoom.mjs (Issue #17).
-- Deliberately many tables so the world box is larger than the 1280x800
-- Playwright viewport in both axes — the initial fit scale is therefore < 1
-- and there is room to pan. CREATE-only: the startup auto-load runs in design
-- mode, which rejects INSERT/UPDATE/DELETE.
CREATE TABLE customers (id INT, name VARCHAR(50), email VARCHAR(80), created DATE);
CREATE TABLE orders (id INT, customer_id INT, total INT, placed DATE);
CREATE TABLE order_items (id INT, order_id INT, product_id INT, qty INT);
CREATE TABLE products (id INT, name VARCHAR(50), price INT, sku VARCHAR(30));
CREATE TABLE categories (id INT, name VARCHAR(50), parent_id INT, slug VARCHAR(30));
CREATE TABLE suppliers (id INT, name VARCHAR(50), country VARCHAR(30), rating INT);
CREATE TABLE warehouses (id INT, code VARCHAR(10), city VARCHAR(40), capacity INT);
CREATE TABLE inventory (id INT, product_id INT, warehouse_id INT, on_hand INT);
CREATE TABLE shipments (id INT, order_id INT, carrier VARCHAR(30), shipped DATE);
CREATE TABLE payments (id INT, order_id INT, method VARCHAR(20), amount INT);
CREATE TABLE reviews (id INT, product_id INT, customer_id INT, stars INT);
CREATE TABLE addresses (id INT, customer_id INT, line1 VARCHAR(60), postcode VARCHAR(12));
