# GitHub連携によるSQL実行履歴保持機能 設計書

このドキュメントは [github-sync-spec.md](./github-sync-spec.md) で定義した
「何を・なぜ」に対して、**どう実装するか**を記述するものである
（[Issue #18](https://github.com/Yaeshio/SQL-Viz/issues/18)）。実装は
下記のマイルストーン順（M1→M6）に、依存関係を崩さない形で段階的に
進める想定であり、本ドキュメント作成時点ではまだ着手していない
（Issue #18、未実装）。

## 1. 全体方針

現状のパイプライン（[CLAUDE.md](../CLAUDE.md) の「アーキテクチャ」節を参照）
`splitStatements → parseSql（事前検証ゲート） → PgEngine.run() →
snapshotAfter → layoutTables → diffStates → playEvents` を維持したまま、
以下の2点を追加する。

1. **モードゲート**という新しい検証レイヤーを `parseSql` の事前検証ゲートの
   「後・実行の前」に挿入し、今のモードで許可されていない文種を一括で
   拒否する。
2. **GitHub Contents APIへのプッシュ**という新しい末端ステップを、
   ユーザーの明示的な操作（「スキーマをプッシュ」「クエリを昇格してプッシュ」）
   としてパイプラインの外側に追加する（アニメーション再生後に独立して
   発火する、既存の実行フローには影響しない）。

## 2. モード管理の実装方針

- `src/hooks/useAppMode.ts`（新規）— `export type AppMode = 'design' | 'experiment'`
  を持つ単純な `useState` ラッパー。`{ mode, setMode }` を返す。
- **単一のPGliteセッションを両モードで共有する**（`PgEngine` インスタンスを
  モードごとに分けない）。構造的安全性は M3 で追加するモードゲート
  （文種の許可リストチェック）のみで担保する。
  - 却下した代替案: モードごとに独立した/フォーク可能なPGliteセッションを
    持たせる案。実験モードの `INSERT`/`UPDATE`/`DELETE` を隔離すれば
    「設計モード復帰時のリセット」（3節）が自然に実現できる利点はあるが、
    PGliteインスタンスの複製・切り替えコストと実装複雑度が高く、
    「実験モードで許可される文種を絞る」という単純なゲートだけで
    構造安全性の要件（github-sync-spec.md 2節）は満たせるため、MVPでは
    見送る。
- **モード遷移時のデータリセット**（実験モード→設計モード復帰時）:
  `PgEngine` に、設計モードへ最後に遷移した時点（＝直近の設計モード操作
  完了時点）のスナップショットを保持させ、実験モードから設計モードへ
  戻る際にそのスナップショットへ復元する処理を追加する。具体的には
  `PgEngine` に `snapshotDesignState(): void` / `restoreDesignState(): Promise<DBState>`
  相当のメソッドを追加し、`useAppMode` の `setMode` が `'experiment' → 'design'`
  遷移を検出した際に `restoreDesignState()` を呼ぶ形を想定する（PGlite
  自体への行レベルのロールバックではなく、既存の `cloneState`
  （`src/reducer.ts`）パターンを踏襲したアプリ側スナップショット＋
  再実行、または該当テーブルの行を再INSERTし直す方式のどちらが妥当かは
  実装時に精査する）。

## 3. `parser.ts` 拡張方針

現行の許可リスト方式（`assertNoExtraClauses` + `CREATE_ALLOWED_FIELDS`/
`INSERT_ALLOWED_FIELDS`/`SELECT_ALLOWED_FIELDS`）を踏襲し、`Parsed` 型
共用体に以下を追加する。

- `ParsedUpdate`: `node-sql-parser` の `Update` ノード
  （`{ type: "update", db, table, set, where, returning? }`）から
  `type, table, set, where` のみを許可。`set: SetList[]`
  （`{ column, value, table }`）の `value` は既存の `litValue()` を
  再利用し、リテラル以外の式は拒否する（`WHERE` 右辺の既存制約と同じ
  考え方）。`WHERE` 句自体は既存の `parseWhere()`（単純な1比較のみ）を
  そのまま再利用する。
- `ParsedDelete`: `Delete` ノード
  （`{ type: "delete", table, from, where, returning? }`）から
  `type, table, from, where` のみを許可。`WHERE` は `parseWhere()` を再利用。
- `ParsedAlter`: `Alter` ノード（`{ type: "alter", table, expr }`）。
  `node-sql-parser` の型定義上 `expr` は `any` であるため、実装着手時に
  `new Parser().astify('ALTER TABLE t ADD COLUMN c INT', {database:'PostgreSQL'})`
  および `... DROP COLUMN c` を実際に実行してASTの実際の形を確認し、
  既存コードの `WHERE` 句解析・識別子アンラップ処理と同じ精度でコメントに
  残す。**MVPスコープは単一の `ADD COLUMN` または単一の `DROP COLUMN` の
  みを許可し、それ以外（`RENAME`、`ALTER COLUMN TYPE`、複数アクションの
  同時指定、制約の追加/削除）は `Unsupported clause` として拒否する**
  （github-sync-spec.md 3節・8節）。
- `ParsedDrop`: `Drop` ノード（`{ type: "drop", keyword, name }`）から
  `keyword === 'table'` かつ単一テーブル名のみを許可。

## 4. `pglite/engine.ts` 拡張方針

- `snapshotAfter()` に新しい分岐を追加する:
  - `'drop'`: `next.tables` から該当テーブルを削除、`next.order` から
    splice、`ctidMaps` からも該当エントリを削除、`version` をインクリメント。
  - `'alter'`（ADD COLUMN）: `columns` に新しいカラムを追記した上で、
    既存の `insert` 分岐と同じ `ctid` 起点の再クエリで全行を取得し直し
    （新カラムはデフォルトで `NULL` として反映される）。
  - `'alter'`（DROP COLUMN）: `columns` から該当カラムを削除し、
    各 `Row.values` からも該当キーを削除。
  - `'update'`: `WHERE` に一致する `ctid` 集合を取得し（既存の `select`
    分岐の `matchedIds` 取得ロジックと同じパターン）、該当行のみ値を
    再クエリして `next.tables[table].rows` にマージ。
  - `'delete'`: `WHERE` に一致する `ctid` 集合を取得し、対応する安定行ID
    を `ctidMap` 経由で解決した上で、配列から物理的に削除する
    （`select` の `filteredOut` ソフトフィルタとは異なり、破壊的削除）。
- `buildLabel()` に `alter`/`drop`/`update`/`delete` のケースを追加。
- `PgEngine.run(sql, canvasWidth, mode: AppMode)`（M5節参照）に
  `mode` 引数を追加し、既存の全文事前パースゲートの直後・各文実行の前に
  モードゲート（5節）を挿入する。

## 5. モードゲートの実装

`src/pglite/engine.ts` に、文種とモードの対応表を持つ定数を追加する。

```ts
const MODE_ALLOWED_TYPES: Record<AppMode, Set<Parsed['type']>> = {
  design: new Set(['create', 'alter', 'drop']),
  experiment: new Set(['select', 'insert', 'update', 'delete']),
};
```

`PgEngine.run()` は、既存の「全文をパースしてから初めて1文目を実行する」
という all-or-nothing の構造を維持したまま、パース済みの全文に対して
`MODE_ALLOWED_TYPES[mode]` によるチェックを行い、1つでも許可されない
文種があれば、どの文も実行せずに
`{ results: [], parseError: 'Statement type "<type>" is not allowed in <mode> mode' }`
を返す（既存の構文パースエラー時の挙動と同じ形）。

## 6. `types.ts` / `diff.ts` の拡張

`AnimationEvent` 共用体に以下を追加する（`DBState`/`Table`/`Column` 自体の
型拡張はMVPでは不要——リレーション/FKはスコープ外のため）。

```ts
| { kind: 'table_remove'; table: string }
| { kind: 'column_add'; table: string; column: string }
| { kind: 'column_drop'; table: string; column: string }
| { kind: 'row_update'; table: string; rowId: string }
| { kind: 'row_remove'; table: string; rowId: string }
```

`diffStates()`（`src/diff.ts`）に、既存の「テーブル出現→行追加→
フィルタ変化→SELECTハイライト」という順序付けを踏襲する形で、
テーブル削除検出（`old.order` にあり `next.order` にない名前）、
カラム追加/削除検出（同名テーブルの `columns` の名前集合比較）、
行削除検出（既存の行追加検出ロジックの逆——`old` にあり `next` にない
行ID）、行更新検出（`old`/`next` 双方に存在するが `values` が異なる行。
値の比較はキーごとの比較、または `JSON.stringify` 比較のいずれかで実装
する）を追加する。

`src/components/canvas/TableNode.tsx`/`TableRow.tsx` は、既存の
`framer-motion`（`AnimatePresence`）による退場アニメーションを
`table_remove`/`row_remove` にも適用し、`row_update` には既存の
フィルタ時の減光とは異なる強調表示（パルス等）を追加する。カラムの
追加/削除に伴うテーブルカード内の再レイアウトは `src/lib/canvasLayout.ts`
の既存計算を拡張する形で行う（新規ファイルは作らない）。
`src/hooks/useAnimationPlayer.ts` の内部状態（`appearingRows`/
`filteringRows`/`highlight`）に、削除・更新系の状態を追加する。

## 7. `schema/ddl.sql` 生成

- `src/pglite/ddlExport.ts`（新規）— `src/lib/` ではなく `src/pglite/`
  配下に置く。理由: [CLAUDE.md](../CLAUDE.md) が明記する通り、
  `src/lib/` はビュー層専用の純粋計算（`canvasLayout.ts`）のためのもので
  あり、`ddlExport.ts` は生きたPGliteインスタンスへ `information_schema`
  をクエリする必要があるため、PGlite実行エンジン関連コードをまとめた
  `src/pglite/` に置く（`engine.ts`/`splitStatements.ts` と同じ意図的な
  フラット配置の例外）。
- シグネチャ: `async function generateDdl(db: PGlite, order: string[]): Promise<string>`。
  `information_schema.tables`/`information_schema.columns`
  （`table_schema = 'public'` に限定）を `order` の順序でクエリし、
  PostgreSQLの型名（`character varying` + `character_maximum_length`、
  `integer`、`text`、`boolean`、`date` 等）を `CREATE TABLE` 構文に
  変換する。制約（PK/FK/NOT NULL/DEFAULT）はMVP範囲外。
- `PgEngine` は現状 `db`（PGliteインスタンス）を private に保持している
  ため、`generateDdl` から利用できるよう最小限のアクセサ
  （例: `PgEngine.getDb(): PGlite | null`）を追加する。`db` 自体は
  private のまま、公開面を必要最小限に留める。

## 8. `query-examples.md` 生成・昇格フロー

- `src/hooks/usePromotedQueries.ts`（新規）— 昇格済みクエリの配列
  `{ id, sql, label, note, promotedAt }[]` を状態として持ち、
  `localStorage`（キー例: `sqlviz.promotedQueries.v1`）に保存する
  （本アプリで初めての `localStorage` 利用——実装完了後、
  [CLAUDE.md](../CLAUDE.md) の「永続化を持たない」という記述を実態に
  合わせて改訂する必要がある。9節参照）。
- `src/github/formatQueryExamplesMd.ts`（新規、純粋関数）—
  昇格済みクエリの配列を受け取り、github-sync-spec.md 5節のフォーマット
  に従ったMarkdown文字列を返す。
- 実験モードの実行ログ（`useSqlRunner` の `log: string[]`）から、
  どのログ行が `SELECT` 文に対応するかを判定できるようにする必要がある。
  現状 `log` は文字列配列のみで文種情報を保持しないため、
  `{ text: string; sql: string; type: Parsed['type'] }[]` 相当の
  構造化された形へ拡張する（`UseSqlRunnerResult` の型変更を伴う）。
  `SqlEditorPane`（または `ExecutionLogPanel.tsx`）に、実験モードかつ
  `type === 'select'` のログ行にのみ「昇格」ボタンを表示する。

## 9. GitHub Contents API連携

**依存関係の決定**: 新規パッケージを追加せず、`fetch()` ベースの
`src/github/client.ts` を自前実装する。

- 検討した選択肢:
  - **`@octokit/rest` を追加する** — ブラウザ環境でも動作するが、
    本機能が必要とするエンドポイントは実質2つ
    （`GET`/`PUT /repos/{owner}/{repo}/contents/{path}`）と
    `GET /repos/{owner}/{repo}`（デフォルトブランチ確認）のみであり、
    フルクライアントを導入するのは過剰。将来的にリポジトリ一覧
    ピッカー（`/user/repos` のページネーション処理等）を追加する場合は
    改めて検討する。
  - **`fetch()` を直接使う自前実装（採用）** — 依存を増やさず、
    このプロジェクトが一貫して保ってきた軽量な依存関係
    （`docs/routing-decision.md` が示す「明確な必要性がない限り新規
    パッケージを追加しない」という判断基準と同じ考え方）を維持できる。
- `src/github/client.ts`: `getRepo(owner, repo, token)`、
  `getFile(owner, repo, path, branch, token)`、
  `putFile(owner, repo, path, content, message, branch, token, sha?)`。
  Contents APIの `PUT` は既存ファイルの更新時に `sha` が必須のため、
  `putFile` は内部で `getFile` を先に呼び `sha` を解決してから更新する
  （新規ファイル作成時は `sha` なしで呼び出す）。本文のbase64エンコードは
  日本語（`query-examples.md` に含まれうる）を含めてUTF-8安全な方式
  （`TextEncoder` 経由）で行う。
- `src/github/pushSchema.ts`（新規）— `generateDdl()`（7節）+
  `client.putFile()` を組み合わせ、`schema/ddl.sql` へプッシュする。
- `src/github/pushQueryExamples.ts`（新規）— `formatQueryExamplesMd()`
  （8節）+ `client.putFile()` を組み合わせ、`query-examples.md` へ
  プッシュする（github-sync-spec.md 5節の通りリネームないし上書き。
  マージは行わない）。
- **着手前に必須の検証（未検証・github-sync-spec.md 9節）**: `api.github.com`
  への認証付きブラウザ発 `PUT` がCORS的に成立するか。失敗した場合は
  サーバーレスプロキシ等のバックエンド追加が必要になり、この設計書
  全体の前提（バックエンドなし）が崩れるため、その場合はユーザーに
  確認を取った上で方針を再検討する。

## 10. 追加UIコンポーネント

- `src/components/layout/ModeToggle.tsx`（新規、または `AppHeader.tsx`
  に組み込み）— 設計モード/実験モードの切替セグメントコントロール。
- `src/components/github/GitHubSettingsPanel.tsx`（新規）— PAT入力欄
  （マスク表示、fine-grained PAT推奨の案内文つき）、`owner/repo`/
  ブランチの手動入力欄、「接続テスト」（`getRepo` 呼び出し）、
  「スキーマをプッシュ」（設計モードのみ活性化）ボタン。
- `src/components/github/QueryExamplesPanel.tsx`（新規）— 昇格済み
  クエリの一覧（ラベル/メモの編集、削除）、「GitHubへプッシュ」ボタン。
- `App.tsx`/`AppHeader.tsx` に、設定パネルへの入口（歯車アイコン等）を
  追加する。

## 11. テスト方針

既存の `tests/` の慣習（フラット配置、`tests/test-utils.ts` の
フィクスチャ再利用、`<PREFIX>-<NN>` 形式の安定したテストID）を踏襲する。

- **parser/engine層（M1）**: 既存の `describe` ブロック構成を踏襲した
  純粋ユニットテスト。`tests/parser.test.ts` に `ALTER TABLE`/
  `DROP TABLE`/`UPDATE`/`DELETE` 用の新しい `describe` ブロックを追加。
  現在 `tests/parser.test.ts:178-185` にある
  「`UPDATE`/`DELETE`は`Unsupported statement type`になる」という
  `it.each` は、この実装によって陳腐化するため書き換える。
  `tests/engine.test.ts` には `ENGINE-ALTER-*`/`ENGINE-DROP-*`/
  `ENGINE-UPDATE-*`/`ENGINE-DELETE-*` を追加。
- **モードゲート（M3）**: `PgEngine.run(sql, width, mode)` に対する直接の
  ユニットテスト（`db.query()` 呼び出し前に拒否されることをモックなしで
  検証可能）。設計モードでの `SELECT` 拒否、実験モードでの `CREATE`
  拒否、1文だけ許可されない複数文バッチが全体として拒否されること
  （既存の `SMOKE-10` と同じ「事前検証で一括拒否」パターン）を検証。
- **`ddlExport.ts`（M4）**: `tests/engine.test.ts` と同様、実PGlite
  インスタンスに対する統合テスト。CREATE/ALTER/DROPの一連の操作後、
  生成されたDDL文字列を新しい `PgEngine` に流し込み直して同じ
  `information_schema` になることを確認する（ラウンドトリップ検証）。
- **GitHub連携（M5/M6）**: **CIで実GitHubへ接続してはならない**
  （`.github/workflows/ci.yml` は現状シークレット/環境変数を一切
  使っておらず、本機能のためだけに実PATをCIシークレットへ追加すること
  はしない）。`vi.stubGlobal('fetch', ...)` 等でVitestから `fetch` を
  モックし、`src/github/client.ts` の境界でリクエスト形状
  （メソッド・パス・base64本文・`sha`の有無）を検証する。実際の
  CORS/認証挙動の検証（github-sync-spec.md 9節の未決事項）は、
  `tools/visual-check/`（[CLAUDE.md](../CLAUDE.md) 参照）と同様に
  自動テストの対象外とし、手動での一回限りの確認に委ねる。
- M1に伴うドキュメント側の更新（`docs/smoke-test-spec.md` §4/§5、
  `docs/smoke-test-design.md` §4.2、`docs/user-stories.md` §5/§6）は
  同じPR内で行う。これらは単なる補足説明ではなく、この
  リポジトリの慣習において「現在UPDATE/DELETE/ALTERは非対応である」
  ことを仕様として明記した資料であるため、実装と同時に更新しないと
  陳腐化する。

## 12. 将来の運用

- `ALTER TABLE` の対応範囲拡張（`RENAME COLUMN`、`ALTER COLUMN TYPE`、
  複数アクション、制約の追加/削除）が必要になった場合は、3節の
  許可リストを拡張し、4節の `snapshotAfter` 分岐・6節に対応する
  `AnimationEvent` を合わせて拡張する。
- リレーション（外部キー）対応が必要になった場合は、`types.ts` への
  `foreignKeys` 相当のフィールド追加、`parser.ts` での制約句パース、
  キャンバスでのリレーション線描画を含む、本Issueとは別規模の
  プロジェクトとして計画する。
- GitHubリポジトリ/ブランチのピッカーUIが必要になった場合は、9節で
  見送った `@octokit/rest` の導入、または `/user/repos` への直接
  `fetch` 呼び出し（ページネーション対応）を検討する。

## 13. 未決事項

[github-sync-spec.md](./github-sync-spec.md) 9節を参照
（GitHub Contents APIへのブラウザ発 `PUT` のCORS実現可否、M5着手前に
実機検証が必要）。それ以外の主要な設計判断はユーザー確認済みの確定
事項として本ドキュメント各節に反映済み。
