import { useState } from 'react';
import { SAMPLE } from './constants/sampleSql';
import { useAppMode } from './hooks/useAppMode';
import { useSqlRunner } from './hooks/useSqlRunner';
import { useGitHubSettings } from './hooks/useGitHubSettings';
import AppHeader from './components/layout/AppHeader';
import CanvasPane from './components/layout/CanvasPane';
import SqlEditorPane from './components/sql-editor/SqlEditorPane';
import GitHubSettingsPanel from './components/github/GitHubSettingsPanel';

export default function App() {
  const { mode, setMode } = useAppMode();
  const { settings, setSettings } = useGitHubSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
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
    getDb,
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
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <GitHubSettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSettingsChange={setSettings}
        mode={mode}
        order={state.order}
        getDb={getDb}
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
