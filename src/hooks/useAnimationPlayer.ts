import { useCallback, useState } from 'react';
import type { AnimationEvent } from '../types';

export interface AnimationHighlight {
  table: string;
  columns: string[];
}

export interface UseAnimationPlayerResult {
  appearingRows: Set<string>;
  filteringRows: Set<string>;
  updatingRows: Set<string>;
  appearingColumns: Set<string>;
  highlight: AnimationHighlight | null;
  playEvents: (events: AnimationEvent[]) => Promise<void>;
  resetAnimation: () => void;
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Column identity is only unique within a table, so appearingColumns keys
 * on table+column rather than column name alone. */
export function columnKey(table: string, column: string): string {
  return `${table}::${column}`;
}

/** Owns the row/column-appear/filter/update/highlight state and plays an
 * AnimationEvent[] timeline against it via setTimeout-paced delays.
 *
 * table_remove/row_remove/column_drop need no state of their own: by the time
 * playEvents runs, the removed item is already absent from DBState (dispatch
 * happens before playEvents), so framer-motion's AnimatePresence fires the
 * exit transition on unmount automatically. These cases only await a delay
 * so that exit transition has time to finish before subsequent events (or
 * the next statement's dispatch) proceed.
 */
export function useAnimationPlayer(): UseAnimationPlayerResult {
  const [appearingRows, setAppearingRows] = useState<Set<string>>(new Set());
  const [filteringRows, setFilteringRows] = useState<Set<string>>(new Set());
  const [updatingRows, setUpdatingRows] = useState<Set<string>>(new Set());
  const [appearingColumns, setAppearingColumns] = useState<Set<string>>(new Set());
  const [highlight, setHighlight] = useState<AnimationHighlight | null>(null);

  const playEvents = useCallback(async (events: AnimationEvent[]) => {
    const appearing = new Set<string>();
    const filtering = new Set<string>();
    const updating = new Set<string>();
    const appearingCols = new Set<string>();
    for (const ev of events) {
      switch (ev.kind) {
        case 'table_appear':
          await delay(120);
          break;
        case 'table_remove':
          await delay(300);
          break;
        case 'column_add':
          appearingCols.add(columnKey(ev.table, ev.column));
          setAppearingColumns(new Set(appearingCols));
          await delay(180);
          break;
        case 'column_drop':
          await delay(180);
          break;
        case 'row_add':
          appearing.add(ev.rowId);
          setAppearingRows(new Set(appearing));
          await delay(180);
          break;
        case 'row_remove':
          await delay(250);
          break;
        case 'row_update':
          updating.add(ev.rowId);
          setUpdatingRows(new Set(updating));
          await delay(300);
          break;
        case 'row_filter':
          filtering.add(ev.rowId);
          setFilteringRows(new Set(filtering));
          await delay(250);
          break;
        case 'row_unfilter':
          filtering.delete(ev.rowId);
          setFilteringRows(new Set(filtering));
          await delay(200);
          break;
        case 'select_highlight':
          setHighlight({ table: ev.table, columns: ev.columns });
          await delay(300);
          break;
      }
    }
    // keep highlight; clear transient sets after a beat
    await delay(400);
    setAppearingRows(new Set());
    setFilteringRows(new Set());
    setUpdatingRows(new Set());
    setAppearingColumns(new Set());
  }, []);

  const resetAnimation = useCallback(() => {
    setHighlight(null);
    setAppearingRows(new Set());
    setFilteringRows(new Set());
    setUpdatingRows(new Set());
    setAppearingColumns(new Set());
  }, []);

  return {
    appearingRows,
    filteringRows,
    updatingRows,
    appearingColumns,
    highlight,
    playEvents,
    resetAnimation,
  };
}
