import { describe, expect, it } from 'vitest';
import { clampPan, computeFitTransform, computeWorldBox, KEEP_VISIBLE, WORLD_MARGIN } from '../src/lib/canvasLayout';
import { TABLE_H, TABLE_W } from '../src/layout';
import { makeColumn, makeRow, makeTable } from './test-utils';

function tableWithShape(name: string, columnCount: number, rowCount: number, x = 0, y = 0) {
  const columns = Array.from({ length: columnCount }, (_, i) => makeColumn(`c${i}`, 'INT'));
  const rows = Array.from({ length: rowCount }, (_, i) => makeRow(`${name}-r${i}`, { c0: i }));
  return makeTable(name, columns, rows, x, y);
}

describe('computeWorldBox — 全テーブル外接矩形をtightに包む + 四辺マージン', () => {
  it('WORLDBOX-MIN-01: テーブルが無ければ最小サイズ 800x500・原点(0,0)を返す', () => {
    expect(computeWorldBox([])).toEqual({ minX: 0, minY: 0, width: 800, height: 500 });
  });

  it('WORLDBOX-MIN-02: 内容が小さいときも最小サイズにクランプされる（左・上端はテーブル位置 − margin まで伸びる）', () => {
    const box = computeWorldBox([tableWithShape('t', 2, 1, 24, 24)]);
    expect(box).toEqual({ minX: 24 - WORLD_MARGIN, minY: 24 - WORLD_MARGIN, width: 800, height: 500 });
  });

  it('WORLDBOX-BBOX-01: 単独テーブルの外接矩形はテーブル自身の実寸 + margin×2（原点からの距離に依存しない）', () => {
    // 原点を特別扱いしないため、テーブルが原点付近にあろうと遠くにあろうと
    // box の width/height（＝サイズ）は変わらない——変わるのは minX/minY
    // （テーブル位置に追従するオフセット）だけ。
    const near = tableWithShape('near', 2, 1, 24, 24);
    const far = tableWithShape('far', 2, 1, 5000, 4000);
    const boxNear = computeWorldBox([near]);
    const boxFar = computeWorldBox([far]);
    expect(boxFar.width).toBe(boxNear.width);
    expect(boxFar.height).toBe(boxNear.height);
    expect(boxFar.minX).toBe(far.x - WORLD_MARGIN);
    expect(boxFar.minY).toBe(far.y - WORLD_MARGIN);
  });

  it('WORLDBOX-BBOX-02: 複数テーブルの最左端・最右端・最上端・最下端を採用する', () => {
    const wide = tableWithShape('wide', 2, 0, 1800, 40);
    const tall = tableWithShape('tall', 1, 12, 40, 1200);
    const box = computeWorldBox([wide, tall]);
    const left = Math.min(wide.x, tall.x);
    const right = Math.max(wide.x + TABLE_W, tall.x + TABLE_W);
    const top = Math.min(wide.y, tall.y);
    const bottom = Math.max(wide.y + TABLE_H(wide), tall.y + TABLE_H(tall));
    expect(box.minX).toBe(left - WORLD_MARGIN);
    expect(box.minY).toBe(top - WORLD_MARGIN);
    expect(box.width).toBe(right - left + WORLD_MARGIN * 2);
    expect(box.height).toBe(bottom - top + WORLD_MARGIN * 2);
  });

  it('WORLDBOX-HEIGHT-01: 行数の多いテーブルで下端が見切れない（固定200ではなく TABLE_H を使う）', () => {
    const t = tableWithShape('big', 1, 10, 0, 100);
    const box = computeWorldBox([t]);
    // 旧実装の `t.y + 200` (= 300) ではなく、実際のカード高さで計算される
    expect(TABLE_H(t)).toBeGreaterThan(200);
    expect(box.height).toBe(TABLE_H(t) + WORLD_MARGIN * 2);
  });

  it('WORLDBOX-MARGIN-01: margin 引数でマージン量を上書きできる', () => {
    // MIN_WORLD_W/H のクランプに隠れないよう、素の外接矩形が十分大きい
    // 2テーブルのフィクスチャで margin あり/なしの差分を直接比較する。
    const wide = tableWithShape('wide', 2, 0, 1800, 40);
    const tall = tableWithShape('tall', 1, 12, 40, 1200);
    const withMargin = computeWorldBox([wide, tall]);
    const noMargin = computeWorldBox([wide, tall], 0);
    expect(withMargin.width - noMargin.width).toBe(WORLD_MARGIN * 2);
    expect(withMargin.height - noMargin.height).toBe(WORLD_MARGIN * 2);
    expect(withMargin.minX - noMargin.minX).toBe(-WORLD_MARGIN);
    expect(withMargin.minY - noMargin.minY).toBe(-WORLD_MARGIN);
  });
});

describe('computeWorldBox — 負のx/yを持つテーブル（ドラッグで左・上方向へ出たケース、Issue #34）', () => {
  it('WORLDBOX-NEG-01: 負のx/yを持つテーブルがあるとmargin分だけ左・上へ拡張する', () => {
    const t = tableWithShape('t', 2, 1, -400, -200);
    const box = computeWorldBox([t]);
    expect(box.minX).toBe(-400 - WORLD_MARGIN);
    expect(box.minY).toBe(-200 - WORLD_MARGIN);
  });

  it('WORLDBOX-NEG-02: 右下方向の広がりは左上のテーブルに引きずられず、各テーブルの実際の右端・下端 + marginのまま', () => {
    const left = tableWithShape('left', 1, 0, -300, -100);
    const right = tableWithShape('right', 1, 0, 900, 700);
    const box = computeWorldBox([left, right]);
    expect(box.minX).toBe(-300 - WORLD_MARGIN);
    expect(box.minY).toBe(-100 - WORLD_MARGIN);
    const maxX = 900 + TABLE_W;
    const maxY = 700 + TABLE_H(right);
    expect(box.width).toBe(maxX - box.minX + WORLD_MARGIN);
    expect(box.height).toBe(maxY - box.minY + WORLD_MARGIN);
  });

  it('WORLDBOX-NEG-03: 単独テーブルを自身のカード幅より大きく左へドラッグしても幅が異常に膨らまない', () => {
    // t.x + TABLE_W が負になるまで左へ出す。minX/maxXは常にテーブル自身の
    // 実座標だけから求まる（原点(0)のような人工的なシード値と混ざらない）
    // ため、この種の非対称バグはそもそも起こり得ない——素の外接矩形
    // (TABLE_W=240) はMIN_WORLD_W(800)にクランプされ、妥当な値になる。
    const t = tableWithShape('t', 1, 0, -3000, 0);
    const box = computeWorldBox([t]);
    expect(t.x + TABLE_W).toBeLessThan(0); // 前提: 自身の右端も負
    expect(box.minX).toBe(-3000 - WORLD_MARGIN);
    expect(box.width).toBe(800); // MIN_WORLD_W にクランプされる
  });

  it('WORLDBOX-NEG-04: margin 引数は負方向の拡張にも適用される', () => {
    const t = tableWithShape('t', 1, 0, -500, -300);
    const box = computeWorldBox([t], 0);
    expect(box.minX).toBe(-500);
    expect(box.minY).toBe(-300);
  });
});

describe('computeFitTransform — ビューポートにワールドを中央フィット', () => {
  it('FIT-01: ワールドがビューポートより大きいとき min(縮尺) で収め、中央に置く', () => {
    const fit = computeFitTransform({ width: 1000, height: 800 }, { minX: 0, minY: 0, width: 2000, height: 1000 });
    expect(fit.scale).toBeCloseTo(0.5); // width が律速: 1000/2000
    // 中央寄せ: (1000 - 2000*0.5)/2 = 0, (800 - 1000*0.5)/2 = 150
    expect(fit.positionX).toBeCloseTo(0);
    expect(fit.positionY).toBeCloseTo(150);
  });

  it('FIT-02: 小さいワールドは既定では拡大しない（maxScale=1）', () => {
    const fit = computeFitTransform({ width: 1200, height: 800 }, { minX: 0, minY: 0, width: 400, height: 300 });
    expect(fit.scale).toBe(1);
    expect(fit.positionX).toBeCloseTo((1200 - 400) / 2);
    expect(fit.positionY).toBeCloseTo((800 - 300) / 2);
  });

  it('FIT-03: padding の分だけ内側にフィットする', () => {
    const noPad = computeFitTransform({ width: 1000, height: 1000 }, { minX: 0, minY: 0, width: 5000, height: 5000 });
    const pad = computeFitTransform(
      { width: 1000, height: 1000 },
      { minX: 0, minY: 0, width: 5000, height: 5000 },
      { padding: 50 },
    );
    expect(pad.scale).toBeLessThan(noPad.scale);
    expect(pad.scale).toBeCloseTo(900 / 5000);
  });

  it('FIT-04: minScale で下限クランプされる', () => {
    const fit = computeFitTransform(
      { width: 100, height: 100 },
      { minX: 0, minY: 0, width: 100000, height: 100000 },
      { minScale: 0.1 },
    );
    expect(fit.scale).toBe(0.1);
  });
});

describe('clampPan — ワールドを（ほぼ）画面外へパンさせない緩い制限', () => {
  const world = { minX: 0, minY: 0, width: 2000, height: 1000 };
  const viewport = { width: 800, height: 600 };
  const k = KEEP_VISIBLE; // 140

  it('CLAMP-01: 範囲内の pan はそのまま（スナップしない）', () => {
    expect(clampPan({ scale: 1, positionX: -300, positionY: -100 }, viewport, world)).toEqual({
      positionX: -300,
      positionY: -100,
    });
  });

  it('CLAMP-02: パン端では keepVisible 分だけワールドを画面内に残す', () => {
    // X: コンテンツ 2000 > ビュー 800 → pos ∈ [k-2000, 800-k]
    const far = clampPan({ scale: 1, positionX: -99999, positionY: -99999 }, viewport, world);
    expect(far.positionX).toBe(k - 2000);
    expect(far.positionY).toBe(k - 1000);
    const near = clampPan({ scale: 1, positionX: 99999, positionY: 99999 }, viewport, world);
    expect(near.positionX).toBe(800 - k);
    expect(near.positionY).toBe(600 - k);
  });

  it('CLAMP-03: レターボックス時（スケール済みワールド < ビューポート）も自由に動かせる — 中央固定しない', () => {
    // scale 0.2 -> scaled world 400x200。旧実装は pos を [0, view-content] の
    // 狭い範囲へ即スナップしていた（レビュー指摘の原因）。緩い制限では
    // keepVisible を残す広い範囲まで動かせる。
    expect(clampPan({ scale: 0.2, positionX: 60, positionY: 60 }, viewport, world)).toEqual({
      positionX: 60,
      positionY: 60,
    });
    // X: コンテンツ 400 → keep = min(140,400,800)=140 → pos ∈ [140-400, 800-140] = [-260, 660]
    const far = clampPan({ scale: 0.2, positionX: -9999, positionY: -9999 }, viewport, world);
    expect(far.positionX).toBe(140 - 400);
    // Y: コンテンツ 200 → keep=min(140,200,600)=140 → min = 140-200 = -60
    expect(far.positionY).toBe(140 - 200);
  });

  it('CLAMP-04: keepVisible は引数で上書きできる', () => {
    const r = clampPan({ scale: 1, positionX: 99999, positionY: 0 }, viewport, world, 0);
    expect(r.positionX).toBe(800); // keep 0 → ワールドを端にちょうど接するところまで押せる
  });
});
