# acceptance-check（フェーズ受け入れテストハーネス）

α版検証の各フェーズ（Phase A/B/C、詳細は
[docs/alpha-phase-acceptance-criteria.md](../../docs/alpha-phase-acceptance-criteria.md)）の
完了条件を、Docker上のPlaywrightで**自動的にpass/fail判定する**ためのツール。

[tools/visual-check/](../visual-check/)（エージェントが目視でスクリーンショットを確認する
補助ツール、`docs/smoke-test-spec.md` §3参照）とは別ツールであり、こちらはDOM/実ファイル
の内容をアサーションで自動判定する。ただし visual-check と同様、`npm test` や CI
（[.github/workflows/ci.yml](../../.github/workflows/ci.yml)）には組み込まれていない。

## なぜDockerか

visual-checkと同じ理由（[tools/visual-check/README.md](../visual-check/README.md)参照）。
ChromiumのOS依存ライブラリをroot権限なしで導入するため、公式Playwrightイメージを使う。

## 前提条件

- Docker Desktop がインストールされ、このWSLディストリビューションでWSL Integrationが
  有効化されていること（`docker version` が成功すること）。
- リポジトリのルートで `npm install` 済みであること（`scripts/openLocal.mjs` を
  `orchestrate-phase-a.mjs` から直接importして使うため）。

## 使い方（Phase A: ローカルファイル同期の実ファイルI/O検証）

```bash
# 1. このツール自身の依存関係をインストール（ルートのnode_modulesとは独立）
cd tools/acceptance-check && npm install && cd -

# 2. イメージをビルド（初回のみ、以降はキャッシュされる）
docker build -t sql-viz-acceptance-check tools/acceptance-check

# 3. Phase Aの受け入れシナリオを実行
node tools/acceptance-check/orchestrate-phase-a.mjs
```

`orchestrate-phase-a.mjs` が以下を自動で行う（開発者がdevサーバーを事前に起動しておく
必要はない — visual-checkとの違い）：

1. `os.tmpdir()` 配下に使い捨ての一時ディレクトリを作成（未使用の任意のディレクトリ）。
2. `scripts/openLocal.mjs` の `spawnVite()` を直接呼び出し、そのディレクトリ内のまだ
   存在しないスキーマファイルを指す実の `sql-studio` dev サーバーをホスト上で起動。
3. `sql-viz-acceptance-check` コンテナ（`--phase=A-initial`）を実行し、
   `host.docker.internal` 経由でそのdevサーバーに対し実Chromiumで一連の操作
   （コールドスタート確認 → テーブル作成・Save → 外部編集・Reload）を行い、
   ホスト側の一時ディレクトリを直接bind mountして書き込まれたファイル内容も検証する。
4. devサーバーを停止し、同じ（now-populatedな）ファイルに対して**新しいプロセスとして**
   再度 `spawnVite()` を呼び出す。
5. `sql-viz-acceptance-check` コンテナ（`--phase=A-restart`）を実行し、再起動時の
   サイレント自動ロードを検証する。
6. devサーバーを停止し、同じ（restartフェーズが読み込んだ）スキーマファイルに対して、
   `mode: 'verify'` かつ一時ディレクトリ配下の `verify-saves/` を `saveDir` とする
   **新しいプロセス**として再度 `spawnVite()` を呼び出す（Issue #32）。
7. `sql-viz-acceptance-check` コンテナ（`--phase=A-verify`、`--save-dir=/workspace/
   verify-saves`）を実行し、検証モードでの読み込みは通常通り行われること・Save が
   対象ファイルを変更せず `saveDir` へ別名保存されること・`POST /api/schema` への
   直接アクセスが403で拒否されることを検証する。
8. devサーバーを停止し、一時ディレクトリを削除。

最終的に `{"phase": "A", "scenarios": [...], "ok": true}` 形式のJSONを標準出力に出し、
`ok` が `false` の場合は非ゼロで終了する。

## 使い方（Phase B: キャンバスのパン・ズーム、Issue #17）

```bash
# イメージビルドまでは Phase A と同じ
node tools/acceptance-check/orchestrate-phase-b.mjs
```

`orchestrate-phase-b.mjs` は Phase A より単純で、devサーバーを1つだけ起動する：

1. `os.tmpdir()` 配下の使い捨てディレクトリに
   `fixtures/phaseB-panzoom-schema.sql`（Playwrightのビューポートより大きな
   ワールドボックスになるよう十数個の `CREATE TABLE` を含む）をコピーする。
2. そのファイルを指す実の `sql-studio` dev サーバーを `spawnVite()` で起動
   （アプリが起動時サイレント自動ロードでキャンバスを描く）。
3. `sql-viz-acceptance-check` コンテナ（`--phase=B-panzoom`）を実行し、実Chromiumで
   ホイールズーム・空白ドラッグによるパン・Fitボタンを操作して、`Canvas.tsx` が
   公開する `data-*` 属性（`data-canvas-scale` / `-pan-x` / `-pan-y` /
   `data-world-w` / `-world-h`）でpass/failを判定する。検証項目は
   「初期表示が全テーブルにフィット（scale<1）」「ホイールで拡大」
   「Fitボタンで初期倍率へ復帰」「ドラッグでパンしテキスト選択は誤発火しない」
   「限界までパンしてもテーブル群が画面外に出ない（`limitToBounds`）」。
4. devサーバーを停止し、一時ディレクトリを削除。`{"phase": "B", ..., "ok": bool}` を出力。

## 使い方（Phase B: テーブルのドラッグ移動、Issue #34）

```bash
# イメージビルドまでは Phase A と同じ
node tools/acceptance-check/orchestrate-phase-b-drag.mjs
```

`orchestrate-phase-b-drag.mjs` は `orchestrate-phase-b.mjs` と同じ構造：

1. `os.tmpdir()` 配下の使い捨てディレクトリに
   `fixtures/phaseB-drag-schema.sql`（`t0`/`t1`の2テーブルのみ。初期フィットが
   ちょうど scale=1 になるサイズに意図的に抑えてあり、シナリオ側でスクリーン
   px のドラッグ量とワールド座標のdx/dyが一致する）をコピーする。
2. そのファイルを指す実の `sql-studio` dev サーバーを `spawnVite()` で起動。
3. `sql-viz-acceptance-check` コンテナ（`--phase=B-drag`）を実行し、実Chromiumで
   `TableNode.tsx` が公開する `data-testid="table-drag-handle"`
   （ヘッダー限定のドラッグハンドル）を実ポインタ操作で掴んで移動し、
   `data-testid="table-node"` の `data-x`/`data-y` でpass/failを判定する。
   検証項目は「ドラッグでテーブルが移動し、離した後も位置が保持される
   （スナップバックしない）」「テーブルのドラッグ中はキャンバス全体の
   パン・ズーム（`data-canvas-scale`/`-pan-x`/`-pan-y`）が一切動かない
   （ヘッダーの`onPointerDown`が`stopPropagation`でreact-zoom-pan-pinch側の
   リスナーに伝播させないことの確認）」「ドラッグ後に別のCREATE TABLEを
   実行しても位置が保持され（`layoutTables()`による上書きがない）、かつ
   新規テーブルがドラッグ済みテーブルと重ならない位置に生成される
   （衝突回避パスの確認）」。
4. devサーバーを停止し、一時ディレクトリを削除。`{"phase": "B-drag", ..., "ok": bool}` を出力。

## `run.mjs`（コンテナ側エントリポイント）のCLIオプション

`orchestrate-phase-a.mjs` から内部的に呼ばれるが、単体でも実行できる。

| オプション | 既定値 | 説明 |
|---|---|---|
| `--phase` | なし（必須） | 実行するシナリオモジュール名（`scenarios/phase<value>.mjs`）。現状 `A-initial` / `A-restart` / `A-verify` / `B-panzoom` / `B-drag` |
| `--url` | なし（必須） | 対象のsql-studio dev serverのURL |
| `--schema` | なし（必須） | コンテナ内から見えるスキーマファイルのパス（bind mount先、例: `/workspace/schema.sql`） |
| `--save-dir` | なし | `A-verify` 専用。検証モードの別名保存先（bind mount先、例: `/workspace/verify-saves`） |
| `--out` | なし | JSON結果を標準出力に加えてファイルにも書き出す場合のパス |
| `--timeout` | `15000` | 各操作のタイムアウト（ミリ秒） |

## バージョン管理上の注意

`package.json` の `playwright` バージョンと `Dockerfile` のベースイメージタグ
（`v<version>-noble`）は必ず一致させること（visual-checkと同じ注意）。

## 今後の拡張

- Phase B は `#17`（パン・ズーム + Fit、`scenarios/phaseB-panzoom.mjs`）と
  `#34`（テーブルのドラッグ移動、`scenarios/phaseB-drag.mjs`）の両方が実装済み。
  `#34`本体の未決事項（ALTER ADD/DROP COLUMNによる手動配置済みテーブルの
  リサイズ時に再配置が必要か）は、Issue本文の通り実装後の使用感確認まで
  意図的に据え置いており、`phaseB-drag.mjs`はこのケースを検証しない。
- Phase A自体（`#27`/`#31`/`#32`/`#33`）が実装されたら、`orchestrate-phase-a.mjs` の
  `spawnVite()` 直接呼び出しは、`#31` で追加される Docker 化された sql-studio
  （`docker run ... sql-studio /workspace/schema.sql`）への差し替えを検討する
  （詳細は [docs/alpha-phase-acceptance-criteria.md](../../docs/alpha-phase-acceptance-criteria.md)）。
