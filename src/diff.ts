import type { AnimationEvent, DBState } from './types';

/**
 * Compare old and new DBState and produce an ordered list of animation events.
 * Order: table appearances first, then row additions, then filter changes,
 * then select highlight.
 */
export function diffStates(old: DBState, next: DBState): AnimationEvent[] {
  const events: AnimationEvent[] = [];

  // 1. Tables that appeared
  for (const name of next.order) {
    if (!old.tables[name]) {
      events.push({ kind: 'table_appear', table: name });
    }
  }

  // 2. Row additions + filter changes per table
  for (const name of next.order) {
    const nt = next.tables[name];
    const ot = old.tables[name];
    if (!ot) {
      // brand new table: all its rows are "added"
      nt.rows.forEach((r, i) => events.push({ kind: 'row_add', table: name, rowId: r.id, index: i }));
      continue;
    }
    // additions: rows present in next but not in old (matched by id)
    const oldIds = new Set(ot.rows.map((r) => r.id));
    nt.rows.forEach((r, i) => {
      if (!oldIds.has(r.id)) events.push({ kind: 'row_add', table: name, rowId: r.id, index: i });
    });
    // filter changes
    const oldById = new Map(ot.rows.map((r) => [r.id, r]));
    nt.rows.forEach((r) => {
      const o = oldById.get(r.id);
      if (!o) return;
      if (!o.filteredOut && r.filteredOut) events.push({ kind: 'row_filter', table: name, rowId: r.id });
      if (o.filteredOut && !r.filteredOut) events.push({ kind: 'row_unfilter', table: name, rowId: r.id });
    });
  }

  // 3. Select highlight
  if (next.lastSelect) {
    events.push({
      kind: 'select_highlight',
      table: next.lastSelect.table,
      columns: next.lastSelect.columns,
    });
  }

  return events;
}
