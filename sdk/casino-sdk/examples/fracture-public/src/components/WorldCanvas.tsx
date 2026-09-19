import { lazy, Suspense, useState, type CSSProperties } from 'react';
import { type Reality } from '../lib/fracture';
import { ANCHOR, ANCHORS, arcPositions, type Position } from '../lib/fractureRun';

/**
 * three.js is ~500kB of the bundle — more than the rest of the game put
 * together — and "loads near-instantly" is a jam eligibility requirement.
 * So it is never in the critical path: the CSS scene (which is already
 * mounted as the WebGL fallback) paints immediately, this chunk streams in
 * behind it, and the canvas only takes over once it reports itself live.
 * Bundle weight becomes progressive enhancement instead of a loading cost.
 */
const ThreeWorld = lazy(() =>
  import('./ThreeWorld').then(m => ({ default: m.ThreeWorld })),
);

/**
 * 'holding' is a brief, silent beat between "the result is known" and "the
 * world visibly breaks" — see MIN_ANTICIPATION_MS / HOLD_MS in App.tsx. The
 * world freezes at the tensest point of the anticipation pulse rather than
 * relaxing back to idle, so the silence reads as held breath, not a glitch.
 */
export type WorldPhase = 'idle' | 'anticipation' | 'holding' | 'breaking' | 'settled';

type Props = {
  phase: WorldPhase;
  /** The law doing the breaking — only meaningful once phase is 'breaking'. */
  law: Reality | null;
  /** Where the player's Reality Anchor stands. */
  anchor: Position;
  /**
   * The arc being destroyed this step, or null.
   *
   * This is null for the whole of 'anticipation' by design, not by omission:
   * the VRF word that picks the arc does not exist until after the anchor is
   * committed, so there is nothing to show and nothing to leak. The telegraph
   * conveys that danger is rising, never where it will land.
   */
  arc: { start: Position; length: number } | null;
  /** True when the landing arc contained the anchor. */
  struck: boolean;
  /** Steps survived so far — the world frays as a run gets deeper. */
  step: number;
  /**
   * Accumulated per-law damage for this session (0..MAX_DAMAGE each). Exposed
   * to CSS as custom properties so the stylesheet decides what "gravity has
   * broken three times" looks like — this component just publishes the numbers.
   */
  damage: Record<Reality, number>;
};

const KEY: Record<Reality, string> = {
  0: 'gravity',
  1: 'time',
  2: 'scale',
  3: 'orbit',
  4: 'void',
};

/**
 * The star field. Sizes are in `cqw` so they scale with the frame like the
 * rest of the scene; varied radius/duration/delay stops the sky reading as a
 * regular grid of identical dots. Hand-placed rather than random so the
 * composition is stable across reloads and screenshots.
 */
const STARS: { x: number; y: number; r: number; dur: number; delay: number }[] = [
  { x: 62, y: 18, r: 0.42, dur: 3.1, delay: 0 },
  { x: 78, y: 9, r: 0.34, dur: 4.3, delay: 0.6 },
  { x: 40, y: 27, r: 0.3, dur: 3.7, delay: 1.4 },
  { x: 88, y: 22, r: 0.46, dur: 5.2, delay: 0.3 },
  { x: 25, y: 11, r: 0.28, dur: 4.6, delay: 2.1 },
  { x: 53, y: 6, r: 0.36, dur: 3.4, delay: 1.1 },
  { x: 70, y: 33, r: 0.24, dur: 5.8, delay: 0.9 },
  { x: 94, y: 40, r: 0.3, dur: 4.1, delay: 1.8 },
  { x: 12, y: 24, r: 0.26, dur: 6.2, delay: 0.4 },
  { x: 33, y: 38, r: 0.22, dur: 4.9, delay: 2.6 },
  { x: 47, y: 15, r: 0.2, dur: 5.5, delay: 3.1 },
  { x: 82, y: 30, r: 0.24, dur: 3.9, delay: 1.5 },
  { x: 6, y: 8, r: 0.32, dur: 4.4, delay: 2.3 },
  { x: 58, y: 42, r: 0.2, dur: 6.6, delay: 0.7 },
  { x: 97, y: 13, r: 0.28, dur: 5.0, delay: 1.9 },
  { x: 19, y: 41, r: 0.2, dur: 5.7, delay: 3.4 },
  { x: 72, y: 3, r: 0.24, dur: 4.2, delay: 2.8 },
  { x: 43, y: 34, r: 0.18, dur: 6.9, delay: 1.2 },
];

/** Fireflies near the ground — the one thing that drifts on its own path. */
const MOTES: { x: number; y: number; r: number; dur: number; delay: number }[] = [
  { x: 30, y: 72, r: 0.55, dur: 9, delay: 0 },
  { x: 58, y: 78, r: 0.45, dur: 11, delay: 2.4 },
  { x: 74, y: 68, r: 0.5, dur: 10, delay: 4.1 },
  { x: 16, y: 80, r: 0.4, dur: 12, delay: 6.3 },
  { x: 88, y: 76, r: 0.42, dur: 13, delay: 1.7 },
];

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
 */
/**
 * Where each anchor stands in the CSS fallback scene, as a percentage of the
 * frame. The three.js diorama places the same five positions in world space;
 * these exist so the fallback is still a playable, legible board.
 */
const ANCHOR_SPOT: Record<Position, { x: number; y: number }> = {
  0: { x: 21, y: 53 }, // hilltop
  1: { x: 73, y: 58 }, // orchard
  2: { x: 48, y: 62 }, // hearth
  3: { x: 87, y: 71 }, // fenceline
  4: { x: 31, y: 79 }, // hollow
};

export function WorldCanvas({ phase, law, anchor, arc, struck, step, damage }: Props) {
  const breaking = phase === 'breaking' || phase === 'settled';
  const breakKey = breaking && law !== null ? KEY[law] : undefined;
  const hitPositions = arc ? arcPositions(arc.start, arc.length) : [];

  /**
   * 'loading' until the three.js chunk has streamed in and the scene reports
   * itself live; 'unavailable' if WebGL can't start at all. The CSS scene
   * stays mounted underneath in every state — this only decides which of the
   * two is visible, so neither a slow network nor a missing GPU ever costs a
   * playable round.
   */
  const [gl, setGl] = useState<'loading' | 'ok' | 'unavailable'>('loading');

  return (
    <div
      className={`world${gl === 'ok' ? ' world-gl-on' : ''}`}
      data-phase={phase}
      data-break={breakKey}
      data-struck={arc ? (struck ? 'yes' : 'no') : undefined}
      style={
        {
          '--dmg-gravity': damage[0],
          '--dmg-time': damage[1],
          '--dmg-scale': damage[2],
          '--dmg-orbit': damage[3],
          '--dmg-void': damage[4],
          '--run-step': step,
        } as CSSProperties
      }
    >
      <div className="world-frame">
        {/* The three.js diorama. If WebGL can't start, `gl` flips to
            'unavailable', the `world-gl-on` class comes off, and the CSS
            scene below — still mounted and fully playable — becomes
            visible again. */}
        {gl !== 'unavailable' && (
          <Suspense fallback={null}>
            <ThreeWorld
              phase={phase}
              law={law}
              anchor={anchor}
              arc={arc}
              struck={struck}
              damage={damage}
              onReady={() => setGl('ok')}
              onUnavailable={() => setGl('unavailable')}
            />
          </Suspense>
        )}

        {/* The whole scene is decorative — the round's state is conveyed by
            the result banner and the prediction cards, both of which are
            real text, so one aria-hidden here covers all of it. */}
        <div className="world-stage" aria-hidden="true">
          {/* sky --------------------------------------------------------- */}
          <div className="layer layer-sky">
            <div className="nebula nebula-a" />
            <div className="nebula nebula-b" />

            {STARS.map((s, i) => (
              <span
                key={i}
                className="star"
                style={{
                  left: `${s.x}%`,
                  top: `${s.y}%`,
                  width: `${s.r}cqw`,
                  height: `${s.r}cqw`,
                  animationDuration: `${s.dur}s`,
                  animationDelay: `${s.delay}s`,
                }}
              />
            ))}

            <div className="obj moon" />

            <div className="obj cloud cloud-a">
              <i />
              <i />
              <i />
            </div>
            <div className="obj cloud cloud-b">
              <i />
              <i />
              <i />
            </div>
            <div className="obj cloud cloud-c">
              <i />
              <i />
              <i />
            </div>
          </div>

          {/* distance — silhouette bands behind the ground for depth ------ */}
          <div className="layer layer-far">
            <div className="hills hills-back" />
            <div className="hills hills-mid" />
            <div className="horizon-glow" />
          </div>

          {/* ground ------------------------------------------------------ */}
          {/* The grass plane and its track paint FIRST so everything below
              stands on top of them. They used to come last, which buried the
              base of the house, the tree trunk and the fence under the
              ground's curve — invisible at phone size, obvious once the
              scene scaled up. */}
          <div className="layer layer-ground">
            <div className="ground" />
            <div className="path" />

            <div className="obj tree tree-far">
              <span className="tree-canopy" />
              <span className="tree-trunk" />
            </div>

            <div className="obj house">
              <span className="house-roof" />
              <span className="house-body" />
              <span className="house-window" />
              <span className="house-window house-window-b" />
              <span className="house-door" />
            </div>

            <div className="obj tree">
              <span className="tree-canopy" />
              <span className="tree-trunk" />
            </div>

            <div className="obj rock rock-a" />
            <div className="obj rock rock-b" />
            <div className="obj rock rock-c" />
            <div className="obj fence" />

            <div className="obj grass grass-a" />
            <div className="obj grass grass-b" />
            <div className="obj grass grass-c" />
            <div className="obj grass grass-d" />

            {/* Permanent damage marks. Present in the DOM at all times and
                driven entirely by the --dmg-* custom properties, so they cost
                nothing at level 0 and never accumulate as extra elements. */}
            <div className="scar scar-void" />
            <div className="ghost ghost-time" />
          </div>

          {/* fireflies --------------------------------------------------- */}
          <div className="layer layer-motes">
            {MOTES.map((m, i) => (
              <span
                key={i}
                className="mote"
                style={{
                  left: `${m.x}%`,
                  top: `${m.y}%`,
                  width: `${m.r}cqw`,
                  height: `${m.r}cqw`,
                  boxShadow: `0 0 ${m.r * 3}cqw ${m.r}cqw rgba(255, 238, 194, 0.45)`,
                  animationDuration: `${m.dur}s`,
                  animationDelay: `${m.delay}s`,
                }}
              />
            ))}
          </div>

          {/* the singularity, only visible for VOID ---------------------- */}
          <div className="void-core" />

          {/* The five positions, and where the anchor is standing. The
              three.js diorama draws these in world space; this is the
              fallback board, so it has to stay legible on its own. */}
          <div className="anchors">
            {ANCHORS.map(id => (
              <span
                key={id}
                className={
                  `anchor-spot` +
                  (id === anchor ? ' here' : '') +
                  (hitPositions.includes(id) ? ' hit' : '')
                }
                style={{ left: `${ANCHOR_SPOT[id].x}%`, top: `${ANCHOR_SPOT[id].y}%` }}
                title={ANCHOR[id].name}
              />
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
