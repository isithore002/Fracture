import { encodeAbiParameters } from 'viem';
import type { HostApiV1, HostSnapshotV1 } from '@chain/casino-sdk/guest';

import {
  bucketToOutcome,
  decodeGameState,
  encodeGameData,
  payoutFor,
  type Reality,
} from './fracture';

/**
 * Standalone demo host.
 *
 * The jam requires the hosted page to be playable outside the chain.wtf iframe,
 * so when the Penpal handshake never resolves we mount this instead of a dead
 * "waiting for host" screen. It implements the same `HostApiV1` surface and
 * pushes the same `HostSnapshotV1` shape, so `App.tsx` has exactly one code
 * path — there is no "demo branch" threaded through the UI.
 *
 * The outcome mapping is the contract's, byte for byte (reject >= 200, then
 * % 100, then the 45/25/15/10/5 ranges), drawn from `crypto.getRandomValues`.
 * This is a local demo with play money and no chain: it is NOT the VRF path
 * and never settles anything. Real-money rounds inside the host always go
 * through the contract and Chain's VRF.
 */

const DEMO_TOKEN = { symbol: 'chUSD', decimals: 18 };
const STARTING_BALANCE = 1000n * 10n ** 18n;
/** Matches the local simulator's VRF round-trip closely enough to feel real. */
const DEMO_SETTLE_DELAY_MS = 900;

const MANIFEST = {
  schemaVersion: 1 as const,
  gameId: 'FractureGame',
  apiVersion: 1 as const,
  defaultLocale: 'en',
  locales: { en: { name: 'Fracture', description: 'Predict which law of reality breaks.' } },
  presentation: {
    mode: 'full-iframe' as const,
    hostPanels: { openSession: false, history: false, status: false },
  },
  capabilities: {
    openSession: true as const,
    submitAction: false,
    forfeitExpiredSession: false,
    cancelStuckRandomness: false,
    resize: true,
  },
};

function randomBucket(): number {
  const buf = new Uint8Array(32);
  for (;;) {
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (byte < 200) return byte % 100;
    }
    // Every byte rejected: draw a fresh word. Probability ~2e-21 per pass.
  }
}

type DemoSession = {
  sessionId: string;
  sessionKey: string;
  prediction: Reality;
  wager: bigint;
  phase: number;
  payout: bigint;
  gameState?: `0x${string}`;
  randomness?: `0x${string}`;
  isSettled: boolean;
  /** Winnings stay out of the displayed balance until `revealOutcome`. */
  revealed: boolean;
};

export type DemoHost = {
  hostApi: HostApiV1;
  subscribe: (fn: (snapshot: HostSnapshotV1) => void) => () => void;
};

export function createDemoHost(): DemoHost {
  let balance = STARTING_BALANCE;
  let nextId = 1;
  const sessions: DemoSession[] = [];
  const listeners = new Set<(s: HostSnapshotV1) => void>();

  const snapshot = (): HostSnapshotV1 => ({
    apiVersion: 1,
    integration: {
      chainId: 0,
      slug: 'fracture-demo',
      gameAddress: '0x0000000000000000000000000000000000000000',
      manifest: MANIFEST,
    },
    wallet: { status: 'ready', address: '0x000000000000000000000000000000000000dEmo' },
    token: DEMO_TOKEN,
    balances: { smartVaultBalance: balance.toString() },
    sessions: {
      items: sessions.map(s => ({
        sessionId: s.sessionId,
        sessionKey: s.sessionKey,
        gameAddress: '0x0000000000000000000000000000000000000000',
        phase: s.phase,
        wager: s.wager.toString(),
        payout: s.payout.toString(),
        isSettled: s.isSettled,
        lastEventTimestamp: Date.now(),
        raw: { gameState: s.gameState, randomness: s.randomness },
      })),
    },
    ui: { locale: 'en', theme: 'dark' },
  });

  const push = () => {
    const next = snapshot();
    for (const fn of listeners) fn(next);
  };

  const hostApi = {
    async openSession({ wager, gameData }: { wager: string; gameData: `0x${string}` }) {
      const amount = BigInt(wager);
      if (amount > balance) throw new Error('Insufficient demo balance');

      // gameData is the abi-encoded uint8 prediction the contract would read.
      const prediction = Number(BigInt(gameData)) as Reality;
      balance -= amount;

      const session: DemoSession = {
        sessionId: String(nextId),
        sessionKey: `demo-${nextId}`,
        prediction,
        wager: amount,
        phase: 1, // WAITING_RANDOMNESS
        payout: 0n,
        isSettled: false,
        revealed: false,
      };
      nextId += 1;
      sessions.push(session);
      push();

      setTimeout(() => {
        const bucket = randomBucket();
        const outcome = bucketToOutcome(bucket);
        const won = outcome === prediction;
        const payout = won ? payoutFor(amount, prediction) : 0n;

        const randomness = (`0x${bucket.toString(16).padStart(2, '0')}${'00'.repeat(31)}`) as `0x${string}`;
        session.phase = 3; // SETTLED
        session.isSettled = true;
        session.payout = payout;
        session.randomness = randomness;
        session.gameState = encodeAbiParameters(
          [
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
          ],
          [{ prediction, outcome, bucket, resolved: true, won, randomness }],
        );
        // Deliberately NOT credited here. The real host withholds winnings
        // from its balance display between `openSession` and the game's
        // `revealOutcome` call, so the balance can't spoil the outcome while
        // the world is still breaking. Mirroring that here keeps demo mode
        // honest: if the game forgot to call `revealOutcome`, the bug shows
        // up in demo exactly as it would in production.
        push();
      }, DEMO_SETTLE_DELAY_MS);

      return { sessionKey: session.sessionKey, transactionHash: '0x' as `0x${string}` };
    },
    async submitAction() {
      throw new Error('Fracture has no mid-session actions');
    },
    async cancelStuckRandomness() {
      throw new Error('Not reachable in demo mode');
    },
    async revealOutcome({ sessionId }: { sessionId: string }) {
      // Release the withheld winnings, the same way the real host does once
      // the game says its result presentation has finished.
      const session = sessions.find(s => s.sessionId === sessionId);
      if (!session || session.revealed || session.payout === 0n) return;
      session.revealed = true;
      balance += session.payout;
      push();
    },
    async reportContentSize() {
      /* no-op */
    },
  } as unknown as HostApiV1;

  return {
    hostApi,
    subscribe(fn) {
      listeners.add(fn);
      fn(snapshot());
      return () => listeners.delete(fn);
    },
  };
}

// Re-exported so App.tsx can decode demo sessions with the same helper it uses
// for real ones.
export { decodeGameState, encodeGameData };
