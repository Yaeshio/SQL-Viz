import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Maximize } from 'lucide-react';
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch';
import type { ReactZoomPanPinchRef } from 'react-zoom-pan-pinch';
import type { DBState } from '../../types';
import { clampPan, computeFitTransform, computeWorldBox } from '../../lib/canvasLayout';
import TableNode from './TableNode';
import type { CanvasHighlight } from './TableNode';

/** wraps exactly the table nodes (no grid/margin) — kept as a stable hook for
 * tests to measure the real content rect. */
const TABLES_BOUNDS_ID = 'sqlviz-tables-bounds';

/** Screen-px inset kept between the world box and the viewport edge on "Fit". */
const FIT_PADDING = 24;
const MIN_SCALE = 0.05;
const MAX_SCALE = 4;

interface Props {
  /** the CanvasPane <section>; transform state is published here as data-* attrs */
  paneRef: RefObject<HTMLElement>;
  state: DBState;
  /** ids of rows that should currently animate in (added this tick) */
  appearingRows: Set<string>;
  /** ids of rows that should currently fade out (filtered this tick) */
  filteringRows: Set<string>;
  /** ids of rows whose values just changed (UPDATE) and should pulse */
  updatingRows: Set<string>;
  /** table+column keys (see columnKey()) that should currently animate in (ALTER ADD COLUMN this tick) */
  appearingColumns: Set<string>;
  /** table currently highlighted by SELECT, plus its projected columns */
  highlight: CanvasHighlight | null;
}

export default function Canvas({
  paneRef,
  state,
  appearingRows,
  filteringRows,
  updatingRows,
  appearingColumns,
  highlight,
}: Props) {
  const tables = state.order.map((n) => state.tables[n]);
  const world = computeWorldBox(tables);
  const transformRef = useRef<ReactZoomPanPinchRef>(null);
  const worldRef = useRef(world);
  worldRef.current = world;
  // false until the user pans/zooms by hand — while false, the view auto-fits
  // as the world box grows (the startup load streams tables in one at a time).
  const interactedRef = useRef(false);
  // guards the pan clamp from cancelling an in-flight fit animation (a delayed
  // onPanningStop / onWheelStop can land right after the fit starts).
  const fittingRef = useRef(false);

  // Published imperatively (no React state) so panning/zooming never triggers a
  // re-render of the SVG/table tree — react-zoom-pan-pinch only mutates a CSS
  // transform on its wrapper. Read by tools/acceptance-check/scenarios/phaseB*.
  const publishTransform = useCallback(
    (s: { scale: number; positionX: number; positionY: number }) => {
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
  }, [paneRef, world.width, world.height]);

  // Fit = center the world box in the pane, scaled to sit within FIT_PADDING of
  // every edge. Pure geometry (computeFitTransform) driven by the pane's own
  // size — no dependency on the live SVG bbox or framer-motion's enter
  // animation. Stable identity (reads world via a ref) so the effect below only
  // re-runs on an actual world-size change.
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

  // Auto-fit ONLY while the initial load is still streaming tables in: fit on
  // mount and on each world-size growth, then disarm for good ~1.2s after the
  // world stops changing (or immediately on the first manual pan/zoom). After
  // that the view is only ever re-framed by the explicit "Fit" button — running
  // more SQL later never yanks the camera. (Review feedback on Issue #17.)
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
    // one-shot re-frame; does NOT re-arm auto-fit
    interactedRef.current = true;
    // next frame: let any just-ended pan/zoom gesture finish its own cleanup
    // (pointerup) before we start the fit animation
    requestAnimationFrame(() => fitToContent(300));
  }, [fitToContent]);

  const markInteracted = useCallback(() => {
    interactedRef.current = true;
  }, []);

  // limitToBounds is off (its "content must cover the viewport" rule forbids the
  // letterboxing that fit-all-tables needs), so re-apply our own world-box pan
  // limit when a gesture ends — overshoot during the drag snaps back into range.
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
        // discrete, predictable zoom steps — `smooth` multiplies step by the
        // raw wheel deltaY, which makes a single mouse notch zoom wildly.
        smooth={false}
        wheel={{ step: 0.2 }}
        doubleClick={{ disabled: true }}
        panning={{ velocityDisabled: true }}
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
            viewBox={`0 0 ${world.width} ${world.height}`}
            className="block"
          >
            <defs>
              <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
                <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#1e293b" strokeWidth={0.5} />
              </pattern>
            </defs>
            <rect width={world.width} height={world.height} fill="url(#grid)" />
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
