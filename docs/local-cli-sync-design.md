# ローカルCLI経由のファイル同期機能 設計書

[local-cli-sync-spec.md](./local-cli-sync-spec.md)（何を・なぜ）を実現する
ための、実装方法（対象ファイル・モジュール構成）を記述する。
[Issue #26](https://github.com/Yaeshio/SQL-Viz/issues/26) に対応。

## 1. ファイル一覧

| ファイル | 役割 |
|---|---|
| `scripts/openLocal.mjs` | `npm run sql-studio` のCLIエントリポイント |
| `src/local/apiPlugin.ts` | Vite dev server プラグイン。`GET`/`POST /api/schema` |
| `src/local/localSync.ts` | ブラウザ側の薄いfetchラッパー（`isLocalMode`/`fetchSchema`/`saveSchema`） |
| `src/hooks/useLocalSync.ts` | `localSync.ts` を状態管理でラップするReactフック |
| `src/components/local/LocalSyncControls.tsx` | ヘッダーのSave/Reloadボタン（旧GitHub設定ギアの置き換え） |

再利用（無改修）: `src/pglite/ddlExport.ts` の `generateDdl()`。GitHub非依存
の設計だったため、保存対象を `POST /api/schema` に差し替えるだけで済んだ。

## 2. `scripts/openLocal.mjs`

Vite の `vite` CLIバイナリを子プロセスとして起動する方式ではなく、Vite の
JS API（`createServer()`）を**この Node スクリプトのプロセス内で**直接
呼び出す。これは `vite.config.ts` を一切変更せずに `localApiPlugin` を
注入するための必須の設計判断である——`vite` CLIバイナリを spawn する方式
では、注入するプラグインの情報を渡す手段が `vite.config.ts` 経由（環境変数
を読んで条件分岐する等）に限られてしまい、「`vite.config.ts` はローカル
CLIモードの存在を一切知らない」という要件と両立しない。`createServer()`
は指定しない限り既定でルートの `vite.config.ts` を自動ロードしつつ渡した
inline config をマージするため、`react()` 等の既存プラグインはそのまま
活き、`localApiPlugin` だけを CLI側からしか注入されない形で追加できる。

主要なエクスポート（テスト容易性のため、副作用を伴う処理を個別関数に
分離している）:

- `resolveDdlPath(arg, cwd)`: 相対パスを `cwd` 基準の絶対パスに解決する
  （絶対パスはそのまま返す）。
- `openBrowser(url, platform)`: OS別コマンド（darwin: `open`, win32:
  `cmd /c start`, その他: `xdg-open`）を `node:child_process.exec` で
  呼び出す。新規npm依存は追加しない。失敗してもサーバー起動自体はブロック
  せず、URLをコンソールに表示して手動オープンを促す。
- `spawnVite({ filePath, port })`: `process.env.VITE_LOCAL_FILE = 'true'`
  をセットしてから `createServer()` を呼び、`localApiPlugin(filePath)` を
  注入し、`server.host: '127.0.0.1'` に固定して `listen()` する。
- `main(argv)`: 引数なし（ファイルパス未指定）の場合は usage を stderr へ
  出力して exit code 1 で終了する（デフォルトパスへのフォールバックは
  行わない——「引数を渡し忘れた」ことに気づけるようにするため）。

### Node の TypeScript サポートへの依存

`openLocal.mjs`（プレーンな `.mjs`、`npm run sql-studio` から直接 `node`
で実行される）が `src/local/apiPlugin.ts`（TypeScript）を直接 `import`
している。これは Node 22.6+ が持つ組み込みの型ストリッピング機能
（erasable な構文——`interface`・型注釈・アロー関数等——のみをフラグなしで
実行できる）に依存する。本リポジトリの CI（`.github/workflows/ci.yml`）・
開発環境ともに Node 24 を使用しており動作確認済みだが、`apiPlugin.ts` に
`enum`・namespace・パラメータプロパティ等の非erasable構文を持ち込まない
ことが前提になる。`package.json` に `"engines": { "node": ">=22.6" }` を
明記している。

Vitest 経由のテスト（`tests/openLocal.test.ts` 等）はesbuildベースの
変換パイプラインを使うため、この制約の影響を受けない。

## 3. `src/local/apiPlugin.ts`

Vite の `configureServer` フック（Connect ミドルウェア）として実装。
`buildApiPlugin(filePath: string): Plugin` が `filePath` を**生成時に一度
だけ**受け取り、以降のリクエストからは一切パスを受け付けない
（spec 3節のセキュリティ要件）。`/api/schema` 以外のパス・GET/POST 以外の
メソッドは `next()` で後続のVite内部ルーティングに委譲する。

`tests/localApi.test.ts` は `vi.mock('node:fs/promises', ...)` で `readFile`/
`writeFile`/`mkdir` をモックし、`configureServer` に渡されるフェイクの
`server.middlewares.use` からハンドラを取り出して直接呼び出す単体テスト。
実ファイルI/Oは行わない。

## 4. `src/local/localSync.ts` / `src/hooks/useLocalSync.ts`

`localSync.ts` はフレームワーク非依存の薄い `fetch` ラッパー
（`isLocalMode`/`fetchSchema`/`saveSchema`）。`isLocalMode()` は
`import.meta.env.VITE_LOCAL_FILE` の真偽値を返すだけで、実行時に変化
しないビルド時フラグである。

`useLocalSync.ts` はこれを React の状態管理でラップし、`save`/`reload` の
実行状態を `GitHubSettingsPanel`（旧実装）と同じ判別共用体パターン
（`{ kind: 'idle' | 'pending' | 'success' | 'error' }`）で表現する。この
フック自体の単体テストは書いていない——本リポジトリには元々Reactフック/
コンポーネント単体テストの慣習がなく（`@testing-library/react` 未導入）、
UI層の動作確認は目視確認ツール（`tools/visual-check/`）に委ねている。

## 5. `useSqlRunner` の拡張（起動時サイレント自動ロード）

`run(): Promise<void>` を `run(options?: RunOptions): Promise<void>` に拡張
した。既存の手動Runボタン呼び出し（引数なし）は型・挙動とも完全に後方
互換である。

```ts
interface RunOptions {
  sql?: string;    // 指定時はエディタのsqlステートも同時に更新する
  silent?: boolean; // 実行ログへの書き込みを抑制する（アニメーションは通常通り再生）
}
```

`silent: true` は `setLog([])`/`pushLog()` の呼び出しを一切スキップする
実装で、ログペインの見た目を変えずに（＝専用のprop配線を増やさずに）
「静かな実行」を実現している。エラー（`setError`）はサイレント時も通常
通り発生させる——サイレントは「起動時演出の抑制」であって「エラーの隠蔽」
ではないという解釈による。

`App.tsx` はマウント時の `useEffect` で `isLocalMode()` が真のときのみ
`fetchSchema()` を呼び、非空なら `run({ sql: content, silent: true })` を
実行する。ファイル不在（空文字列）やフェッチ失敗は握りつぶし、通常の
空キャンバス起動にフォールバックする。`run` 自体は `sql`/`mode` が変わる
たびに再生成される（`useCallback` の依存配列）ため、起動時 `useEffect`
からは `useRef` 経由の最新版（`runRef.current`）を呼び出し、effect自体の
依存配列は `[localSync.isLocal]`（実行時に変化しない値）のみに保っている。

### 副次的な修正: `onRun` の呼び出し方

`SqlEditorPane` の Run ボタンは `<button onClick={onRun}>` と `onRun` を
直接DOMイベントハンドラとして渡す実装だった。`App.tsx` 側も
`onRun={run}` と関数をそのまま渡していたため、`run` が引数を取るように
なると、クリック時に `MouseEvent` が第一引数としてそのまま `run` に渡って
しまう（`options.sql`/`options.silent` はどちらも `undefined` になるため
実害はないが、意図が不明瞭で事故りやすい）。`App.tsx` 側を
`onRun={() => run()}` に修正した。

## 6. UI: `LocalSyncControls`

`isLocal === false` のとき `null` を返す設計とし、「本番/Vercelビルドでは
ローカル同期UIを一切表示しない」という要件をこのコンポーネント内に閉じ
込めている（`App.tsx`/`AppHeader.tsx` 側に `isLocal &&` の分岐を散らさ
ない）。`AppHeader.tsx` の旧GitHub設定ギアボタン（`aria-label="GitHub連携
設定"`）をこのコンポーネントで置き換えた。

Save ボタンの活性条件は旧 `GitHubSettingsPanel.canPush` と同じ
`mode === 'design' && order.length > 0`（`App.tsx` が算出して
`saveDisabled` として渡す）。Save ボタンには `data-testid="save-to-file-btn"`
を付与している（目視確認シナリオでの選択用）。

## 7. テスト方針

| レイヤー | テストファイル | 手法 |
|---|---|---|
| `apiPlugin.ts` | `tests/localApi.test.ts` | `node:fs/promises` をモック、フェイクの `server.middlewares.use` |
| `openLocal.mjs` | `tests/openLocal.test.ts` | `vite`/`../src/local/apiPlugin`/`node:child_process` をモック |
| `localSync.ts` | `tests/localMode.test.ts` | `vi.stubEnv`/`vi.stubGlobal('fetch', ...)`（`tests/pushSchema.test.ts` と同じパターン） |
| `useLocalSync.ts`/UI | — | 単体テストなし。`tools/visual-check/` による目視確認に委ねる（5節参照） |

`generateDdl()`（`tests/ddlExport.test.ts`）は無改修のため既存テストの
ままで問題ない。

目視確認では以下を実ブラウザ（Docker上のPlaywright）で確認済み:

1. `npm run dev`（`VITE_LOCAL_FILE` 未設定）でヘッダーに Save/Reload
   ボタン・旧GitHubギアアイコンのいずれも表示されないこと。
2. `npm run sql-studio -- <path>` でヘッダーに Reload/Save ボタンが表示
   され、ギアアイコンが表示されないこと。CREATE TABLE 実行 → Save 押下で
   実際にファイルへDDLが書き込まれること。
3. 保存済みファイルを指定して再起動すると、Runボタンを押さずにキャンバス
   へテーブルが自動復元され、実行ログには何も追加されない（サイレント
   ロードの仕様通り）こと。

## 8. 既知の制限

- WSL2 環境では `xdg-open` が存在しない場合があり、ブラウザ自動起動に
  失敗することがある（`openBrowser` はこの場合コンソールにURLを表示する
  フォールバックを持つ）。
- `npm run build`（Vercelビルド）はローカルモードUIを一切含まない
  静的SPAをそのまま出力する。ローカルCLIモードのコード
  （`src/local/`, `src/hooks/useLocalSync.ts`,
  `src/components/local/`）自体はバンドルに含まれるが、
  `isLocalMode()` が常に `false` を返すため実行時に到達しない。
