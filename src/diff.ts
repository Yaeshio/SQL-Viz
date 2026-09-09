import type { AnimationEvent, DBState } from './types';

/**
 * 変更前後の DBState を比較し、順序付きのアニメーションイベント列を生成する。
 * 順序: テーブルの出現 → テーブルの削除 → テーブルごと（next.order 順）の
 * カラム追加/削除・行追加/削除・行の値更新・フィルタ変化 → SELECT ハイライト。
 */
export function diffStates(old: DBState, next: DBState): AnimationEvent[] {
  const events: AnimationEvent[] = [];

  // 1. 出現したテーブル
  for (const name of next.order) {
    if (!old.tables[name]) {
      events.push({ kind: 'table_appear', table: name });
    }
  }

  // 2. 削除されたテーブル（next.order からは辿れないので old.order を走査する）
  for (const name of old.order) {
    if (!next.tables[name]) {
      events.push({ kind: 'table_remove', table: name });
    }
  }

  // 3. テーブルごとのカラム変化 + 行の追加/削除/更新 + フィルタ変化
  for (const name of next.order) {
    const nt = next.tables[name];
    const ot = old.tables[name];
    if (!ot) {
      // まったく新しいテーブル: その全行が「追加」扱い
      nt.rows.forEach((r, i) => events.push({ kind: 'row_add', table: name, rowId: r.id, index: i }));
      continue;
    }

    // カラムの追加/削除（名前で比較）
    const oldColNames = new Set(ot.columns.map((c) => c.name));
    const newColNames = new Set(nt.columns.map((c) => c.name));
    nt.columns.forEach((c) => {
      if (!oldColNames.has(c.name)) events.push({ kind: 'column_add', table: name, column: c.name });
    });
    ot.columns.forEach((c) => {
      if (!newColNames.has(c.name)) events.push({ kind: 'column_drop', table: name, column: c.name });
    });

    // 追加: next には在るが old には無い行（id で照合）
    const oldIds = new Set(ot.rows.map((r) => r.id));
    const newIds = new Set(nt.rows.map((r) => r.id));
    nt.rows.forEach((r, i) => {
      if (!oldIds.has(r.id)) events.push({ kind: 'row_add', table: name, rowId: r.id, index: i });
    });

    // 削除: old には在るが next には無い行（id で照合）
    ot.rows.forEach((r) => {
      if (!newIds.has(r.id)) events.push({ kind: 'row_remove', table: name, rowId: r.id });
    });

    const oldById = new Map(ot.rows.map((r) => [r.id, r]));

    // 値の更新: old と new の両方の values に存在するキーだけを比較する。
    // そのため、既存行に対する ALTER TABLE 自身の NULL 埋め（ADD COLUMN）や
    // キー削除（DROP COLUMN）が row_update として誤報告されない。
    nt.rows.forEach((r) => {
      const o = oldById.get(r.id);
      if (!o) return;
      const sharedKeys = Object.keys(o.values).filter((k) => k in r.values);
      const changed = sharedKeys.some((k) => o.values[k] !== r.values[k]);
      if (changed) events.push({ kind: 'row_update', table: name, rowId: r.id });
    });

    // フィルタの変化
    nt.rows.forEach((r) => {
      const o = oldById.get(r.id);
      if (!o) return;
      if (!o.filteredOut && r.filteredOut) events.push({ kind: 'row_filter', table: name, rowId: r.id });
      if (o.filteredOut && !r.filteredOut) events.push({ kind: 'row_unfilter', table: name, rowId: r.id });
    });
  }

  // 4. SELECT ハイライト
  if (next.lastSelect) {
    events.push({
      kind: 'select_highlight',
      table: next.lastSelect.table,
      columns: next.lastSelect.columns,
    });
  }

  return events;
}
