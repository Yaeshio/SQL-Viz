import { SAMPLE } from './constants/sampleSql';
import { useSqlRunner } from './hooks/useSqlRunner';
import AppHeader from './components/layout/AppHeader';
import CanvasPane from './components/layout/CanvasPane';
import SqlEditorPane from './components/sql-editor/SqlEditorPane';

export default function App() {
  const {
    sql,
    setSql,
    log,
    error,
    playing,
    state,
    tableCount,
    rowCount,
    appearingRows,
    filteringRows,
    highlight,
    canvasRef,
    run,
    reset,
  } = useSqlRunner(SAMPLE);

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
      <AppHeader tableCount={tableCount} rowCount={rowCount} onReset={reset} />

      <div className="flex-1 flex min-h-0">
        <SqlEditorPane
          sql={sql}
          onSqlChange={setSql}
          error={error}
          playing={playing}
          onRun={run}
          log={log}
        />
        <CanvasPane
          canvasRef={canvasRef}
          tableCount={tableCount}
          state={state}
          appearingRows={appearingRows}
          filteringRows={filteringRows}
          highlight={highlight}
        />
      </div>
    </div>
  );
}
