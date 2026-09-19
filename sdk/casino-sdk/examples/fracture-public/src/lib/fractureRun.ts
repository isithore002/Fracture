import { decodeAbiParameters, encodeAbiParameters, hexToBytes, keccak256 } from 'viem';

import { type Reality } from './fracture';

/**
 * Mirror of FractureRunGame.sol. Every constant here has a counterpart in the
 * contract, and `scripts/verify-run-rtp.mjs` proves the contract's own version
 * by enumeration against deployed bytecode. This file must never become a
 * second, independent source of truth — if you change a hazard or a multiplier,
 * change it in the contract and re-run the proof.
 */

export const POSITIONS = 5;
export const MAX_STEPS = 10;

/** floor(256 / 5) * 5 — only byte 255 is rejected. */
const DRAW_REJECT = 255;

export type Position = 0 | 1 | 2 | 3 | 4;

export const ANCHORS = [0, 1, 2, 3, 4] as const;

type AnchorInfo = {
  id: Position;
  key: string;
  name: string;
  /** Where it sits in the world, for the readout. */
  blurb: string;
};

/**
 * The ring, in adjacency order. An arc destroys a contiguous run of these, so
 * the order is the geometry: neighbours in this list are neighbours in the
 * world and are destroyed together.
 */
export const ANCHOR: Record<Position, AnchorInfo> = {
  0: { id: 0, key: 'hilltop', name: 'Hilltop', blurb: 'High ground, nothing above it' },
  1: { id: 1, key: 'orchard', name: 'Orchard', blurb: 'Under the three old trees' },
  2: { id: 2, key: 'hearth', name: 'Hearth', blurb: 'Inside, where the lights are on' },
  3: { id: 3, key: 'fenceline', name: 'Fenceline', blurb: 'Out at the edge of the plot' },
  4: { id: 4, key: 'hollow', name: 'Hollow', blurb: 'Low ground, down among the rocks' },
};

// ---------------------------------------------------------------------------
// Paytable
// ---------------------------------------------------------------------------

/** The contract's `hazardAt`: how many of the five positions a step destroys. */
export function hazardAt(step: number): number {
  if (step <= 4) return 1;
  if (step <= 8) return 2;
  return 3;
}

/**
 * The contract's `multiplierOf`, as exact rationals.
 *
 * Each entry is RTP / S_k — 0.95 divided by the chance of surviving that far —
 * which is what makes the expected return exactly 95% at every single one of
 * these rows. See the contract header for the derivation.
 */
const MULTIPLIER: Record<number, { num: bigint; den: bigint }> = {
  1: { num: 19n, den: 16n },
  2: { num: 95n, den: 64n },
  3: { num: 475n, den: 256n },
  4: { num: 2375n, den: 1024n },
  5: { num: 11875n, den: 3072n },
  6: { num: 59375n, den: 9216n },
  7: { num: 296875n, den: 27648n },
  8: { num: 1484375n, den: 82944n },
  9: { num: 7421875n, den: 165888n },
  10: { num: 37109375n, den: 331776n },
};

/** payout = wager * num / den — the contract's `payoutFor`, to the wei. */
export function payoutFor(wager: bigint, step: number): bigint {
  const m = MULTIPLIER[step];
  if (!m) return 0n;
  return (wager * m.num) / m.den;
}

/** Display multiplier, e.g. 6.4426 at step 6. Never used for settlement math. */
export function multiplierAt(step: number): number {
  const m = MULTIPLIER[step];
  if (!m) return 1;
  return Number(m.num) / Number(m.den);
}

/** Chance of surviving the step about to be taken, as a percentage. */
export function stepSurvivalPct(step: number): number {
  return ((POSITIONS - hazardAt(step)) / POSITIONS) * 100;
}

/** Chance of a fresh run reaching `step` alive, as a percentage. */
export function reachPct(step: number): number {
  let p = 1;
  for (let k = 1; k <= step; k++) p *= (POSITIONS - hazardAt(k)) / POSITIONS;
  return p * 100;
}

// ---------------------------------------------------------------------------
// Randomness — the contract's draw, byte for byte
// ---------------------------------------------------------------------------

/**
 * The contract's `drawFromRandomness`: reject byte 255 so all five positions
 * get exactly 51 preimages, then take two independent draws from the same word
 * — the arc start, and which law did the breaking.
 */
export function drawFromRandomness(randomness: `0x${string}`): {
  arcStart: Position;
  law: Reality;
} {
  let seed = hexToBytes(randomness);
  let index = 0;
  const draws: number[] = [];
  while (draws.length < 2) {
    if (index === seed.length) {
      seed = hexToBytes(keccak256(seed));
      index = 0;
    }
    const sample = seed[index];
    index += 1;
    if (sample < DRAW_REJECT) draws.push(sample % POSITIONS);
  }
  return { arcStart: draws[0] as Position, law: draws[1] as Reality };
}

/**
 * The contract's `isStruck`. For any fixed position exactly `length` of the
 * five arc starts contain it — which is why no anchor is safer than another.
 */
export function isStruck(position: number, arcStart: number, length: number): boolean {
  return (position + POSITIONS - arcStart) % POSITIONS < length;
}

/** The positions an arc destroys, in ring order. */
export function arcPositions(arcStart: number, length: number): Position[] {
  return Array.from({ length }, (_, i) => ((arcStart + i) % POSITIONS) as Position);
}

// --- bridge encoding --------------------------------------------------------

/** gameData is a single abi-encoded uint8 anchor position (32 bytes). */
export function encodeGameData(position: Position): `0x${string}` {
  return encodeAbiParameters([{ type: 'uint8' }], [position]);
}

export const ACTION_CASH_OUT = 0;
export const ACTION_CONTINUE = 1;

/** actionData is `abi.encode(uint8 action, uint8 position)` (64 bytes). */
export function encodeAction(action: 0 | 1, position: Position): `0x${string}` {
  return encodeAbiParameters([{ type: 'uint8' }, { type: 'uint8' }], [action, position]);
}

const STATE_PARAMS = [
  {
    type: 'tuple',
    components: [
      { name: 'step', type: 'uint8' },
      { name: 'position', type: 'uint8' },
      { name: 'arcStart', type: 'uint8' },
      { name: 'arcLength', type: 'uint8' },
      { name: 'law', type: 'uint8' },
      { name: 'struck', type: 'bool' },
      { name: 'cashedOut', type: 'bool' },
      { name: 'randomness', type: 'bytes32' },
    ],
  },
] as const;

export type RunState = {
  /** Steps survived so far. */
  step: number;
  /** The anchor committed for the step in flight. */
  position: Position;
  arcStart: Position;
  arcLength: number;
  law: Reality;
  struck: boolean;
  cashedOut: boolean;
  randomness: `0x${string}`;
};

/** Decodes the contract's RunState from a session's gameState. */
export function decodeRunState(gameState: `0x${string}`): RunState | null {
  try {
    const [state] = decodeAbiParameters(STATE_PARAMS, gameState);
    return {
      step: state.step,
      position: state.position as Position,
      arcStart: state.arcStart as Position,
      arcLength: state.arcLength,
      law: state.law as Reality,
      struck: state.struck,
      cashedOut: state.cashedOut,
      randomness: state.randomness,
    };
  } catch {
    return null;
  }
}

export function encodeRunState(state: RunState): `0x${string}` {
  return encodeAbiParameters(STATE_PARAMS, [state]);
}

/**
 * Largest wager the casino's live risk limit allows.
 *
 * Run mode commits the WHOLE ladder up front — `quoteCaps` reserves the
 * step-10 payout at `openSession`, whether or not the player ever gets there —
 * so the exposure per bet is ~110.85x the stake rather than the 18x of the
 * original game. Deriving the ceiling from the host's own number is the only
 * safe way to size a bet; a hard-coded maximum would start reverting the
 * moment vault liquidity moved.
 */
export function maxWagerFor(maxAllowedReservedProfit: bigint): bigint {
  const top = MULTIPLIER[MAX_STEPS];
  // reserve = wager * num/den - wager <= limit  =>  wager <= limit * den / (num - den)
  return (maxAllowedReservedProfit * top.den) / (top.num - top.den);
}
