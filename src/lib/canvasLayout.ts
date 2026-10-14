import type { Column, Row, Table } from '../types';
import { HEADER_H, ROW_H, COL_GAP, TABLE_H, TABLE_W } from '../layout';

export interface TableInnerLayout {
  colRows: { col: Column; y: number }[];
  dataRows: { row: Row; y: number }[];
  /** カラム定義行群とデータ行群の境界の y 座標（区切り線の描画に使う）。 */
  dividerY: number;
  height: number;
}

/** テーブルカードのカラム定義行・データ行の y オフセットと、カードの総高さを
 * 計算する。 */
export function computeTableInnerLayout(table: Table): TableInnerLayout {
  let y = HEADER_H;
  const colRows = table.columns.map((c) => {
    const cy = y;
    y += ROW_H;
    return { col: c, y: cy };
  });
  y += COL_GAP / 2;
  const dividerY = y;
  const dataRows = table.rows.map((r) => {
    const ry = y;
    y += ROW_H;
    return { row: r, y: ry };
  });
  const height = y;
  return { colRows, dataRows, dividerY, height };
}

/** テーブルカード内のカラム定義行の縦方向の中心（ワールド座標）。カラムが無ければ
 * null。`computeTableInnerLayout()` の `colRows[i].y`（行の上端）+ ROW_H/2 と一致する。 */
export function computeColumnCenterY(table: Table, columnName: string): number | null {
  const i = table.columns.findIndex((c) => c.name === columnName);
  return i < 0 ? null : table.y + HEADER_H + i * ROW_H + ROW_H / 2;
}

export interface RelationGeometry {
  /** FK 側（from）の端点 */
  x1: number;
  y1: number;
  /** 参照先（to）の端点 */
  x2: number;
  y2: number;
  /** from / to の端点がカードのどちら側にあるか。+1 = 右辺、-1 = 左辺（線はその外側へ出る） */
  side1: 1 | -1;
  side2: 1 | -1;
  /** SVG の path `d`（3 次ベジェ） */
  d: string;
}

/** 左右に並んでいるとみなす、2 枚のカードの間の最小の隙間（ワールド単位）。 */
const RELATION_SIDE_GAP = 24;
const CURVE_MIN = 40;
const CURVE_MAX = 140;
/** 同じ列を自己参照するときに端点を縦にずらす量（線が退化しないように）。 */
const SELF_LOOP_SPREAD = 6;

/**
 * FK 列の行から参照先列の行へ結ぶコネクタの端点とベジェを計算する（Issue #45）。
 * 端点はカードの左右の辺の、各カラム行の縦中心に置く。
 * - 左右に並んでいるとき（隙間が RELATION_SIDE_GAP 以上）: 向かい合う辺同士を結ぶ
 * - 水平方向に重なる／自己参照のとき: 両端とも右辺から外側へ膨らむ C 字で結ぶ
 * どちらかのカラムが実在しなければ null（例: カラムの DROP 中）。純粋な幾何計算で、
 * `from`/`to` の x/y にはドラッグ中のライブ位置を渡せる。
 */
export function computeRelationGeometry(
  from: Table,
  fromColumn: string,
  to: Table,
  toColumn: string,
): RelationGeometry | null {
  let y1 = computeColumnCenterY(from, fromColumn);
  let y2 = computeColumnCenterY(to, toColumn);
  if (y1 === null || y2 === null) return null;

  let x1: number;
  let x2: number;
  let side1: 1 | -1;
  let side2: 1 | -1;
  let k: number;
  if (from.x + TABLE_W + RELATION_SIDE_GAP <= to.x) {
    x1 = from.x + TABLE_W;
    x2 = to.x;
    side1 = 1;
    side2 = -1;
    k = Math.min(CURVE_MAX, Math.max(CURVE_MIN, (x2 - x1) / 2));
  } else if (to.x + TABLE_W + RELATION_SIDE_GAP <= from.x) {
    x1 = from.x;
    x2 = to.x + TABLE_W;
    side1 = -1;
    side2 = 1;
    k = Math.min(CURVE_MAX, Math.max(CURVE_MIN, (x1 - x2) / 2));
  } else {
    x1 = from.x + TABLE_W;
    x2 = to.x + TABLE_W;
    side1 = 1;
    side2 = 1;
    k = CURVE_MIN + Math.min(80, Math.abs(y2 - y1) * 0.25);
    if (y1 === y2 && x1 === x2) {
      y1 -= SELF_LOOP_SPREAD;
      y2 += SELF_LOOP_SPREAD;
    }
  }

  const d = `M ${x1} ${y1} C ${x1 + side1 * k} ${y1}, ${x2 + side2 * k} ${y2}, ${x2} ${y2}`;
  return { x1, y1, x2, y2, side1, side2, d };
}

export interface RowCellLayout {
  columnName: string;
  /** このセルの手前の区切り線の x 位置。先頭カラムでは null。 */
  dividerX: number | null;
  textX: number;
  display: string;
  isNull: boolean;
}

/** 1 データ行分の、セルごとの x 位置と切り詰めた表示テキストを計算する。 */
export function computeRowCells(columns: Column[], row: Row): RowCellLayout[] {
  const cellPad = 8;
  const colW = (TABLE_W - cellPad * 2) / columns.length;
  const maxChars = Math.max(1, Math.floor(colW / 6.5) - 1);
  return columns.map((c, i) => {
    const val = row.values[c.name];
    const isNull = val === null;
    const raw = isNull ? 'NULL' : String(val);
    const display = raw.length > maxChars ? raw.slice(0, maxChars - 1) + '…' : raw;
    return {
      columnName: c.name,
      dividerX: i > 0 ? cellPad + i * colW : null,
      textX: cellPad + i * colW + 6,
      display,
      isNull,
    };
  });
}

export interface WorldBox {
  /** ボックスの左上隅のワールド座標 x/y。手動配置されたテーブル（Issue #34 の
   * ドラッグ）が原点より左/上に無い限りぴったり 0 で、ある場合は負になる——
   * SVG の viewBox もそれに合わせてオフセットされ、キャンバスが右/下だけでなく
   * 左/上へも広がれるようにする。 */
  minX: number;
  minY: number;
  width: number;
  height: number;
}

/** テーブルの外接矩形の周囲に確保する空白（px、ワールド単位）。「Fit」表示に
 * 少し余白を持たせ、パンできる先を用意するため。 */
export const WORLD_MARGIN = 96;

/** パン限界において clampPan() が各軸で画面内に残すワールドボックスの最小 px。
 * WORLD_MARGIN より大きくすることで、単なる空白マージンではなく実テーブルの
 * 一部が必ず見えるようにする。 */
export const KEEP_VISIBLE = 140;

/** ほぼ空のキャンバスでも妥当な広さを埋めるためのワールドの最小サイズ。 */
const MIN_WORLD_W = 800;
const MIN_WORLD_H = 500;

/** すべてのテーブルの実カード矩形を四辺すべてに `margin` の空白を付けてぴったり
 * 包む、ワールド座標のボックス（SVG のピクセル幅/高さ + 左上原点）を計算し、
 * 最小サイズにクランプする。ワールド原点 (0,0) を暗黙の下限として特別扱い
 * しない——左/上も右/下と同じく、あらゆる辺をテーブル自身の現在位置のみから
 * 同じ方法で計算する。そのため、いずれかの辺へドラッグされたテーブル（Issue #34）は
 * 右/下だけでなく全方向で同じ連続的・先回りの `margin` px のクッションを得る。
 * 純粋な幾何計算——パン/ズーム変換は Canvas.tsx がこの上に適用する。 */
export function computeWorldBox(tables: Table[], margin: number = WORLD_MARGIN): WorldBox {
  if (tables.length === 0) {
    return { minX: 0, minY: 0, width: MIN_WORLD_W, height: MIN_WORLD_H };
  }
  const left = Math.min(...tables.map((t) => t.x));
  const right = Math.max(...tables.map((t) => t.x + TABLE_W));
  const top = Math.min(...tables.map((t) => t.y));
  const bottom = Math.max(...tables.map((t) => t.y + TABLE_H(t)));
  const minX = left - margin;
  const minY = top - margin;
  return {
    minX,
    minY,
    width: Math.max(right - left + margin * 2, MIN_WORLD_W),
    height: Math.max(bottom - top + margin * 2, MIN_WORLD_H),
  };
}

export interface FitTransform {
  scale: number;
  positionX: number;
  positionY: number;
}

export interface FitOptions {
  minScale?: number;
  /** フィット時にこれを超えてズームインしない（既定 1 — 小さいキャンバスを拡大しない）。 */
  maxScale?: number;
  /** ワールドボックスとビューポート端の間に確保する余白（画面 px）。 */
  padding?: number;
}

/** `world` を `viewport` の中央に置き、全辺の `padding` 内に収まるようスケール
 * する react-zoom-pan-pinch の変換（{scale, positionX, positionY}）を計算する。
 * 純粋な幾何計算なので単体テストでき、初期フィットと「Fit」ボタンが 1 つの
 * コードパスを共有できる（ライブの SVG 外接矩形や framer-motion の再生中の
 * 入場アニメーションに依存しない）。 */
export function computeFitTransform(
  viewport: { width: number; height: number },
  world: WorldBox,
  { minScale = 0.05, maxScale = 1, padding = 0 }: FitOptions = {},
): FitTransform {
  const availW = Math.max(1, viewport.width - padding * 2);
  const availH = Math.max(1, viewport.height - padding * 2);
  const raw = Math.min(availW / world.width, availH / world.height);
  const scale = Math.min(maxScale, Math.max(minScale, raw));
  return {
    scale,
    positionX: (viewport.width - world.width * scale) / 2,
    positionY: (viewport.height - world.height * scale) / 2,
  };
}

/** ワールドボックスが（ほぼ）画面外へドラッグされないよう、パンオフセットを
 * クランプする: 限界では、スケール後のワールドボックスの `keepVisible` px が
 * 各軸でビューポート内に残る。これは *緩い* 制限で——その範囲内ではビューは
 * 自由に動くのでコンテンツ端での跳ね返りが無い——それでいて Issue #17 の
 * 「外接矩形 + margin を越えてパンできない」（キャンバスを完全に見失うことは
 * 決してない）を担保する。react-zoom-pan-pinch は limitToBounds を無効にして
 * 動作する（そのバウンドは「全テーブルにフィット」が必要とするレターボックス
 * 表示を禁じてしまう）。代わりに Canvas.tsx がジェスチャー終了時にこれを
 * 再適用する。純粋な幾何計算。 */
export function clampPan(
  transform: { scale: number; positionX: number; positionY: number },
  viewport: { width: number; height: number },
  world: WorldBox,
  keepVisible: number = KEEP_VISIBLE,
): { positionX: number; positionY: number } {
  const axis = (pos: number, content: number, view: number) => {
    const keep = Math.min(keepVisible, content, view);
    const min = keep - content; // ワールドの遠い端が、近いビューポート端から `keep` 内側に残る
    const max = view - keep; // ワールドの近い端が、遠いビューポート端から `keep` 内側に残る
    if (min > max) return (view - content) / 2; // ビューポートが 2*keep より小さい——単に中央寄せ
    return Math.min(max, Math.max(min, pos));
  };
  return {
    positionX: axis(transform.positionX, world.width * transform.scale, viewport.width),
    positionY: axis(transform.positionY, world.height * transform.scale, viewport.height),
  };
}
