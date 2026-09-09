import type { PGlite } from '@electric-sql/pglite';
import type { AnimationEvent, AppMode, DBState, Row, WhereClause } from '../types';
import { parseSql, type Parsed } from '../parser.ts';
import { diffStates } from '../diff.ts';
import { layoutTables } from '../layout.ts';
import { cloneState, emptyState } from '../reducer.ts';
import { splitStatements } from './splitStatements.ts';

export interface StatementResult {
  label: string;
  state: DBState;
  events: AnimationEvent[];
  error?: string;
}

export interface RunResult {
  results: StatementResult[];
  parseError?: string;
}

/** mode-and-sql-scope-spec.md 2節の許可マトリクス。design/experimentは相互排他で、
 * 一方が構造(CREATE/ALTER/DROP)、他方がデータ(SELECT/INSERT/UPDATE/DELETE)を担う。 */
const MODE_ALLOWED_TYPES: Record<AppMode, ReadonlySet<Parsed['type']>> = {
  design: new Set(['create', 'alter', 'drop']),
  experiment: new Set(['select', 'insert', 'update', 'delete']),
};

interface DesignCheckpoint {
  ctidMaps: Map<string, Map<string, string>>;
  lastState: DBState;
  rowSeq: number;
}

/** experiment トランザクションが開いている間、各文を囲む固定の SAVEPOINT 名。
 * これにより失敗した 1 文はトランザクション全体を中断するのではなく、その文の
 * 直前まで戻る（Issue #36）。 */
const STMT_SAVEPOINT = 'sqlviz_stmt';

export function quoteIdent(name: string): string {
  return `"${name.toLowerCase().replace(/"/g, '""')}"`;
}

function normalizeValue(v: unknown): string | number | boolean | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v === undefined) return null;
  return v as string | number | boolean | null;
}

function formatPgError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function buildLabel(stmt: Parsed): string {
  if (stmt.type === 'create') {
    return `CREATE TABLE ${stmt.table} (${stmt.columns.length} cols)`;
  }
  if (stmt.type === 'insert') {
    return `INSERT INTO ${stmt.table} (${stmt.rows.length} row${stmt.rows.length > 1 ? 's' : ''})`;
  }
  if (stmt.type === 'alter') {
    return stmt.action === 'add'
      ? `ALTER TABLE ${stmt.table} ADD COLUMN ${stmt.column.name}`
      : `ALTER TABLE ${stmt.table} DROP COLUMN ${stmt.column}`;
  }
  if (stmt.type === 'drop') {
    return `DROP TABLE ${stmt.table}`;
  }
  if (stmt.type === 'update') {
    const w = stmt.where ? ` WHERE ${stmt.where.column} ${stmt.where.operator} ${String(stmt.where.value)}` : '';
    return `UPDATE ${stmt.table} SET ${stmt.set.map((s) => s.column).join(', ')}${w}`;
  }
  if (stmt.type === 'delete') {
    const w = stmt.where ? ` WHERE ${stmt.where.column} ${stmt.where.operator} ${String(stmt.where.value)}` : '';
    return `DELETE FROM ${stmt.table}${w}`;
  }
  const w = stmt.where ? ` WHERE ${stmt.where.column} ${stmt.where.operator} ${String(stmt.where.value)}` : '';
  return `SELECT ${stmt.columns.join(', ')} FROM ${stmt.table}${w}`;
}

/**
 * 実際の PGlite（WASM PostgreSQL）インスタンスを背後に持つ、状態を保持する実行
 * エンジン。受理された文はすべて実際に Postgres に対して実行されるため、型エラー・
 * 制約違反・WHERE 句の評価はすべて、手書きの JS 再実装ではなく本物の PostgreSQL の
 * 挙動を反映する。インスタンス自体が蓄積されたデータベース状態であり、DBState の
 * スナップショットは各文のあとに、レイアウト/差分/アニメーションを駆動する目的
 * だけのためにそこから導出される。
 */
export class PgEngine {
  private db: PGlite | null = null;
  private readyPromise: Promise<void> | null = null;
  private ctidMaps = new Map<string, Map<string, string>>();
  private rowSeq = 0;
  private lastState: DBState = emptyState();
  private inExperimentTx = false;
  private designCheckpoint: DesignCheckpoint | null = null;

  isReady(): boolean {
    return this.db !== null;
  }

  /** 読み取り専用のイントロスペクション（例: ddlExport.ts が information_schema を
   * クエリする）のために、背後の PGlite インスタンスを公開する。db 自体は
   * private のままで、外部からそこへ到達する唯一の正規手段がこれ。 */
  getDb(): PGlite | null {
    return this.db;
  }

  /** 最後に計算された DBState。GET /api/query/state（Issue #27）向けに読み取り
   * 専用で公開する——読むだけで、何も実行しない。 */
  getState(): DBState {
    return this.lastState;
  }

  /**
   * ユーザーのドラッグを記録する（Issue #34）: テーブルを与えられたワールド座標で
   * manuallyPositioned にマークし、その結果を `this.lastState`——次回の `run()` が
   * `current` として clone する内部スナップショット——へ書き込む。これがないと、
   * ドラッグはブラウザ自身の DBState コピーにしか届かず、次の文で layoutTables() に
   * 黙って捨てられてしまう。designCheckpoint が開いているときはその
   * `designCheckpoint.lastState` にも変更を反映する。そうすることで、後の
   * experiment→design の returnToDesign() ROLLBACK（データ変更のみを取り消す）が、
   * ドラッグを experiment モード開始時の位置へ戻してしまわないようにする。
   * テーブルが存在しない場合（例: ドラッグ中に drop された）は何もしない。
   */
  setTablePosition(name: string, x: number, y: number): DBState {
    if (!this.lastState.tables[name]) return this.lastState;
    const next = cloneState(this.lastState);
    next.tables[name] = { ...next.tables[name], x, y, manuallyPositioned: true };
    this.lastState = next;

    if (this.designCheckpoint?.lastState.tables[name]) {
      const checkpointState = this.designCheckpoint.lastState;
      this.designCheckpoint.lastState = {
        ...checkpointState,
        tables: {
          ...checkpointState.tables,
          [name]: { ...checkpointState.tables[name], x, y, manuallyPositioned: true },
        },
      };
    }

    return next;
  }

  ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        const { PGlite } = await import('@electric-sql/pglite');
        const db = new PGlite();
        await db.waitReady;
        this.db = db;
      })();
    }
    return this.readyPromise;
  }

  reset(): void {
    this.db = null;
    this.readyPromise = null;
    this.ctidMaps = new Map();
    this.rowSeq = 0;
    this.lastState = emptyState();
    this.inExperimentTx = false;
    this.designCheckpoint = null;
  }

  private newRowId(): string {
    return `r${(this.rowSeq++).toString(36)}`;
  }

  private cloneCtidMaps(): Map<string, Map<string, string>> {
    const copy = new Map<string, Map<string, string>>();
    for (const [table, inner] of this.ctidMaps) copy.set(table, new Map(inner));
    return copy;
  }

  /**
   * experiment モードに入って以降に行われたデータ変更（INSERT/UPDATE/DELETE）を
   * すべて取り消す。最初の experiment モードの文で開いたトランザクションを、素の
   * Postgres の ROLLBACK で巻き戻すことによる。構造を変える文は experiment モードでは
   * 決して許可されない（run() のモードゲート）ので、ここでの ROLLBACK がスキーマ
   * 変更を捨てることはあり得ない。前回の reset/init 以降 experiment モードに一度も
   * 入っていない（またはすでに復帰済み）の場合は何もしない。
   */
  async returnToDesign(): Promise<DBState | null> {
    if (!this.inExperimentTx || !this.designCheckpoint) return null;
    const db = this.db!;
    await db.query('ROLLBACK');
    const { ctidMaps, lastState, rowSeq } = this.designCheckpoint;
    this.ctidMaps = ctidMaps;
    this.lastState = lastState;
    this.rowSeq = rowSeq;
    this.inExperimentTx = false;
    this.designCheckpoint = null;
    return lastState;
  }

  /**
   * WHERE 句が一致する安定行 id の集合を、SELECT が使うのと同じ ctid ルックアップの
   * パターンで解決する。UPDATE/DELETE ではこれを生の文の実行前に呼ばなければ
   * ならない: Postgres は更新された行に新しい物理 ctid を割り当てるため、あとで
   * 照合すると、更新された行の安定 id を保つのではなく新規挿入された行として
   * 誤認識してしまう。null は「WHERE 句なし、全行が一致」を意味する
   * （SELECT の matchedIds と同じ）。
   */
  private async resolveMatchedIds(db: PGlite, table: string, where: WhereClause | null): Promise<Set<string> | null> {
    if (!where) return null;
    const ctidMap = this.ctidMaps.get(table) ?? new Map<string, string>();
    const { rows } = await db.query<{ __ctid: string }>(
      `SELECT ctid::text AS __ctid FROM ${quoteIdent(table)} WHERE ${quoteIdent(where.column)} ${where.operator} $1`,
      [where.value],
    );
    return new Set(rows.map((r) => ctidMap.get(String(r.__ctid))).filter((id): id is string => !!id));
  }

  async run(sql: string, worldWidth: number, mode: AppMode): Promise<RunResult> {
    await this.ensureReady();
    const db = this.db!;

    const rawStatements = splitStatements(sql);
    if (rawStatements.length === 0) return { results: [] };

    // 事前ゲート: どの文も実行する前に、全文を対応サブセットの許可リストに対して
    // 分類・検証する。従来の all-or-nothing な parseError の挙動と同じ。
    const parsed: { raw: string; stmt: Parsed }[] = [];
    for (const raw of rawStatements) {
      const { statements, error } = parseSql(raw);
      if (error) return { results: [], parseError: error };
      parsed.push({ raw, stmt: statements[0] });
    }

    // モードゲート: 上記の構文ゲートの上に載る、独立した 2 つ目の許可リスト
    // （mode-and-sql-scope-spec.md 2節）。all-or-nothing で、パースエラーと同じ形:
    // 1 文でも不許可の文種があればバッチ全体を手つかずで拒否する。
    const allowedTypes = MODE_ALLOWED_TYPES[mode];
    const disallowed = parsed.find(({ stmt }) => !allowedTypes.has(stmt.type));
    if (disallowed) {
      return {
        results: [],
        parseError: `Statement type "${disallowed.stmt.type}" is not allowed in ${mode} mode`,
      };
    }

    // experiment トランザクションは、モードトグル自体ではなく、実際に実行される
    // 最初の experiment モードの文で遅延的に開く。そのため、何も実行せずにモードを
    // 切り替えるだけなら何も起きない。experiment モードで行われるすべて（Run を
    // 何回押しても）は、returnToDesign() が巻き戻すまでこの 1 つの未コミット
    // トランザクションに蓄積される。
    if (mode === 'experiment' && !this.inExperimentTx) {
      this.designCheckpoint = {
        ctidMaps: this.cloneCtidMaps(),
        lastState: this.lastState,
        rowSeq: this.rowSeq,
      };
      await db.query('BEGIN');
      this.inExperimentTx = true;
    }

    const results: StatementResult[] = [];
    let current = this.lastState;

    // experiment トランザクションが開いている間は、各文を SAVEPOINT で囲み、
    // 失敗した文がその文の直前までしか巻き戻らないようにする。これがないと、
    // 1 つの Postgres エラーがトランザクション全体を中断し、そのトランザクションは
    // run() 呼び出しをまたいで開いたままなので、POST /api/query/reset まで以降の
    // すべてのリクエストが——どちらのモードでも——失敗する（Issue #36）。SAVEPOINT は
    // トランザクションブロック内でのみ有効なため inExperimentTx でガードする。
    // design モードの自動コミット文には不要。
    const useSavepoint = this.inExperimentTx;

    for (const { raw, stmt } of parsed) {
      const label = buildLabel(stmt);

      if (useSavepoint) await db.query(`SAVEPOINT ${STMT_SAVEPOINT}`);

      let next: DBState;
      try {
        // UPDATE/DELETE では、生の文が走る前に一致 id を解決する（Postgres は
        // 更新時に ctid を振り直す）——ここでの失敗もきれいに巻き戻るよう
        // SAVEPOINT の内側で行う。
        let matchedIds: Set<string> | null = null;
        if (stmt.type === 'update' || stmt.type === 'delete') {
          matchedIds = await this.resolveMatchedIds(db, stmt.table, stmt.where);
        }
        await db.query(raw);
        next = await this.snapshotAfter(stmt, current, matchedIds);
      } catch (e) {
        if (useSavepoint) {
          // ROLLBACK TO は SAVEPOINT を解放しない。あとで RELEASE することで
          // SAVEPOINT スタックが文をまたいで増え続けないようにする。
          await db.query(`ROLLBACK TO SAVEPOINT ${STMT_SAVEPOINT}`);
          await db.query(`RELEASE SAVEPOINT ${STMT_SAVEPOINT}`);
        }
        results.push({ label, state: current, events: [], error: formatPgError(e) });
        break;
      }

      if (useSavepoint) await db.query(`RELEASE SAVEPOINT ${STMT_SAVEPOINT}`);

      const laidOut = layoutTables(next, worldWidth);
      const events = diffStates(current, laidOut);
      results.push({ label, state: laidOut, events });
      current = laidOut;
    }

    this.lastState = current;
    return { results };
  }

  private async snapshotAfter(stmt: Parsed, current: DBState, matchedIds: Set<string> | null = null): Promise<DBState> {
    const db = this.db!;

    if (stmt.type === 'create') {
      const next = cloneState(current);
      next.tables[stmt.table] = { name: stmt.table, columns: stmt.columns, rows: [], x: 0, y: 0 };
      next.order.push(stmt.table);
      next.lastSelect = null;
      next.version++;
      this.ctidMaps.set(stmt.table, new Map());
      return next;
    }

    if (stmt.type === 'insert') {
      const table = current.tables[stmt.table];
      const next = cloneState(current);
      const ctidMap = this.ctidMaps.get(stmt.table) ?? new Map<string, string>();
      this.ctidMaps.set(stmt.table, ctidMap);

      const colList = table.columns.map((c) => quoteIdent(c.name)).join(', ');
      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT ctid::text AS __ctid, ${colList} FROM ${quoteIdent(stmt.table)} ORDER BY ctid`,
      );
      const newRows: Row[] = rows.map((r) => {
        const ctid = String(r.__ctid);
        let id = ctidMap.get(ctid);
        if (!id) {
          id = this.newRowId();
          ctidMap.set(ctid, id);
        }
        const values: Row['values'] = {};
        for (const c of table.columns) values[c.name] = normalizeValue(r[c.name]);
        return { id, values };
      });

      next.tables[stmt.table] = { ...next.tables[stmt.table], rows: newRows };
      next.lastSelect = null;
      next.version++;
      return next;
    }

    if (stmt.type === 'drop') {
      const next = cloneState(current);
      delete next.tables[stmt.table];
      next.order = next.order.filter((name) => name !== stmt.table);
      this.ctidMaps.delete(stmt.table);
      if (next.lastSelect?.table === stmt.table) next.lastSelect = null;
      next.version++;
      return next;
    }

    if (stmt.type === 'alter') {
      const next = cloneState(current);
      const table = next.tables[stmt.table];
      if (stmt.action === 'add') {
        const column = stmt.column;
        next.tables[stmt.table] = {
          ...table,
          columns: [...table.columns, column],
          rows: table.rows.map((r) => ({ ...r, values: { ...r.values, [column.name]: null } })),
        };
      } else {
        const columnName = stmt.column;
        next.tables[stmt.table] = {
          ...table,
          columns: table.columns.filter((c) => c.name !== columnName),
          rows: table.rows.map((r) => {
            const values = { ...r.values };
            delete values[columnName];
            return { ...r, values };
          }),
        };
      }
      next.lastSelect = null;
      next.version++;
      return next;
    }

    if (stmt.type === 'update') {
      const table = current.tables[stmt.table];
      const next = cloneState(current);
      const setEntries = stmt.set.map((s) => [s.column, s.value] as const);
      next.tables[stmt.table] = {
        ...next.tables[stmt.table],
        rows: table.rows.map((r) =>
          matchedIds === null || matchedIds.has(r.id)
            ? { ...r, values: { ...r.values, ...Object.fromEntries(setEntries) } }
            : r,
        ),
      };
      next.lastSelect = null;
      next.version++;
      return next;
    }

    if (stmt.type === 'delete') {
      const next = cloneState(current);
      const ctidMap = this.ctidMaps.get(stmt.table);
      const rows = current.tables[stmt.table].rows.filter((r) => !(matchedIds === null || matchedIds.has(r.id)));
      next.tables[stmt.table] = { ...next.tables[stmt.table], rows };
      if (ctidMap) {
        for (const [ctid, id] of ctidMap) {
          if (matchedIds === null || matchedIds.has(id)) ctidMap.delete(ctid);
        }
      }
      next.lastSelect = null;
      next.version++;
      return next;
    }

    // select: データは変更せず、既存行に対して filteredOut を再計算するだけ
    const table = current.tables[stmt.table];
    const next = cloneState(current);
    const filterMatchedIds = await this.resolveMatchedIds(db, stmt.table, stmt.where);

    next.tables[stmt.table] = {
      ...next.tables[stmt.table],
      rows: table.rows.map((r) => ({ ...r, filteredOut: filterMatchedIds ? !filterMatchedIds.has(r.id) : false })),
    };
    next.lastSelect = { table: stmt.table, columns: stmt.columns, where: stmt.where };
    next.version++;
    return next;
  }
}
