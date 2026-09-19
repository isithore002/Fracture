import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatUnits, parseUnits } from 'viem';
import type { HostSnapshotV1 } from '@chain/casino-sdk/guest';

type HostSnapshotSessions = HostSnapshotV1['sessions']['items'];

import { useCasinoHost } from './lib/useCasinoHost';
import { REALITIES, REALITY, isTerminalPhase, type Reality } from './lib/fracture';
import {
  ACTION_CASH_OUT,
  ACTION_CONTINUE,
  ANCHOR,
  ANCHORS,
  MAX_STEPS,
  arcPositions,
  decodeRunState,
  encodeAction,
  encodeGameData,
  hazardAt,
  maxWagerFor,
  multiplierAt,
  payoutFor,
  reachPct,
  stepSurvivalPct,
  type Position,
} from './lib/fractureRun';
import { WorldCanvas, type WorldPhase } from './components/WorldCanvas';
import { ArcReadout } from './components/ArcReadout';
import {
  playAnticipation,
  playBank,
  playClimb,
  playLock,
  playLose,
  playOutcome,
  playSelect,
  playSweep,
  playTensionPulse,
  playTick,
  playWin,
  startAmbient,
  unlockAudio,
} from './lib/sound';
import './styles/fracture.css';

const ANCHOR_GLYPH: Record<Position, string> = {
  0: '▲', // hilltop — high ground
  1: '❦', // orchard — the trees
  2: '⌂', // hearth — the house
  3: '⊟', // fenceline — the edge
  4: '▽', // hollow — low ground
};

/**
 * Presentation-only pacing. None of this changes when a step actually resolves
 * on-chain — it only paces how an already-known result is revealed.
 *
 *   commit -> [telegraph, at least MIN_TELEGRAPH_MS] -> HOLD_MS silence
 *   -> the arc lands -> SAFE_MS or FRACTURE_MS -> decision, or run over
 *
 * SAFE is deliberately short and FRACTURE is long: a climbing run should feel
 * fast, and the moment it ends should not.
 */
const MIN_TELEGRAPH_MS = 620;
/** A beat of near-silence right before the arc lands. */
const HOLD_MS = 180;
/** Surviving: a quick pulse, then straight back to the decision. */
const SAFE_MS = 460;
/** The run ending: the full law transformation gets its weight. */
const FRACTURE_MS = 1500;
/** Floor on the "committed" beat so a fast open doesn't cut the lock flash. */
const LOCK_MS = 380;
/** Cadence of the soft "still waiting" pulse, matched to the CSS tension loop. */
const TENSION_PULSE_MS = 1400;

/**
 * Damage saturates here. A cap is what keeps persistence from turning into
 * visual noise: the world can look thoroughly wrecked, but it can't accumulate
 * forever and it can't get unreadable.
 */
export const MAX_DAMAGE = 5;

/** One resolved step, kept for the run log. */
type StepRecord = {
  step: number;
  anchor: Position;
  arcStart: Position;
  arcLength: number;
  law: Reality;
  struck: boolean;
};

type RunPhase =
  /** No run open. Place a wager, place an anchor. */
  | 'idle'
  /** A transaction is in flight (openSession, or an action). */
  | 'committing'
  /** The VRF word for the step in flight does not exist yet. */
  | 'awaiting'
  /** The result is known; the arc is landing on screen. */
  | 'resolving'
  /** Survived. CASH OUT, or ONE MORE. */
  | 'choosing'
  /** Over — struck, or banked. */
  | 'over';

type Run = {
  /** Local id for this run; never compared against host data. */
  id: number;
  /**
   * The key the host handed back from `openSession`. The host opens with an
   * optimistic `pending:<uuid>` row and later swaps it for the real session id,
   * so this key can go stale — `knownKeys` is what actually finds our row.
   */
  sessionKey?: string;
  /** The host's real session id. Needed for `submitAction` and `revealOutcome`. */
  sessionId?: string;
  /**
   * Hash of the transaction that opened this run. The most reliable handle we
   * get back from `openSession` — unlike `sessionKey` it cannot be swapped out
   * from under us, so it is what pins the run to its row before the session id
   * is known.
   */
  openTxHash?: `0x${string}`;
  /** Session keys that already existed when we opened, so we can spot ours. */
  knownKeys: string[];
  wager: bigint;
  /** Steps survived so far. */
  step: number;
  /** How many step resolutions have been presented — the replay guard. */
  presented: number;
  phase: RunPhase;
  log: StepRecord[];
  /** The step currently landing on screen. */
  landing?: StepRecord;
  ended?: 'struck' | 'banked';
  payout?: bigint;
  /** ms since epoch when the current step was committed. */
  committedAt: number;
};

/**
 * Finds this run's session row.
 *
 * The host pushes an optimistic `pending:<uuid>` row the moment `openSession`
 * is called, then replaces it with the real session id once the transaction is
 * observed — and the SDK documents that both arrival orders happen. Matching on
 * the key `openSession` returned therefore loses the row exactly when it
 * settles. We match the returned key when it is still present, and otherwise
 * take the newest row that was not there before we opened.
 */
function findRow(items: HostSnapshotSessions, run: Run): HostSnapshotSessions[number] | undefined {
  // Identity, strongest first. A run lives across many pushes and many steps,
  // and several of its own sessions can be live at once, so the row has to be
  // pinned rather than re-guessed every time.
  if (run.sessionId) {
    const byId = items.find(item => item.sessionId === run.sessionId);
    if (byId) return byId;
  }
  // The hash of the transaction that opened this run. Exact, and immune to the
  // host swapping its optimistic `pending:<uuid>` key for the real session id.
  if (run.openTxHash) {
    const byTx = items.find(item => item.raw.openTransactionHash === run.openTxHash);
    if (byTx) return byTx;
  }
  if (run.sessionKey) {
    const direct = items.find(item => item.sessionKey === run.sessionKey);
    if (direct) return direct;
  }

  // Last resort, and deliberately narrow. The old single-shot game could take
  // "newest row we had not seen before" because a round settled within
  // seconds, so at most one session was ever in flight. Run mode breaks that:
  // sessions stay open for as long as the player keeps deciding, abandoned
  // ones stay open indefinitely, and a host that backfills history stamps
  // those old rows with a fresh `lastEventTimestamp` — at which point "newest"
  // is an ABANDONED run, not this one. Picking it stalls the new run forever
  // with the wager already taken.
  //
  // So only consider rows that could actually be ours: unsettled, and not
  // already present when we opened.
  const known = new Set(run.knownKeys);
  const candidates = items.filter(
    item => !known.has(item.sessionKey) && !item.isSettled && !isTerminalPhase(item.phase),
  );
  if (candidates.length !== 1) return undefined; // ambiguous — wait for identity
  return candidates[0];
}

export function App() {
  const { hostApi, snapshot, demo } = useCasinoHost();

  const [anchor, setAnchor] = useState<Position>(2);
  const [wagerInput, setWagerInput] = useState('1.00');
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Reality doesn't heal. Every arc that lands leaves a permanent mark for the
   * rest of the session, so the world the player is looking at is a record of
   * what they've been through rather than a scene that resets each run — and a
   * long run visibly wrecks it, which is the point.
   *
   * Purely cosmetic and purely local: this never reaches the contract, the
   * wager, the odds or the payout.
   */
  const [damage, setDamage] = useState<Record<Reality, number>>({ 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 });

  /** Reveal-pacing timers, in the order they fire: lock -> floor -> hold -> land. */
  const lockTimer = useRef<number | undefined>(undefined);
  const floorTimer = useRef<number | undefined>(undefined);
  const holdTimer = useRef<number | undefined>(undefined);
  const landTimer = useRef<number | undefined>(undefined);
  const runSeq = useRef(1);
  /**
   * The reveal fires from inside a timeout chain, so it must not close over a
   * `hostApi` from an older render — the SDK explicitly warns that a
   * reconnect would leave that reference stale.
   */
  const hostApiRef = useRef(hostApi);
  hostApiRef.current = hostApi;

  const decimals = snapshot?.token.decimals ?? 18;
  const symbol = snapshot?.token.symbol ?? 'chUSD';

  const balance = useMemo(() => {
    const raw = snapshot?.balances.smartVaultBalance;
    return raw !== undefined ? BigInt(raw) : undefined;
  }, [snapshot?.balances.smartVaultBalance]);

  /**
   * Run mode reserves the whole ladder at `openSession`, so the per-bet
   * exposure is ~110.85x the stake. The ceiling has to come from the host's
   * live risk limit — a hard-coded maximum would start reverting the moment
   * vault liquidity moved.
   */
  const maxWager = useMemo(() => {
    const raw = snapshot?.casino?.maxAllowedReservedProfit;
    if (raw === undefined) return undefined;
    try {
      return maxWagerFor(BigInt(raw));
    } catch {
      return undefined;
    }
  }, [snapshot?.casino?.maxAllowedReservedProfit]);

  const wager = useMemo(() => {
    try {
      const parsed = parseUnits(wagerInput || '0', decimals);
      return parsed > 0n ? parsed : null;
    } catch {
      return null;
    }
  }, [wagerInput, decimals]);

  const ready = snapshot?.wallet.status === 'ready';
  const phase = run?.phase ?? 'idle';
  const inFlight = phase === 'committing' || phase === 'awaiting' || phase === 'resolving';
  /** The anchor can only be moved when the run is actually waiting on us. */
  const canMove = phase === 'idle' || phase === 'choosing' || phase === 'over';

  const step = run?.step ?? 0;
  const banked = step > 0 ? payoutFor(run?.wager ?? 0n, step) : 0n;
  const nextStep = Math.min(step + 1, MAX_STEPS);

  /**
   * Pick a live run back up after a reload.
   *
   * A run is a multi-step on-chain session: closing the tab at step 6 leaves it
   * sitting in WAITING_PLAYER_ACTION with real banked value on it. Without
   * this, reopening the game would show a fresh idle screen while that session
   * quietly waited out its action deadline — the player would have to forfeit
   * (and lose the host's cut) to get their winnings back. So on the first
   * snapshot we look for our own unfinished session and rebuild the run around
   * it, leaving the player exactly where they left off.
   *
   * Only ever adopts a session the host still reports as live, and never
   * touches the stake, the step or the multiplier — all of those come from the
   * contract's own game state.
   */
  const adopted = useRef(false);
  useEffect(() => {
    if (adopted.current || run !== null || !snapshot) return;
    const live = snapshot.sessions.items.find(
      item =>
        !item.isSettled &&
        !isTerminalPhase(item.phase) &&
        (item.phase === 1 || item.phase === 2) &&
        item.raw.gameState !== undefined,
    );
    if (!live) return;
    const state = decodeRunState(live.raw.gameState as `0x${string}`);
    if (!state || state.struck || state.cashedOut) return;

    adopted.current = true;
    setAnchor(state.position);
    setRun({
      id: runSeq.current++,
      sessionKey: live.sessionKey,
      sessionId: live.sessionId,
      knownKeys: [],
      wager: live.wager !== undefined ? BigInt(live.wager) : 0n,
      step: state.step,
      // Everything already resolved has been resolved; nothing to replay.
      presented: state.step,
      phase: live.phase === 2 ? 'choosing' : 'awaiting',
      // The earlier steps' words are not reconstructible from one snapshot, so
      // the log starts here rather than inventing rows that were never drawn.
      log: [],
      committedAt: Date.now(),
    });
  }, [run, snapshot]);

  // --- advance the run from host snapshot pushes -----------------------------
  //
  // The result itself is known the instant the host reports the step resolved —
  // nothing here changes when that happens or what it is. What changes is how
  // the reveal is staged: telegraph, a beat of silence, then the arc lands.
  useEffect(() => {
    if (!run || !snapshot) return;
    if (run.phase !== 'awaiting' && run.phase !== 'committing') return;

    const row = findRow(snapshot.sessions.items, run);
    if (!row) return;

    // Pin the session id the moment the row is identified, not just when a
    // step is presented: from here on `findRow` matches on it exactly and can
    // never fall back to guessing between concurrent sessions.
    if (row.sessionId && row.sessionId !== run.sessionId) {
      const runId = run.id;
      const pinned = row.sessionId;
      setRun(current => (current && current.id === runId ? { ...current, sessionId: pinned } : current));
    }

    const settled = row.isSettled || isTerminalPhase(row.phase);
    const state = row.raw.gameState ? decodeRunState(row.raw.gameState) : null;

    if (!state) {
      // Mid-flight the host may push a row before its game state has synced,
      // so an undecodable state is normal right up until the session is
      // terminal. Once it IS terminal and there is still a blob we cannot
      // read, the session was settled by a contract that does not speak run
      // mode — almost always the original single-shot FractureGame, whose
      // 192-byte FractureState cannot be read as a 256-byte RunState.
      //
      // Without this the effect just returns on every push and the game sits
      // on "Drawing…" forever with nothing in the console. Say what happened
      // instead: a judge pointed at the wrong address should see a cause, not
      // a hang.
      if (settled && row.raw.gameState) {
        setRun(null);
        setError(
          'That session settled, but its result is not in run-mode format — the game is ' +
            'pointed at a contract that does not implement Fracture Run Mode. Check the ' +
            'game address.',
        );
      }
      return;
    }

    // How many steps have actually resolved: a strike resolves the step the
    // player did not survive, so it counts one beyond the survived total.
    const resolvedCount = state.struck ? state.step + 1 : state.step;

    // A cash-out settles without resolving a new step — nothing to reveal, the
    // multiplier was already on screen.
    if (settled && state.cashedOut && resolvedCount <= run.presented) {
      const payout =
        row.payout !== undefined && BigInt(row.payout) > 0n
          ? BigInt(row.payout)
          : payoutFor(run.wager, state.step);
      const sessionId = row.sessionId;
      setRun(current =>
        current && current.id === run.id
          ? { ...current, phase: 'over', ended: 'banked', payout, sessionId }
          : current,
      );
      playBank();
      if (sessionId) void hostApiRef.current?.revealOutcome({ sessionId }).catch(() => {});
      return;
    }

    if (resolvedCount <= run.presented) return; // nothing new to show yet

    const record: StepRecord = {
      step: resolvedCount,
      anchor: state.position,
      arcStart: state.arcStart,
      arcLength: state.arcLength,
      law: state.law,
      struck: state.struck,
    };
    const payout =
      row.payout !== undefined && BigInt(row.payout) > 0n
        ? BigInt(row.payout)
        : state.struck
          ? 0n
          : payoutFor(run.wager, state.step);

    const runId = run.id;
    const sessionId = row.sessionId;
    const elapsed = Date.now() - run.committedAt;
    const floorDelay = Math.max(0, MIN_TELEGRAPH_MS - elapsed);

    // Mark as presented immediately so a repeat snapshot push mid-reveal can't
    // restart the sequence or double-fire the sound.
    setRun(current =>
      current && current.id === runId ? { ...current, presented: resolvedCount, sessionId } : current,
    );

    window.clearTimeout(floorTimer.current);
    floorTimer.current = window.setTimeout(() => {
      // The silent beat: tension stops, nothing plays, the world holds still.
      setRun(current =>
        current && current.id === runId ? { ...current, phase: 'resolving' } : current,
      );

      window.clearTimeout(holdTimer.current);
      holdTimer.current = window.setTimeout(() => {
        setRun(current =>
          current && current.id === runId ? { ...current, landing: record } : current,
        );
        // This is the moment the arc lands and the world transforms. A strike
        // gets the law's full voice; surviving hears it sweep past instead —
        // ten full transformations in one run would be exhausting, and the
        // tails would bleed over the following step.
        if (record.struck) playOutcome(record.law);
        else playSweep(record.law);

        // Reality is damaged whether or not the anchor was inside the arc —
        // the law broke either way.
        setDamage(prev =>
          prev[record.law] >= MAX_DAMAGE
            ? prev
            : { ...prev, [record.law]: prev[record.law] + 1 },
        );

        window.clearTimeout(landTimer.current);
        landTimer.current = window.setTimeout(
          () => {
            setRun(current => {
              if (!current || current.id !== runId) return current;
              const log = [...current.log, record];
              if (record.struck) {
                return { ...current, phase: 'over', ended: 'struck', payout: 0n, log };
              }
              const survived = record.step;
              if (survived >= MAX_STEPS) {
                return { ...current, phase: 'over', ended: 'banked', step: survived, payout, log };
              }
              // Surviving releases the world: the wave passed, the ground
              // reforms, and all five positions are live again for the next
              // step. Only a run-ending strike leaves the world broken —
              // holding the end state through the decision would both freeze
              // the diorama mid-transformation and imply the arc that just
              // swept is still there, which it is not.
              return { ...current, phase: 'choosing', step: survived, log, landing: undefined };
            });

            if (record.struck) {
              playLose();
            } else if (record.step >= MAX_STEPS) {
              playWin();
            } else {
              playClimb(record.step);
            }

            // The presentation is over, so tell the host to stop withholding
            // the winnings. This is a REQUIRED part of the guest contract, not
            // an optimisation: from `openSession` until this call the host
            // clamps its balance displays so they can move down but never up,
            // deliberately, so the top bar can't spoil the outcome. Skip it and
            // a win looks like the player simply lost their stake. Display
            // only, so a failure here must never surface as a betting error.
            if (settled && sessionId) {
              void hostApiRef.current?.revealOutcome({ sessionId }).catch(() => {});
            }
          },
          record.struck ? FRACTURE_MS : SAFE_MS,
        );
      }, HOLD_MS);
    }, floorDelay);
  }, [run, snapshot]);

  // A soft heartbeat while the VRF round-trip runs longer than the initial
  // tension sweep, so a slow step doesn't read as the game having stalled.
  useEffect(() => {
    if (phase !== 'awaiting') return;
    const id = window.setInterval(() => playTensionPulse(), TENSION_PULSE_MS);
    return () => window.clearInterval(id);
  }, [phase]);

  useEffect(
    () => () => {
      window.clearTimeout(lockTimer.current);
      window.clearTimeout(floorTimer.current);
      window.clearTimeout(holdTimer.current);
      window.clearTimeout(landTimer.current);
    },
    [],
  );

  const place = useCallback(
    (next: Position) => {
      if (!canMove) return;
      unlockAudio();
      startAmbient();
      playSelect();
      setAnchor(next);
    },
    [canMove],
  );

  /** Opens a fresh run at the current wager and anchor. */
  const startRun = useCallback(async () => {
    if (!hostApi || !wager) return;
    unlockAudio();
    startAmbient();
    setError(null);

    const id = runSeq.current++;
    const committedAt = Date.now();
    const knownKeys = (snapshot?.sessions.items ?? []).map(item => item.sessionKey);
    setRun({
      id,
      knownKeys,
      wager,
      step: 0,
      presented: 0,
      phase: 'committing',
      log: [],
      committedAt,
    });
    playLock();

    try {
      const { sessionKey, transactionHash } = await hostApi.openSession({
        wager: wager.toString(),
        gameData: encodeGameData(anchor),
      });
      // Pin the run to its opening transaction straight away, so the row can
      // be identified even if the host reshuffles its session keys.
      setRun(current =>
        current && current.id === id ? { ...current, openTxHash: transactionHash } : current,
      );
      // The bet is already placed — this only delays our own visual exit from
      // the "committed" beat so the lock flash isn't cut off by a session open
      // that resolves in a handful of ms (demo mode has no network round-trip).
      const lockElapsed = Date.now() - committedAt;
      window.clearTimeout(lockTimer.current);
      lockTimer.current = window.setTimeout(
        () => {
          setRun(current =>
            current && current.id === id ? { ...current, sessionKey, phase: 'awaiting' } : current,
          );
          playAnticipation();
        },
        Math.max(0, LOCK_MS - lockElapsed),
      );
    } catch (e) {
      setRun(null);
      setError(e instanceof Error ? e.message : 'The run could not be opened.');
    }
  }, [hostApi, wager, anchor, snapshot]);

  /** ONE MORE — anchor reality somewhere and take another step. */
  const continueRun = useCallback(async () => {
    if (!hostApi || !run || run.phase !== 'choosing' || !run.sessionId) return;
    unlockAudio();
    setError(null);
    const runId = run.id;
    const committedAt = Date.now();
    setRun(current =>
      current && current.id === runId
        ? { ...current, phase: 'committing', landing: undefined, committedAt }
        : current,
    );
    playLock();

    try {
      await hostApi.submitAction({
        sessionId: run.sessionId,
        actionData: encodeAction(ACTION_CONTINUE, anchor),
      });
      const lockElapsed = Date.now() - committedAt;
      window.clearTimeout(lockTimer.current);
      lockTimer.current = window.setTimeout(
        () => {
          setRun(current =>
            current && current.id === runId && current.phase === 'committing'
              ? { ...current, phase: 'awaiting' }
              : current,
          );
          playAnticipation();
        },
        Math.max(0, LOCK_MS - lockElapsed),
      );
    } catch (e) {
      setRun(current => (current && current.id === runId ? { ...current, phase: 'choosing' } : current));
      setError(e instanceof Error ? e.message : 'The step could not be taken.');
    }
  }, [hostApi, run, anchor]);

  /** CASH OUT — bank what the run is worth and end it. */
  const cashOut = useCallback(async () => {
    if (!hostApi || !run || run.phase !== 'choosing' || !run.sessionId) return;
    unlockAudio();
    setError(null);
    const runId = run.id;
    setRun(current =>
      current && current.id === runId ? { ...current, phase: 'committing' } : current,
    );
    playLock();

    try {
      await hostApi.submitAction({
        sessionId: run.sessionId,
        actionData: encodeAction(ACTION_CASH_OUT, anchor),
      });
    } catch (e) {
      setRun(current => (current && current.id === runId ? { ...current, phase: 'choosing' } : current));
      setError(e instanceof Error ? e.message : 'The cash-out could not be placed.');
    }
  }, [hostApi, run, anchor]);

  /** Clear the ended run and arm a fresh one at the same stake. */
  const reset = useCallback(() => {
    setRun(null);
    setError(null);
  }, []);

  /**
   * One detent on the wager dial. Steps through a fixed ladder rather than
   * adding a fixed amount, so the control stays useful whether the player is
   * betting 0.10 or 500 — and always lands on a round number.
   */
  const stepWager = useCallback((direction: 1 | -1) => {
    const ladder = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000];
    setWagerInput(current => {
      const value = Number(current || '0');
      const next =
        direction > 0
          ? (ladder.find(s => s > value + 1e-9) ?? ladder[ladder.length - 1])
          : ([...ladder].reverse().find(s => s < value - 1e-9) ?? ladder[0]);
      return next.toFixed(2);
    });
    playTick();
  }, []);

  // --- derived view state ----------------------------------------------------
  const landing = run?.landing;
  // 'choosing' maps to 'idle', not 'settled': between steps the world is at
  // rest (carrying its permanent damage), because the step that just resolved
  // is over. Only an ended run holds the broken state.
  const worldPhase: WorldPhase =
    phase === 'idle' || phase === 'choosing'
      ? 'idle'
      : phase === 'committing' || phase === 'awaiting'
        ? 'anticipation'
        : phase === 'resolving'
          ? landing
            ? 'breaking'
            : 'holding'
          : 'settled';

  const activeLaw = landing?.law ?? null;
  const struckNow = landing?.struck ?? false;
  const arc = landing ? { start: landing.arcStart, length: landing.arcLength } : null;

  const fmt = (v: bigint) => {
    const s = formatUnits(v, decimals);
    const n = Number(s);
    return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : s;
  };

  const totalDamage = REALITIES.reduce<number>((sum, id) => sum + damage[id], 0);
  /** 100% = nothing has broken yet; 0% = every law is fully maxed out. */
  const stabilityPct = Math.round(100 - (totalDamage / (REALITIES.length * MAX_DAMAGE)) * 100);

  const overWager = maxWager !== undefined && wager !== null && wager > maxWager;
  const canStart =
    !!hostApi &&
    !!wager &&
    !inFlight &&
    ready &&
    !overWager &&
    (balance === undefined || wager <= balance);

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1 className="wordmark">Fracture</h1>
          <p className="tagline">Place your reality. Then survive it.</p>
        </div>
        <div className="balance">
          {demo && <span className="demo-pill">Demo</span>}
          {balance !== undefined && (
            <strong>
              {fmt(balance)} {symbol}
            </strong>
          )}
        </div>
      </header>

      <div className="layout">
        <div className="world-wrap">
          <WorldCanvas
            phase={worldPhase}
            law={activeLaw}
            anchor={anchor}
            arc={arc}
            struck={struckNow}
            damage={damage}
            step={step}
          />

          {/* The ladder: what the run is worth now, and what one more is worth.
              This is the whole decision, so it sits on the world, not buried
              in a panel. */}
          {/* Not once the run is over: the result banner and the run log own
              that moment, and the ladder would sit on top of them. */}
          {run && phase !== 'idle' && phase !== 'over' && (
            <div className="ladder" data-phase={phase}>
              <div className="ladder-cell">
                <span className="ladder-label">Banked</span>
                <span className="ladder-value">{step > 0 ? `${multiplierAt(step).toFixed(4)}×` : '—'}</span>
                <span className="ladder-sub">{step > 0 ? `${fmt(banked)} ${symbol}` : 'step 0'}</span>
              </div>
              <div className="ladder-arrow" aria-hidden="true">
                →
              </div>
              <div className="ladder-cell ladder-next">
                <span className="ladder-label">One more</span>
                <span className="ladder-value">{multiplierAt(nextStep).toFixed(4)}×</span>
                <span className="ladder-sub">
                  {stepSurvivalPct(nextStep).toFixed(0)}% survive · {hazardAt(nextStep)} of 5 go
                </span>
              </div>
            </div>
          )}

          {phase === 'awaiting' && (
            <p className="status">
              <span className="dots">Drawing the fracture</span>
            </p>
          )}

          {phase === 'over' && run && (
            <div className={`result ${run.ended === 'banked' ? 'win' : 'lose'}`}>
              <p className="result-headline">
                {run.ended === 'banked'
                  ? run.step >= MAX_STEPS
                    ? 'You ran the whole ladder'
                    : 'Banked'
                  : 'Reality fractured'}
              </p>
              <p className="result-detail">
                {run.ended === 'banked' ? (
                  <>
                    {run.step} {run.step === 1 ? 'step' : 'steps'} —{' '}
                    <span className="amount amount-win">
                      +{fmt(run.payout ?? 0n)} {symbol}
                    </span>{' '}
                    at {multiplierAt(run.step).toFixed(4)}&times;
                  </>
                ) : (
                  <>
                    {REALITY[run.log[run.log.length - 1]?.law ?? 0].name} took the{' '}
                    {ANCHOR[run.log[run.log.length - 1]?.anchor ?? 0].name} on step {run.log.length}{' '}
                    —{' '}
                    <span className="amount amount-lose">
                      &minus;{fmt(run.wager)} {symbol}
                    </span>
                  </>
                )}
              </p>
              {run.log.length > 0 && <ArcReadout log={run.log} />}
            </div>
          )}
        </div>

        <div className="controls">
          <section className="panel">
            <p className="section-label">
              {phase === 'choosing' ? 'Where does reality go next?' : 'Place your reality'}
            </p>
            <p className="section-hint">
              {canMove
                ? 'Every position carries the same odds. Choose anyway.'
                : 'Anchor locked — the fracture is being drawn.'}
            </p>
            <div className="picks picks-anchors">
              {ANCHORS.map(id => {
                const hit = landing ? arcPositions(landing.arcStart, landing.arcLength).includes(id) : false;
                return (
                  <button
                    key={id}
                    type="button"
                    data-anchor={ANCHOR[id].key}
                    className={
                      `pick pick-anchor` +
                      (anchor === id && phase === 'committing' ? ' locking' : '') +
                      (landing && hit ? ' struck' : '') +
                      (landing && !hit ? ' spared' : '')
                    }
                    aria-pressed={anchor === id}
                    disabled={!canMove}
                    onClick={() => place(id)}
                  >
                    <span className="pick-glyph" aria-hidden="true">
                      {ANCHOR_GLYPH[id]}
                    </span>
                    <span className="pick-name">{ANCHOR[id].name}</span>
                  </button>
                );
              })}
            </div>
            <p key={anchor} className="pick-note" data-anchor={ANCHOR[anchor].key}>
              {ANCHOR[anchor].blurb}
            </p>
          </section>

          {/* What this session has done to the world — YOUR FRACTURE, not a
              stats sheet. Every number is derived straight from `damage`;
              there is no separate history log or event list behind it.
              Only appears once something has actually broken, so a
              first-time player isn't shown an empty meter with no context. */}
          {totalDamage > 0 && (
            <section className="panel damage-panel">
              <div className="damage-title">
                <span className="damage-title-name">Your Fracture</span>
                <span className="damage-title-count">
                  {totalDamage} {totalDamage === 1 ? 'reality event' : 'reality events'}
                </span>
              </div>
              <div className="damage-stability">
                <span className="damage-stability-label">Stability</span>
                <span
                  className="damage-stability-track"
                  role="img"
                  aria-label={`Reality stability ${stabilityPct}%`}
                >
                  <span className="damage-stability-fill" style={{ width: `${stabilityPct}%` }} />
                </span>
              </div>
              <ul className="damage-list">
                {REALITIES.map(id => (
                  <li key={id} className="damage-row" data-law={REALITY[id].key}>
                    <span className="damage-name">{REALITY[id].name}</span>
                    <span
                      className="damage-bars"
                      role="img"
                      aria-label={`${REALITY[id].name} broken ${damage[id]} of ${MAX_DAMAGE} times`}
                    >
                      {Array.from({ length: MAX_DAMAGE }, (_, i) => (
                        <span key={i} className={`damage-pip${i < damage[id] ? ' on' : ''}`} />
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel">
            {phase === 'choosing' ? (
              <>
                <p className="section-label">Step {step} survived</p>
                <div className="decision">
                  <button type="button" className="cash" onClick={() => void cashOut()}>
                    <span className="key-line">Cash out</span>
                    <span className="key-sub">
                      {fmt(banked)} {symbol} · {multiplierAt(step).toFixed(2)}&times;
                    </span>
                  </button>
                  <button type="button" className="cta more" onClick={() => void continueRun()}>
                    <span className="key-line">One more</span>
                    <span className="key-sub">
                      {multiplierAt(nextStep).toFixed(2)}&times; · {stepSurvivalPct(nextStep).toFixed(0)}%
                    </span>
                  </button>
                </div>
                <p className="payout-preview">
                  Surviving pays <strong>{fmt(payoutFor(run?.wager ?? 0n, nextStep))} {symbol}</strong>.
                  Losing ends the run at zero.
                </p>
              </>
            ) : phase === 'over' ? (
              <>
                <p className="section-label">Wager</p>
                <div className="wager-row">
                  <div className="wager-field">
                    <input
                      inputMode="decimal"
                      value={wagerInput}
                      onChange={e => setWagerInput(e.target.value)}
                      aria-label={`Wager in ${symbol}`}
                    />
                    <span className="unit">{symbol}</span>
                  </div>
                  <button type="button" className="step" aria-label="Decrease wager" onClick={() => stepWager(-1)}>
                    &minus;
                  </button>
                  <button type="button" className="step" aria-label="Increase wager" onClick={() => stepWager(1)}>
                    +
                  </button>
                </div>
                <button type="button" className="cta" disabled={!canStart} onClick={() => { reset(); void startRun(); }}>
                  Run it again
                </button>
                <p className="payout-preview">
                  Step 1 pays {multiplierAt(1).toFixed(4)}&times; at {stepSurvivalPct(1).toFixed(0)}%.
                </p>
              </>
            ) : (
              <>
                <p className="section-label">Wager</p>
                <div className="wager-row">
                  <div className="wager-field">
                    <input
                      inputMode="decimal"
                      value={wagerInput}
                      disabled={inFlight}
                      onChange={e => setWagerInput(e.target.value)}
                      aria-label={`Wager in ${symbol}`}
                    />
                    <span className="unit">{symbol}</span>
                  </div>
                  <button
                    type="button"
                    className="step"
                    aria-label="Decrease wager"
                    disabled={inFlight}
                    onClick={() => stepWager(-1)}
                  >
                    &minus;
                  </button>
                  <button
                    type="button"
                    className="step"
                    aria-label="Increase wager"
                    disabled={inFlight}
                    onClick={() => stepWager(1)}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="chip chip-max"
                    disabled={inFlight || balance === undefined}
                    onClick={() => {
                      if (balance === undefined) return;
                      const cap = maxWager !== undefined && maxWager < balance ? maxWager : balance;
                      setWagerInput(formatUnits(cap, decimals));
                    }}
                  >
                    Max
                  </button>
                </div>

                <button type="button" className="cta" disabled={!canStart} onClick={() => void startRun()}>
                  {inFlight ? 'Drawing…' : 'Enter the run'}
                </button>

                <p className="payout-preview">
                  {wager ? (
                    <>
                      Step 1 pays{' '}
                      <strong>
                        {fmt(payoutFor(wager, 1))} {symbol}
                      </strong>{' '}
                      at {multiplierAt(1).toFixed(4)}&times; &middot; {stepSurvivalPct(1).toFixed(0)}% survive
                    </>
                  ) : (
                    'Enter a wager'
                  )}
                </p>
                {overWager && maxWager !== undefined && (
                  <p className="error">
                    The vault will not cover a run this size. Maximum {fmt(maxWager)} {symbol}.
                  </p>
                )}
              </>
            )}

            {error && <p className="error">{error}</p>}
          </section>
        </div>
      </div>

      <p className="footnote">
        95.00% RTP at every stopping point, fixed by construction: the multiplier after k steps is
        0.95 &divide; the chance of surviving k steps, so cashing out at step 1, step 7 or riding to{' '}
        {multiplierAt(MAX_STEPS).toFixed(2)}&times; all return exactly 95%. Reaching the top happens{' '}
        {reachPct(MAX_STEPS).toFixed(4)}% of the time.
        {demo
          ? ' Demo mode — play money, local RNG, no chain. Real runs settle on-chain via Chain VRF, one fresh draw per step.'
          : ' Every step draws a fresh word from Chain’s VRF, after your anchor is committed.'}
      </p>
    </div>
  );
}
