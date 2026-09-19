import { useEffect, useRef } from 'react';
import type { Reality } from '../lib/fracture';
import { createFractureScene, type FractureScene, type ScenePhase } from '../three/fractureScene';

type Props = {
  phase: ScenePhase;
  outcome: Reality | null;
  preview: Reality | null;
  selected: Reality;
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
  outcome,
  preview,
  selected,
  damage,
  onUnavailable,
  onReady,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<FractureScene | null>(null);
  // Held in a ref so the mount effect can seed the scene with current props
  // without taking them as dependencies (which would rebuild the whole world
  // on every prop change).
  const latest = useRef({ phase, outcome, preview, selected, damage });
  latest.current = { phase, outcome, preview, selected, damage };
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
    sceneRef.current?.setState({ phase, outcome, preview, selected, damage });
  }, [phase, outcome, preview, selected, damage]);

  return <canvas ref={canvasRef} className="world-gl" aria-hidden="true" />;
}
