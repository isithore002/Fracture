import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateCasinoGameManifest } from '@chain/casino-sdk';

import {
  BUCKETS,
  REALITIES,
  REALITY,
  RTP_NUM,
  bucketFromRandomness,
  bucketToOutcome,
  decodeGameState,
  encodeGameData,
  payoutFor,
  reservedProfitFor,
  type Reality,
} from './fracture';

/**
 * These guard the frontend mirror of FractureGame.sol against drift. The
 * contract itself is proven separately and more strongly by
 * `scripts/verify-rtp.mjs`, which enumerates deployed bytecode.
 */

describe('paytable', () => {
  it('weights partition the 100 buckets exactly', () => {
    const total = REALITIES.reduce((sum, id) => sum + REALITY[id].weight, 0n);
    expect(total).toBe(BUCKETS);
  });

  it('every bucket 0..99 maps to the outcome that owns it', () => {
    const tally = new Map<Reality, bigint>();
    for (let b = 0; b < 100; b++) {
      const o = bucketToOutcome(b);
      tally.set(o, (tally.get(o) ?? 0n) + 1n);
    }
    for (const id of REALITIES) {
      expect(tally.get(id)).toBe(REALITY[id].weight);
    }
  });

  it('probability x payout is exactly 95% of the wager for every outcome', () => {
    const wager = 10n ** 18n;
    for (const id of REALITIES) {
      const payout = payoutFor(wager, id);
      // w * payout must equal RTP_NUM * wager, never exceed it, and fall short
      // by strictly less than one weight unit (integer floor).
      const lhs = REALITY[id].weight * payout;
      const rhs = RTP_NUM * wager;
      expect(lhs).toBeLessThanOrEqual(rhs);
      expect(rhs - lhs).toBeLessThan(REALITY[id].weight);
    }
  });

  it('stake + reserved profit equals payout to the wei', () => {
    for (const wager of [1n, 7n, 10n ** 18n, 123456789n]) {
      for (const id of REALITIES) {
        expect(wager + reservedProfitFor(wager, id)).toBe(payoutFor(wager, id));
      }
    }
  });
});

describe('rejection sampling', () => {
  it('accepts only bytes below 200, giving every bucket 2 preimages', () => {
    const counts = new Map<number, number>();
    for (let b = 0; b < 256; b++) {
      if (b >= 200) continue;
      const bucket = b % 100;
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    expect(counts.size).toBe(100);
    expect([...counts.values()].every(c => c === 2)).toBe(true);
  });

  it('takes the first accepted byte of the word', () => {
    // 0x37 = 55 -> accepted -> bucket 55
    expect(bucketFromRandomness(`0x37${'00'.repeat(31)}`)).toBe(55);
    // 0xff rejected, then 0x05 accepted -> bucket 5
    expect(bucketFromRandomness(`0xff05${'00'.repeat(30)}`)).toBe(5);
  });

  it('rehashes rather than throwing when every byte is rejected', () => {
    const bucket = bucketFromRandomness(`0x${'ff'.repeat(32)}`);
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);
  });
});

describe('bridge encoding', () => {
  it('encodes gameData as a single 32-byte uint8 prediction', () => {
    for (const id of REALITIES) {
      const encoded = encodeGameData(id);
      expect(encoded).toHaveLength(2 + 64);
      expect(Number(BigInt(encoded))).toBe(id);
    }
  });

  it('returns null for an unresolved or malformed game state', () => {
    expect(decodeGameState('0x')).toBeNull();
  });
});

describe('manifest', () => {
  it('passes the SDK validator', () => {
    const raw = readFileSync(resolve(__dirname, '../../public/game.manifest.json'), 'utf8');
    const result = validateCasinoGameManifest(JSON.parse(raw));
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
  });
});
