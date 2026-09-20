import * as THREE from 'three';
import type { Reality } from '../lib/fracture';

/**
 * The FRACTURE world, in three.js — a "surreal cosmic diorama": a miniature
 * night landscape under a low-FOV (telephoto) camera, which is what gives a
 * real scene that tilt-shift, model-village read rather than looking like a
 * first-person view of a normal-sized world.
 *
 * Framework-agnostic on purpose. React owns the HUD and the round state
 * machine; this module owns pixels. The only contact surface is `setState`,
 * which React calls when props change — so a re-render never touches the
 * render loop, and the render loop never touches React.
 *
 * NOTHING here can influence a result. It is handed the outcome only after
 * the round has already settled on-chain, exactly like the CSS scene it
 * replaces, and it has no access to the wager, the bridge or the VRF word.
 */

export type ScenePhase = 'idle' | 'anticipation' | 'holding' | 'breaking' | 'settled';

export type SceneState = {
  phase: ScenePhase;
  /** The law that actually broke — only meaningful from 'breaking' onward. */
  outcome: Reality | null;
  /** The law the pointer is hovering in the HUD, or null. */
  preview: Reality | null;
  /** The committed prediction. */
  selected: Reality;
  /** Per-law damage levels, 0..MAX_DAMAGE. The world's memory of the session. */
  damage: Record<Reality, number>;
  /** Which of the five ring positions the Reality Anchor is standing on. */
  anchor: number;
  /**
   * The arc being destroyed this step, or null.
   *
   * Null for the whole of 'anticipation' by design: the VRF word that picks
   * the arc does not exist until after the anchor is committed, so there is
   * nothing here to draw and nothing to leak.
   */
  arc: { start: number; length: number } | null;
  /** True when the landing arc contained the anchor. */
  struck: boolean;
};

/** The five world positions, as a ring. Neighbours here are neighbours in the
 *  world, which is what makes an arc read as one sweeping wave rather than a
 *  scatter of unrelated explosions. Index order matches `ANCHOR` in
 *  lib/fractureRun.ts: HILLTOP, ORCHARD, HEARTH, FENCELINE, HOLLOW. */
const RING_RADIUS = 1.62;
const RING_CENTER = { x: 0, z: -0.1 };
const RING: Array<{ x: number; z: number }> = Array.from({ length: 5 }, (_, i) => {
  // Start at the back and walk counter-clockwise, so the ring reads left to
  // right across the frame the way the HUD keys are ordered.
  const theta = -(i * 72 * Math.PI) / 180;
  return {
    x: RING_CENTER.x + RING_RADIUS * Math.sin(theta),
    z: RING_CENTER.z - RING_RADIUS * Math.cos(theta),
  };
});

/**
 * A point pushed `d` further out from the ring's centre than position `i`.
 *
 * The landmarks sit just outside their pads rather than on top of them, so
 * the pad stays visible and the Anchor has somewhere to stand that isn't
 * inside the house.
 */
const ringOut = (i: number, d: number): { x: number; z: number } => {
  // Sideways along the ring, not outward from its centre. Outward looks
  // natural on paper but puts the near-side landmarks directly between the
  // camera and their own markers, so HEARTH and FENCELINE went invisible.
  // A tangential offset stands the landmark BESIDE its position instead.
  const dx = RING[i].x - RING_CENTER.x;
  const dz = RING[i].z - RING_CENTER.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: RING[i].x - (dz / len) * d, z: RING[i].z + (dx / len) * d };
};

/**
 * Mirrors BREAK_MS in App.tsx (1400/1400/1400/1600/1900). Kept as a local
 * copy rather than an import so this module has no dependency on the app's
 * state machine — and exact sync isn't needed anyway: like the CSS version's
 * `animation-fill-mode: forwards`, the transformation simply holds its end
 * state once it completes, so a few ms of drift is invisible.
 */
const BREAK_SECONDS: Record<Reality, number> = {
  0: 1.4,
  1: 1.4,
  2: 1.4,
  3: 1.6,
  4: 1.9,
};

const MAX_DAMAGE = 5;

/** Damage past this level per law stops accumulating visually (see App.tsx). */
const clampDamage = (n: number) => Math.min(Math.max(n, 0), MAX_DAMAGE);

/** Staged thresholds, mirroring the CSS scene: `max(0, level - threshold)`. */
const staged = (level: number, threshold: number) => Math.max(0, level - threshold);

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInCubic = (t: number) => t * t * t;
const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt));

type Placed = {
  object: THREE.Object3D;
  /** Rest transform — every per-frame effect composes on top of this. */
  base: { pos: THREE.Vector3; rot: THREE.Euler; scale: number };
  /** Per-object phase offset so idle motion isn't synchronised. */
  seed: number;
  /** Heavier things resist GRAVITY slightly less dramatically. */
  mass: number;
};

export type FractureScene = {
  setState: (next: SceneState) => void;
  resize: () => void;
  dispose: () => void;
};

export function createFractureScene(canvas: HTMLCanvasElement): FractureScene | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
  } catch {
    // No WebGL (locked-down browser, blocked GPU, headless without swiftshader).
    // The caller falls back to the CSS scene, which is fully playable.
    return null;
  }

  const parent = canvas.parentElement;
  const initialWidth = parent?.clientWidth || 640;
  const initialHeight = parent?.clientHeight || 480;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(initialWidth, initialHeight, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  // Fog in the sky's own colour is what turns a flat object layout into depth.
  scene.fog = new THREE.Fog(0x1a1338, 13, 34);

  /* ---------------------------------------------------------------- camera */
  // A long lens (low FOV) pulled far back: the miniature/diorama look comes
  // from compressed perspective, not from making the objects small.
  const camera = new THREE.PerspectiveCamera(26, initialWidth / initialHeight, 0.1, 100);
  // Raised and near-centred, because the ring of five positions IS the board
  // now: the shot has to read as a whole playable surface, not as a landscape
  // with a house in the foreground. Low and off to one side made the nearest
  // position loom over the other four.
  const cameraHome = new THREE.Vector3(0, 3.4, 11.8);
  camera.position.copy(cameraHome);
  const lookTarget = new THREE.Vector3(0, 0.85, -0.3);
  camera.lookAt(lookTarget);

  /* --------------------------------------------------------------- lighting */
  const hemi = new THREE.HemisphereLight(0x8f7fd6, 0x141a2e, 0.85);
  scene.add(hemi);

  // The moon is the key light; warm, low, and to the left, matching where the
  // moon mesh actually sits so the lighting reads as coming from it.
  const moonLight = new THREE.DirectionalLight(0xffeec2, 1.15);
  moonLight.position.set(-6, 5.5, 3.5);
  scene.add(moonLight);

  // Cool rim from behind-right to separate silhouettes from the fog.
  const rim = new THREE.DirectionalLight(0x7f6bff, 0.5);
  rim.position.set(4, 2.5, -5);
  scene.add(rim);

  /* ------------------------------------------------------------ scene roots */
  // Everything that ORBIT rotates lives under `world`; the moon and stars sit
  // outside it so they can counter-rotate independently.
  const world = new THREE.Group();
  scene.add(world);

  const disposables: Array<THREE.BufferGeometry | THREE.Material | THREE.Texture> = [];
  const track = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(x: T): T => {
    disposables.push(x);
    return x;
  };

  const placed: Placed[] = [];
  const register = (
    object: THREE.Object3D,
    seed: number,
    mass = 1,
  ): Placed => {
    const entry: Placed = {
      object,
      base: {
        pos: object.position.clone(),
        rot: object.rotation.clone(),
        scale: object.scale.x,
      },
      seed,
      mass,
    };
    placed.push(entry);
    return entry;
  };

  /* ------------------------------------------------------------------ ground */
  // A shallow dome rather than a flat plane: the curve reads as a small planet
  // fragment and gives the horizon a soft edge against the fog.
  const groundGeo = track(new THREE.SphereGeometry(7.2, 48, 32, 0, Math.PI * 2, 0, Math.PI * 0.5));
  const groundMat = track(
    new THREE.MeshStandardMaterial({ color: 0x24404a, roughness: 0.95, metalness: 0, flatShading: false }),
  );
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.position.y = -6.85;
  world.add(ground);
  const groundEntry = register(ground, 0, 4);

  /* -------------------------------------------------------------------- house */
  const house = new THREE.Group();
  const wallsGeo = track(new THREE.BoxGeometry(1.12, 0.86, 0.96));
  const wallsMat = track(new THREE.MeshStandardMaterial({ color: 0xe9e3f7, roughness: 0.8 }));
  const walls = new THREE.Mesh(wallsGeo, wallsMat);
  walls.position.y = 0.43;
  house.add(walls);

  const roofGeo = track(new THREE.ConeGeometry(0.92, 0.62, 4));
  const roofMat = track(new THREE.MeshStandardMaterial({ color: 0xb85c7a, roughness: 0.7, flatShading: true }));
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.position.y = 1.16;
  roof.rotation.y = Math.PI / 4;
  house.add(roof);

  // Lit windows: emissive so they read as the only warm interior light.
  const windowGeo = track(new THREE.PlaneGeometry(0.2, 0.22));
  const windowMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xffe9a8,
      emissive: 0xffd98a,
      emissiveIntensity: 1.4,
      side: THREE.DoubleSide,
    }),
  );
  for (const wx of [-0.27, 0.27]) {
    const win = new THREE.Mesh(windowGeo, windowMat);
    win.position.set(wx, 0.52, 0.485);
    house.add(win);
  }
  const doorGeo = track(new THREE.PlaneGeometry(0.22, 0.4));
  const doorMat = track(new THREE.MeshStandardMaterial({ color: 0x4c3f72, roughness: 0.9, side: THREE.DoubleSide }));
  const door = new THREE.Mesh(doorGeo, doorMat);
  door.position.set(0, 0.2, 0.486);
  house.add(door);

  // The props sit ON the ring, not around it: each position is somewhere the
  // player can actually stand, so an arc destroys recognisable places rather
  // than empty ground. HEARTH is the house.
  const hearth = ringOut(2, 0.34);
  house.position.set(hearth.x, 0, hearth.z);
  house.rotation.y = 0.42;
  world.add(house);
  const houseEntry = register(house, 1.7, 2.4);

  /* -------------------------------------------------------------------- trees */
  const trunkGeo = track(new THREE.CylinderGeometry(0.062, 0.085, 0.72, 7));
  const trunkMat = track(new THREE.MeshStandardMaterial({ color: 0x7a5434, roughness: 0.95 }));
  const foliageGeo = track(new THREE.IcosahedronGeometry(0.44, 0));
  const foliageMat = track(
    new THREE.MeshStandardMaterial({ color: 0x2f7d5c, roughness: 0.85, flatShading: true }),
  );

  // ORCHARD — the three old trees, clustered on their position.
  const treeSpecs = [
    { x: ringOut(1, 0.38).x, z: ringOut(1, 0.38).z + 0.24, s: 1.0, seed: 0.4 },
    { x: ringOut(1, 0.62).x, z: ringOut(1, 0.62).z - 0.16, s: 0.76, seed: 2.1 },
    { x: ringOut(1, 0.2).x - 0.26, z: ringOut(1, 0.2).z - 0.4, s: 0.62, seed: 3.6 },
  ];
  const treeEntries: Placed[] = [];
  for (const spec of treeSpecs) {
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = 0.36;
    tree.add(trunk);
    const foliage = new THREE.Mesh(foliageGeo, foliageMat);
    foliage.position.y = 0.94;
    foliage.rotation.set(spec.seed, spec.seed * 1.7, 0);
    tree.add(foliage);
    tree.position.set(spec.x, 0, spec.z);
    tree.scale.setScalar(spec.s);
    world.add(tree);
    treeEntries.push(register(tree, spec.seed, 1));
  }

  /* -------------------------------------------------------------------- rocks */
  const rockGeo = track(new THREE.IcosahedronGeometry(0.17, 0));
  const rockMat = track(new THREE.MeshStandardMaterial({ color: 0x3c3a56, roughness: 1, flatShading: true }));
  // HOLLOW — the low ground, down among the rocks.
  const rockSpecs = [
    { x: ringOut(4, -0.34).x, z: ringOut(4, -0.34).z + 0.2, s: 1.0, seed: 1.1 },
    { x: ringOut(4, -0.56).x, z: ringOut(4, -0.56).z + 0.04, s: 0.72, seed: 2.7 },
    { x: ringOut(4, -0.2).x + 0.06, z: ringOut(4, -0.2).z - 0.32, s: 0.85, seed: 4.2 },
    { x: ringOut(0, 0.45).x, z: ringOut(0, 0.45).z + 0.1, s: 0.55, seed: 5.3 },
  ];
  for (const spec of rockSpecs) {
    const rock = new THREE.Mesh(rockGeo, rockMat);
    rock.position.set(spec.x, 0.1 * spec.s, spec.z);
    rock.rotation.set(spec.seed, spec.seed * 2.3, spec.seed * 0.7);
    rock.scale.setScalar(spec.s);
    world.add(rock);
    register(rock, spec.seed, 0.6);
  }

  /* -------------------------------------------------------------------- fence */
  const fence = new THREE.Group();
  const postGeo = track(new THREE.BoxGeometry(0.05, 0.3, 0.05));
  const railGeo = track(new THREE.BoxGeometry(1.28, 0.035, 0.035));
  const fenceMat = track(new THREE.MeshStandardMaterial({ color: 0x9a90c4, roughness: 0.9 }));
  for (let i = 0; i < 5; i++) {
    const post = new THREE.Mesh(postGeo, fenceMat);
    post.position.set(-0.64 + i * 0.32, 0.15, 0);
    fence.add(post);
  }
  for (const railY of [0.1, 0.24]) {
    const rail = new THREE.Mesh(railGeo, fenceMat);
    rail.position.set(0, railY, 0);
    fence.add(rail);
  }
  // FENCELINE — out at the edge of the plot.
  const fenceSpot = ringOut(3, -0.34);
  fence.position.set(fenceSpot.x, 0, fenceSpot.z);
  fence.rotation.y = -0.62;
  world.add(fence);
  register(fence, 2.9, 0.5);

  /* ------------------------------------------------- the ring and the Anchor */
  // A marker on every position, and the Anchor standing on one of them. This
  // is the board: five places to be when the next fracture arrives.
  //
  // The markers are standing columns, not discs on the ground. The camera sits
  // only ~12 degrees above the horizon so it can keep the moon in frame, and
  // at that angle a flat disc projects to a few pixels of ellipse and vanishes.
  // A vertical element reads at any camera pitch.
  const padGeo = track(new THREE.CylinderGeometry(0.06, 0.15, 1.45, 14, 1, true));
  const padRingGeo = track(new THREE.RingGeometry(0.2, 0.3, 24));
  const padMats = RING.map(() =>
    track(
      new THREE.MeshBasicMaterial({
        color: 0x8fa8d8,
        transparent: true,
        opacity: 0.26,
        side: THREE.DoubleSide,
        depthWrite: false,
        // Additive so a marker glows through whatever is behind it instead of
        // occluding the world like a solid post.
        blending: THREE.AdditiveBlending,
      }),
    ),
  );
  const pads = RING.map((spot, i) => {
    const pad = new THREE.Group();
    const column = new THREE.Mesh(padGeo, padMats[i]);
    column.position.y = 0.725;
    pad.add(column);
    const ring = new THREE.Mesh(padRingGeo, padMats[i]);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    pad.add(ring);
    pad.position.set(spot.x, 0, spot.z);
    world.add(pad);
    return pad;
  });

  // The Anchor itself: a small upright shard of held-together reality. It
  // travels between pads rather than teleporting, so moving it feels like
  // moving something.
  const anchorGroup = new THREE.Group();
  const anchorGeo = track(new THREE.OctahedronGeometry(0.19, 0));
  const anchorMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xfff2d0,
      emissive: 0xffd98a,
      emissiveIntensity: 1.6,
      roughness: 0.4,
      flatShading: true,
    }),
  );
  const anchorMesh = new THREE.Mesh(anchorGeo, anchorMat);
  anchorMesh.position.y = 1.95;
  anchorGroup.add(anchorMesh);

  const beamGeo = track(new THREE.CylinderGeometry(0.075, 0.19, 1.8, 16, 1, true));
  const beamMat = track(
    new THREE.MeshBasicMaterial({
      color: 0xffd98a,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  const anchorBeam = new THREE.Mesh(beamGeo, beamMat);
  anchorBeam.position.y = 0.9;
  anchorGroup.add(anchorBeam);

  anchorGroup.position.set(RING[2].x, 0, RING[2].z);
  world.add(anchorGroup);

  /* --------------------------------------------------------------- moon + sky */
  const moonGeo = track(new THREE.SphereGeometry(0.55, 32, 24));
  const moonMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xffeec2,
      emissive: 0xffeec2,
      emissiveIntensity: 0.85,
      roughness: 1,
      // The moon sits far beyond the fog's far plane so it reads as sky
      // rather than scenery; without this it gets washed out to nothing.
      fog: false,
    }),
  );
  const moon = new THREE.Mesh(moonGeo, moonMat);
  const moonHome = new THREE.Vector3(-3.3, 3.5, -9.6);
  moon.position.copy(moonHome);
  scene.add(moon);

  // Soft halo. This needs a radial falloff texture — a flat additive plane
  // renders as a visible hard-edged rectangle against the sky, which is
  // exactly what it did on the first pass. Generated on a canvas rather than
  // shipped as an image so the scene stays asset-free.
  const haloTex = track(
    (() => {
      const size = 128;
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const ctx = c.getContext('2d')!;
      const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, 'rgba(255,238,194,0.85)');
      grad.addColorStop(0.35, 'rgba(255,238,194,0.28)');
      grad.addColorStop(1, 'rgba(255,238,194,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    })(),
  );
  const haloMat = track(
    new THREE.SpriteMaterial({
      map: haloTex,
      color: 0xffeec2,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  const halo = new THREE.Sprite(haloMat);
  halo.scale.setScalar(3.4);
  halo.position.copy(moonHome);
  scene.add(halo);

  /* -------------------------------------------------------------------- stars */
  const STAR_COUNT = 320;
  const starPos = new Float32Array(STAR_COUNT * 3);
  const starPhase = new Float32Array(STAR_COUNT);
  for (let i = 0; i < STAR_COUNT; i++) {
    // Shell distribution, biased to the upper hemisphere and pushed behind
    // the action so stars never sit in front of the diorama.
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 0.85 + 0.1);
    const r = 17 + Math.random() * 9;
    starPos[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
    starPos[i * 3 + 1] = Math.abs(Math.cos(phi)) * r * 0.75 + 1.5;
    starPos[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r;
    starPhase[i] = Math.random() * Math.PI * 2;
  }
  const starGeo = track(new THREE.BufferGeometry());
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const starMat = track(
    new THREE.PointsMaterial({
      color: 0xf2eefc,
      size: 0.075,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      fog: false, // stars are sky, not scenery — fog would erase them
    }),
  );
  const stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

  /* -------------------------------------------------------------------- motes */
  // Slow drifting fireflies inside the diorama — the main "this world is
  // alive" signal while idle. Deliberately few; this is atmosphere, not a
  // particle demo.
  const MOTE_COUNT = 90;
  const motePos = new Float32Array(MOTE_COUNT * 3);
  const moteHome = new Float32Array(MOTE_COUNT * 3);
  const motePhase = new Float32Array(MOTE_COUNT);
  for (let i = 0; i < MOTE_COUNT; i++) {
    const x = (Math.random() - 0.5) * 6.4;
    const y = 0.15 + Math.random() * 1.9;
    const z = (Math.random() - 0.5) * 5.2;
    moteHome[i * 3] = x;
    moteHome[i * 3 + 1] = y;
    moteHome[i * 3 + 2] = z;
    motePos[i * 3] = x;
    motePos[i * 3 + 1] = y;
    motePos[i * 3 + 2] = z;
    motePhase[i] = Math.random() * Math.PI * 2;
  }
  const moteGeo = track(new THREE.BufferGeometry());
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
  const moteMat = track(
    new THREE.PointsMaterial({
      color: 0xffe9a8,
      size: 0.055,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  const motes = new THREE.Points(moteGeo, moteMat);
  world.add(motes);

  /* --------------------------------------------------------- void singularity */
  const voidGeo = track(new THREE.SphereGeometry(1, 32, 24));
  const voidMat = track(new THREE.MeshBasicMaterial({ color: 0x05030c }));
  const singularity = new THREE.Mesh(voidGeo, voidMat);
  singularity.position.set(0, 0.9, 0);
  singularity.scale.setScalar(0.001);
  singularity.visible = false;
  world.add(singularity);

  // Violet accretion ring around the singularity.
  const ringGeo = track(new THREE.RingGeometry(1.02, 1.5, 48));
  const ringMat = track(
    new THREE.MeshBasicMaterial({
      color: 0xb98cff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  const accretion = new THREE.Mesh(ringGeo, ringMat);
  accretion.position.copy(singularity.position);
  accretion.visible = false;
  world.add(accretion);

  /* -------------------------------------------------------------- time ghosts */
  // TIME leaves afterimages: cheap translucent clones of the two most
  // readable silhouettes, revealed only when Time has actually broken.
  const ghostMat = track(
    new THREE.MeshBasicMaterial({
      color: 0x6fd4e6,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  const ghosts: THREE.Object3D[] = [];
  const makeGhost = (source: THREE.Object3D, offset: THREE.Vector3) => {
    const ghost = source.clone(true);
    ghost.traverse(child => {
      if ((child as THREE.Mesh).isMesh) (child as THREE.Mesh).material = ghostMat;
    });
    ghost.position.add(offset);
    ghost.visible = false;
    world.add(ghost);
    ghosts.push(ghost);
    return ghost;
  };
  const houseGhost = makeGhost(house, new THREE.Vector3(-0.42, 0, 0.3));
  const treeGhost = makeGhost(treeEntries[0].object, new THREE.Vector3(0.38, 0, 0.26));

  /* ----------------------------------------------------------------- state */
  let state: SceneState = {
    phase: 'idle',
    outcome: null,
    preview: null,
    selected: 0,
    damage: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 },
    anchor: 2,
    arc: null,
    struck: false,
  };

  /** Per-pad destruction level, 0..1, eased so an arc lands as a wave. */
  const padHit = [0, 0, 0, 0, 0];

  // Smoothed hover intensities per law, so previews ease in/out instead of
  // snapping as the pointer crosses cards.
  const hover: Record<Reality, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  let breakStart = 0;
  let lastPhase: ScenePhase = 'idle';
  let tension = 0;
  const clock = new THREE.Clock();
  let elapsed = 0;
  const reduceMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

  const setState = (next: SceneState) => {
    if (next.phase === 'breaking' && lastPhase !== 'breaking') breakStart = elapsed;
    lastPhase = next.phase;
    state = next;
  };

  /* ------------------------------------------------------------------ resize */
  const resize = () => {
    const host = canvas.parentElement;
    if (!host) return;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // On a narrow/portrait frame the same camera crops the diorama badly, so
    // pull back and widen slightly instead of just letter-boxing the desktop
    // composition — the world stays the hero at every size.
    const portrait = h > w;
    camera.fov = portrait ? 34 : 26;
    camera.updateProjectionMatrix();
  };

  /* -------------------------------------------------------------- the frame */
  const scratch = new THREE.Vector3();
  let raf = 0;

  const frame = () => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    elapsed += dt;

    const dmg = state.damage;
    const g = clampDamage(dmg[0]);
    const t = clampDamage(dmg[1]);
    const s = clampDamage(dmg[2]);
    const o = clampDamage(dmg[3]);
    const v = clampDamage(dmg[4]);

    // --- hover intensities -------------------------------------------------
    for (const law of [0, 1, 2, 3, 4] as Reality[]) {
      const target = state.preview === law && state.phase === 'idle' ? 1 : 0;
      hover[law] = damp(hover[law], target, 9, dt);
    }

    // --- break progress ----------------------------------------------------
    const breaking = state.phase === 'breaking' || state.phase === 'settled';
    const outcome = state.outcome;
    let progress = 0;
    if (breaking && outcome !== null) {
      const dur = BREAK_SECONDS[outcome];
      progress = state.phase === 'settled' ? 1 : Math.min((elapsed - breakStart) / dur, 1);
    }
    const p = easeOutCubic(progress);

    // Anticipation tension: a held breath that rises while waiting and snaps
    // to stillness during the silent 'holding' beat.
    const tensionTarget =
      state.phase === 'anticipation' ? 1 : state.phase === 'holding' ? 0.15 : 0;
    tension = damp(tension, tensionTarget, 4, dt);

    const motion = reduceMotion ? 0.25 : 1;

    // --- per-object composition -------------------------------------------
    for (const entry of placed) {
      const { object, base, seed, mass } = entry;
      const isGround = entry === groundEntry;

      // idle: a slow breathing sway, faster and jitterier under TIME damage.
      const timeWarp = 1 + t * 0.22;
      const sway = Math.sin(elapsed * 0.55 * timeWarp + seed) * 0.02 * motion;
      const bob = Math.sin(elapsed * 0.42 * timeWarp + seed * 1.6) * 0.018 * motion;

      let px = base.pos.x;
      let py = base.pos.y + (isGround ? 0 : bob);
      let pz = base.pos.z;
      let rx = base.rot.x;
      let rz = base.rot.z + (isGround ? 0 : sway);
      let ry = base.rot.y;
      let scl = base.scale;

      // GRAVITY — persistent lift, staged like the CSS version, plus the
      // live break itself. Lighter things fly further.
      const gLift = (staged(g, 0) * 0.13) / mass;
      py += gLift;
      rz += staged(g, 1) * 0.045 * (seed % 2 === 0 ? 1 : -1);
      if (isGround) py -= staged(g, 3) * 0.12; // the ground sags away

      // SCALE — things stay the wrong size.
      if (!isGround) {
        const grow = entry === houseEntry ? 1 + staged(s, 0) * 0.12 : 1 - staged(s, 0) * 0.07;
        scl *= grow;
      }

      // VOID — objects that have been eaten stay partially gone.
      const voidPull = staged(v, 1) * 0.06;
      if (!isGround && voidPull > 0) {
        scratch.set(base.pos.x, base.pos.y, base.pos.z).multiplyScalar(-voidPull);
        px += scratch.x;
        pz += scratch.z;
        scl *= Math.max(0.25, 1 - voidPull * 1.6);
      }

      // --- hover previews: small, immediate, unmistakable -----------------
      const hg = hover[0];
      if (hg > 0 && !isGround) py += hg * (0.16 / mass);
      const hs = hover[2];
      if (hs > 0 && !isGround) scl *= entry === houseEntry ? 1 + hs * 0.1 : 1 - hs * 0.08;
      const ho = hover[3];
      if (ho > 0 && !isGround) {
        const ang = ho * 0.25 * Math.sin(elapsed * 1.6 + seed);
        const cos = Math.cos(ang);
        const sin = Math.sin(ang);
        const ox = px;
        const oz = pz;
        px = ox * cos - oz * sin;
        pz = ox * sin + oz * cos;
      }
      const hv = hover[4];
      if (hv > 0 && !isGround) {
        scl *= 1 - hv * 0.16;
        px += -px * hv * 0.06;
        pz += -pz * hv * 0.06;
      }
      const ht = hover[1];
      if (ht > 0) rz += Math.sin(elapsed * 7 + seed) * 0.02 * ht;

      // anticipation tremble — the world knows something is coming.
      if (tension > 0.01) {
        const tr = tension * 0.012 * motion;
        px += Math.sin(elapsed * 23 + seed * 3) * tr;
        py += Math.cos(elapsed * 19 + seed * 5) * tr;
      }

      // --- the break itself ------------------------------------------------
      if (breaking && outcome !== null && progress > 0) {
        if (outcome === 0) {
          // GRAVITY: everything falls upward, tumbling as it goes.
          const lift = easeInCubic(progress) * (7.5 / mass);
          py += lift;
          rz += p * 0.9 * (seed % 2 === 0 ? 1 : -1);
          rx += p * 0.5;
          if (isGround) py -= p * 0.55;
        } else if (outcome === 1) {
          // TIME: motion runs backward and stutters, like a tape rewinding.
          const rewind = Math.sin(elapsed * 26) * p * 0.05;
          px += rewind;
          rz -= p * 0.35 * Math.sin(elapsed * 9 + seed);
          scl *= 1 - p * 0.05;
        } else if (outcome === 2) {
          // SCALE: the house balloons, everything else collapses small.
          scl *= entry === houseEntry ? 1 + p * 2.6 : 1 - p * 0.72;
          if (entry === houseEntry) py += p * 0.35;
        } else if (outcome === 3) {
          // ORBIT: handled as a whole-world rotation below; objects also
          // drift outward so the scene visibly loses its centre.
          const push = p * 0.5;
          px += base.pos.x * push;
          pz += base.pos.z * push;
          ry += p * 2.2;
        } else if (outcome === 4) {
          // VOID: pulled into the singularity and erased.
          const pull = easeInCubic(progress);
          px += (0 - base.pos.x) * pull * 0.92;
          py += (0.9 - base.pos.y) * pull * 0.92;
          pz += (0 - base.pos.z) * pull * 0.92;
          scl *= Math.max(0.001, 1 - pull);
          ry += pull * 5;
        }
      }

      object.position.set(px, py, pz);
      object.rotation.set(rx, ry, rz);
      object.scale.setScalar(Math.max(scl, 0.001));
    }

    // --- ORBIT: the world's coordinate system itself breaks -----------------
    const orbitPersist = staged(o, 0) * 0.06;
    const orbitBreak = outcome === 3 && breaking ? p * Math.PI * 1.15 : 0;
    world.rotation.z = orbitPersist + orbitBreak * 0.25;
    world.rotation.y = orbitBreak;
    world.position.y = -orbitPersist * 0.4;
    // Hover preview for ORBIT nudges the same axis so the mechanic is legible
    // before committing.
    world.rotation.y += hover[3] * 0.12 * Math.sin(elapsed * 1.2);

    // --- moon --------------------------------------------------------------
    const moonDrift = Math.sin(elapsed * 0.06) * 0.22 * motion;
    moon.position.set(moonHome.x + moonDrift, moonHome.y + Math.cos(elapsed * 0.05) * 0.14 * motion, moonHome.z);
    let moonScale = 1 + staged(s, 1) * 0.16 + hover[2] * 0.12;
    if (breaking && outcome === 2) moonScale += p * 1.5;
    if (breaking && outcome === 3) {
      // counter-rotate so the rotation reads as the world moving, not the camera
      const ang = -p * Math.PI * 0.8;
      moon.position.x = moonHome.x * Math.cos(ang) - moonHome.z * Math.sin(ang);
      moon.position.z = moonHome.x * Math.sin(ang) + moonHome.z * Math.cos(ang);
    }
    if (breaking && outcome === 4) moonScale *= Math.max(0.05, 1 - p * 0.85);
    moon.scale.setScalar(moonScale);
    halo.position.copy(moon.position);
    // Sprites always face the camera, so no lookAt is needed here.
    halo.scale.setScalar(3.4 * moonScale);
    (halo.material as THREE.SpriteMaterial).opacity =
      Math.max(0, 0.85 + tension * 0.12 - (outcome === 4 && breaking ? p * 0.85 : 0));

    // --- stars -------------------------------------------------------------
    stars.rotation.y = elapsed * 0.004 * motion + (breaking && outcome === 1 ? -p * 0.5 : 0);
    const starTwinkle = 0.85 + Math.sin(elapsed * 1.7) * 0.06 * motion;
    (stars.material as THREE.PointsMaterial).opacity =
      (breaking && outcome === 4 ? starTwinkle * Math.max(0.08, 1 - p) : starTwinkle) *
      (1 - staged(v, 2) * 0.12);

    // --- motes -------------------------------------------------------------
    const moteAttr = moteGeo.getAttribute('position') as THREE.BufferAttribute;
    const moteArr = moteAttr.array as Float32Array;
    for (let i = 0; i < MOTE_COUNT; i++) {
      const i3 = i * 3;
      const ph = motePhase[i];
      let mx = moteHome[i3] + Math.sin(elapsed * 0.32 + ph) * 0.22 * motion;
      let my = moteHome[i3 + 1] + Math.sin(elapsed * 0.45 + ph * 1.7) * 0.16 * motion;
      let mz = moteHome[i3 + 2] + Math.cos(elapsed * 0.28 + ph) * 0.22 * motion;

      // GRAVITY hover/break lifts the motes first — they're the lightest thing
      // in the scene, so they telegraph the law before anything heavy moves.
      my += hover[0] * 0.5 + staged(g, 0) * 0.2;
      if (breaking && outcome === 0) my += easeInCubic(progress) * 6.5;
      if (breaking && outcome === 4) {
        const pull = easeInCubic(progress);
        mx += (0 - mx) * pull;
        my += (0.9 - my) * pull;
        mz += (0 - mz) * pull;
      }
      if (hover[4] > 0) {
        mx += (0 - mx) * hover[4] * 0.25;
        my += (0.9 - my) * hover[4] * 0.25;
        mz += (0 - mz) * hover[4] * 0.25;
      }
      moteArr[i3] = mx;
      moteArr[i3 + 1] = my;
      moteArr[i3 + 2] = mz;
    }
    moteAttr.needsUpdate = true;
    (motes.material as THREE.PointsMaterial).opacity = 0.7 * (1 - staged(v, 1) * 0.15);

    // --- VOID singularity ---------------------------------------------------
    const voidActive = (breaking && outcome === 4) || v > 0 || hover[4] > 0.01;
    singularity.visible = voidActive;
    accretion.visible = voidActive;
    if (voidActive) {
      // Sized against the ring, not the old wide shot this was first tuned
      // for: the five positions sit at radius 1.62, so a 1.5-radius sphere at
      // the centre geometrically swallows the entire board and the step stops
      // being readable at the exact moment it matters. VOID should open a hole
      // in the middle of the world, not replace the world.
      const scarScale = staged(v, 0) * 0.05;
      const hoverScale = hover[4] * 0.08;
      const breakScale = breaking && outcome === 4 ? easeInCubic(progress) * 0.5 : 0;
      singularity.scale.setScalar(Math.max(0.001, scarScale + hoverScale + breakScale));
      accretion.scale.setScalar(Math.max(0.001, (scarScale + hoverScale + breakScale) * 1.1));
      accretion.rotation.z = elapsed * 0.6;
      accretion.rotation.x = Math.PI * 0.42;
      (accretion.material as THREE.MeshBasicMaterial).opacity =
        Math.min(0.75, scarScale * 2 + hoverScale * 3 + breakScale * 0.6);
    }

    // --- TIME ghosts --------------------------------------------------------
    const ghostStrength =
      staged(t, 0) * 0.14 + hover[1] * 0.2 + (breaking && outcome === 1 ? p * 0.45 : 0);
    const ghostsVisible = ghostStrength > 0.005;
    for (const ghost of ghosts) ghost.visible = ghostsVisible;
    if (ghostsVisible) {
      ghostMat.opacity = Math.min(0.5, ghostStrength);
      const wobble = Math.sin(elapsed * 3.1) * 0.03;
      houseGhost.position.x = house.position.x - 0.42 + wobble;
      houseGhost.position.y = house.position.y;
      treeGhost.position.x = treeEntries[0].object.position.x + 0.38 - wobble;
      treeGhost.position.y = treeEntries[0].object.position.y;
    }

    // --- fog + lighting react ----------------------------------------------
    const fog = scene.fog as THREE.Fog;
    if (breaking && outcome === 4) {
      fog.near = 13 - p * 9;
      fog.far = 34 - p * 23;
    } else {
      fog.near = 13 - staged(v, 0) * 0.9;
      fog.far = 34 - staged(v, 0) * 2.8 - tension * 1.7;
    }
    moonLight.intensity =
      1.15 * (1 - (breaking && outcome === 4 ? p * 0.8 : 0)) * (1 - staged(v, 2) * 0.1) +
      tension * 0.12;
    hemi.intensity = 0.85 - staged(v, 1) * 0.06 + hover[1] * 0.1;

    // --- the ring, the Anchor, and the arc ----------------------------------
    // The pads answer to the arc, and the arc only exists once the step has
    // resolved on-chain. During 'anticipation' every pad is equally lit,
    // because at that moment every pad is equally dangerous and the word that
    // decides has not been drawn yet. Nothing here can hint at it.
    for (let i = 0; i < 5; i++) {
      const inArc =
        state.arc !== null && (i + 5 - state.arc.start) % 5 < state.arc.length;
      padHit[i] = damp(padHit[i], inArc ? 1 : 0, inArc ? 7 : 2.5, dt);

      const isHere = i === state.anchor;
      const pad = pads[i];
      const mat = padMats[i];
      // Standing on a pad lights it; the tension pulse runs through all five.
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 3.4 + i * 1.25);
      mat.opacity =
        0.14 +
        (isHere ? 0.22 : 0) +
        tension * 0.18 * pulse -
        padHit[i] * 0.1;
      mat.color.setHex(padHit[i] > 0.02 ? 0xff7a6a : isHere ? 0xffd98a : 0x8fa8d8);
      // A struck position drops away and tilts, as if the ground under it went.
      pad.position.y = -padHit[i] * 0.75;
      pad.rotation.z = padHit[i] * 0.45 * (i % 2 === 0 ? 1 : -1);
      pad.scale.setScalar(1 + padHit[i] * 0.35);
    }

    // The Anchor travels to its pad rather than cutting to it.
    const home = RING[Math.max(0, Math.min(state.anchor, 4))];
    anchorGroup.position.x = damp(anchorGroup.position.x, home.x, 9, dt);
    anchorGroup.position.z = damp(anchorGroup.position.z, home.z, 9, dt);
    anchorMesh.rotation.y += dt * (0.8 + tension * 2.6);
    anchorMesh.rotation.x = Math.sin(elapsed * 0.9) * 0.18;
    // Riding out the strike: if the arc took this position, the Anchor goes
    // down with it. If it did not, it holds absolutely still — surviving
    // should look like surviving, not like a near miss.
    const anchorLost = state.struck ? padHit[Math.max(0, Math.min(state.anchor, 4))] : 0;
    anchorGroup.position.y = -anchorLost * 0.8;
    anchorMat.emissiveIntensity = 1.6 * (1 - anchorLost) + tension * 0.9;
    beamMat.opacity = (0.5 + tension * 0.35) * (1 - anchorLost);
    anchorMesh.scale.setScalar(1 - anchorLost * 0.7);

    // --- camera -------------------------------------------------------------
    // Very restrained: a slow idle drift, a push-in under tension, and a small
    // kick on the break. Camera moves are the easiest way to make a scene feel
    // cheap, so this stays subtle.
    const driftX = Math.sin(elapsed * 0.11) * 0.18 * motion;
    const driftY = Math.cos(elapsed * 0.09) * 0.1 * motion;
    let camX = cameraHome.x + driftX;
    let camY = cameraHome.y + driftY;
    let camZ = cameraHome.z - tension * 0.5;
    if (breaking && outcome !== null) {
      if (outcome === 0) camY += p * 1.1; // follow the rising world
      if (outcome === 2) camZ += p * 1.6; // pull back from the growing house
      if (outcome === 4) camZ -= p * 0.5; // drawn toward the singularity
      const shake = (1 - progress) * 0.05 * motion;
      camX += Math.sin(elapsed * 41) * shake;
      camY += Math.cos(elapsed * 37) * shake;
    }
    camera.position.set(camX, camY, camZ);
    camera.lookAt(lookTarget);

    renderer.render(scene, camera);
  };

  resize();
  raf = requestAnimationFrame(frame);

  // Pause entirely when the tab is hidden — a WebGL loop running in a
  // background tab is pure battery burn on mobile.
  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (raf === 0) {
      clock.getDelta(); // discard the gap so nothing jumps
      raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  const dispose = () => {
    cancelAnimationFrame(raf);
    document.removeEventListener('visibilitychange', onVisibility);
    for (const d of disposables) d.dispose();
    renderer.dispose();
  };

  return { setState, resize, dispose };
}
