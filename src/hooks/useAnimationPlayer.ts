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

/** カラムの同一性はテーブル内でのみ一意なので、appearingColumns はカラム名
 * 単独ではなく table+column をキーにする。 */
export function columnKey(table: string, column: string): string {
  return `${table}::${column}`;
}

/** 行/カラムの appear・filter・update・highlight の state を所有し、
 * AnimationEvent[] のタイムラインを setTimeout で刻まれた delay とともにそれに
 * 対して再生する。
 *
 * table_remove/row_remove/column_drop は自前の state を必要としない: playEvents が
 * 走る時点で、削除された項目はすでに DBState から消えており（dispatch は
 * playEvents より前に起きる）、framer-motion の AnimatePresence がアンマウント時の
 * 退場トランジションを自動で発火する。これらのケースは、後続のイベント（または
 * 次の文の dispatch）が進む前に退場トランジションが終わる時間を確保するために
 * delay を await するだけ。
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
    // highlight は保持する。一時的な set 群は少し置いてからクリアする
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
