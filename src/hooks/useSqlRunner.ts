import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { PGlite } from '@electric-sql/pglite';
import type { AppMode, DBState } from '../types';
import { emptyState } from '../reducer';
import { diffStates } from '../diff';
import { WORLD_W } from '../layout';
import { PgEngine } from '../pglite/engine';
import { useAnimationPlayer } from './useAnimationPlayer';
import type { AnimationHighlight } from './useAnimationPlayer';

// 現在の DBState を保持するだけの reducer
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

export interface RunOptions {
  /** 現在のエディタ内容の代わりに実行する SQL。エディタの `sql` state も
   * 置き換えるため、エディタとキャンバスがずれることはない。 */
  sql?: string;
  /** 起動時の自動ロード向けに実行ログを抑制する（「No statements run yet.」への
   * リセットも、文ごとのログ行も出さない）——アニメーションは通常どおり再生される。
   * エラーは抑制しない。 */
  silent?: boolean;
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
  run: (options?: RunOptions) => Promise<void>;
  reset: () => void;
  getDb: () => PGlite | null;
  /** ドラッグを確定する（Issue #34）: PgEngine.setTablePosition() 経由で
   * テーブルを与えられたワールド座標で manuallyPositioned にマークし（位置が
   * 次の run() を生き延びるように）、アニメーション/差分を介さず即座に state を
   * 更新する——位置の変更はそれ自体が視覚的フィードバックになる。 */
  moveTable: (name: string, x: number, y: number) => void;
}

/** SQL エディタの入力・DBState・実行ログ/エラー/playing フラグを所有し、
 * PgEngine.run() + useAnimationPlayer() を通じて
 * パース→実行(PGlite)→レイアウト→差分→アニメーション のパイプラインを駆動する。
 * PGlite（WASM にコンパイルされた本物の PostgreSQL）がデータ/型の挙動に関する
 * 唯一の情報源で、DBState はそこからレイアウト/差分/アニメーション用に導出された
 * スナップショットにすぎない。`mode` は design/experiment の許可リストを強制する
 * ため毎回の PgEngine.run() 呼び出しへ転送され、experiment→design の遷移は
 * 下の effect 経由で PgEngine.returnToDesign()（experiment モードのデータ変更を
 * ロールバックする）を発火させる。 */
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
  const engineRef = useRef<PgEngine>();
  if (!engineRef.current) engineRef.current = new PgEngine();
  const stateRef = useRef(state);
  stateRef.current = state;
  const prevModeRef = useRef(mode);

  const pushLog = useCallback((line: string) => setLog((l) => [...l, line]), []);

  // experiment モードから design モードへ戻ると、experiment モードで行った
  // データ変更（INSERT/UPDATE/DELETE）をすべて破棄する: engine.returnToDesign()
  // が背後の Postgres トランザクションをロールバックし、その結果の差分は通常の
  // アニメーションとして再生される（既存の row_remove/row_update イベントが
  // 「挿入を取り消す」/「更新を取り消す」を視覚的にすでにカバーしている）。
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

  const run = useCallback(
    async (options?: RunOptions) => {
      setError(null);
      const engine = engineRef.current!;
      const silent = options?.silent ?? false;
      const effectiveSql = options?.sql ?? sql;
      if (options?.sql !== undefined) setSql(options.sql);

      if (!engine.isReady()) {
        setInitializing(true);
        try {
          await engine.ensureReady();
        } finally {
          setInitializing(false);
        }
      }

      const { results, parseError } = await engine.run(effectiveSql, WORLD_W, mode);
      if (parseError) {
        setError(parseError);
        return;
      }
      if (results.length === 0) {
        setError('No executable statements found.');
        return;
      }

      setPlaying(true);
      if (!silent) setLog([]);
      resetAnimation();

      for (const r of results) {
        if (r.error) {
          setError(r.error);
          setPlaying(false);
          return;
        }
        if (!silent) pushLog(r.label);
        dispatch({ type: 'set', state: r.state });
        await playEvents(r.events);
      }
      setPlaying(false);
    },
    [sql, mode, pushLog, playEvents, resetAnimation],
  );

  const reset = useCallback(() => {
    engineRef.current?.reset();
    dispatch({ type: 'reset' });
    setLog([]);
    setError(null);
    resetAnimation();
  }, [resetAnimation]);

  const tableCount = state.order.length;
  const rowCount = useMemo(() => state.order.reduce((n, t) => n + state.tables[t].rows.length, 0), [state]);

  const getDb = useCallback(() => engineRef.current?.getDb() ?? null, []);

  const moveTable = useCallback((name: string, x: number, y: number) => {
    const next = engineRef.current!.setTablePosition(name, x, y);
    dispatch({ type: 'set', state: next });
  }, []);

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
    run,
    reset,
    getDb,
    moveTable,
  };
}
