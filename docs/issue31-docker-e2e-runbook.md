# Issue #31 — sql-studio Docker イメージ E2E 検証手順書

> この手順書は **CLI 版 Claude Code（または人間）がそのまま順に実行できる**ことを
> 目的に書かれている。各ステップは独立して pass/fail 判定でき、末尾の
> 「結果記録テンプレート」に実際の出力を貼り付けて 1 回の検証を完結させる。
>
> 対象イメージ: `docker/sql-studio/Dockerfile`（[README](../docker/sql-studio/README.md)）。
> 関連: [docs/local-cli-sync-spec.md](./local-cli-sync-spec.md)、
> [docs/alpha-phase-acceptance-criteria.md](./alpha-phase-acceptance-criteria.md)
> フェーズA の #31 節。

## 前提

- このリポジトリの `.claude/settings.json` は `sudo` を恒久禁止している。root 権限が
  要る操作は行わない。Chromium 依存は公式 Playwright イメージ側に入っているため不要。
- Docker が使えること（`docker version` がクライアント/サーバー両方を表示）。
  WSL2 + Docker Desktop でも、Linux ネイティブ Docker Engine でも動く。
- sql-studio コンテナとシナリオコンテナは **ユーザー定義ネットワーク上でコンテナ名で
  通信**させる（`host.docker.internal` に依存しない）。
- リポジトリルートで `npm ci` 済み。

## 使う既存資産（無改修）

- `tools/acceptance-check/run.mjs` … シナリオコンテナのエントリポイント。
  `--phase` / `--url` / `--schema` / `--save-dir` を受ける。
- `tools/acceptance-check/scenarios/phaseA-initial.mjs` / `phaseA-restart.mjs` /
  `phaseA-verify.mjs` … 「到達可能な URL と bind mount されたパス」だけに依存する設計。
- `tools/acceptance-check/fixtures/make-e2e-target-repo.mjs` … 検証用リポジトリを
  決定論的に生成する（この手順書のためのフィクスチャ）。

各シナリオコンテナは最後の 1 行に `{"phase":"...","scenarios":[...],"ok":true|false}`
を stdout へ出し、`ok` が false のとき exit code 1。**pass 判定 = その JSON の `ok === true`。**

---

## 手順

`$REPO` はこのリポジトリのルート絶対パス。作業は `cd "$REPO"` から始める。
待機は `sleep` で十分（PGlite コールドスタートはシナリオコンテナ側が待つ）。

### 1. 前提チェック

```bash
docker version
id -u
test -d "$REPO/node_modules" && echo "npm ci: OK"
```

**pass**: `docker version` 成功、`id -u` が 0 以外（非 root。`--user` 検証のため）、
`node_modules` 存在。

### 2. sql-studio イメージのビルド

```bash
cd "$REPO"
docker build -f docker/sql-studio/Dockerfile -t sql-studio .
```

**pass**: exit 0、最終行が `naming to docker.io/library/sql-studio` 等。

エントリポイント疎通（引数なし → USAGE を stderr、exit 1）:

```bash
docker run --rm sql-studio; echo "exit=$?"
```

**pass**: `Usage: npm run sql-studio -- <path/to/schema.sql> ...` が出て `exit=1`。

### 3. acceptance-check イメージの準備

```bash
cd "$REPO/tools/acceptance-check" && npm install && cd "$REPO"
docker build -t sql-viz-acceptance-check tools/acceptance-check
```

**pass**: 両方 exit 0。

### 4. ネットワークと検証用リポジトリ（フィクスチャ）

```bash
docker network create sqlviz-e2e

E2E_ROOT="$(mktemp -d)"
E2EDIR="$E2E_ROOT/target-project"
node tools/acceptance-check/fixtures/make-e2e-target-repo.mjs "$E2EDIR"
```

スクリプト出力例:
```
SCHEMA_REL=db/schema.sql
DEST=/tmp/tmp.XXXXXX/target-project
```

```bash
test ! -e "$E2EDIR/db/schema.sql" && echo "schema absent: OK"
git -C "$E2EDIR" log --oneline
```

**pass**: `db/schema.sql` は**存在しない**（cold-start パス）/ commit がちょうど 1 個。

### 5. A-initial（cold start → CREATE + Save → 外部編集 + Reload）

```bash
docker run -d --name sqls-e2e --network sqlviz-e2e \
  -p 127.0.0.1:5173:5173 \
  -v "$E2EDIR":/workspace \
  --user "$(id -u):$(id -g)" \
  sql-studio /workspace/db/schema.sql
sleep 10

docker run --rm --network sqlviz-e2e \
  -v "$E2EDIR":/workspace \
  sql-viz-acceptance-check \
  --phase=A-initial \
  --url=http://sqls-e2e:5173 \
  --schema=/workspace/db/schema.sql
```

**pass**:
- 出力 JSON の `ok === true`（3 シナリオすべて pass）。
- bind mount 越しに書き込まれたファイルの所有者がホストユーザー:
  ```bash
  stat -c '%U:%u' "$E2EDIR/db/schema.sql"
  test "$(stat -c '%u' "$E2EDIR/db/schema.sql")" = "$(id -u)" && echo "owner: OK"
  ```
- 起動バナーに改修提案ワークフロー仕様書の URL が出ている:
  ```bash
  docker logs sqls-e2e 2>&1 | grep -F 'agent-proposal-workflow-spec.md' && echo "banner: OK"
  ```

```bash
docker rm -f sqls-e2e
```

### 6. A-restart（プロセス再起動時のサイレント自動ロード）

手順 5 が `products` テーブルを書き込んだ**同じファイル**に対し、**新しいコンテナ**で:

```bash
docker run -d --name sqls-e2e --network sqlviz-e2e -p 127.0.0.1:5173:5173 \
  -v "$E2EDIR":/workspace --user "$(id -u):$(id -g)" \
  sql-studio /workspace/db/schema.sql
sleep 10

docker run --rm --network sqlviz-e2e -v "$E2EDIR":/workspace \
  sql-viz-acceptance-check \
  --phase=A-restart --url=http://sqls-e2e:5173 --schema=/workspace/db/schema.sql

docker rm -f sqls-e2e
```

**pass**: JSON `ok === true`（キャンバスに `products` 復元、実行ログは空のまま）。

### 7. A-verify（Issue #32、検証モード）

```bash
mkdir -p "$E2EDIR/verify-saves"

docker run -d --name sqls-e2e --network sqlviz-e2e -p 127.0.0.1:5173:5173 \
  -v "$E2EDIR":/workspace --user "$(id -u):$(id -g)" \
  sql-studio /workspace/db/schema.sql --mode=verify --save-dir=/workspace/verify-saves
sleep 10

docker run --rm --network sqlviz-e2e -v "$E2EDIR":/workspace \
  sql-viz-acceptance-check \
  --phase=A-verify --url=http://sqls-e2e:5173 \
  --schema=/workspace/db/schema.sql --save-dir=/workspace/verify-saves

docker rm -f sqls-e2e
```

**pass**: JSON `ok === true`（対象ファイル不変 / `verify-saves/` へ別名保存 /
`POST /api/schema` が 403）。加えて:

```bash
ls "$E2EDIR/verify-saves"   # → schema.<timestamp>.sql が 1 つ
```

起動ログに `検証モードで起動しました。別名保存の保存先: /workspace/verify-saves` が出る。

### 8. エージェント CLI/API 往復（ブラウザ非依存、ホストから公開ポート経由）

```bash
E2EDIR_CLI="$E2E_ROOT/target-cli"
node tools/acceptance-check/fixtures/make-e2e-target-repo.mjs "$E2EDIR_CLI"

docker run -d --name sqls-cli -p 127.0.0.1:5173:5173 \
  -v "$E2EDIR_CLI":/workspace --user "$(id -u):$(id -g)" \
  sql-studio /workspace/db/schema.sql
sleep 10

node -e "fetch('http://127.0.0.1:5173/api/query/health').then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))"
node scripts/query.mjs "CREATE TABLE t (id INT)" --url=http://127.0.0.1:5173; echo "exit=$?"
```

**pass**:
- health が `{"ready":true,"error":null}`。
- `query.mjs` の stdout が単独で `JSON.parse` 可能、`.results[0].error` が undefined、`exit=0`。

（`curl` を使える環境なら `curl -s http://127.0.0.1:5173/api/query/health` でも可。
このコンテナはこのまま手順 9 でも使う。）

### 9. LAN 到達不能性の実証

手順 8 のコンテナ（`-p 127.0.0.1:5173:5173`）:

```bash
docker inspect --format '{{json .NetworkSettings.Ports}}' sqls-cli
```

**pass**: `"5173/tcp"` の `HostIp` が `"127.0.0.1"`。

対比（**誤用** — `-p 5173:5173`）:

```bash
docker rm -f sqls-cli
docker run -d --name sqls-bad -p 5173:5173 -v "$E2EDIR_CLI":/workspace \
  --user "$(id -u):$(id -g)" sql-studio /workspace/db/schema.sql
docker inspect --format '{{json .NetworkSettings.Ports}}' sqls-bad
docker rm -f sqls-bad
```

**確認**: 誤用時は `HostIp` が `"0.0.0.0"`（LAN の他ホストから到達可能）になり、
README の警告（`-p 127.0.0.1:` を必ず付ける）の意味が実証される。

### 10. `--user` 無しでの所有者の違い

```bash
E2EDIR_ROOT="$E2E_ROOT/target-root"
node tools/acceptance-check/fixtures/make-e2e-target-repo.mjs "$E2EDIR_ROOT"

docker run -d --name sqls-root --network sqlviz-e2e -p 127.0.0.1:5173:5173 \
  -v "$E2EDIR_ROOT":/workspace \
  sql-studio /workspace/db/schema.sql            # ← --user を付けない
sleep 10

docker run --rm --network sqlviz-e2e -v "$E2EDIR_ROOT":/workspace \
  sql-viz-acceptance-check \
  --phase=A-initial --url=http://sqls-root:5173 --schema=/workspace/db/schema.sql

docker rm -f sqls-root
stat -c '%U:%u' "$E2EDIR_ROOT/db/schema.sql"
```

**確認**: `--user` 無しでは書き込まれたファイルが `root:0` 所有（手順 5 との対比）。
※ root 所有ファイルは後片付け（手順 12）で `sudo` 無しには消せない場合があるため、
`E2E_ROOT` を Docker 経由で消すか、この手順を最後に回してもよい。

### 11. 非 Docker 経路の回帰

```bash
E2EDIR_NAT="$E2E_ROOT/target-native"
node tools/acceptance-check/fixtures/make-e2e-target-repo.mjs "$E2EDIR_NAT"

nohup npm run sql-studio -- "$E2EDIR_NAT/db/schema.sql" > "$E2E_ROOT/native.log" 2>&1 &
NATIVE_PID=$!
sleep 10
grep -E 'Local:\s+http://127\.0\.0\.1:5173/' "$E2E_ROOT/native.log" && echo "127.0.0.1 bind: OK"
grep -F 'agent-proposal-workflow-spec.md' "$E2E_ROOT/native.log" && echo "banner: OK"
kill "$NATIVE_PID"
```

**pass**: 従来どおり `127.0.0.1:5173`（`0.0.0.0` ではない）にバインドして起動。
`SQL_STUDIO_HOST`/`SQL_STUDIO_CACHE_DIR` は環境に無いので既定挙動。

### 12. 後片付け

```bash
docker rm -f sqls-e2e sqls-cli sqls-bad sqls-root 2>/dev/null || true
docker network rm sqlviz-e2e 2>/dev/null || true
# root 所有ファイルが残る場合は Docker 経由で削除
docker run --rm -v "$E2E_ROOT":/x alpine rm -rf /x/target-root || true
rm -rf "$E2E_ROOT"
```

（`sql-studio` / `sql-viz-acceptance-check` イメージは次回のために残してよい。）

---

## 失敗時の切り分け

| 症状 | 原因の候補 / 対処 |
|---|---|
| 手順 2 の `npm ci` が `Missing: esbuild@… from lock file` (`EUSAGE`) で失敗 | ベースイメージの npm が古い。`docker/sql-studio/Dockerfile` は `node:24-slim`（npm 11 系）である前提。改変していないか確認。 |
| `docker logs` に `EACCES ... vite.config.ts.timestamp-*.mjs` | `--user` 実行時に Vite が設定ファイルを esbuild でバンドルする一時ファイルを `/app` に書けない。Dockerfile の `RUN chmod 777 /app` が効いているか確認（イメージ再ビルド）。 |
| `docker logs` に `EACCES ... node_modules/.vite` | `SQL_STUDIO_CACHE_DIR` が効いていない。`docker run` に余計な `-e SQL_STUDIO_CACHE_DIR=` を渡していないか、イメージが最新か確認。 |
| シナリオコンテナが `net::ERR_CONNECTION_REFUSED` / タイムアウト | sql-studio がまだ listen していない → `sleep` を増やす。両コンテナが同じ `--network sqlviz-e2e` 上にあり、`--url` のホスト名が sql-studio コンテナの `--name` と一致しているか確認。 |
| `docker logs` に `Blocked request. This host (...) is not allowed.` | `package-lock.json` の `vite` が 5.4.12+ に上がりホストチェックが有効化された。`scripts/openLocal.mjs` の `spawnVite` inline config に `server.allowedHosts`（Docker 経路のみ許可）を足す。 |
| A-verify で `verify-saves/` が空 | `--save-dir` のコンテナ内パスと bind mount 先が食い違っている。両コンテナとも `-v "$E2EDIR":/workspace`、パスは `/workspace/verify-saves`。 |
| ポート 5173 が使用中 | 別プロセス（`npm run dev` 等）を止める。コンテナ内で Vite が 5174 にずれると `-p ...:5173` が合わなくなる。 |
| `node scripts/query.mjs "SELECT 1"` が `Unsupported clause: JOIN` | パーサの既知の制限（`FROM` 無し `SELECT` 非対応）。Docker とは無関係。`CREATE TABLE ...` 等で往復を確認する。 |

---

## 結果記録テンプレート

検証日: `YYYY-MM-DD` / 実施者: / コミット: `git rev-parse --short HEAD` /
Docker: `docker version --format '{{.Server.Version}}'`

| # | ステップ | pass/fail | 備考・出力の要点 |
|---|---|---|---|
| 1 | 前提チェック | | |
| 2 | sql-studio ビルド + エントリ疎通 | | |
| 3 | acceptance-check ビルド | | |
| 4 | ネットワーク + フィクスチャ（schema 不在確認） | | |
| 5 | A-initial（`ok:true` / owner=host / banner） | | |
| 6 | A-restart（`ok:true`） | | |
| 7 | A-verify（`ok:true` / 別名保存 1 件） | | |
| 8 | query CLI/API 往復（exit 0 / ready） | | |
| 9 | `-p 127.0.0.1:` → HostIp 127.0.0.1（誤用時 0.0.0.0） | | |
| 10 | `--user` 無し → owner root:0 | | |
| 11 | 非 Docker 経路の回帰（127.0.0.1 bind / banner） | | |
| 12 | 後片付け | | |

総合判定: **PASS / FAIL**

---

## 検証記録

検証日: `2026-08-28` / 実施者: Claude Code (Yaeshio) / コミット: `31225f8` /
Docker: `29.2.1`（Docker Desktop 4.62.0, Engine 29.2.1）

| # | ステップ | pass/fail | 備考・出力の要点 |
|---|---|---|---|
| 1 | 前提チェック | pass | `docker version` クライアント/サーバー表示、`id -u`=1000（非 root）、`node_modules` 存在 |
| 2 | sql-studio ビルド + エントリ疎通 | pass | build exit 0、`naming to docker.io/library/sql-studio:latest`。引数なし実行で `Usage: npm run sql-studio -- <path/to/schema.sql> ...` を stderr、`exit=1` |
| 3 | acceptance-check ビルド | pass | `npm install` exit 0、`docker build -t sql-viz-acceptance-check` exit 0（`naming to ...sql-viz-acceptance-check:latest`） |
| 4 | ネットワーク + フィクスチャ（schema 不在確認） | pass | `docker network create sqlviz-e2e` 成功、`SCHEMA_REL=db/schema.sql`、`db/schema.sql` 不在、commit ちょうど 1 個（`54a8008 fixture: E2E target project`） |
| 5 | A-initial（`ok:true` / owner=host / banner） | pass | JSON `ok:true`（3 シナリオ全 pass）、`stat`=`yrn-dock:1000`（`owner: OK`）、起動ログに `agent-proposal-workflow-spec.md` の URL（`banner: OK`） |
| 6 | A-restart（`ok:true`） | pass | JSON `ok:true`。`restart-silently-autoloads-populated-schema-file` = table restored silently, no log entry written |
| 7 | A-verify（`ok:true` / 別名保存 1 件） | pass | JSON `ok:true`（3 シナリオ全 pass：silent autoload / saveDir へ別名保存・対象ファイル不変 / 直接 POST は 403）。`verify-saves/` に `schema.2026-08-28T09-39-22.sql` が 1 つ。起動ログに `検証モードで起動しました。別名保存の保存先: /workspace/verify-saves` |
| 8 | query CLI/API 往復（exit 0 / ready） | pass | health = `{"ready":true,"error":null}`。`query.mjs "CREATE TABLE t (id INT)"` の stdout が単独で JSON parse 可能、`.results[0].error` undefined、`exit=0` |
| 9 | `-p 127.0.0.1:` → HostIp 127.0.0.1（誤用時 0.0.0.0） | pass | 正規 `sqls-cli`: `5173/tcp` の `HostIp`=`127.0.0.1`。誤用 `-p 5173:5173` の `sqls-bad`: `HostIp`=`0.0.0.0`（および `::`）= LAN 到達可能、README 警告が実証される |
| 10 | `--user` 無し → owner root:0 | pass | `--user` 省略で A-initial `ok:true`、書き込まれた `db/schema.sql` の `stat`=`root:0`（手順 5 の `yrn-dock:1000` と対比） |
| 11 | 非 Docker 経路の回帰（127.0.0.1 bind / banner） | pass | `npm run sql-studio` が `http://127.0.0.1:5173/`（`0.0.0.0` 無し）にバインド、バナーに `agent-proposal-workflow-spec.md` の URL |
| 12 | 後片付け | pass | コンテナ 4 種・ネットワーク `sqlviz-e2e` 削除、root 所有フィクスチャは Docker 経由で削除、`E2E_ROOT` 削除、ポート 5173 解放。イメージ `sql-studio` / `sql-viz-acceptance-check` は次回用に保持 |

総合判定: **PASS**

備考:
- 手順 5 実行時、前セッションの野良 `node scripts/openLocal.mjs`（別セッションのスクラッチパッドを指す、`/init` に里子化）がポート 5173 を掴んでいて `docker run -p 127.0.0.1:5173:5173` が
  `ports are not available` で失敗した。当該プロセスを kill して解消（Docker イメージ自体の問題ではない。切り分け表「ポート 5173 が使用中」に該当）。
- 手順 11 では `npm run sql-studio` の子プロセス（`node scripts/openLocal.mjs`）が親（`npm`）の kill 後も残存しポート 5173 を掴み続けたため、明示的に kill した。手順書の
  `kill "$NATIVE_PID"` は npm ラッパーのみを対象にしている点に注意。
