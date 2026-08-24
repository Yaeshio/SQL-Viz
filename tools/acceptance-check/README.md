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
6. devサーバーを停止し、一時ディレクトリを削除。

最終的に `{"phase": "A", "scenarios": [...], "ok": true}` 形式のJSONを標準出力に出し、
`ok` が `false` の場合は非ゼロで終了する。

## `run.mjs`（コンテナ側エントリポイント）のCLIオプション

`orchestrate-phase-a.mjs` から内部的に呼ばれるが、単体でも実行できる。

| オプション | 既定値 | 説明 |
|---|---|---|
| `--phase` | なし（必須） | 実行するシナリオモジュール名（`scenarios/phase<value>.mjs`）。現状 `A-initial` / `A-restart` |
| `--url` | なし（必須） | 対象のsql-studio dev serverのURL |
| `--schema` | なし（必須） | コンテナ内から見えるスキーマファイルのパス（bind mount先、例: `/workspace/schema.sql`） |
| `--out` | なし | JSON結果を標準出力に加えてファイルにも書き出す場合のパス |
| `--timeout` | `15000` | 各操作のタイムアウト（ミリ秒） |

## バージョン管理上の注意

`package.json` の `playwright` バージョンと `Dockerfile` のベースイメージタグ
（`v<version>-noble`）は必ず一致させること（visual-checkと同じ注意）。

## 今後の拡張

- Phase B（`#17`/`#34`、キャンバスのパン・ズーム・ドラッグ）向けの
  `scenarios/phaseB*.mjs` は、それらのissueの未決事項（UI仕様）が固まった後に追加する。
- Phase A自体（`#27`/`#31`/`#32`/`#33`）が実装されたら、`orchestrate-phase-a.mjs` の
  `spawnVite()` 直接呼び出しは、`#31` で追加される Docker 化された sql-studio
  （`docker run ... sql-studio /workspace/schema.sql`）への差し替えを検討する
  （詳細は [docs/alpha-phase-acceptance-criteria.md](../../docs/alpha-phase-acceptance-criteria.md)）。
