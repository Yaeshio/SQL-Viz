import type { AnimationEvent, DBState } from './types';

/**
 * Compare old and new DBState and produce an ordered list of animation events.
 * Order: table appearances, then table removals, then per table (in next.order)
 * column additions/removals, row additions/removals, row value updates, filter
 * changes, then select highlight.
 */
export function diffStates(old: DBState, next: DBState): AnimationEvent[] {
  const events: AnimationEvent[] = [];

  // 1. Tables that appeared
  for (const name of next.order) {
    if (!old.tables[name]) {
      events.push({ kind: 'table_appear', table: name });
    }
  }

  // 2. Tables that were removed (not visitable via next.order, so scan old.order)
  for (const name of old.order) {
    if (!next.tables[name]) {
      events.push({ kind: 'table_remove', table: name });
    }
  }

  // 3. Column changes + row additions/removals/updates + filter changes per table
  for (const name of next.order) {
    const nt = next.tables[name];
    const ot = old.tables[name];
    if (!ot) {
      // brand new table: all its rows are "added"
      nt.rows.forEach((r, i) => events.push({ kind: 'row_add', table: name, rowId: r.id, index: i }));
      continue;
    }

    // column additions/removals (compared by name)
    const oldColNames = new Set(ot.columns.map((c) => c.name));
    const newColNames = new Set(nt.columns.map((c) => c.name));
    nt.columns.forEach((c) => {
      if (!oldColNames.has(c.name)) events.push({ kind: 'column_add', table: name, column: c.name });
    });
    ot.columns.forEach((c) => {
      if (!newColNames.has(c.name)) events.push({ kind: 'column_drop', table: name, column: c.name });
    });

    // additions: rows present in next but not in old (matched by id)
    const oldIds = new Set(ot.rows.map((r) => r.id));
    const newIds = new Set(nt.rows.map((r) => r.id));
    nt.rows.forEach((r, i) => {
      if (!oldIds.has(r.id)) events.push({ kind: 'row_add', table: name, rowId: r.id, index: i });
    });

    // removals: rows present in old but not in next (matched by id)
    ot.rows.forEach((r) => {
      if (!newIds.has(r.id)) events.push({ kind: 'row_remove', table: name, rowId: r.id });
    });

    const oldById = new Map(ot.rows.map((r) => [r.id, r]));

    // value updates: compare only keys present in both old and new values, so
    // an ALTER TABLE's own NULL-fill (ADD COLUMN) or key removal (DROP COLUMN)
    // on existing rows isn't itself misreported as a row_update.
    nt.rows.forEach((r) => {
      const o = oldById.get(r.id);
      if (!o) return;
      const sharedKeys = Object.keys(o.values).filter((k) => k in r.values);
      const changed = sharedKeys.some((k) => o.values[k] !== r.values[k]);
      if (changed) events.push({ kind: 'row_update', table: name, rowId: r.id });
    });

    // filter changes
    nt.rows.forEach((r) => {
      const o = oldById.get(r.id);
      if (!o) return;
      if (!o.filteredOut && r.filteredOut) events.push({ kind: 'row_filter', table: name, rowId: r.id });
      if (o.filteredOut && !r.filteredOut) events.push({ kind: 'row_unfilter', table: name, rowId: r.id });
    });
  }

  // 4. Select highlight
  if (next.lastSelect) {
    events.push({
      kind: 'select_highlight',
      table: next.lastSelect.table,
      columns: next.lastSelect.columns,
    });
  }

  return events;
}
