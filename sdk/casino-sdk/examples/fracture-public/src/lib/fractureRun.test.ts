import { describe, expect, it } from 'vitest';

import {
  ACTION_CASH_OUT,
  ACTION_CONTINUE,
  ANCHORS,
  MAX_STEPS,
  POSITIONS,
  arcPositions,
  decodeRunState,
  drawFromRandomness,
  encodeAction,
  encodeGameData,
  encodeRunState,
  hazardAt,
  isStruck,
  maxWagerFor,
  multiplierAt,
  payoutFor,
  reachPct,
  stepSurvivalPct,
  type Position,
} from './fractureRun';

/**
 * These guard the frontend mirror of FractureRunGame.sol against drift. The
 * contract itself is proven separately and far more strongly by
 * `scripts/verify-run-rtp.mjs`, which enumerates deployed bytecode, and by
 * `scripts/e2e-run.mjs`, which settles real multi-step sessions on chain.
 */

/** RTP as an exact rational: 19/20 == 95%. */
const RTP_NUM = 19n;
const RTP_DEN = 20n;

/** S_k derived from the hazard schedule alone, as an exact fraction. */
function survival(step: number): { num: bigint; den: bigint } {
  let num = 1n;
  let den = 1n;
  for (let k = 1; k <= step; k++) {
    num *= BigInt(POSITIONS - hazardAt(k));
    den *= BigInt(POSITIONS);
  }
  return { num, den };
}

describe('hazard schedule', () => {
  it('escalates 1, then 2, then 3 of the five positions', () => {
    expect([1, 2, 3, 4].map(hazardAt)).toEqual([1, 1, 1, 1]);
    expect([5, 6, 7, 8].map(hazardAt)).toEqual([2, 2, 2, 2]);
    expect([9, 10].map(hazardAt)).toEqual([3, 3]);
  });

  it('reports the survival odds the paytable claims', () => {
    expect(stepSurvivalPct(1)).toBe(80);
    expect(stepSurvivalPct(5)).toBe(60);
    expect(stepSurvivalPct(10)).toBe(40);
  });

  it('reaching the top of the ladder is 0.8493% of runs', () => {
    expect(reachPct(MAX_STEPS)).toBeCloseTo(0.8493, 4);
  });
});

describe('the RTP identity', () => {
  /**
   * The whole economic design in one assertion: the multiplier after k steps
   * is RTP / S_k, so expected value at EVERY stopping point is exactly 95% and
   * no stopping strategy can move it.
   */
  it('S_k x M_k == 95% at every stopping point', () => {
    const wager = 10n ** 18n;
    for (let k = 1; k <= MAX_STEPS; k++) {
      const s = survival(k);
      const payout = payoutFor(wager, k);
      // S_k * payout <= (19/20) * wager, in integers only.
      expect(RTP_DEN * s.num * payout).toBeLessThanOrEqual(RTP_NUM * s.den * wager);
      // ...and within one floored wei of it, i.e. equality up to rounding.
      const shortfall = RTP_NUM * s.den * wager - RTP_DEN * s.num * payout;
      expect(shortfall).toBeLessThan(RTP_DEN * s.num);
    }
  });

  it('never pays above 95%, even at a one-wei wager', () => {
    for (let k = 1; k <= MAX_STEPS; k++) {
      const s = survival(k);
      expect(RTP_DEN * s.num * payoutFor(1n, k)).toBeLessThanOrEqual(RTP_NUM * s.den * 1n);
    }
  });

  it('multipliers strictly increase, so a reserve delta can never go negative', () => {
    const wager = 10n ** 18n;
    for (let k = 2; k <= MAX_STEPS; k++) {
      expect(multiplierAt(k)).toBeGreaterThan(multiplierAt(k - 1));
      expect(payoutFor(wager, k)).toBeGreaterThanOrEqual(payoutFor(wager, k - 1));
    }
  });

  it('matches the published paytable to four places', () => {
    const published = [
      1.1875, 1.4844, 1.8555, 2.3193, 3.8656, 6.4426, 10.7377, 17.8961, 44.7403, 111.8507,
    ];
    published.forEach((want, i) => expect(multiplierAt(i + 1)).toBeCloseTo(want, 4));
  });
});

describe('the arc', () => {
  /**
   * The fairness property the anchor rests on. If this ever fails, some
   * position is safer than another and the declared RTP is a lie.
   */
  it('strikes every position with exactly H of the five arcs', () => {
    for (const length of [1, 2, 3]) {
      for (const position of ANCHORS) {
        const struckBy = ANCHORS.filter(arcStart => isStruck(position, arcStart, length));
        expect(struckBy).toHaveLength(length);
      }
    }
  });

  it('wraps around the ring', () => {
    expect(arcPositions(4, 3)).toEqual([4, 0, 1]);
    expect(arcPositions(3, 2)).toEqual([3, 4]);
    expect(arcPositions(0, 1)).toEqual([0]);
  });

  it('agrees with arcPositions for every start and length', () => {
    for (const length of [1, 2, 3]) {
      for (const start of ANCHORS) {
        const listed = arcPositions(start, length);
        for (const p of ANCHORS) {
          expect(isStruck(p, start, length)).toBe(listed.includes(p));
        }
      }
    }
  });
});

describe('the draw', () => {
  it('rejects only byte 255, leaving 51 preimages per position', () => {
    const tally = new Map<number, number>();
    for (let b = 0; b < 255; b++) tally.set(b % 5, (tally.get(b % 5) ?? 0) + 1);
    expect([...tally.values()]).toEqual([51, 51, 51, 51, 51]);
  });

  it('draws an arc start and a law, both in range, for every leading byte', () => {
    for (let b = 0; b < 256; b++) {
      const word = `0x${b.toString(16).padStart(2, '0')}${'11'.repeat(31)}` as const;
      const { arcStart, law } = drawFromRandomness(word);
      expect(arcStart).toBeGreaterThanOrEqual(0);
      expect(arcStart).toBeLessThan(POSITIONS);
      expect(law).toBeGreaterThanOrEqual(0);
      expect(law).toBeLessThan(POSITIONS);
    }
  });

  it('rehashes instead of hanging when a whole word is rejected', () => {
    const { arcStart, law } = drawFromRandomness(`0x${'ff'.repeat(32)}`);
    expect(arcStart).toBeLessThan(POSITIONS);
    expect(law).toBeLessThan(POSITIONS);
  });
});

describe('bridge encoding', () => {
  it('encodes the anchor as a single 32-byte word', () => {
    for (const id of ANCHORS) {
      const encoded = encodeGameData(id);
      expect(encoded).toHaveLength(66); // 0x + 64 hex chars
      expect(Number(BigInt(encoded))).toBe(id);
    }
  });

  it('encodes an action as two words the contract can split', () => {
    const encoded = encodeAction(ACTION_CONTINUE, 3);
    expect(encoded).toHaveLength(130); // 0x + 128 hex chars
    expect(Number(BigInt(`0x${encoded.slice(2, 66)}`))).toBe(ACTION_CONTINUE);
    expect(Number(BigInt(`0x${encoded.slice(66, 130)}`))).toBe(3);
    expect(Number(BigInt(`0x${encodeAction(ACTION_CASH_OUT, 0).slice(2, 66)}`))).toBe(
      ACTION_CASH_OUT,
    );
  });

  it('round-trips a run state', () => {
    const state = {
      step: 6,
      position: 3 as Position,
      arcStart: 4 as Position,
      arcLength: 2,
      law: 1 as const,
      struck: false,
      cashedOut: false,
      randomness: `0x${'ab'.repeat(32)}` as `0x${string}`,
    };
    expect(decodeRunState(encodeRunState(state))).toEqual(state);
  });

  it('returns null rather than throwing on a malformed game state', () => {
    expect(decodeRunState('0xdeadbeef')).toBeNull();
  });
});

describe('risk limits', () => {
  /**
   * Run mode reserves the whole ladder at `openSession`, so the ceiling has to
   * come from the host's live limit. A wager at the cap must still quote a
   * reserve the host will accept.
   */
  it('derives a wager that fits inside the reserve limit', () => {
    for (const limit of [10n ** 18n, 5000n * 10n ** 18n, 123456789n]) {
      const wager = maxWagerFor(limit);
      const reserve = payoutFor(wager, MAX_STEPS) - wager;
      expect(reserve).toBeLessThanOrEqual(limit);
    }
  });

  it('scales with the limit', () => {
    expect(maxWagerFor(2n * 10n ** 18n)).toBeGreaterThan(maxWagerFor(10n ** 18n));
  });
});
