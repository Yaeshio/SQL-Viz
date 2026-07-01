import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import { Play, Database, Terminal, Trash2, ChevronRight } from 'lucide-react';
import Canvas from './Canvas';
import { parseSql } from './parser';
import { diffStates } from './diff';
import { layoutTables } from './layout';
import type { AnimationEvent, DBState } from './types';
import {
  applyCreateTable,
  applyInsert,
  applySelect,
  cloneState,
  emptyState,
} from './reducer';

const SAMPLE = `CREATE TABLE users (id INT, name VARCHAR(50), email VARCHAR(120));

INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@db.dev');
INSERT INTO users (id, name, email) VALUES (2, 'Bob', 'bob@db.dev');
INSERT INTO users (id, name, email) VALUES (3, 'Carol', 'carol@db.dev');

SELECT name FROM users WHERE id > 1;`;

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

export default function App() {
  const [sql, setSql] = useState(SAMPLE);
  const [state, dispatch] = useReducer(reducer, undefined, emptyState);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [appearingRows, setAppearingRows] = useState<Set<string>>(new Set());
  const [filteringRows, setFilteringRows] = useState<Set<string>>(new Set());
  const [highlight, setHighlight] = useState<{ table: string; columns: string[] } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const pushLog = useCallback((line: string) => setLog((l) => [...l, line]), []);

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

  const run = useCallback(async () => {
    setError(null);
    const { statements, error: parseError } = parseSql(sql);
    if (parseError) {
      setError(parseError);
      return;
    }
    if (statements.length === 0) {
      setError('No executable statements found.');
      return;
    }

    setPlaying(true);
    setLog([]);
    setHighlight(null);
    setAppearingRows(new Set());
    setFilteringRows(new Set());

    let current = state;
    for (const stmt of statements) {
      let next: DBState;
      let label: string;
      if (stmt.type === 'create') {
        const res = applyCreateTable(current, stmt.table, stmt.columns);
        next = res.state;
        label = `CREATE TABLE ${stmt.table} (${stmt.columns.length} cols)`;
        if (res.error) {
          setError(res.error);
          setPlaying(false);
          return;
        }
      } else if (stmt.type === 'insert') {
        let res: { state: DBState; error?: string } = { state: current };
        for (const row of stmt.rows) {
          res = applyInsert(res.state, stmt.table, stmt.columns, row);
          if (res.error) break;
        }
        next = res.state;
        label = `INSERT INTO ${stmt.table} (${stmt.rows.length} row${stmt.rows.length > 1 ? 's' : ''})`;
        if (res.error) {
          setError(res.error);
          setPlaying(false);
          return;
        }
      } else {
        const res = applySelect(current, stmt.table, stmt.columns, stmt.where);
        next = res.state;
        const w = stmt.where ? ` WHERE ${stmt.where.column} ${stmt.where.operator} ${String(stmt.where.value)}` : '';
        label = `SELECT ${stmt.columns.join(', ')} FROM ${stmt.table}${w}`;
        if (res.error) {
          setError(res.error);
          setPlaying(false);
          return;
        }
      }

      // layout the next state using canvas width
      const w = canvasRef.current?.clientWidth ?? 800;
      next = layoutTables(cloneState(next), w);

      const events = diffStates(current, next);
      pushLog(label);
      dispatch({ type: 'set', state: next });
      await playEvents(events);
      current = next;
    }
    setPlaying(false);
  }, [sql, state, pushLog, playEvents]);

  const reset = useCallback(() => {
    dispatch({ type: 'reset' });
    setLog([]);
    setError(null);
    setHighlight(null);
    setAppearingRows(new Set());
    setFilteringRows(new Set());
  }, []);

  const tableCount = state.order.length;
  const rowCount = useMemo(() => state.order.reduce((n, t) => n + state.tables[t].rows.length, 0), [state]);

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
      {/* top bar */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-slate-900/60 backdrop-blur">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-sky-500/15 border border-sky-500/30 flex items-center justify-center">
            <Database size={18} className="text-sky-400" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight">SQL Visualizer</h1>
            <p className="text-[11px] text-slate-500 -mt-0.5">CREATE · INSERT · SELECT — animated</p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs text-slate-400">
          <span><span className="text-slate-500">tables</span> <span className="font-mono text-slate-200">{tableCount}</span></span>
          <span><span className="text-slate-500">rows</span> <span className="font-mono text-slate-200">{rowCount}</span></span>
          <button
            onClick={reset}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-700 hover:border-slate-500 hover:bg-slate-800 transition text-slate-300"
          >
            <Trash2 size={13} /> Reset
          </button>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* left: editor */}
        <section className="w-[420px] shrink-0 flex flex-col border-r border-slate-800 bg-slate-900/40">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-500">
            <Terminal size={13} /> SQL Editor
          </div>
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            spellCheck={false}
            className="flex-1 w-full resize-none bg-transparent text-slate-200 font-mono text-[13px] leading-relaxed p-4 outline-none placeholder:text-slate-600"
            placeholder="Type SQL here…"
          />
          {error && (
            <div className="mx-4 mb-2 px-3 py-2 rounded-md bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs font-mono">
              {error}
            </div>
          )}
          <div className="p-3 border-t border-slate-800 flex items-center gap-2">
            <button
              onClick={run}
              disabled={playing}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-semibold text-sm transition"
            >
              <Play size={15} /> {playing ? 'Running…' : 'Run SQL'}
            </button>
          </div>
          {/* log */}
          <div className="border-t border-slate-800 max-h-44 overflow-auto">
            <div className="px-4 py-2 text-[11px] uppercase tracking-wider text-slate-500 sticky top-0 bg-slate-900/80 backdrop-blur">Execution log</div>
            <div className="px-4 pb-3 space-y-1">
              {log.length === 0 && <p className="text-xs text-slate-600 font-mono">No statements run yet.</p>}
              {log.map((line, i) => (
                <div key={i} className="flex items-start gap-2 text-xs font-mono text-slate-400">
                  <ChevronRight size={13} className="mt-0.5 text-sky-500 shrink-0" />
                  <span>{line}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* right: canvas */}
        <section className="flex-1 min-w-0 relative bg-slate-950">
          <div className="absolute top-3 left-4 z-10 text-[11px] uppercase tracking-wider text-slate-500 pointer-events-none">
            Canvas
          </div>
          <div ref={canvasRef} className="absolute inset-0 overflow-auto">
            {tableCount === 0 ? (
              <div className="h-full w-full flex items-center justify-center text-slate-600 text-sm">
                Run a CREATE TABLE statement to begin.
              </div>
            ) : (
              <Canvas
                state={state}
                appearingRows={appearingRows}
                filteringRows={filteringRows}
                highlight={highlight}
              />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
