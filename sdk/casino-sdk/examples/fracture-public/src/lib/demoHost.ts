import { bytesToHex } from 'viem';
import type { HostApiV1, HostSnapshotV1 } from '@chain/casino-sdk/guest';

import {
  ACTION_CONTINUE,
  MAX_STEPS,
  decodeRunState,
  drawFromRandomness,
  encodeGameData,
  encodeRunState,
  hazardAt,
  isStruck,
  payoutFor,
  type Position,
  type RunState,
} from './fractureRun';

/**
 * Standalone demo host.
 *
 * The jam requires the hosted page to be playable outside the chain.wtf iframe,
 * so when the Penpal handshake never resolves we mount this instead of a dead
 * "waiting for host" screen. It implements the same `HostApiV1` surface and
 * pushes the same `HostSnapshotV1` shape, so `App.tsx` has exactly one code
 * path — there is no "demo branch" threaded through the UI.
 *
 * It reproduces the multi-step session lifecycle faithfully, including the part
 * that matters most: a step's random word is drawn only AFTER the anchor is
 * committed, one fresh word per step. Doing it any other way here would hide
 * the exact class of bug the real design exists to prevent.
 *
 * This is a local demo with play money and no chain: it is NOT the VRF path and
 * never settles anything. Real-money runs inside the host always go through the
 * contract and Chain's VRF.
 */

const DEMO_TOKEN = { symbol: 'chUSD', decimals: 18 };
const STARTING_BALANCE = 1000n * 10n ** 18n;
/** Matches the local simulator's VRF round-trip closely enough to feel real. */
const DEMO_VRF_DELAY_MS = 850;

const MANIFEST = {
  schemaVersion: 1 as const,
  gameId: 'FractureRunGame',
  apiVersion: 1 as const,
  defaultLocale: 'en',
  locales: {
    en: { name: 'Fracture', description: 'Place your reality. Survive the fracture. Or bank.' },
  },
  presentation: {
    mode: 'full-iframe' as const,
    hostPanels: { openSession: false, history: false, status: false },
  },
  capabilities: {
    openSession: true as const,
    submitAction: true,
    forfeitExpiredSession: true,
    cancelStuckRandomness: true,
    resize: true,
  },
};

const SESSION_PHASE = { WAITING_RANDOMNESS: 1, WAITING_PLAYER_ACTION: 2, SETTLED: 3 } as const;

function randomWord(): `0x${string}` {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

type DemoSession = {
  sessionId: string;
  sessionKey: string;
  wager: bigint;
  phase: number;
  payout: bigint;
  state: RunState;
  isSettled: boolean;
  /** One entry per step, exactly as a multi-step session reports them. */
  requests: Array<{ nonce: string; requestId: `0x${string}`; randomness?: `0x${string}`; fulfilled: boolean }>;
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
    // Run mode reserves the whole ladder up front, so the game derives its
    // maximum bet from this the same way it would against a real vault.
    casino: { maxAllowedReservedProfit: (5000n * 10n ** 18n).toString() },
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
        raw: {
          gameState: encodeRunState(s.state),
          randomness: s.requests.find(r => r.fulfilled)?.randomness,
          randomnessRequests: s.requests,
        },
      })),
    },
    ui: { locale: 'en', theme: 'dark' },
  });

  const push = () => {
    const next = snapshot();
    for (const fn of listeners) fn(next);
  };

  /**
   * Resolve the step now in flight. Mirrors `onRandomness`: draw the arc, see
   * whether the committed anchor was inside it, then either end the run or
   * hand the decision back to the player.
   */
  const resolveStep = (session: DemoSession) => {
    const randomness = randomWord();
    const step = session.state.step + 1;
    const length = hazardAt(step);
    const { arcStart, law } = drawFromRandomness(randomness);

    session.state = { ...session.state, arcStart, arcLength: length, law, randomness };
    const request = session.requests[session.requests.length - 1];
    request.randomness = randomness;
    request.fulfilled = true;

    if (isStruck(session.state.position, arcStart, length)) {
      session.state = { ...session.state, struck: true };
      session.phase = SESSION_PHASE.SETTLED;
      session.isSettled = true;
      session.payout = 0n;
      push();
      return;
    }

    session.state = { ...session.state, step };

    if (step === MAX_STEPS) {
      // The top of the ladder banks itself — there is no decision left.
      session.state = { ...session.state, cashedOut: true };
      session.phase = SESSION_PHASE.SETTLED;
      session.isSettled = true;
      session.payout = payoutFor(session.wager, MAX_STEPS);
      push();
      return;
    }

    session.phase = SESSION_PHASE.WAITING_PLAYER_ACTION;
    push();
  };

  /** Requests a word for the step in flight, then resolves it after a beat. */
  const requestRandomness = (session: DemoSession) => {
    session.requests.push({
      nonce: String(session.requests.length + 1),
      requestId: randomWord(),
      fulfilled: false,
    });
    session.phase = SESSION_PHASE.WAITING_RANDOMNESS;
    push();
    setTimeout(() => resolveStep(session), DEMO_VRF_DELAY_MS);
  };

  const hostApi = {
    async openSession({ wager, gameData }: { wager: string; gameData: `0x${string}` }) {
      const amount = BigInt(wager);
      if (amount > balance) throw new Error('Insufficient demo balance');

      // gameData is the abi-encoded uint8 anchor the contract would read.
      const position = Number(BigInt(gameData)) as Position;
      balance -= amount;

      const session: DemoSession = {
        sessionId: String(nextId),
        sessionKey: `demo-${nextId}`,
        wager: amount,
        phase: SESSION_PHASE.WAITING_RANDOMNESS,
        payout: 0n,
        state: {
          step: 0,
          position,
          arcStart: 0,
          arcLength: 0,
          law: 0,
          struck: false,
          cashedOut: false,
          randomness: `0x${'00'.repeat(32)}`,
        },
        isSettled: false,
        requests: [],
        revealed: false,
      };
      nextId += 1;
      sessions.push(session);
      requestRandomness(session);

      return { sessionKey: session.sessionKey, transactionHash: '0x' as `0x${string}` };
    },

    async submitAction({ sessionId, actionData }: { sessionId: string; actionData: `0x${string}` }) {
      const session = sessions.find(s => s.sessionId === sessionId);
      if (!session) throw new Error('Unknown session');
      if (session.phase !== SESSION_PHASE.WAITING_PLAYER_ACTION) {
        throw new Error('The run is not waiting on you');
      }

      // actionData is abi.encode(uint8 action, uint8 position) — two words.
      const body = actionData.slice(2);
      const action = Number(BigInt(`0x${body.slice(0, 64)}`));
      const position = Number(BigInt(`0x${body.slice(64, 128)}`)) as Position;

      if (action === ACTION_CONTINUE) {
        session.state = { ...session.state, position };
        requestRandomness(session);
      } else {
        session.state = { ...session.state, cashedOut: true };
        session.phase = SESSION_PHASE.SETTLED;
        session.isSettled = true;
        session.payout = payoutFor(session.wager, session.state.step);
        push();
      }

      return { transactionHash: '0x' as `0x${string}` };
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
export { decodeRunState, encodeGameData };
