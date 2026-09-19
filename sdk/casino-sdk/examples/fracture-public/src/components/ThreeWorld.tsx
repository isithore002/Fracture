import { useEffect, useMemo, useRef } from 'react';
import type { Reality } from '../lib/fracture';
import type { Position } from '../lib/fractureRun';
import { createFractureScene, type FractureScene, type ScenePhase } from '../three/fractureScene';

type Props = {
  phase: ScenePhase;
  /** The law doing the breaking — only meaningful from 'breaking' onward. */
  law: Reality | null;
  /** Which ring position the Reality Anchor stands on. */
  anchor: Position;
  /** The arc being destroyed this step, or null while nothing has resolved. */
  arc: { start: Position; length: number } | null;
  /** True when the landing arc contained the anchor. */
  struck: boolean;
  damage: Record<Reality, number>;
  /** Called once if WebGL can't start, so the caller can fall back to the CSS scene. */
  onUnavailable: () => void;
  /** Called once the scene is actually live, so the CSS scene can be hidden. */
  onReady: () => void;
};

/**
 * React's entire relationship with the three.js world: mount a canvas, hand
 * the scene a state object whenever props change, and tear it down on unmount.
 *
 * Deliberately not a react-three-fiber component tree. The scene is a single
 * imperative object driven by one `setState` call, so React re-renders never
 * reach into the render loop — and a bug in the HUD can't stall the world.
 */
export function ThreeWorld({
  phase,
  law,
  anchor,
  arc,
  struck,
  damage,
  onUnavailable,
  onReady,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<FractureScene | null>(null);

  // The scene predates run mode and still speaks in `outcome`/`preview`/
  // `selected`; the translation lives here rather than rippling a rename
  // through 900 lines of animation that works.
  const sceneState = useMemo(
    () => ({
      phase,
      outcome: law,
      preview: null,
      selected: 0 as Reality,
      damage,
      anchor,
      arc,
      struck,
    }),
    [phase, law, damage, anchor, arc, struck],
  );

  // Held in a ref so the mount effect can seed the scene with current props
  // without taking them as dependencies (which would rebuild the whole world
  // on every prop change).
  const latest = useRef(sceneState);
  latest.current = sceneState;
  const notifyUnavailable = useRef(onUnavailable);
  notifyUnavailable.current = onUnavailable;
  const notifyReady = useRef(onReady);
  notifyReady.current = onReady;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const scene = createFractureScene(canvas);
    if (!scene) {
      notifyUnavailable.current();
      return;
    }
    sceneRef.current = scene;
    scene.setState(latest.current);
    notifyReady.current();

    const host = canvas.parentElement;
    const observer = new ResizeObserver(() => scene.resize());
    if (host) observer.observe(host);

    return () => {
      observer.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setState(sceneState);
  }, [sceneState]);

  return <canvas ref={canvasRef} className="world-gl" aria-hidden="true" />;
}
