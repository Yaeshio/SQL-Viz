# エージェント向けSQL実行API/CLI 仕様書

このドキュメントは [Issue #27「エージェント向けにSQL実行・結果確認を
プログラム的に行えるCLI/APIを追加する」](https://github.com/Yaeshio/SQL-Viz/issues/27)
に基づき、本機能が**何を・なぜ**実現するかを定義するものである。

## 1. 目的とスコープ

想定する開発フロー: 開発者がクエリを提案 → エージェント（Claude Code等）が
実際にこのAPI経由でSQLを実行して結果を確認 → 最適なクエリを報告する、
というループ。ブラウザUIを介さずにエージェントがSQL-Vizのエンジン部分
（`src/pglite/engine.ts`の`PgEngine.run()`）を直接活用できるようにする。
新しいSQL実行ロジックは一切追加しない——既存の`PgEngine.run()`をHTTP/CLI
経由で公開するだけである。

[Issue #26](https://github.com/Yaeshio/SQL-Viz/issues/26)（
[local-cli-sync-spec.md](./local-cli-sync-spec.md)参照）で導入された
ローカルNode.jsサーバー（CLI起動、`127.0.0.1`限定バインド）の仕組みに
相乗りする形で実装されている。

## 2. セッションモデル

`npm run sql-studio -- <path>`で起動したローカルサーバープロセスに、
1つの永続`PgEngine`インスタンスを保持する。リクエストをまたいで状態
（テーブル定義・行データ）が蓄積される。

これはブラウザ側UIが持つ`PGlite`インスタンスとは完全に独立した、Node実行の
サーバー側セッションであり、**両者はリアルタイムには同期しない**。ブラウザ
キャンバス上の未保存の変更は、このAPI経由のセッション状態に一切反映
されない。

**起動時ブートストラップ**: サーバー起動時（および`POST /api/query/reset`
実行時）、`npm run sql-studio -- <path>`起動時に渡されたDDLファイルの内容を
`design`モードで実行し、その状態からセッションを開始する（`GET /api/schema`
のファイル読み込みロジックを共有——`src/local/httpUtils.ts`の`readDdlFile()`）。
ファイルが空/不在の場合は空の`DBState`から開始する（エラーにはしない）。
これにより、エージェントは開発者が保存済みのスキーマと同じ土台から検証を
始められる。

## 3. API仕様

ローカルCLIモード（`npm run sql-studio`）でのみ有効な、Vite dev サーバー上の
ミドルウェア（`/api/query`にマウント）。`npm run dev`ではこのプラグインは
一切注入されないため、エンドポイント自体が存在しない。`npm run build`の
成果物にも含まれない。

### `POST /api/query`

リクエスト: `{ sql: string, mode: 'design' | 'experiment' }`

`PgEngine.run(sql, 800, mode)`（`800`はレイアウト計算専用の内部固定値。
ヘッドレス呼び出しにDOM幅の概念はないため、リクエストからは受け付けない）
を実行し、その戻り値`RunResult`をほぼそのままJSON化して返す（status 200）。

```ts
interface StatementResult {
  label: string;
  state: DBState;
  events: AnimationEvent[];
  error?: string;
}
interface RunResult {
  results: StatementResult[];
  parseError?: string;
}
```

- `sql`または`mode`が欠如・型不正、リクエストボディが不正なJSONの場合は
  400 `{ error: string }`（`/api/schema`と同じ規約）。
- 同一サーバープロセスに対する複数回の呼び出しをまたいで状態が蓄積される
  （例: 1回目`CREATE TABLE`→2回目`INSERT`→3回目`SELECT`で、3回目の
  レスポンスに1・2回目の結果が反映されている）。
- モードゲート違反（例: `design`モードのセッションに`select`/`insert`/
  `update`/`delete`を送る）は`parseError`に`Statement type "..." is not
  allowed in design mode`が入ったレスポンスとして200で返る（逆も同様）。
- サポート対象外の構文は`parseError`に`Unsupported statement type`等が
  入ったレスポンスとして200で返る。
- Postgres側の制約違反・型不一致（例: 存在しないテーブルへの`INSERT`）は
  該当`StatementResult.error`にPGliteのネイティブなエラー文言がそのまま
  入る（例: `relation "ghost" does not exist"`）。
- **リクエストはサーバー側で直列化される**——前のリクエストの処理が
  完了するまで次のリクエストの実行を待たされる。これは単一エージェントが
  並行/連続してリクエストを送った場合でも内部状態（`ctidMap`等）が
  破損しないための最低限の要件であり、複数クライアント間のセッション分離
  （6節で対象外とする別問題）とは異なる。

### `GET /api/query/state`

SQLを実行せず、現在の`DBState`スナップショットを`{ state: DBState }`として
返す。エージェントがクエリを組み立てる前に現在のテーブル/カラム構成を
副作用なしに確認する用途、およびUPDATE/DELETE実行前に「旧値」を保全して
おく用途（4節）に使う。

### `GET /api/query/health`

`{ ready: boolean, error: string | null }`を返す。`ready`は、サーバー側
`PgEngine`の初回コールドスタート（PGliteのWASM初期化＋起動時ブートストラップ
DDLの実行）が完了しているかどうか。`error`は、ブートストラップDDLの実行が
失敗した場合（構文エラー・Postgresエラー・ファイル読み込みエラー等）の
メッセージ（成功時は`null`）。

### `POST /api/query/reset`

サーバー側`PgEngine`セッションを**起動時ブートストラップ直後の状態**へ
即座にリセットする（単なる空DB化ではなく、DDLファイルを再読み込みして
再実行する——ファイルが起動後に書き換えられていれば、その最新内容から
やり直す）。**確認なしに即座に反映される破壊的操作**であり、実行中の
セッション状態はすべて失われる。`{ ok: boolean, error: string | null }`を
返す（`ok`は再ブートストラップが成功したか）。

## 4. 結果の解釈方法（文種別）

`RunResult`はUI描画用の完全な状態スナップショットであり、「今回の文で
何がどう変わったか」を直接返すAPIではない。文種ごとに以下の手順で解釈する
必要がある。

- **SELECT**: `results[i].state.tables[table].rows`のうち
  `filteredOut === false`の行が該当行であり、列は
  `results[i].state.lastSelect.columns`を用いて呼び出し側で絞り込む
  （本エンジンは行を除外するのではなくフラグを立てる方式であり、列
  プロジェクションも行わないため、レスポンスをそのまま「クエリ結果」とは
  見なせない）。
- **INSERT**: `results[i].events`内の`row_add`が持つ`rowId`一覧と
  `results[i].state.tables[table].rows`を突き合わせ、該当`rowId`を持つ行が
  今回挿入された行である（`state.rows`自体は挿入前から存在した行も含む
  全件スナップショットのため、`events`なしでは新規行を特定できない）。
- **UPDATE**: `events`内の`row_update`の`rowId`で変更された行を特定
  できるが、**「何がどう変わったか（旧値→新値）」は`events`にもレスポンスの
  どこにも含まれない**。旧値が必要な場合は、UPDATE実行前に
  `GET /api/query/state`で取得したスナップショット、または同一リクエスト内
  で直前に実行した文の`state`を、呼び出し側で保持しておく必要がある。
- **DELETE**: `events`内の`row_remove`の`rowId`で削除された行を特定
  できるが、**削除された行の値自体は`next.state`にはもう存在しない**。
  UPDATEと同様、値が必要な場合は実行前のスナップショットを呼び出し側で
  保持しておく必要がある。
- **CREATE/ALTER/DROP**: テーブル/カラムという構造の識別子（名前）そのものが
  変化対象であり、エージェントは自分が投げたSQL文からその名前を既知の
  ため、`state.tables[名前]`の有無や`columns`配列を直接見るだけで判定でき、
  `events`を経由する必要は薄い。

**この取り出し規約は単一テーブル前提である。** JOIN等の複数テーブルを
またぐ文が将来追加された際（[Issue #48](https://github.com/Yaeshio/SQL-Viz/issues/48)、
本仕様のスコープ外）は、本規約の見直しが必要になる。

### エラー発生時のセッション挙動

文がPostgresエラー（型不一致・制約違反・存在しないテーブル等、
`StatementResult.error`に文言が入るケース）になった場合：

- **その失敗した1文だけ**が取り消される（`experiment`モードでは内部的に
  文ごとの`SAVEPOINT`へロールバックする）。同一リクエスト内でそれ以前に
  成功した文、および過去の`POST /api/query`呼び出しで成功した文の効果は
  すべて維持される。
- 同一バッチ内では、最初にエラーになった文で実行を打ち切る（それ以降の
  文は実行されない）。`results`にはエラー文を含むそこまでの
  `StatementResult`が入る。
- **セッションは汚染されない。** エラー後も後続のリクエストを
  `design`/`experiment`どちらのモードでもそのまま受け付ける。回復のための
  `POST /api/query/reset`は不要。
- `experiment`モードで積み上げた未コミットのデータ変更を**まとめて**
  破棄したい場合の手段は引き続き`POST /api/query/reset`（サーバーセッション
  では`experiment→design`のモード復帰による`ROLLBACK`経路は無いため、
  全取り消しには`reset`を使う）。

## 5. CLI仕様

`node scripts/query.mjs "<SQL>"`（または`npm run query -- "<SQL>"`）で、
起動中の`npm run sql-studio`サーバーへHTTP経由でSQLを送信し、結果を標準
出力へ表示する。標準出力には`RunResult`と等価なJSONのみを出力し、人間向け
の補足メッセージは標準エラー出力に限定する（エージェントが`stdout`をそのまま
`JSON.parse`できることを保証するため）。

**注意（npm run特有の落とし穴）**: `npm`はデフォルトで`> pkg@version query`
`> node scripts/query.mjs ...`という2行のバナーを**標準出力へ**出力してから
実際のコマンドを実行するため、素の`npm run query -- "<SQL>"`は`stdout`に
このバナーが混入し、そのままでは`JSON.parse`できない（実機検証で確認済み）。
エージェントがstdoutをそのままパースする用途では、`npm run --silent query --
"<SQL>"`（`--silent`はnpm自身のフラグのため`--`より前に置く）を使うか、
npmを介さず`node scripts/query.mjs "<SQL>"`を直接呼び出すこと。後者は
このバナー問題が原理的に発生しないため、エージェント用途にはこちらを推奨する。

標準入力からのSQL読み込みにも対応する（`npm run query < script.sql`、
または`echo "..." | npm run query`）。複数行・引用符を含む複雑なSQLを
シェル引数のエスケープなしに渡せる。位置引数が指定されていればそちらを
優先し、標準入力は読まない。

`--mode=design|experiment`（省略時`design`）、`--url=http://127.0.0.1:PORT`
（省略時`http://127.0.0.1:5173`）を指定できる。

終了コード:

| コード | 意味 |
|---|---|
| `0` | 成功（`parseError`なし、全文の`error`なし） |
| `1` | SQL実行エラー（`parseError`または`StatementResult.error`が存在） |
| `2` | サーバー未起動/接続エラー（`fetch`自体が失敗） |
| `3` | リクエスト不正（SQL未指定、`--mode`不正、サーバーが非2xx応答） |

## 6. セキュリティ考慮事項

- サーバーは`127.0.0.1`のみにバインドされる（`scripts/openLocal.mjs`が
  Vite dev serverに設定するホストを、`/api/schema`と共有）。
- `npm run sql-studio`実行中のみ有効。`npm run dev`ではこのプラグインは
  一切注入されないためエンドポイントが存在せず、`npm run build`の成果物にも
  含まれない。
- ブートストラップ対象のファイルパスはCLI起動時の引数に固定され、
  リクエストからは一切受け取らない（`/api/schema`と同じ設計、任意パス
  書き込み/読み込み脆弱性を避けるための必須要件）。
- リクエストの直列化（3節）は、単一エージェントによる内部状態破損を防ぐ
  ためのものであり、複数エージェント/複数クライアントが同一サーバーに
  同時接続する際のセッション分離・認可制御を提供するものではない
  （7節で対象外とする）。

## 7. 対象外

- ブラウザUIのキャンバス上の**未保存**の変更と、このAPI経由のセッション
  状態をリアルタイムに同期させること（2節）。
- 複数エージェント/複数クライアントが同一サーバーに同時接続する際の、
  セッション分離・認可制御。
- 複合WHERE・ALTER TABLEのRENAME/型変更・単一ALTER文での複数アクション等、
  現時点で`parser.ts`が対応していない構文への拡張（Mediumティア、
  [Issue #47](https://github.com/Yaeshio/SQL-Viz/issues/47)）。
- JOIN・GROUP BY/集約等、複数テーブル結合・集約結果の可視化を伴う構文への
  拡張（Largeティア、[Issue #48](https://github.com/Yaeshio/SQL-Viz/issues/48)）。

## 8. 参照

- [Issue #27](https://github.com/Yaeshio/SQL-Viz/issues/27)
- [local-cli-sync-spec.md](./local-cli-sync-spec.md) — ローカルサーバー基盤・
  DDLファイルブートストラップの共有ロジック
- [mode-and-sql-scope-spec.md](./mode-and-sql-scope-spec.md) — design/
  experimentモードの許可マトリクス（`PgEngine.run()`がそのまま適用する）
