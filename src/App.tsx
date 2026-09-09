import { useEffect, useRef } from 'react';
import { SAMPLE } from './constants/sampleSql';
import { useAppMode } from './hooks/useAppMode';
import { useSqlRunner } from './hooks/useSqlRunner';
import { useLocalSync } from './hooks/useLocalSync';
import { fetchSchema } from './local/localSync';
import { generateDdl } from './pglite/ddlExport';
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
    run,
    reset,
    getDb,
    moveTable,
  } = useSqlRunner(SAMPLE, mode);

  const localSync = useLocalSync();
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  // 起動時のサイレント自動ロード（Issue #26 Phase 5）: ローカル CLI モードでは、
  // CLI が指している DDL を取得し、実行ログに触れずに design モードで再生する。
  // ファイルが無い場合（fetchSchema が '' で解決）や fetch 失敗は、どちらも
  // 通常の空キャンバス起動へフォールバックする。
  useEffect(() => {
    if (!localSync.isLocal) return;
    let cancelled = false;
    (async () => {
      try {
        const content = await fetchSchema();
        if (!cancelled && content.trim()) {
          await runRef.current({ sql: content, silent: true });
        }
      } catch {
        // 握りつぶす: 起動時ロードの失敗は空キャンバス状態へ縮退する
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [localSync.isLocal]);

  const handleReset = () => {
    reset();
    setMode('design');
  };

  const verifyMode = localSync.startupMode === 'verify';

  const handleSave = async () => {
    const db = getDb();
    if (!db) return;
    const ddl = await generateDdl(db, state.order);
    if (verifyMode) {
      await localSync.verifySave(ddl);
    } else {
      await localSync.save(ddl);
    }
  };

  const handleReload = async () => {
    const content = await localSync.reload();
    if (content !== null) await run({ sql: content });
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
        localSync={{
          isLocal: localSync.isLocal,
          verifyMode,
          saveStatus: localSync.saveStatus,
          reloadStatus: localSync.reloadStatus,
          saveDisabled: mode !== 'design' || state.order.length === 0,
          onSave: handleSave,
          onReload: handleReload,
        }}
      />

      <div className="flex-1 flex min-h-0">
        <SqlEditorPane
          sql={sql}
          onSqlChange={setSql}
          error={error}
          playing={playing}
          initializing={initializing}
          modeTransitioning={modeTransitioning}
          onRun={() => run()}
          log={log}
        />
        <CanvasPane
          tableCount={tableCount}
          state={state}
          appearingRows={appearingRows}
          filteringRows={filteringRows}
          updatingRows={updatingRows}
          appearingColumns={appearingColumns}
          highlight={highlight}
          onMoveTable={moveTable}
        />
      </div>
    </div>
  );
}
