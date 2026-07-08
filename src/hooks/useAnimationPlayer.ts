import { useCallback, useState } from 'react';
import type { AnimationEvent } from '../types';

export interface AnimationHighlight {
  table: string;
  columns: string[];
}

export interface UseAnimationPlayerResult {
  appearingRows: Set<string>;
  filteringRows: Set<string>;
  highlight: AnimationHighlight | null;
  playEvents: (events: AnimationEvent[]) => Promise<void>;
  resetAnimation: () => void;
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Owns the row-appear/filter/highlight state and plays an AnimationEvent[]
 * timeline against it via setTimeout-paced delays. */
export function useAnimationPlayer(): UseAnimationPlayerResult {
  const [appearingRows, setAppearingRows] = useState<Set<string>>(new Set());
  const [filteringRows, setFilteringRows] = useState<Set<string>>(new Set());
  const [highlight, setHighlight] = useState<AnimationHighlight | null>(null);

  const playEvents = useCallback(async (events: AnimationEvent[]) => {
    const appearing = new Set<string>();
    const filtering = new Set<string>();
    for (const ev of events) {
      switch (ev.kind) {
        case 'table_appear':
          await delay(120);
          break;
        case 'row_add':
          appearing.add(ev.rowId);
          setAppearingRows(new Set(appearing));
          await delay(180);
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
  }, []);

  const resetAnimation = useCallback(() => {
    setHighlight(null);
    setAppearingRows(new Set());
    setFilteringRows(new Set());
  }, []);

  return { appearingRows, filteringRows, highlight, playEvents, resetAnimation };
}
