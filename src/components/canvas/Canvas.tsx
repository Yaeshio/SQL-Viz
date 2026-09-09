import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Maximize } from 'lucide-react';
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch';
import type { ReactZoomPanPinchRef } from 'react-zoom-pan-pinch';
import type { DBState } from '../../types';
import { clampPan, computeFitTransform, computeWorldBox } from '../../lib/canvasLayout';
import TableNode from './TableNode';
import type { CanvasHighlight } from './TableNode';

/** テーブルノードだけをぴったり包む（グリッド/マージンを含まない）——テストが
 * 実コンテンツ矩形を測るための安定したフックとして残している。 */
const TABLES_BOUNDS_ID = 'sqlviz-tables-bounds';

/** 「Fit」時にワールドボックスとビューポート端の間に確保する余白（画面 px）。 */
const FIT_PADDING = 24;
const MIN_SCALE = 0.05;
const MAX_SCALE = 4;

interface Props {
  /** CanvasPane の <section>。変換状態を data-* 属性としてここに公開する */
  paneRef: RefObject<HTMLElement>;
  state: DBState;
  /** 今このタイミングで入場アニメーションすべき行の id（このティックで追加された） */
  appearingRows: Set<string>;
  /** 今このタイミングでフェードアウトすべき行の id（このティックでフィルタされた） */
  filteringRows: Set<string>;
  /** 値が今変わって（UPDATE）パルスすべき行の id */
  updatingRows: Set<string>;
  /** 今このタイミングで入場アニメーションすべき table+column キー（columnKey() 参照。このティックの ALTER ADD COLUMN） */
  appearingColumns: Set<string>;
  /** 現在 SELECT でハイライトされているテーブルと、その射影カラム */
  highlight: CanvasHighlight | null;
  /** 完了したテーブルのドラッグ（Issue #34）を最終ワールド座標で確定する。 */
  onMoveTable: (name: string, x: number, y: number) => void;
}

export default function Canvas({
  paneRef,
  state,
  appearingRows,
  filteringRows,
  updatingRows,
  appearingColumns,
  highlight,
  onMoveTable,
}: Props) {
  // テーブルのドラッグ（Issue #34）——下の `world` より前に宣言することで、
  // 進行中のドラッグをそこへ流し込める（worldTables 参照）。pointerdown を
  // 報告するのはヘッダー（class "sqlviz-drag-handle"。下でパンから excluded）
  // だけなので、キャンバスのパンジェスチャーと争うことはない。進行中のオフセットは
  // ここのローカル state に持ち、背後の DBState（および PgEngine 内のその複製）は
  // pointerup で onMoveTable 経由に一度だけ触れる。
  const [draggingName, setDraggingName] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ dx: 0, dy: 0 });

  const tables = state.order.map((n) => state.tables[n]);
  // *進行中の* ドラッグ位置を（最後に確定した state だけでなく）ワールドボックス
  // 計算へ流し込む。そのため、ドラッグを離したあとではなくテーブルが端へ近づく
  // につれてキャンバスが先回りで育つ。<TableNode> へ渡す `tables` 自体は手つかず
  // なので、memo() は依然としてドラッグ中の 1 つ以外の全テーブルの再レンダーを
  // スキップする。
  const worldTables = draggingName
    ? tables.map((t) => (t.name === draggingName ? { ...t, x: t.x + dragOffset.dx, y: t.y + dragOffset.dy } : t))
    : tables;
  const world = computeWorldBox(worldTables);
  const transformRef = useRef<ReactZoomPanPinchRef>(null);
  const worldRef = useRef(world);
  worldRef.current = world;
  // 現在のキャンバスのズーム。下の publishTransform が同期を保つ——ドラッグの
  // 画面 px 差分をワールド単位へ変換するときに（購読ではなく）読むだけなので、
  // テーブルドラッグの再レンダーはドラッグ中の TableNode のみにスコープされる。
  const scaleRef = useRef(1);
  // ユーザーが手でパン/ズームするまで false——false の間はワールドボックスが
  // 育つのに合わせてビューが自動フィットする（起動時ロードはテーブルを 1 つずつ
  // ストリーミングする）。
  const interactedRef = useRef(false);
  // パンのクランプが、実行中のフィットアニメーションをキャンセルしないよう
  // ガードする（遅延した onPanningStop / onWheelStop がフィット開始直後に届きうる）。
  const fittingRef = useRef(false);

  // 命令的に公開する（React state を使わない）ため、パン/ズームが SVG/テーブル木の
  // 再レンダーを引き起こすことは決してない——react-zoom-pan-pinch はラッパーの
  // CSS transform を書き換えるだけ。tools/acceptance-check/scenarios/phaseB* が読む。
  const publishTransform = useCallback(
    (s: { scale: number; positionX: number; positionY: number }) => {
      scaleRef.current = s.scale;
      const el = paneRef.current;
      if (!el) return;
      el.dataset.canvasScale = String(s.scale);
      el.dataset.canvasPanX = String(s.positionX);
      el.dataset.canvasPanY = String(s.positionY);
    },
    [paneRef],
  );

  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    el.dataset.worldW = String(world.width);
    el.dataset.worldH = String(world.height);
    el.dataset.worldMinX = String(world.minX);
    el.dataset.worldMinY = String(world.minY);
    // minX/minY は width/height と必ずしも一緒に変わるわけではない（例: 原点付近の
    // 純粋な垂直ドラッグは minY/height しか動かさない）ので、width/height だけに
    // 頼らず 4 つすべてを明示的に列挙する。
  }, [paneRef, world.width, world.height, world.minX, world.minY]);

  // ワールド原点のドラッグ補正（Issue #34 のフォローアップ）。テーブルを左/上の
  // 端へドラッグしている間、そのテーブルが最左/最上のテーブルに *なる* ので、
  // computeWorldBox() の minX/minY（つまり SVG の viewBox 原点）がそれに 1:1 で
  // 追従する。react-zoom-pan-pinch のパン変換はヘッダードラッグ中は凍結されている
  // （ヘッダーはパンジェスチャーから excluded）ため、その原点シフトを吸収するものが
  // なく、ドラッグ中のテーブルはピン留めされて見え、他の *すべての* テーブルが
  // 逆方向へ流れる。右/下のドラッグでは minX/minY が動かないのでこの問題は起きない。
  // 対策: ドラッグ中に原点がシフトするたびに、パン変換を同じ量（× scale）だけ
  // アニメーション無しでずらす。そうすれば動いていないワールド点は画面上で
  // 静止する——screen(wx) = positionX + (wx - minX)·scale なので、positionX に
  // (minX_new - minX_old)·scale を足せばよい。viewBox 変更と同じフレームで走る
  // よう useLayoutEffect を使う（ちらつき無し）。
  const prevWorldOriginRef = useRef({ minX: world.minX, minY: world.minY });
  useLayoutEffect(() => {
    const prev = prevWorldOriginRef.current;
    prevWorldOriginRef.current = { minX: world.minX, minY: world.minY };
    const api = transformRef.current;
    if (!draggingName || !api) return;
    const dMinX = world.minX - prev.minX;
    const dMinY = world.minY - prev.minY;
    if (dMinX === 0 && dMinY === 0) return;
    const { scale, positionX, positionY } = api.state;
    api.setTransform(positionX + dMinX * scale, positionY + dMinY * scale, scale, 0);
  }, [draggingName, world.minX, world.minY]);

  // Fit = ワールドボックスをペインの中央に置き、全辺の FIT_PADDING 内に収まる
  // ようスケールする。ペイン自身のサイズで駆動される純粋な幾何計算
  // （computeFitTransform）——ライブの SVG bbox や framer-motion の入場アニメーション
  // に依存しない。安定した同一性（world は ref 経由で読む）なので、下の effect は
  // 実際のワールドサイズ変化のときだけ再実行される。
  const fitToContent = useCallback(
    (animationMs: number) => {
      const pane = paneRef.current;
      const api = transformRef.current;
      if (!pane || !api) return;
      const fit = computeFitTransform(
        { width: pane.clientWidth, height: pane.clientHeight },
        worldRef.current,
        { minScale: MIN_SCALE, maxScale: 1, padding: FIT_PADDING },
      );
      fittingRef.current = true;
      window.setTimeout(() => {
        fittingRef.current = false;
      }, animationMs + 120);
      api.setTransform(fit.positionX, fit.positionY, fit.scale, animationMs);
      publishTransform(fit);
    },
    [paneRef, publishTransform],
  );

  // 自動フィットは初期ロードがまだテーブルをストリーミングしている間だけ:
  // マウント時と、ワールドサイズが育つたびにフィットし、その後ワールドが変化
  // しなくなって約 1.2 秒で恒久的に解除する（または最初の手動パン/ズームで即座に）。
  // それ以降は、明示的な「Fit」ボタンでしかビューは再フレームされない——あとで
  // SQL を実行してもカメラは動かない。（Issue #17 のレビュー反映。）
  useEffect(() => {
    if (interactedRef.current) return;
    const raf = requestAnimationFrame(() => {
      if (!interactedRef.current) fitToContent(0);
    });
    const settle = window.setTimeout(() => {
      interactedRef.current = true;
    }, 1200);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
    };
  }, [world.width, world.height, fitToContent]);

  const handleFit = useCallback(() => {
    // 一度きりの再フレーム。自動フィットを再アームしない
    interactedRef.current = true;
    // 次フレーム: 終わったばかりのパン/ズームジェスチャーが自身のクリーンアップ
    // （pointerup）を終えてから、フィットアニメーションを開始する
    requestAnimationFrame(() => fitToContent(300));
  }, [fitToContent]);

  const markInteracted = useCallback(() => {
    interactedRef.current = true;
  }, []);

  // draggingName/dragOffset の state 自体は上、`world` より前で宣言している。
  const dragOriginRef = useRef<{ name: string; startClientX: number; startClientY: number } | null>(null);

  const handleHeaderPointerDown = useCallback(
    (e: ReactPointerEvent, name: string) => {
      markInteracted();
      dragOriginRef.current = { name, startClientX: e.clientX, startClientY: e.clientY };
      setDragOffset({ dx: 0, dy: 0 });
      setDraggingName(name);
    },
    [markInteracted],
  );

  useEffect(() => {
    if (!draggingName) return;

    const offsetFor = (e: PointerEvent) => {
      const origin = dragOriginRef.current;
      const scale = scaleRef.current || 1;
      if (!origin) return { dx: 0, dy: 0 };
      return { dx: (e.clientX - origin.startClientX) / scale, dy: (e.clientY - origin.startClientY) / scale };
    };

    const handleMove = (e: PointerEvent) => setDragOffset(offsetFor(e));

    const handleUp = (e: PointerEvent) => {
      const origin = dragOriginRef.current;
      const { dx, dy } = offsetFor(e);
      dragOriginRef.current = null;
      setDraggingName(null);
      if (!origin) return;
      const table = state.tables[origin.name];
      if (!table) return;
      onMoveTable(origin.name, table.x + dx, table.y + dy);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [draggingName, state, onMoveTable]);

  // limitToBounds は無効（その「コンテンツはビューポートを覆わねばならない」規則が、
  // 全テーブルにフィットするのに必要なレターボックス表示を禁じる）なので、
  // ジェスチャー終了時に独自のワールドボックスのパン制限を再適用する——
  // ドラッグ中のオーバーシュートは範囲内へスナップバックする。
  const clampToBounds = useCallback(() => {
    if (fittingRef.current) return;
    const pane = paneRef.current;
    const api = transformRef.current;
    if (!pane || !api) return;
    const { scale, positionX, positionY } = api.state;
    const clamped = clampPan(
      { scale, positionX, positionY },
      { width: pane.clientWidth, height: pane.clientHeight },
      worldRef.current,
    );
    if (Math.abs(clamped.positionX - positionX) > 0.5 || Math.abs(clamped.positionY - positionY) > 0.5) {
      api.setTransform(clamped.positionX, clamped.positionY, scale, 120);
    }
  }, [paneRef]);

  return (
    <div className="absolute inset-0">
      <TransformWrapper
        ref={transformRef}
        minScale={MIN_SCALE}
        maxScale={MAX_SCALE}
        limitToBounds={false}
        // 離散的で予測可能なズームステップ——`smooth` はステップを生の wheel deltaY で
        // 乗算するため、マウスの 1 ノッチで過剰にズームしてしまう。
        smooth={false}
        wheel={{ step: 0.2 }}
        doubleClick={{ disabled: true }}
        // Issue #34: テーブルヘッダーは "sqlviz-drag-handle" クラスを持つので、
        // react-zoom-pan-pinch 自身のパンジェスチャー（React のイベント木とは
        // 無関係に `window` の "mousedown" を購読する——TableNode.tsx 参照）は、
        // pointerdown がそこで発生した場合はテーブルドラッグと争わずに自身を
        // スキップする。
        panning={{ velocityDisabled: true, excluded: ['sqlviz-drag-handle'] }}
        onPanningStart={markInteracted}
        onWheelStart={markInteracted}
        onPinchStart={markInteracted}
        onPanningStop={clampToBounds}
        onWheelStop={clampToBounds}
        onPinchStop={clampToBounds}
        onTransform={(_ref, s) => publishTransform(s)}
      >
        <TransformComponent
          wrapperStyle={{ width: '100%', height: '100%' }}
          contentClass="select-none"
        >
          <svg
            width={world.width}
            height={world.height}
            viewBox={`${world.minX} ${world.minY} ${world.width} ${world.height}`}
            className="block"
          >
            <defs>
              <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
                <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#1e293b" strokeWidth={0.5} />
              </pattern>
            </defs>
            <rect x={world.minX} y={world.minY} width={world.width} height={world.height} fill="url(#grid)" />
            <g id={TABLES_BOUNDS_ID}>
              <AnimatePresence>
                {tables.map((t) => (
                  <TableNode
                    key={t.name}
                    table={t}
                    appearingRows={appearingRows}
                    filteringRows={filteringRows}
                    updatingRows={updatingRows}
                    appearingColumns={appearingColumns}
                    highlight={highlight}
                    onHeaderPointerDown={handleHeaderPointerDown}
                    isDragging={draggingName === t.name}
                    dragOffset={draggingName === t.name ? dragOffset : undefined}
                  />
                ))}
              </AnimatePresence>
            </g>
          </svg>
        </TransformComponent>
      </TransformWrapper>

      <button
        type="button"
        data-testid="fit-view-btn"
        onClick={handleFit}
        title="Fit all tables"
        className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-700 bg-slate-900/80 backdrop-blur hover:border-slate-500 hover:bg-slate-800 transition text-slate-300 text-xs"
      >
        <Maximize size={13} /> Fit
      </button>
    </div>
  );
}
