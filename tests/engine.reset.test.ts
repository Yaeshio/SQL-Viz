import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryOptions } from '@electric-sql/pglite';
import { PgEngine } from '../src/pglite/engine';
import { emptyState } from '../src/reducer';

const CANVAS_W = 800;

let engine: PgEngine;

beforeEach(() => {
  engine = new PgEngine();
});

// 各テストのPGliteインスタンスを解放する（Issue #71。解放しないと1個あたり約190MB残留する）。
afterEach(() => engine.close());

/**
 * 現行インスタンスへ `pattern` に一致する SQL が送られたら、その応答を呼び出し元
 * （run()/returnToDesign()）へ返す前に engine.close() を呼ぶ。「その文の実行中に
 * Reset された」状況を、タイミングに頼らず決定的に作るためのもの。
 */
async function closeOnQuery(target: PgEngine, pattern: RegExp) {
  await target.ensureReady();
  const db = target.getDb()!;
  const query = db.query.bind(db);
  /** このインスタンスへ送られた SQL（送られた順）。 */
  const sent: string[] = [];
  let closing: Promise<void> | null = null;
  let markFired!: () => void;
  /** close() を呼んだ時点で解決する（close() の完了は待たない）。 */
  const fired = new Promise<void>((resolve) => {
    markFired = resolve;
  });
  vi.spyOn(db, 'query').mockImplementation(async <T,>(sql: string, params?: unknown[], options?: QueryOptions) => {
    sent.push(sql);
    const result = await query<T>(sql, params, options);
    if (!closing && pattern.test(sql)) {
      closing = target.close();
      markFired();
    }
    return result;
  });
  return {
    db,
    sent,
    fired,
    /** close() の完了（旧インスタンスの解放）を待つ。 */
    closed: () => closing!,
  };
}

describe('PgEngine — 実行中の Reset による打ち切り (Issue #73)', () => {
  it('ENGINE-ABORT-01: コールドスタート中に reset() すると、run() は新しいインスタンスを起動し直さずに打ち切られる', async () => {
    const running = engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');
    engine.reset();

    expect(await running).toEqual({ results: [], aborted: true });
    expect(engine.isReady()).toBe(false);
    expect(engine.getState()).toEqual(emptyState());

    const retry = await engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');
    expect(retry.results[0].error).toBeUndefined();
    expect(engine.getState().order).toEqual(['users']);
  });

  it('ENGINE-ABORT-02: 複数文の実行中に reset() すると、残りの文を送らず、Reset 前の状態を書き戻さない', async () => {
    const trap = await closeOnQuery(engine, /CREATE TABLE a\b/);

    const result = await engine.run('CREATE TABLE a (id INT); CREATE TABLE b (id INT);', CANVAS_W, 'design');
    expect(result).toEqual({ results: [], aborted: true });
    expect(engine.getState()).toEqual(emptyState());
    expect(trap.sent.some((sql) => /CREATE TABLE b\b/.test(sql))).toBe(false);

    await trap.closed();
    expect(trap.db.closed).toBe(true);

    const retry = await engine.run('CREATE TABLE a (id INT)', CANVAS_W, 'design');
    expect(retry.results[0].error).toBeUndefined();
    expect(engine.getState().order).toEqual(['a']);
  });

  it('ENGINE-ABORT-03: experiment の BEGIN 実行中に reset() しても、開いたトランザクションを新しい世代へ持ち越さない', async () => {
    await engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');
    const trap = await closeOnQuery(engine, /^BEGIN$/);

    const result = await engine.run('INSERT INTO users (id) VALUES (1)', CANVAS_W, 'experiment');
    expect(result).toEqual({ results: [], aborted: true });
    expect(await engine.returnToDesign()).toBeNull();
    await trap.closed();

    // 新しい世代では BEGIN からやり直し、experiment のデータ変更が通常どおり巻き戻る
    await engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');
    const inserted = await engine.run('INSERT INTO users (id) VALUES (1)', CANVAS_W, 'experiment');
    expect(inserted.results[0].error).toBeUndefined();
    const restored = await engine.returnToDesign();
    expect(restored?.tables.users.rows).toEqual([]);
  });

  it('ENGINE-ABORT-04: INSERT のスナップショット取得中に reset() しても、新しい世代の行 id の採番に影響しない', async () => {
    await engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');
    const trap = await closeOnQuery(engine, /^SELECT ctid::text AS __ctid, /);

    const result = await engine.run('INSERT INTO users (id) VALUES (1), (2), (3)', CANVAS_W, 'experiment');
    expect(result).toEqual({ results: [], aborted: true });
    await trap.closed();

    await engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');
    const { results } = await engine.run('INSERT INTO users (id) VALUES (10)', CANVAS_W, 'experiment');
    expect(results[0].error).toBeUndefined();
    expect(results[0].state.tables.users.rows.map((r) => r.id)).toEqual(['r0']);
  });

  it('ENGINE-ABORT-05: returnToDesign() の ROLLBACK 中に reset() すると、null を返し Reset 前の checkpoint を書き戻さない', async () => {
    await engine.run('CREATE TABLE users (id INT)', CANVAS_W, 'design');
    await engine.run('INSERT INTO users (id) VALUES (1)', CANVAS_W, 'experiment');
    const trap = await closeOnQuery(engine, /^ROLLBACK$/);

    expect(await engine.returnToDesign()).toBeNull();
    expect(engine.getState()).toEqual(emptyState());
    await trap.closed();
    expect(await engine.returnToDesign()).toBeNull();
  });

  it('ENGINE-ABORT-06: Reset 前に始めた run() は、Reset 後に始めた run() の結果を上書きしない', async () => {
    const trap = await closeOnQuery(engine, /CREATE TABLE a\b/);

    const before = engine.run('CREATE TABLE a (id INT); CREATE TABLE b (id INT);', CANVAS_W, 'design');
    await trap.fired;
    const after = engine.run('CREATE TABLE c (id INT)', CANVAS_W, 'design');

    const [beforeResult, afterResult] = await Promise.all([before, after]);
    expect(beforeResult).toEqual({ results: [], aborted: true });
    expect(afterResult.results[0].error).toBeUndefined();
    expect(engine.getState().order).toEqual(['c']);
  });
});
