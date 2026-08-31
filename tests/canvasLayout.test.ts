import { describe, expect, it } from 'vitest';
import { clampPan, computeFitTransform, computeWorldBox, KEEP_VISIBLE, WORLD_MARGIN } from '../src/lib/canvasLayout';
import { TABLE_H, TABLE_W } from '../src/layout';
import { makeColumn, makeRow, makeTable } from './test-utils';

function tableWithShape(name: string, columnCount: number, rowCount: number, x = 0, y = 0) {
  const columns = Array.from({ length: columnCount }, (_, i) => makeColumn(`c${i}`, 'INT'));
  const rows = Array.from({ length: rowCount }, (_, i) => makeRow(`${name}-r${i}`, { c0: i }));
  return makeTable(name, columns, rows, x, y);
}

describe('computeWorldBox — 全テーブル外接矩形 + マージン', () => {
  it('WORLDBOX-MIN-01: テーブルが無ければ最小サイズ 800x500 を返す', () => {
    expect(computeWorldBox([])).toEqual({ width: 800, height: 500 });
  });

  it('WORLDBOX-MIN-02: 内容が小さいときも最小サイズにクランプされる', () => {
    const box = computeWorldBox([tableWithShape('t', 2, 1, 24, 24)]);
    expect(box).toEqual({ width: 800, height: 500 });
  });

  it('WORLDBOX-BBOX-01: 遠くに配置されたテーブルの右下端 + マージンまで広がる', () => {
    const t = tableWithShape('far', 2, 1, 2000, 1500);
    const box = computeWorldBox([t]);
    expect(box.width).toBe(2000 + TABLE_W + WORLD_MARGIN);
    expect(box.height).toBe(1500 + TABLE_H(t) + WORLD_MARGIN);
  });

  it('WORLDBOX-BBOX-02: 複数テーブルの最大右端・最大下端を採用する', () => {
    const wide = tableWithShape('wide', 2, 0, 1800, 40);
    const tall = tableWithShape('tall', 1, 12, 40, 1200);
    const box = computeWorldBox([wide, tall]);
    expect(box.width).toBe(1800 + TABLE_W + WORLD_MARGIN);
    expect(box.height).toBe(1200 + TABLE_H(tall) + WORLD_MARGIN);
  });

  it('WORLDBOX-HEIGHT-01: 行数の多いテーブルで下端が見切れない（固定200ではなく TABLE_H を使う）', () => {
    const t = tableWithShape('big', 1, 10, 0, 100);
    const box = computeWorldBox([t]);
    // 旧実装の `t.y + 200` (= 300) ではなく、実際のカード高さで計算される
    expect(TABLE_H(t)).toBeGreaterThan(200);
    expect(box.height).toBe(100 + TABLE_H(t) + WORLD_MARGIN);
  });

  it('WORLDBOX-MARGIN-01: margin 引数でマージン量を上書きできる', () => {
    const t = tableWithShape('far', 2, 1, 2000, 1500);
    const box = computeWorldBox([t], 0);
    expect(box.width).toBe(2000 + TABLE_W);
    expect(box.height).toBe(1500 + TABLE_H(t));
  });
});

describe('computeFitTransform — ビューポートにワールドを中央フィット', () => {
  it('FIT-01: ワールドがビューポートより大きいとき min(縮尺) で収め、中央に置く', () => {
    const fit = computeFitTransform({ width: 1000, height: 800 }, { width: 2000, height: 1000 });
    expect(fit.scale).toBeCloseTo(0.5); // width が律速: 1000/2000
    // 中央寄せ: (1000 - 2000*0.5)/2 = 0, (800 - 1000*0.5)/2 = 150
    expect(fit.positionX).toBeCloseTo(0);
    expect(fit.positionY).toBeCloseTo(150);
  });

  it('FIT-02: 小さいワールドは既定では拡大しない（maxScale=1）', () => {
    const fit = computeFitTransform({ width: 1200, height: 800 }, { width: 400, height: 300 });
    expect(fit.scale).toBe(1);
    expect(fit.positionX).toBeCloseTo((1200 - 400) / 2);
    expect(fit.positionY).toBeCloseTo((800 - 300) / 2);
  });

  it('FIT-03: padding の分だけ内側にフィットする', () => {
    const noPad = computeFitTransform({ width: 1000, height: 1000 }, { width: 5000, height: 5000 });
    const pad = computeFitTransform({ width: 1000, height: 1000 }, { width: 5000, height: 5000 }, { padding: 50 });
    expect(pad.scale).toBeLessThan(noPad.scale);
    expect(pad.scale).toBeCloseTo(900 / 5000);
  });

  it('FIT-04: minScale で下限クランプされる', () => {
    const fit = computeFitTransform({ width: 100, height: 100 }, { width: 100000, height: 100000 }, { minScale: 0.1 });
    expect(fit.scale).toBe(0.1);
  });
});

describe('clampPan — ワールドを（ほぼ）画面外へパンさせない緩い制限', () => {
  const world = { width: 2000, height: 1000 };
  const viewport = { width: 800, height: 600 };
  const k = KEEP_VISIBLE; // 140

  it('CLAMP-01: 範囲内の pan はそのまま（スナップしない）', () => {
    expect(clampPan({ scale: 1, positionX: -300, positionY: -100 }, viewport, world)).toEqual({
      positionX: -300,
      positionY: -100,
    });
  });

  it('CLAMP-02: パン端では keepVisible 分だけワールドを画面内に残す', () => {
    // X: content 2000 > view 800 -> pos ∈ [k-2000, 800-k]
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
    // X: content 400 -> keep = min(140,400,800)=140 -> pos ∈ [140-400, 800-140] = [-260, 660]
    const far = clampPan({ scale: 0.2, positionX: -9999, positionY: -9999 }, viewport, world);
    expect(far.positionX).toBe(140 - 400);
    // Y: content 200 -> keep=min(140,200,600)=140 -> min = 140-200 = -60
    expect(far.positionY).toBe(140 - 200);
  });

  it('CLAMP-04: keepVisible は引数で上書きできる', () => {
    const r = clampPan({ scale: 1, positionX: 99999, positionY: 0 }, viewport, world, 0);
    expect(r.positionX).toBe(800); // keep 0 -> world can be pushed to just touching the edge
  });
});
