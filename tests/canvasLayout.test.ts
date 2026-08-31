import { describe, expect, it } from 'vitest';
import { clampPan, computeFitTransform, computeWorldBox, WORLD_MARGIN } from '../src/lib/canvasLayout';
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

describe('clampPan — ワールドを画面外へパンさせない', () => {
  const world = { width: 2000, height: 1000 };
  const viewport = { width: 800, height: 600 };

  it('CLAMP-01: 拡大時（スケール済みワールド > ビューポート）はビューポートを覆い続ける', () => {
    // scaled world = 2000x1000 > 800x600。pos は [view-content, 0] に収まる
    expect(clampPan({ scale: 1, positionX: 500, positionY: 300 }, viewport, world)).toEqual({
      positionX: 0,
      positionY: 0,
    });
    expect(clampPan({ scale: 1, positionX: -5000, positionY: -5000 }, viewport, world)).toEqual({
      positionX: 800 - 2000,
      positionY: 600 - 1000,
    });
  });

  it('CLAMP-02: 範囲内の pan はそのまま', () => {
    expect(clampPan({ scale: 1, positionX: -300, positionY: -100 }, viewport, world)).toEqual({
      positionX: -300,
      positionY: -100,
    });
  });

  it('CLAMP-03: 縮小時（スケール済みワールド < ビューポート）は完全に画面内へ収める', () => {
    // scale 0.2 -> scaled world 400x200、pos は [0, view-content] = [0, 400]/[0,400]
    expect(clampPan({ scale: 0.2, positionX: -50, positionY: -50 }, viewport, world)).toEqual({
      positionX: 0,
      positionY: 0,
    });
    expect(clampPan({ scale: 0.2, positionX: 9999, positionY: 9999 }, viewport, world)).toEqual({
      positionX: 800 - 400,
      positionY: 600 - 200,
    });
    // 中央付近はそのまま
    expect(clampPan({ scale: 0.2, positionX: 200, positionY: 200 }, viewport, world)).toEqual({
      positionX: 200,
      positionY: 200,
    });
  });
});
