import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { DBState } from '../types';
import { emptyState } from '../reducer';
import { PgEngine } from '../pglite/engine';
import { useAnimationPlayer } from './useAnimationPlayer';
import type { AnimationHighlight } from './useAnimationPlayer';

// reducer that just holds the current DBState
type Action = { type: 'set'; state: DBState } | { type: 'reset' };
function reducer(state: DBState, action: Action): DBState {
  switch (action.type) {
    case 'set':
      return action.state;
    case 'reset':
      return emptyState();
    default:
      return state;
  }
}

export interface UseSqlRunnerResult {
  sql: string;
  setSql: (value: string) => void;
  log: string[];
  error: string | null;
  playing: boolean;
  initializing: boolean;
  state: DBState;
  tableCount: number;
  rowCount: number;
  appearingRows: Set<string>;
  filteringRows: Set<string>;
  highlight: AnimationHighlight | null;
  canvasRef: RefObject<HTMLDivElement>;
  run: () => Promise<void>;
  reset: () => void;
}

/** Owns SQL editor input, DBState, execution log/error/playing flags, and
 * drives the parse→execute(PGlite)→layout→diff→animate pipeline via
 * PgEngine.run() + useAnimationPlayer(). PGlite (real PostgreSQL compiled to
 * WASM) is the single source of truth for data/type behavior; DBState is only
 * a snapshot derived from it for layout/diff/animation. */
export function useSqlRunner(initialSql: string): UseSqlRunnerResult {
  const [sql, setSql] = useState(initialSql);
  const [state, dispatch] = useReducer(reducer, undefined, emptyState);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const { appearingRows, filteringRows, highlight, playEvents, resetAnimation } = useAnimationPlayer();
  const canvasRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PgEngine>();
  if (!engineRef.current) engineRef.current = new PgEngine();

  const pushLog = useCallback((line: string) => setLog((l) => [...l, line]), []);

  const run = useCallback(async () => {
    setError(null);
    const engine = engineRef.current!;

    if (!engine.isReady()) {
      setInitializing(true);
      try {
        await engine.ensureReady();
      } finally {
        setInitializing(false);
      }
    }

    const { results, parseError } = await engine.run(sql, canvasRef.current?.clientWidth ?? 800);
    if (parseError) {
      setError(parseError);
      return;
    }
    if (results.length === 0) {
      setError('No executable statements found.');
      return;
    }

    setPlaying(true);
    setLog([]);
    resetAnimation();

    for (const r of results) {
      if (r.error) {
        setError(r.error);
        setPlaying(false);
        return;
      }
      pushLog(r.label);
      dispatch({ type: 'set', state: r.state });
      await playEvents(r.events);
    }
    setPlaying(false);
  }, [sql, pushLog, playEvents, resetAnimation]);

  const reset = useCallback(() => {
    engineRef.current?.reset();
    dispatch({ type: 'reset' });
    setLog([]);
    setError(null);
    resetAnimation();
  }, [resetAnimation]);

  const tableCount = state.order.length;
  const rowCount = useMemo(() => state.order.reduce((n, t) => n + state.tables[t].rows.length, 0), [state]);

  return {
    sql,
    setSql,
    log,
    error,
    playing,
    initializing,
    state,
    tableCount,
    rowCount,
    appearingRows,
    filteringRows,
    highlight,
    canvasRef,
    run,
    reset,
  };
}
