import type { Reality } from '../lib/fracture';

export type WorldPhase = 'idle' | 'anticipation' | 'breaking' | 'settled';

type Props = {
  phase: WorldPhase;
  /** The reality that broke — only meaningful once phase is 'breaking' or later. */
  outcome: Reality | null;
};

const KEY: Record<Reality, string> = {
  0: 'gravity',
  1: 'time',
  2: 'scale',
  3: 'orbit',
  4: 'void',
};

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
export function WorldCanvas({ phase, outcome }: Props) {
  const breaking = phase === 'breaking' || phase === 'settled';
  const breakKey = breaking && outcome !== null ? KEY[outcome] : undefined;

  return (
    <div className="world" data-phase={phase} data-break={breakKey}>
      <div className="world-frame">
        <div className="world-stage">
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
      </div>
    </div>
  );
}
