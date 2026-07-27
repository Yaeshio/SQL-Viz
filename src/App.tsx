import { SAMPLE } from './constants/sampleSql';
import { useAppMode } from './hooks/useAppMode';
import { useSqlRunner } from './hooks/useSqlRunner';
import AppHeader from './components/layout/AppHeader';
import CanvasPane from './components/layout/CanvasPane';
import SqlEditorPane from './components/sql-editor/SqlEditorPane';

export default function App() {
  const { mode, setMode } = useAppMode();
  const {
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
  } = useSqlRunner(SAMPLE, mode);

  const handleReset = () => {
    reset();
    setMode('design');
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
      <AppHeader
        tableCount={tableCount}
        rowCount={rowCount}
        mode={mode}
        onModeChange={setMode}
        modeDisabled={playing || initializing || modeTransitioning}
        onReset={handleReset}
      />

      <div className="flex-1 flex min-h-0">
        <SqlEditorPane
          sql={sql}
          onSqlChange={setSql}
          error={error}
          playing={playing}
          initializing={initializing}
          modeTransitioning={modeTransitioning}
          onRun={run}
          log={log}
        />
        <CanvasPane
          canvasRef={canvasRef}
          tableCount={tableCount}
          state={state}
          appearingRows={appearingRows}
          filteringRows={filteringRows}
          updatingRows={updatingRows}
          appearingColumns={appearingColumns}
          highlight={highlight}
        />
      </div>
    </div>
  );
}
