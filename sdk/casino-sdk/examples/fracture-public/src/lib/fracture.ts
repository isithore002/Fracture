import { decodeAbiParameters, encodeAbiParameters, hexToBytes, keccak256 } from 'viem';

/**
 * Mirror of FractureGame.sol. Every constant here has a counterpart in the
 * contract, and `scripts/verify-rtp.mjs` proves the contract's own version by
 * enumeration against deployed bytecode. This file must never become a second,
 * independent source of truth — if you change a weight, change it in the
 * contract and re-run the proof.
 */

export const RTP_NUM = 95n;
export const BUCKETS = 100n;

/** floor(256 / 100) * 100 — bytes at or above this are rejected. */
const ROLL_REJECT = 200;

export type Reality = 0 | 1 | 2 | 3 | 4;

export const REALITIES = [0, 1, 2, 3, 4] as const;

type RealityInfo = {
  id: Reality;
  key: string;
  name: string;
  /** Bucket count out of 100. These sum to exactly 100. */
  weight: bigint;
  tagline: string;
};

export const REALITY: Record<Reality, RealityInfo> = {
  0: { id: 0, key: 'gravity', name: 'Gravity', weight: 45n, tagline: 'Everything falls upward' },
  1: { id: 1, key: 'time', name: 'Time', weight: 25n, tagline: 'The world runs backward' },
  2: { id: 2, key: 'scale', name: 'Scale', weight: 15n, tagline: 'Big turns small, small turns huge' },
  3: { id: 3, key: 'orbit', name: 'Orbit', weight: 10n, tagline: 'The world swings off its axis' },
  4: { id: 4, key: 'void', name: 'Void', weight: 5n, tagline: 'Everything collapses to nothing' },
};

/** payout = wager * 95 / w — the contract's `payoutFor`, to the wei. */
export function payoutFor(wager: bigint, outcome: Reality): bigint {
  return (wager * RTP_NUM) / REALITY[outcome].weight;
}

export function reservedProfitFor(wager: bigint, outcome: Reality): bigint {
  const payout = payoutFor(wager, outcome);
  return payout > wager ? payout - wager : 0n;
}

/** Display multiplier, e.g. 2.1111 for Gravity. Never used for settlement math. */
export function multiplierOf(outcome: Reality): number {
  return Number(RTP_NUM) / Number(REALITY[outcome].weight);
}

/** Win chance as a percentage, e.g. 45. */
export function chanceOf(outcome: Reality): number {
  return Number(REALITY[outcome].weight);
}

/** The contract's `bucketToOutcome`: ranges are exactly 45/25/15/10/5 wide. */
export function bucketToOutcome(bucket: number): Reality {
  if (bucket < 45) return 0;
  if (bucket < 70) return 1;
  if (bucket < 85) return 2;
  if (bucket < 95) return 3;
  return 4;
}

/**
 * The contract's `bucketFromRandomness`, byte for byte: reject any byte >= 200
 * so all 100 buckets get exactly 2 preimages each, rehashing the seed rather
 * than reverting if a whole word is rejected.
 */
export function bucketFromRandomness(randomness: `0x${string}`): number {
  let seed = hexToBytes(randomness);
  let index = 0;
  for (;;) {
    if (index === seed.length) {
      seed = hexToBytes(keccak256(seed));
      index = 0;
    }
    const sample = seed[index];
    index += 1;
    if (sample < ROLL_REJECT) return sample % 100;
  }
}

export function outcomeFromRandomness(randomness: `0x${string}`): Reality {
  return bucketToOutcome(bucketFromRandomness(randomness));
}

// --- bridge encoding --------------------------------------------------------

/** gameData is a single abi-encoded uint8 prediction (32 bytes). */
export function encodeGameData(prediction: Reality): `0x${string}` {
  return encodeAbiParameters([{ type: 'uint8' }], [prediction]);
}

const STATE_PARAMS = [
  {
    type: 'tuple',
    components: [
      { name: 'prediction', type: 'uint8' },
      { name: 'outcome', type: 'uint8' },
      { name: 'bucket', type: 'uint8' },
      { name: 'resolved', type: 'bool' },
      { name: 'won', type: 'bool' },
      { name: 'randomness', type: 'bytes32' },
    ],
  },
] as const;

export type FractureResult = {
  prediction: Reality;
  outcome: Reality;
  bucket: number;
  won: boolean;
  randomness: `0x${string}`;
};

/** Decodes the contract's FractureState from a settled session's gameState. */
export function decodeGameState(gameState: `0x${string}`): FractureResult | null {
  try {
    const [state] = decodeAbiParameters(STATE_PARAMS, gameState);
    if (!state.resolved) return null;
    return {
      prediction: state.prediction as Reality,
      outcome: state.outcome as Reality,
      bucket: state.bucket,
      won: state.won,
      randomness: state.randomness,
    };
  } catch {
    return null;
  }
}

/** SessionPhase.SETTLED */
export const PHASE_SETTLED = 3;

export function isTerminalPhase(phase: number | undefined): boolean {
  return phase !== undefined && phase >= PHASE_SETTLED;
}
