import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { AppMode, DBState } from '../types';
import { emptyState } from '../reducer';
import { diffStates } from '../diff';
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
  modeTransitioning: boolean;
  state: DBState;
  tableCount: number;
  rowCount: number;
  appearingRows: Set<string>;
  filteringRows: Set<string>;
  updatingRows: Set<string>;
  appearingColumns: Set<string>;
  highlight: AnimationHighlight | null;
  canvasRef: RefObject<HTMLDivElement>;
  run: () => Promise<void>;
  reset: () => void;
}

/** Owns SQL editor input, DBState, execution log/error/playing flags, and
 * drives the parse→execute(PGlite)→layout→diff→animate pipeline via
 * PgEngine.run() + useAnimationPlayer(). PGlite (real PostgreSQL compiled to
 * WASM) is the single source of truth for data/type behavior; DBState is only
 * a snapshot derived from it for layout/diff/animation. `mode` is forwarded
 * to every PgEngine.run() call to enforce the design/experiment allowlist,
 * and an experiment→design transition triggers PgEngine.returnToDesign()
 * (rolling back experiment-mode data changes) via the effect below. */
export function useSqlRunner(initialSql: string, mode: AppMode): UseSqlRunnerResult {
  const [sql, setSql] = useState(initialSql);
  const [state, dispatch] = useReducer(reducer, undefined, emptyState);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [modeTransitioning, setModeTransitioning] = useState(false);
  const { appearingRows, filteringRows, updatingRows, appearingColumns, highlight, playEvents, resetAnimation } =
    useAnimationPlayer();
  const canvasRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PgEngine>();
  if (!engineRef.current) engineRef.current = new PgEngine();
  const stateRef = useRef(state);
  stateRef.current = state;
  const prevModeRef = useRef(mode);

  const pushLog = useCallback((line: string) => setLog((l) => [...l, line]), []);

  // Returning from experiment to design mode discards every data change
  // (INSERT/UPDATE/DELETE) made in experiment mode: engine.returnToDesign()
  // rolls back the underlying Postgres transaction, and the resulting diff
  // is played as a normal animation (existing row_remove/row_update events
  // already cover "undo an insert" / "undo an update" visually).
  useEffect(() => {
    const prevMode = prevModeRef.current;
    prevModeRef.current = mode;
    if (prevMode !== 'experiment' || mode !== 'design') return;

    let cancelled = false;
    (async () => {
      setModeTransitioning(true);
      try {
        const restored = await engineRef.current!.returnToDesign();
        if (restored && !cancelled) {
          const events = diffStates(stateRef.current, restored);
          dispatch({ type: 'set', state: restored });
          await playEvents(events);
        }
      } finally {
        if (!cancelled) setModeTransitioning(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mode, playEvents]);

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

    const { results, parseError } = await engine.run(sql, canvasRef.current?.clientWidth ?? 800, mode);
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
  }, [sql, mode, pushLog, playEvents, resetAnimation]);

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
    modeTransitioning,
    state,
    tableCount,
    rowCount,
    appearingRows,
    filteringRows,
    updatingRows,
    appearingColumns,
    highlight,
    canvasRef,
    run,
    reset,
  };
}
