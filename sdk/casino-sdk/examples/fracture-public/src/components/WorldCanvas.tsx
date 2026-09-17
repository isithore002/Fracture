import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { REALITIES, REALITY, type Reality } from '../lib/fracture';
import {
  playCaptureReady,
  playDragFizzle,
  startCoreHum,
  stopCoreHum,
  updateCoreHum,
} from '../lib/sound';

/**
 * 'holding' is a brief, silent beat between "the result is known" and "the
 * world visibly breaks" — see MIN_ANTICIPATION_MS / HOLD_MS in App.tsx. The
 * world freezes at the tensest point of the anticipation pulse rather than
 * relaxing back to idle, so the silence reads as held breath, not a glitch.
 */
export type WorldPhase = 'idle' | 'anticipation' | 'holding' | 'breaking' | 'settled';

type Props = {
  phase: WorldPhase;
  /** The reality that broke — only meaningful once phase is 'breaking' or later. */
  outcome: Reality | null;
  /** The currently committed prediction — where the Core rests when idle. */
  selected: Reality;
  /** Only draggable while idle and no bet is in flight. */
  interactive: boolean;
  /** Fires on a successful drag-release — identical effect to tapping a card. */
  onLock: (reality: Reality) => void;
};

const KEY: Record<Reality, string> = {
  0: 'gravity',
  1: 'time',
  2: 'scale',
  3: 'orbit',
  4: 'void',
};

const GLYPH: Record<Reality, string> = {
  0: '↑',
  1: '↺',
  2: '◱',
  3: '◌',
  4: '⬤',
};

/**
 * Anchor positions, in percent of the world-frame box. A hand-tuned pentagon
 * that keeps every anchor inside the frame with margin and mostly clear of
 * the background scenery (tree/house sit low and center-ish). This is the
 * single source of truth for anchor layout — both the rendered marker and
 * the Core's resting position read from it, so they can never drift apart.
 */
const ANCHOR_POS: Record<Reality, { left: number; top: number }> = {
  0: { left: 50, top: 15 }, // gravity — top
  1: { left: 83, top: 34 }, // time — upper right
  2: { left: 68, top: 80 }, // scale — lower right
  3: { left: 32, top: 80 }, // orbit — lower left
  4: { left: 17, top: 34 }, // void — upper left
};

/** Proximity at or above this (0..1) is close enough to lock on release. */
const LOCK_THRESHOLD = 0.55;

/**
 * A small, capped "lean" toward the nearest anchor while dragging — a preview
 * of that reality's signature motion, scaled far down from the real break
 * transforms in fracture.css so it reads as a hint, not the transformation
 * itself. Applied as an inline style directly to `.world-stage`, which has no
 * competing CSS `animation` on it during the idle phase (only 'anticipation'
 * and 'holding' animate `.world-stage`, and dragging is only possible while
 * idle), so there's nothing for this to fight with.
 */
function leanStyle(outcome: Reality, intensity: number): { transform: string; filter: string } {
  switch (outcome) {
    case 0: // gravity — the world lifts, faintly
      return { transform: `translateY(${-intensity * 9}px) scale(${1 + intensity * 0.01})`, filter: 'none' };
    case 1: // time — colour drains as if rewinding
      return { transform: `scale(${1 - intensity * 0.01})`, filter: `saturate(${1 - intensity * 0.35})` };
    case 2: // scale — a faint grow
      return { transform: `scale(${1 + intensity * 0.05})`, filter: 'none' };
    case 3: // orbit — a faint swing
      return { transform: `rotate(${intensity * 6}deg)`, filter: 'none' };
    case 4: // void — a faint pull inward
      return { transform: `scale(${1 - intensity * 0.045})`, filter: `brightness(${1 - intensity * 0.15})` };
  }
}

/**
 * The miniature world.
 *
 * Deliberately CSS-transform driven — translate / scale / rotate / opacity on a
 * handful of SVG shapes. The five effects don't need a physics or WebGL engine,
 * and the transform properties are all GPU-composited, so the reveal stays at
 * 60fps on a phone inside an iframe.
 *
 * The transformation is selected by a single data attribute on the root; every
 * effect below is expressed as keyframes in `styles/fracture.css` keyed off
 * `[data-break='...']`. Adding an outcome means adding a keyframe block, not
 * touching this component.
 *
 * ---
 *
 * The Core (drag-to-lock): a physical alternative to tapping a prediction
 * card. Five static anchors sit around the world; dragging the Core near one
 * previews that reality with a small "lean" on the whole scene, and a
 * heartbeat hum that gets louder and higher the closer you hold. Releasing
 * inside an anchor's capture range locks that prediction by calling `onLock`
 * — the exact same callback a card tap uses — so nothing downstream (wager,
 * VRF, payout) knows or cares which input method chose the prediction.
 *
 * This is pointer-events based (not separate mouse/touch handlers), so mouse
 * drag and touch drag are the same code path. The tap-card grid stays fully
 * functional and is the accessible path: the Core is `aria-hidden`, since the
 * labeled cards already expose the identical action to keyboard/assistive
 * tech users.
 */
export function WorldCanvas({ phase, outcome, selected, interactive, onLock }: Props) {
  const breaking = phase === 'breaking' || phase === 'settled';
  const breakKey = breaking && outcome !== null ? KEY[outcome] : undefined;

  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<HTMLDivElement>(null);
  const anchorRefs = useRef<Record<Reality, HTMLDivElement | null>>({
    0: null,
    1: null,
    2: null,
    3: null,
    4: null,
  });

  const dragging = useRef(false);
  const nearest = useRef<{ reality: Reality; intensity: number }>({ reality: selected, intensity: 0 });
  const wasLockable = useRef(false);
  const [hasDragged, setHasDragged] = useState(false);

  const clearLean = useCallback(() => {
    if (stageRef.current) {
      stageRef.current.style.transform = '';
      stageRef.current.style.filter = '';
    }
    for (const id of REALITIES) {
      anchorRefs.current[id]?.style.setProperty('--intensity', '0');
    }
  }, []);

  const restAtSelected = useCallback(() => {
    const core = coreRef.current;
    if (!core) return;
    const pos = ANCHOR_POS[selected];
    core.style.left = `${pos.left}%`;
    core.style.top = `${pos.top}%`;
  }, [selected]);

  // Snap the resting Core to whatever is currently selected — including the
  // very first render, and after a tap-card selection changes it.
  useEffect(() => {
    if (!dragging.current) restAtSelected();
  }, [selected, restAtSelected]);

  useEffect(() => {
    if (!interactive) clearLean();
  }, [interactive, clearLean]);

  const handleMove = useCallback((clientX: number, clientY: number) => {
    const frame = frameRef.current;
    const core = coreRef.current;
    if (!frame || !core) return;
    const rect = frame.getBoundingClientRect();

    // Position the Core, clamped to stay within the frame with a small margin.
    const margin = 14;
    const x = Math.min(rect.width - margin, Math.max(margin, clientX - rect.left));
    const y = Math.min(rect.height - margin, Math.max(margin, clientY - rect.top));
    core.style.left = `${(x / rect.width) * 100}%`;
    core.style.top = `${(y / rect.height) * 100}%`;

    // Distance to each anchor, measured against the actually-rendered anchor
    // elements rather than the abstract percentages, so hit-testing is exact
    // regardless of the frame's real on-screen size (phone vs. desktop vs.
    // the compact iframe embed).
    const captureRadius = 0.24 * Math.min(rect.width, rect.height);
    let best: { reality: Reality; intensity: number } = { reality: selected, intensity: 0 };
    for (const id of REALITIES) {
      const anchorEl = anchorRefs.current[id];
      if (!anchorEl) continue;
      const aRect = anchorEl.getBoundingClientRect();
      const ax = aRect.left + aRect.width / 2;
      const ay = aRect.top + aRect.height / 2;
      const dist = Math.hypot(clientX - ax, clientY - ay);
      const intensity = Math.max(0, Math.min(1, 1 - dist / captureRadius));
      anchorEl.style.setProperty('--intensity', intensity.toFixed(3));
      if (intensity > best.intensity) best = { reality: id, intensity };
    }
    nearest.current = best;

    if (best.intensity > 0.02) {
      const lean = leanStyle(best.reality, best.intensity);
      if (stageRef.current) {
        stageRef.current.style.transform = lean.transform;
        stageRef.current.style.filter = lean.filter;
      }
    } else {
      clearLean();
    }

    updateCoreHum(best.reality, best.intensity);
    const lockable = best.intensity >= LOCK_THRESHOLD;
    if (lockable && !wasLockable.current) playCaptureReady();
    wasLockable.current = lockable;
  }, [selected, clearLean]);

  const endDrag = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    stopCoreHum();
    clearLean();

    const { reality, intensity } = nearest.current;
    const core = coreRef.current;
    // Both branches leave the Core resting exactly on an anchor centre rather
    // than wherever the pointer happened to be — `.core-snap` gives that
    // small correction a transition instead of a jump. On a lock this window
    // also covers the slightly-later position write that `restAtSelected`
    // makes from the effect below, once `selected` actually changes.
    if (core) {
      core.classList.add('core-snap');
      window.setTimeout(() => core.classList.remove('core-snap'), 260);
    }

    if (intensity >= LOCK_THRESHOLD) {
      onLock(reality);
      const anchorEl = anchorRefs.current[reality];
      if (anchorEl) {
        anchorEl.classList.add('anchor-locked-flash');
        window.setTimeout(() => anchorEl.classList.remove('anchor-locked-flash'), 480);
      }
    } else {
      playDragFizzle();
      restAtSelected();
    }
  }, [onLock, clearLean, restAtSelected]);

  // Listeners live on `window` for the whole component lifetime rather than
  // being attached/removed per drag — they no-op via the `dragging` ref when
  // idle. This avoids the far more fragile alternative of re-attaching them
  // from inside the pointerdown handler: a dependency-array "re-arm" trick
  // would capture a stale `handleMove`/`endDrag` closure after the very first
  // drag, since nothing would ever change the effect's deps again to force a
  // second attachment.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (dragging.current) handleMove(e.clientX, e.clientY);
    };
    const onUp = () => {
      if (dragging.current) endDrag();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [handleMove, endDrag]);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!interactive) return;
      e.preventDefault();
      dragging.current = true;
      wasLockable.current = false;
      nearest.current = { reality: selected, intensity: 0 };
      startCoreHum(selected);
      setHasDragged(true); // hides the one-time hint text
      handleMove(e.clientX, e.clientY);
    },
    [interactive, selected, handleMove],
  );

  return (
    <div className="world" data-phase={phase} data-break={breakKey}>
      <div className="world-frame" ref={frameRef}>
        <div className="world-stage" ref={stageRef}>
          {/* sky layer -------------------------------------------------- */}
          <div className="layer layer-sky">
            <div className="obj moon" aria-hidden="true" />
            <div className="obj star star-a" aria-hidden="true" />
            <div className="obj star star-b" aria-hidden="true" />
            <div className="obj star star-c" aria-hidden="true" />
            <div className="obj cloud cloud-a" aria-hidden="true" />
            <div className="obj cloud cloud-b" aria-hidden="true" />
          </div>

          {/* ground layer ----------------------------------------------- */}
          <div className="layer layer-ground">
            <div className="obj tree" aria-hidden="true">
              <span className="tree-canopy" />
              <span className="tree-trunk" />
            </div>

            <div className="obj house" aria-hidden="true">
              <span className="house-roof" />
              <span className="house-body" />
              <span className="house-window" />
              <span className="house-door" />
            </div>

            <div className="obj rock rock-a" aria-hidden="true" />
            <div className="obj rock rock-b" aria-hidden="true" />
            <div className="obj fence" aria-hidden="true" />

            <div className="ground" aria-hidden="true" />
          </div>

          {/* the singularity, only visible for VOID ---------------------- */}
          <div className="void-core" aria-hidden="true" />
        </div>

        {/* Anchors + Core sit above the scene, only live while idle. The
            tap-card grid below the world is the accessible equivalent of
            every action here, so this whole layer is decorative+enhancing. */}
        {phase === 'idle' && (
          <div className="anchors" aria-hidden="true">
            {REALITIES.map(id => (
              <div
                key={id}
                ref={el => {
                  anchorRefs.current[id] = el;
                }}
                className={`anchor anchor-${KEY[id]}${selected === id ? ' anchor-selected' : ''}`}
                style={{ left: `${ANCHOR_POS[id].left}%`, top: `${ANCHOR_POS[id].top}%` }}
              >
                <span className="anchor-glyph">{GLYPH[id]}</span>
                <span className="anchor-name">{REALITY[id].name}</span>
              </div>
            ))}

            {/* The pointer-handling box is 44px (a real touch target) even
                though the visible orb inside it stays a small 22px — small
                visual, big invisible grab zone, the standard fix for "the
                thing you actually need to hit with a finger is too small". */}
            <div
              ref={coreRef}
              className={`fracture-core${interactive ? '' : ' fracture-core-inert'}`}
              onPointerDown={handlePointerDown}
              style={{ left: `${ANCHOR_POS[selected].left}%`, top: `${ANCHOR_POS[selected].top}%` }}
            >
              <span className="fracture-core-dot" />
            </div>

            {!hasDragged && interactive && (
              <p className="drag-hint">Drag the core to a law — hold it, then let go to lock in</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
