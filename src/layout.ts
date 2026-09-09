import type { DBState, Table } from './types';

export const TABLE_W = 240;
export const HEADER_H = 36;
export const ROW_H = 30;
export const COL_GAP = 16;
export const TABLE_GAP_X = 48;
export const TABLE_GAP_Y = 56;
export const PAD = 24;

/** ワールド座標系の固定折り返し幅（Issue #17）。テーブル位置はライブの
 * ビューポート幅ではなくこの定数を基準に配置される。そのためキャンバスを
 * パン/ズームしてもテーブルが再フローせず、ブラウザとクエリ API サーバーが
 * 同一のレイアウトを生成する。5 列グリッド用のサイズ:
 * floor((WORLD_W - PAD) / (TABLE_W + TABLE_GAP_X)) === 5。 */
export const WORLD_W = 1680;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** AABB（軸平行境界ボックス, axis-aligned bounding box）による重なり判定。
 * 標準のテーブル間ギャップの半分だけ膨らませることで、自動配置されたテーブルが
 * 障害物に「触れないだけ」ではなく通常どおりの余白を保つようにする。 */
function rectsOverlap(a: Rect, b: Rect): boolean {
  const mx = TABLE_GAP_X / 2;
  const my = TABLE_GAP_Y / 2;
  return a.x < b.x + b.w + mx && a.x + a.w + mx > b.x && a.y < b.y + b.h + my && a.y + a.h + my > b.y;
}

/**
 * 折り返しグリッドにテーブルの x/y 位置を割り当てる。`manuallyPositioned`
 * フラグの付いたテーブル（Issue #34 — ユーザーがドラッグしたもの）はそのまま
 * 残し、グリッド計算からは完全に除外する。残りの（自動）テーブルは新規作成分も
 * 含め、除外分が空けるはずだった隙間を作らず詰めて配置される。次に各自動テーブルの
 * グリッド候補位置を、`state.order` の順に 1 つずつ、手動配置テーブルおよびこの
 * 同一パスで先に配置済みの自動テーブルのいずれとも重ならなくなるまで真下へ
 * ずらす——そのため新規テーブルがユーザーのグリッド外へドラッグしたテーブルの
 * 上に出現することは決してない。手動配置テーブルが 1 つも無ければこのずらしは
 * 発動しないので、出力は Issue #34 以前と変わらない。
 */
export function layoutTables(state: DBState, canvasW: number): DBState {
  const cols = Math.max(1, Math.floor((canvasW - PAD) / (TABLE_W + TABLE_GAP_X)));
  const autoNames = state.order.filter((name) => !state.tables[name].manuallyPositioned);

  const rowCount = Math.ceil(autoNames.length / cols);
  const rowHeights = new Array(rowCount).fill(0);
  autoNames.forEach((name, i) => {
    const row = Math.floor(i / cols);
    rowHeights[row] = Math.max(rowHeights[row], TABLE_H(state.tables[name]));
  });
  const rowY: number[] = [];
  let acc = PAD;
  for (let r = 0; r < rowCount; r++) {
    rowY[r] = acc;
    acc += rowHeights[r] + TABLE_GAP_Y;
  }

  const obstacles: Rect[] = state.order
    .filter((name) => state.tables[name].manuallyPositioned)
    .map((name) => {
      const t = state.tables[name];
      return { x: t.x, y: t.y, w: TABLE_W, h: TABLE_H(t) };
    });

  autoNames.forEach((name, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const h = TABLE_H(state.tables[name]);
    const rect: Rect = { x: PAD + col * (TABLE_W + TABLE_GAP_X), y: rowY[row], w: TABLE_W, h };
    while (obstacles.some((o) => rectsOverlap(rect, o))) {
      rect.y += TABLE_GAP_Y + h;
    }
    state.tables[name].x = rect.x;
    state.tables[name].y = rect.y;
    obstacles.push(rect);
  });

  return state;
}

export function TABLE_H(t: Table): number {
  return HEADER_H + t.columns.length * ROW_H + t.rows.length * ROW_H + COL_GAP;
}
