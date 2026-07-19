# Issue #4 リファクタリング 手動動作確認ログ

> **注記（Issue #14）**: 本ドキュメントは Issue #4（`App.tsx`/`Canvas.tsx` の
> 責務分割リファクタリング）時点の、一度きりの手動検証記録である。現在も
> 継続的に運用されているチェックリストではない。当時参照していたエラー
> 文言はその後の Issue #8（PGlite導入）で実PostgreSQLのネイティブな文言に
> 変わったため、以下は歴史的な記録としての正確性のために現在の文言へ
> 更新してあるが、本ログ自体を再実施する運用は行っていない。

[smoke-test-spec.md](./smoke-test-spec.md) の `SMOKE-*` シナリオに対応する SQL 文を、
実際に開発サーバー（`npm run dev`）の SQL エディタに貼り付けて実行し、
`App.tsx`/`Canvas.tsx` の責務分割リファクタリング（Issue #4）前後で挙動が
変わっていないことを目視確認するためのチェックリスト。SQL 文・期待結果は
[tests/smoke.test.ts](../tests/smoke.test.ts) の実装と一致させている
（そちらは `PgEngine.run()` を直接呼ぶユニットテストで既に全件パス済み。
本ログは同じシナリオを実際の画面・アニメーションで確認する）。

## 実行方法

1. `npm run dev` でアプリを開く
2. 各ケースの SQL をエディタに貼り付けて「Run SQL」を押す
   （複数文のシナリオは貼り付けた内容をまとめて1回で実行する。
   D. のみ2回に分けて実行する）
3. 「期待結果」と実際の画面表示を照合し、「実施結果」欄に ✅ / ❌ と気づいた点を記入
4. 次のケースに進む前に「Reset」ボタンを押して状態をクリアする

---

## A. 正常系（実装済み機能の一気通貫シナリオ）

### SMOKE-01: ゴールデンシナリオ（初期表示のSAMPLEと同一）

```sql
CREATE TABLE users (id INT, name VARCHAR(50), email VARCHAR(120));

INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@db.dev');
INSERT INTO users (id, name, email) VALUES (2, 'Bob', 'bob@db.dev');
INSERT INTO users (id, name, email) VALUES (3, 'Carol', 'carol@db.dev');

SELECT name FROM users WHERE id > 1;
```

期待結果: `users`テーブルがフェードインで出現 → 3行が1件ずつ追加アニメーション →
`id=1`(Alice)の行がフェードアウト（`filteredOut`） → `name`列がハイライト表示。
実行ログに5行（CREATE/INSERT×3/SELECT）が順に追加される。

実施結果: [ ]

### SMOKE-02: 複数テーブルのグリッド配置

```sql
CREATE TABLE a (id INT);
CREATE TABLE b (id INT);
CREATE TABLE c (id INT);
INSERT INTO a (id) VALUES (1);
INSERT INTO b (id) VALUES (1);
INSERT INTO c (id) VALUES (1);
SELECT * FROM a;
```

期待結果: 3テーブルがキャンバス上で重ならずグリッド状に配置される。

実施結果: [ ]

### SMOKE-03: `SELECT *`（列指定なし）

```sql
CREATE TABLE users (id INT, name VARCHAR(50));
INSERT INTO users (id, name) VALUES (1, 'Alice');
SELECT * FROM users;
```

期待結果: 全列（`id`/`name`両方）がハイライト表示される。

実施結果: [ ]

### SMOKE-04: フィルタ解除（`row_unfilter`）

```sql
CREATE TABLE users (id INT, name VARCHAR(50));
INSERT INTO users (id, name) VALUES (1, 'Alice');
INSERT INTO users (id, name) VALUES (2, 'Bob');
SELECT * FROM users WHERE id > 1;
SELECT * FROM users;
```

期待結果: 1回目のSELECTで`id=1`(Alice)がフェードアウト、2回目のSELECT（WHEREなし）で
Aliceが再びフェードインして復帰する。

実施結果: [ ]

### SMOKE-05: 各データ型 + NULL

```sql
CREATE TABLE t (a INT, b VARCHAR(20), c TEXT, d BOOLEAN, e DATE);
INSERT INTO t (a, b, c, d, e) VALUES (1, 'x', 'y', true, '2024-01-01');
INSERT INTO t (a, b, c, d, e) VALUES (NULL, NULL, NULL, NULL, NULL);
```

期待結果: 1行目は各列の値がそのまま表示される。2行目は全セルが`NULL`表示
（グレーアウトした文字色）になる。

実施結果: [ ]

---

## B. エラー系（実装済み機能に対する妥当なエラー）

### SMOKE-06: 存在しないテーブル

```sql
INSERT INTO ghost (id) VALUES (1);
```

期待結果: 赤枠のエラーバナーに `relation "ghost" does not exist` と表示される
（実PostgreSQLのネイティブな文言。旧文言は `Table "ghost" does not exist`）。

実施結果: [ ]

### SMOKE-07: テーブル名の重複

```sql
CREATE TABLE users (id INT);
CREATE TABLE users (id INT);
```

期待結果: 1文目は成功しテーブルが表示される。2文目でエラーバナーに
`relation "users" already exists` と表示され、実行ログは1文目のみ追加される
（旧文言は `Table "users" already exists`）。

実施結果: [ ]

### SMOKE-08: VALUES の数がカラム数を超える INSERT

```sql
CREATE TABLE users (id INT, name VARCHAR(50));
INSERT INTO users VALUES (1, 'Alice', 'extra');
```

期待結果: エラーバナーに `INSERT has more expressions than target columns`
と表示される（実PostgreSQLのネイティブな文言。旧シナリオは「`columns` と
`VALUES` の数が不一致」で `Column count mismatch` を期待していたが、
`VALUES` がカラム数より**少ない**場合は実PostgreSQLではエラーにならず
残りのカラムが `NULL` 埋めされる挙動に変わっている。上記の SQL は
`VALUES` がカラム数より**多い**、エラーになる方のケースを示す）。

実施結果: [ ]

### SMOKE-09: 構文エラー

```sql
SELECT FROM WHERE;;;
```

期待結果: エラーバナーに `Parse error: ...` と表示される（テーブル・行は何も生成されない）。

実施結果: [ ]

### SMOKE-10: 複数文の途中でエラー（早期終了）

```sql
CREATE TABLE users (id INT);
INSERT INTO ghost (id) VALUES (1);
INSERT INTO users (id) VALUES (2);
```

期待結果: `users`テーブルは作成されるが、2文目でエラーになり
`relation "ghost" does not exist` が表示される（旧文言は
`Table "ghost" does not exist`）。3文目（`users`への正しいINSERT）は
実行されず、`users`テーブルの行数は0のまま。

実施結果: [ ]

---

## C. 未実装SQL構文（明示的にエラーになることの確認）

### SMOKE-11: UPDATE

```sql
UPDATE users SET name = 'x' WHERE id = 1;
```

期待結果: `Unsupported statement type: update`

実施結果: [ ]

### SMOKE-12: DELETE

```sql
DELETE FROM users WHERE id = 1;
```

期待結果: `Unsupported statement type: delete`

実施結果: [ ]

### SMOKE-13: ALTER TABLE

```sql
ALTER TABLE users ADD COLUMN age INT;
```

期待結果: `Unsupported statement type: alter`

実施結果: [ ]

### SMOKE-14: JOIN

```sql
SELECT * FROM a INNER JOIN b ON a.id = b.id;
```

期待結果: `Unsupported clause: JOIN`

実施結果: [ ]

### SMOKE-15: 複合WHERE（AND/OR）

```sql
SELECT * FROM users WHERE id > 1 AND id < 10;
```

期待結果: `Unsupported clause: WHERE`

実施結果: [ ]

### SMOKE-16: GROUP BY / ORDER BY / LIMIT / UNION

```sql
SELECT * FROM users GROUP BY id;
```
期待結果: `Unsupported clause: groupby`　実施結果: [ ]

```sql
SELECT * FROM users ORDER BY id;
```
期待結果: `Unsupported clause: orderby`　実施結果: [ ]

```sql
SELECT * FROM users LIMIT 10;
```
期待結果: `Unsupported clause: limit`　実施結果: [ ]

```sql
SELECT * FROM users UNION SELECT * FROM admins;
```
期待結果: `Unsupported clause: _next`　実施結果: [ ]

---

## D. 複数回の実行(Run)をまたぐシナリオ

### SMOKE-17: Runをまたいだ状態継続

1回目（Runを押す）:
```sql
CREATE TABLE users (id INT, name VARCHAR(50));
```

エディタの内容を消し、2回目（Runを押す）:
```sql
INSERT INTO users (id, name) VALUES (1, 'Alice');
```

期待結果: 2回目の実行で`table_appear`（テーブルのフェードイン）は再発火せず、
既存の`users`テーブルに`Alice`の行だけが追加アニメーションで表示される。

実施結果: [ ]

---

## 総合確認

- [ ] 上記すべてのケースで、リファクタリング前と比較して見た目・タイミングに
      差異が無いこと
- [ ] ブラウザの開発者コンソールにエラーが出力されていないこと
