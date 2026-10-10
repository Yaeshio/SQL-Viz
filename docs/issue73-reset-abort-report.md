# Issue #73 検証報告（一時ファイル）

> **本ドキュメントは 2026-10-10 に実施した Issue #73（コールドスタート中に Reset を押しても
> 実行中の Run が打ち切られない問題）の検証記録であり、恒久的な仕様書ではない。レビュー後は
> 削除して差し支えない。**

## 方針

Issue の修正方針の候補のうち、案1（世代による打ち切り）と案2（Reset ボタンの無効化）を
両方採った。Reset は全テーブル・実験データを消す副作用の大きい操作なので、処理中は押せなく
する。世代による打ち切りは、エンジンの正しさ（完了条件・回帰テスト）と、ボタン操作以外から
`run()` が始まる経路への予防として残した。Reset の確認モーダルなど、Reset 操作の UX 改善は
別 Issue で扱う。

そのため、Issue の完了条件の「読込中に Reset → Reset 後のキャンバスが空のまま残る」は、
「読込中は Reset を押せない（押そうとしても何も起きない）」に置き換わる。

## 対応内容（段階ごとに1コミット）

- **段階1（7c0cd7a）**: `PgEngine` の Reset で初期化する状態（`ctidMaps`/`rowSeq`/`lastState`/
  `inExperimentTx`/`designCheckpoint`）を世代オブジェクトにまとめ、`close()` で丸ごと差し替える。
  `run()`/`returnToDesign()` は開始時の世代にだけ書き込み、`await` から戻ったときに世代が
  変わっていれば打ち切る。`run()` は `{ results: [], aborted: true }` を返し、新しいインスタンスを
  起動し直さない（`readyDb()` のループを削除）。
- **段階2（9ba5b98）**: `playing || initializing || modeTransitioning` の間は Reset ボタンを
  押せなくする（`title` に「処理中はリセットできません」）。あわせて `playing` を `run()` の冒頭で
  立てて `finally` で下ろすようにした。これまではエンジン起動済みのとき、SQL 実行中
  （`engine.run()` の待ち）にどのフラグも立たず、Run・Reset・モード切替が押せた。
- **段階3（6505414）**: `useSqlRunner` に `generationRef`、`useAnimationPlayer` に epoch を
  持たせ、Reset 前に始めた `run()`・モード復帰・アニメーション再生を打ち切る（予防）。
- **段階4（29965ae）**: CLAUDE.md に記載した。

## 回帰テスト（`tests/engine.reset.test.ts`）

`engine.test.ts` には追記せず新ファイルに置いた。「〜の最中に Reset」は、`db.query` を
`vi.spyOn` で包み、指定した SQL の応答を返す前に `engine.close()` を呼んで決定的に作る。

| ID | シナリオ | 修正前（段階1の前） |
|---|---|---|
| ENGINE-ABORT-01 | コールドスタート中に reset() | 新しいインスタンスを起動し直して全文完走した |
| ENGINE-ABORT-02 | 複数文 CREATE の1文目の実行時に reset() | 2文目も旧インスタンスで実行し、全文完走した |
| ENGINE-ABORT-03 | experiment の BEGIN 実行時に reset() | 打ち切られず完走した |
| ENGINE-ABORT-04 | INSERT のスナップショット取得時に reset() | 打ち切られず完走した |
| ENGINE-ABORT-05 | returnToDesign() の ROLLBACK 時に reset() | `TypeError: Cannot destructure property 'ctidMaps' of 'this.designCheckpoint' as it is null` で落ちた |
| ENGINE-ABORT-06 | Reset 前の run と Reset 後の run を両方 await | 打ち切られず完走した |

修正前は6件すべて失敗し、段階1の後は6件すべて成功した。ローカルの `npm test` 全体は
16ファイル・327件すべて成功した。`npm run typecheck` / `npm run lint` / `npm run build` も成功した。

## 実ブラウザ（2026-10-10、ブランチ先頭 29965ae）

`tools/visual-check/` の Docker イメージ（Playwright 1.61.1 / Chromium）で、スクラッチの
Playwright スクリプトを `--entrypoint node` で実行した（`tools/visual-check/` 自体は無改修）。
対象は `npm run dev`。Run ボタンの表示・disabled、Reset とモード切替の disabled、ヘッダーの
tables/rows を 50ms ごとに記録し、処理中に Reset を `click({ force: true })` で押そうとした
（disabled のボタンにも座標クリックを送る。クリックの直前・直後とも Reset が disabled だった
ことも記録した）。

2回実行し、2回とも53項目すべて成功した。

- A. 読込直後に Run → 読込中に Reset を押そうとする: Reset は効かず、テーブルが1つ作られ、
  エラーは出ない。
- B. エンジン起動済みで5文の CREATE を Run → 実行・再生中に Reset を押そうとする: Reset は
  効かず、テーブルが6つになる。「エンジン読込中…」は出ない。
- C. experiment で6行 INSERT → design へ戻す → 「モード切替中…」の間に Reset を押そうとする:
  Reset は効かず、ROLLBACK で0行、テーブル6つのまま design に戻る。
- A〜C を通して、disabled の Reset に `click` イベントは1度も届いていない（capture 段階の
  リスナーで確認）。
- A〜C と E1 のすべてで、処理中は Reset とモード切替が常に disabled、Reset の `title` が表示され、
  処理の途中で「Run SQL」（押せる）に戻らない。処理が終わると Run・Reset とも押せる。
- D. 処理が終わった後の Reset は従来どおり動く（キャンバスが空、design、エラーなし）。
- E. 回帰（#71 のシナリオ相当）: Reset 後の Run で再びコールドスタートし、同じ CREATE が
  `already exists` にならない。パースエラー・モード違反（design の SELECT）はエラーが表示され、
  ボタンは「Run SQL」に戻り Reset も押せる。エラー後の CREATE は成功する。
- console には、#71 の報告にもある `react-zoom-pan-pinch` の `` `ref` is not a prop `` の
  警告以外は出ない。

ボタン表示の遷移（2回目の実行）:

```
A（読込直後に Run、読込中に Reset を押そうとした）
     11ms  エンジン読込中…(disabled) | reset:disabled | modeToggle:disabled | tables=0 rows=0
   4998ms  Running…(disabled)        | reset:disabled | modeToggle:disabled | tables=1 rows=0
   5470ms  Run SQL                   | reset:enabled  | modeToggle:enabled  | tables=1 rows=0

B（起動済みで5文の CREATE、実行・再生中に Reset を押そうとした）
      2ms  Running…(disabled) | reset:disabled | modeToggle:disabled | tables=2 rows=0
    512ms  Running…(disabled) | reset:disabled | modeToggle:disabled | tables=3 rows=0
   1054ms  Running…(disabled) | reset:disabled | modeToggle:disabled | tables=4 rows=0
   1614ms  Running…(disabled) | reset:disabled | modeToggle:disabled | tables=5 rows=0
   2085ms  Running…(disabled) | reset:disabled | modeToggle:disabled | tables=6 rows=0
   2605ms  Run SQL            | reset:enabled  | modeToggle:enabled  | tables=6 rows=0

C（experiment → design、モード切替中に Reset を押そうとした）
      2ms  モード切替中…(disabled) | reset:disabled | modeToggle:disabled | tables=6 rows=0
   1904ms  Run SQL                 | reset:enabled  | modeToggle:enabled  | tables=6 rows=0
```

Issue に記録された修正前の遷移は「エンジン読込中…(disabled) → Run SQL → Run SQL(disabled) →
Running…(disabled) → Run SQL」で、Reset の後に読込中の表示が消えて Run が押せる状態があった。
修正後は「エンジン読込中…(disabled) → Running…(disabled) → Run SQL」で、途中で押せる状態に
ならない。

**画面から確認できないもの** — 段階3（フック側の打ち切り）は、処理中は Reset を押せないため
画面からは起こせない。エンジン側は上記の回帰テストで確認しており、フック側はコードで担保して
いる（React フックのテスト基盤は未導入）。

## 補足

- 検証スクリプトの初版では C が1項目失敗した（モード切替の後にテーブル数が0になった）。
  原因はスクリプト側で、force クリックの前に撮っていたスクリーンショットに1秒以上かかり、
  その間にモード切替が終わって Reset が押せる状態に戻っていたため、遅れて届いたクリックが
  正規の Reset として実行されていた。クリックを先に送り、直前・直後とも Reset が disabled
  だったことを確認するよう直した後は、上記のとおり成功している。C だけを force クリック
  あり・なしで別に実行した場合も、どちらもテーブルは残り、Reset に `click` は届かなかった。
- 対象外とした既存の挙動: ローカルCLIモードの Reload ボタンは処理中も押せるため、Reset とは
  別経路で `run()` が重なりうる。また、`run()` の最中にテーブルをドラッグすると、`run()` の完了時に
  位置が上書きされうる。どちらも本 Issue では手を入れていない。
