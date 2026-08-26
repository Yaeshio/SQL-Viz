# 改修提案ドキュメント作成ワークフロー仕様

このドキュメントは [Issue #33「改修提案・クエリ例ドキュメントを、
エージェントがローカルCLI環境で書き出すワークフローを整備する」]
(https://github.com/Yaeshio/SQL-Viz/issues/33) に基づき、AIコーディング
エージェントが「改修提案ドキュメント」（変更前後のスキーマ抜粋・検証に
使ったクエリ例をまとめた文書）を書き出す際の手順・テンプレートを定める
ものである。

新しいAPIエンドポイントやUI（Save相当のボタン等）は一切追加しない。
あくまでエージェント（人間が操作するAIコーディングエージェント）の裁量
による書き出しであり、SQL-Viz本体の永続化層（`src/local/`）は変更しない。

## 0. 実行環境についての前提

この文書は、読み手のエージェントが **SQL-Viz自身のリポジトリを
チェックアウトしていない環境**（例: 将来のDocker配布経由での利用、
Issue #31）で読む可能性を前提に書く。そのため、以下で説明する手順は
「対象プロジェクト側のファイル」と「起動中のsql-studioプロセス（CLI/API）」
だけで完結するものに限定し、SQL-Vizのソースコードへの直接アクセスは
前提としない。

この文書自体への恒久的な参照方法は、`npm run sql-studio`（および将来の
Docker版エントリポイント）の起動時にコンソールへ常に印字される、この
ページのGitHub URLである（3節参照）。

## 1. 目的とスコープ

現状、スキーマDDL本体（`schema/ddl.sql` 等）とは別に、変更前後のスキーマ
差分やクエリ例をまとめたドキュメントを永続化する経路が存在しない。

類似の要望は旧 [Issue #24](https://github.com/Yaeshio/SQL-Viz/issues/24)
（実験モードのSELECT結果昇格 → `query-examples.md` への**アプリによる**
自動プッシュ）として検討されたが、アプリのUI機能としての必要性が低いと
判断されクローズ済み（[docs/local-cli-sync-spec.md](./local-cli-sync-spec.md)
§6「対象外」）。

Issue #33はこれと異なり、**エージェント自身が変更前後のスキーマ抜粋・
クエリ例を自身のセッション内に保持し、指定されたドキュメントファイルへ
直接書き出す**という運用を、新規のアプリ機能を作らずに実現するための
ワークフロー整備である。前提となるのは以下2つの既存機能：

- [Issue #27](https://github.com/Yaeshio/SQL-Viz/issues/27) —
  エージェント向けSQL実行API/CLI（[docs/agent-query-api-spec.md](./agent-query-api-spec.md)）
- [Issue #32](https://github.com/Yaeshio/SQL-Viz/issues/32) —
  起動時`author`/`verify`モード選択

## 2. 前提知識（用語の整理）

本ワークフローで使う2つの「モード」は**別軸**であり、混同しないよう
注意する。

- **`author`/`verify`**（起動時モード、Issue #32、`npm run sql-studio --
  <path> --mode=author|verify`） — 対象スキーマ**ファイル**への書き込みを
  許可するかどうかを制御する。`verify`モードでは対象ファイルへの書き込みが
  一切行われない（多重防御）。
- **`design`/`experiment`**（`AppMode`、Issue #18、`node scripts/query.mjs
  "<SQL>" --mode=design|experiment`） — 実行できるSQL文の種類（DDL vs
  DML）を制御する、セッション内の実行権限ゲート。

本ワークフローでは、起動時モードは`verify`（対象ファイルを保護するため）、
クエリごとの`AppMode`は変更内容に応じて`design`（DDL）または`experiment`
（DML）を使う。

## 3. ワークフロー手順

1. 対象スキーマファイルに対し、次のように起動する（本体ファイルへの
   誤保存を防ぐため`verify`モードを使う）:

   ```bash
   npm run sql-studio -- <path/to/target/schema.sql> --mode=verify
   ```

   起動時のコンソール出力に、この仕様書へのURLが常に印字される
   （[scripts/openLocal.mjs](../scripts/openLocal.mjs)）。

2. `node scripts/query.mjs "<SQL>" --mode=design|experiment`
   （stdin対応。`npm run --silent query --`でも可、詳細は
   [docs/agent-query-api-spec.md](./agent-query-api-spec.md)）で
   提案したい変更を試行し、返ってくる`RunResult`のJSON
   （`{ results: StatementResult[], parseError? }`、各`StatementResult`は
   `{ label, state: DBState, events, error? }`）をエージェント自身の
   セッション内に保持する。

3. 変更前（初期状態）と変更後（試行後）それぞれの`DBState.tables`から、
   人間が読めるスキーマ抜粋（DDL相当の記述、または対象テーブルの
   カラム一覧）を整形する。

4. 検証に使ったクエリ文とその結果（成功/失敗、影響行数、エラー文言等の
   要点）を整理する。

5. 4節のテンプレートに沿ってMarkdownドキュメントを作成する。

6. 書き出し先を、その場でユーザーと相談して決定し、ファイルシステムへ
   **直接**（`Write`等、アプリのAPIを経由せずに）書き出す。

   - 固定の既定パスは定めない。SQL-Viz自身は「開発対象プロジェクトの
     スキーマ設計を可視化・検証するためのツール」であり、対象プロジェクト
     （`<path/to/target/schema.sql>`が属するリポジトリ）は起動のたびに
     異なるため、SQL-Viz自身の`docs/`のような固定の置き場所を規定すると
     かえって不自然になる。
   - 原則として、対象プロジェクト側（SQL-Viz自身のリポジトリではない）に
     置くことを推奨する。改修提案は対象プロジェクトの設計変更に関する
     記録であり、その対象プロジェクトの一部として残るのが自然なため。
   - この置き場所の決め方自体を毎回CLIオプションやGUI設定で自動化する
     機能は、今回は追加しない（5節「対象外・将来検討事項」参照）。

7. （任意）人間のレビューが完了したら、対象プロジェクト側の関連Issue/PRへ
   のリンクを追記する。

## 4. テンプレート

```markdown
# 改修提案: <タイトル>

## 背景・目的

<なぜこの変更を提案するか>

## 変更前スキーマ抜粋

\`\`\`sql
<DDL抜粋、または対象テーブルのカラム一覧>
\`\`\`

## 変更後スキーマ抜粋

\`\`\`sql
<DDL抜粋、または対象テーブルのカラム一覧>
\`\`\`

## 検証に使用したクエリ例

| クエリ | 結果概要 |
|---|---|
| `<SQL>` | <成功/失敗、影響行数、返り値の要点> |

## 影響・注意点

<既存データへの影響、破壊的変更の有無等>

## 関連Issue/PR

<リンク>
```

## 5. 対象外・将来検討事項

- 書き出し先の動的設定（新規CLIフラグ・GUI設定の追加）は現時点では
  実装しない。今回のワークフローは、エージェントが対象プロジェクトへの
  ファイル書き込み権限を元々持っていることを前提に、その場でユーザーと
  相談して決める運用とする。要望が増えれば、その時点で別Issueとして
  検討する。
- Issue #26（スキーマ本体の保存先、起動時オプションで固定）をGUIから
  動的に変更可能にする件も、同様に本Issueのスコープ外。要望があれば
  別Issueを起票する。
- 旧Issue #24の「アプリが自動でファイルへ書き込む」方式は、今回も
  引き続き採用しない。

## 6. 参照

- [Issue #33](https://github.com/Yaeshio/SQL-Viz/issues/33)
- [Issue #27](https://github.com/Yaeshio/SQL-Viz/issues/27) /
  [docs/agent-query-api-spec.md](./agent-query-api-spec.md)
- [Issue #32](https://github.com/Yaeshio/SQL-Viz/issues/32) /
  [docs/local-cli-sync-spec.md](./local-cli-sync-spec.md) §2.1
- [Issue #24](https://github.com/Yaeshio/SQL-Viz/issues/24)（旧方式、クローズ済み）
