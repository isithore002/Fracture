import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatUnits, parseUnits } from 'viem';
import type { HostSnapshotV1 } from '@chain/casino-sdk/guest';

type HostSnapshotSessions = HostSnapshotV1['sessions']['items'];

import { useCasinoHost } from './lib/useCasinoHost';
import {
  REALITIES,
  REALITY,
  bucketFromRandomness,
  bucketToOutcome,
  chanceOf,
  decodeGameState,
  encodeGameData,
  isTerminalPhase,
  multiplierOf,
  payoutFor,
  type FractureResult,
  type Reality,
} from './lib/fracture';
import { WorldCanvas, type WorldPhase } from './components/WorldCanvas';
import { RollReadout } from './components/RollReadout';
import {
  playAnticipation,
  playLock,
  playLose,
  playOutcome,
  playSelect,
  playTensionPulse,
  playWin,
  startAmbient,
  unlockAudio,
} from './lib/sound';
import './styles/fracture.css';

const GLYPH: Record<Reality, string> = {
  0: '↑', // gravity — up arrow
  1: '↺', // time — anticlockwise
  2: '◱', // scale
  3: '◌', // orbit
  4: '⬤', // void
};

/** How long each break animation runs before the payout banner lands. */
const BREAK_MS: Record<Reality, number> = {
  0: 2100,
  1: 2100,
  2: 2100,
  3: 2400,
  4: 2600,
};

/**
 * Presentation-only pacing. None of this changes when the round actually
 * settles on-chain — it only paces how the *reveal* of an already-known
 * result is staged, so a fast VRF round-trip doesn't feel abrupt and a slow
 * one doesn't feel broken:
 *
 *   click -> [MIN_ANTICIPATION_MS floor, measured from the click] -> HOLD_MS
 *   silent beat -> the world breaks -> BREAK_MS[outcome] -> settled
 */
const MIN_ANTICIPATION_MS = 1450;
/** A deliberate beat of near-silence right before the transformation starts. */
const HOLD_MS = 340;
/**
 * A floor on the "prediction locked" beat itself. In demo mode `openSession`
 * resolves almost instantly (no real network round-trip), which would cut the
 * lock-flash animation off after a few ms. On a real host this never binds —
 * the actual transaction round-trip already takes longer than this.
 */
const LOCK_MS = 460;
/** Cadence of the soft "still waiting" pulse, matched to the CSS tension loop. */
const TENSION_PULSE_MS = 1400;

/**
 * Damage saturates here. A cap is what keeps persistence from turning into
 * visual noise: the world can look thoroughly wrecked, but it can't accumulate
 * forever and it can't get unreadable.
 */
export const MAX_DAMAGE = 5;

type Round = {
  /** Local id for this round; never compared against host data. */
  id: number;
  /**
   * The key the host handed back from `openSession`. The host opens with an
   * optimistic `pending:<uuid>` row and later swaps it for the real session id,
   * so this key can go stale — `knownKeys` is what actually finds our row.
   */
  sessionKey?: string;
  /**
   * The host's real session id, read off the settled row. Needed for
   * `revealOutcome` — without it the host keeps winnings hidden (see the
   * reveal call in the settle sequence below).
   */
  sessionId?: string;
  /** Session keys that already existed when we opened, so we can spot ours. */
  knownKeys: string[];
  prediction: Reality;
  wager: bigint;
  /**
   * `holding` is a purely presentational beat between "the result is known"
   * and "the world visibly breaks" — see MIN_ANTICIPATION_MS / HOLD_MS above.
   */
  status: 'opening' | 'waiting' | 'holding' | 'breaking' | 'settled';
  /** ms since epoch when the player committed — the anticipation floor. */
  openedAt: number;
  result?: FractureResult;
  payout?: bigint;
};

/**
 * Finds this round's session row.
 *
 * The host pushes an optimistic `pending:<uuid>` row the moment `openSession`
 * is called, then replaces it with the real session id once the transaction is
 * observed — and the SDK documents that both arrival orders happen. Matching on
 * the key `openSession` returned therefore loses the row exactly when it
 * settles. We match the returned key when it is still present, and otherwise
 * take the newest row that was not there before we opened.
 */
function findRow(
  items: HostSnapshotSessions,
  round: Round,
): HostSnapshotSessions[number] | undefined {
  if (round.sessionKey) {
    const direct = items.find(item => item.sessionKey === round.sessionKey);
    if (direct) return direct;
  }
  const known = new Set(round.knownKeys);
  const fresh = items.filter(item => !known.has(item.sessionKey));
  if (fresh.length === 0) return undefined;
  // `items` is newest-first from the host; fall back to the last event stamp.
  return fresh.reduce((newest, item) =>
    item.lastEventTimestamp > newest.lastEventTimestamp ? item : newest,
  );
}

export function App() {
  const { hostApi, snapshot, demo } = useCasinoHost();

  const [prediction, setPrediction] = useState<Reality>(0);
  const [wagerInput, setWagerInput] = useState('1.00');
  const [round, setRound] = useState<Round | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Reality doesn't heal. Every law that breaks leaves a permanent mark for
   * the rest of the session, so the world the player is looking at is a record
   * of what they've been through rather than a scene that resets each round.
   *
   * Stored as one level per law (0..MAX_DAMAGE) rather than a growing list of
   * damage objects — the renderer interprets five numbers, so a 200-round
   * session costs exactly as much to draw as a 2-round one.
   *
   * Purely cosmetic and purely local: this never reaches the contract, the
   * wager, the odds or the payout.
   */
  const [damage, setDamage] = useState<Record<Reality, number>>({ 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 });
  /** Reveal-pacing timers, in the order they fire: lock -> floor -> hold -> settle. */
  const lockTimer = useRef<number | undefined>(undefined);
  const floorTimer = useRef<number | undefined>(undefined);
  const holdTimer = useRef<number | undefined>(undefined);
  const settleTimer = useRef<number | undefined>(undefined);
  const roundSeq = useRef(1);
  /**
   * The reveal fires from inside a timeout chain, so it must not close over a
   * `hostApi` from an older render — the SDK explicitly warns that a
   * reconnect would leave that reference stale.
   */
  const hostApiRef = useRef(hostApi);
  hostApiRef.current = hostApi;
  /** Round ids whose settlement has already been staged, so a repeat host
   *  snapshot push while we're mid-reveal doesn't restart the sequence or
   *  double-fire the outcome sound. */
  const staged = useRef(new Set<number>());

  const decimals = snapshot?.token.decimals ?? 18;
  const symbol = snapshot?.token.symbol ?? 'chUSD';

  const balance = useMemo(() => {
    const raw = snapshot?.balances.smartVaultBalance;
    return raw !== undefined ? BigInt(raw) : undefined;
  }, [snapshot?.balances.smartVaultBalance]);

  const wager = useMemo(() => {
    try {
      const parsed = parseUnits(wagerInput || '0', decimals);
      return parsed > 0n ? parsed : null;
    } catch {
      return null;
    }
  }, [wagerInput, decimals]);

  const busy = round !== null && round.status !== 'settled';
  const ready = snapshot?.wallet.status === 'ready';

  // --- settle the active round from host snapshot pushes ---------------------
  //
  // The result itself is known the instant the host reports the row settled —
  // nothing here changes when that happens or what it is. What changes is how
  // the *reveal* is staged, so a fast VRF round-trip doesn't feel like nothing
  // happened and a slow one doesn't feel broken:
  //
  //   result known -> (wait out MIN_ANTICIPATION_MS from the click, if needed)
  //   -> a silent "holding" beat (HOLD_MS) -> the world breaks + outcome sound
  //   -> BREAK_MS[outcome] of transformation -> settled + win/lose sound
  useEffect(() => {
    if (!round || round.status !== 'waiting' || !snapshot) return;
    if (staged.current.has(round.id)) return; // already sequencing this round

    const row = findRow(snapshot.sessions.items, round);
    if (!row || !(row.isSettled || isTerminalPhase(row.phase))) return;

    // Prefer the decoded on-chain game state; fall back to re-deriving the
    // outcome from the raw VRF word with the same mapping the contract uses.
    const decoded = row.raw.gameState ? decodeGameState(row.raw.gameState) : null;
    const fromRandomness =
      !decoded && row.raw.randomness && BigInt(row.raw.randomness) !== 0n
        ? ((): FractureResult => {
            // Derive the bucket the same way the contract does rather than
            // leaving it unknown — the roll is what the result screen shows
            // the player, so this path must produce it too.
            const bucket = bucketFromRandomness(row.raw.randomness as `0x${string}`);
            const outcome = bucketToOutcome(bucket);
            return {
              prediction: round.prediction,
              outcome,
              bucket,
              won: outcome === round.prediction,
              randomness: row.raw.randomness as `0x${string}`,
            };
          })()
        : null;

    const result = decoded ?? fromRandomness;
    if (!result) return; // settled but not synced yet — wait for the next push

    const payout =
      row.payout !== undefined && BigInt(row.payout) > 0n
        ? BigInt(row.payout)
        : result.won
          ? payoutFor(round.wager, result.prediction)
          : 0n;

    staged.current.add(round.id);
    const roundId = round.id;
    const sessionId = row.sessionId;
    const elapsed = Date.now() - round.openedAt;
    const floorDelay = Math.max(0, MIN_ANTICIPATION_MS - elapsed);

    window.clearTimeout(floorTimer.current);
    floorTimer.current = window.setTimeout(() => {
      // The silent beat: tension stops, nothing plays, the world holds still.
      setRound(current =>
        current && current.id === roundId
          ? { ...current, status: 'holding', result, payout, sessionId }
          : current,
      );

      window.clearTimeout(holdTimer.current);
      holdTimer.current = window.setTimeout(() => {
        setRound(current =>
          current && current.id === roundId ? { ...current, status: 'breaking' } : current,
        );
        // This is the moment the world transforms.
        playOutcome(result.outcome);

        window.clearTimeout(settleTimer.current);
        settleTimer.current = window.setTimeout(() => {
          setRound(current =>
            current && current.id === roundId ? { ...current, status: 'settled' } : current,
          );
          if (result.won) playWin();
          else playLose();

          // The world keeps the scar. Note this tracks `result.outcome` — the
          // law that actually broke — not the player's prediction: reality was
          // damaged regardless of whether they called it right.
          setDamage(prev =>
            prev[result.outcome] >= MAX_DAMAGE
              ? prev
              : { ...prev, [result.outcome]: prev[result.outcome] + 1 },
          );

          // The presentation is over, so tell the host to stop withholding
          // the winnings. This is a REQUIRED part of the guest contract, not
          // an optimisation: from `openSession` until this call the host
          // clamps its balance displays so they can move down but never up,
          // deliberately, so the top bar can't spoil the outcome before the
          // world finishes breaking. Skip it and a win looks like the player
          // simply lost their wager — the payout is already final on-chain,
          // only its display is held back. Display-only, so a failure here
          // must never surface as a betting error.
          if (sessionId) {
            void hostApiRef.current?.revealOutcome({ sessionId }).catch(() => {});
          }
        }, BREAK_MS[result.outcome]);
      }, HOLD_MS);
    }, floorDelay);
  }, [round, snapshot]);

  // A soft heartbeat while the VRF round-trip runs longer than the initial
  // tension sweep, so a slow settle doesn't read as the game having stalled.
  // Stops the instant we leave 'waiting' (i.e. right as the silent hold beat
  // begins), which is what keeps the silence in "silence -> reveal" honest.
  useEffect(() => {
    if (round?.status !== 'waiting') return;
    const id = window.setInterval(() => playTensionPulse(), TENSION_PULSE_MS);
    return () => window.clearInterval(id);
  }, [round?.status]);

  useEffect(
    () => () => {
      window.clearTimeout(lockTimer.current);
      window.clearTimeout(floorTimer.current);
      window.clearTimeout(holdTimer.current);
      window.clearTimeout(settleTimer.current);
    },
    [],
  );

  const pick = useCallback((next: Reality) => {
    unlockAudio();
    startAmbient();
    playSelect();
    setPrediction(next);
  }, []);

  const submit = useCallback(async () => {
    if (!hostApi || !wager) return;
    unlockAudio();
    startAmbient();
    setError(null);

    const id = roundSeq.current++;
    const openedAt = Date.now();
    const knownKeys = (snapshot?.sessions.items ?? []).map(item => item.sessionKey);
    // "Prediction locked" — the commit itself, before the network round-trip.
    setRound({ id, knownKeys, prediction, wager, status: 'opening', openedAt });
    playLock();

    try {
      const { sessionKey } = await hostApi.openSession({
        wager: wager.toString(),
        gameData: encodeGameData(prediction),
      });
      // The bet is already placed — this only delays *our own* visual exit
      // from the "locked" beat, so the lock-flash isn't cut off by a session
      // open that resolves in a handful of ms (demo mode has no real network
      // round-trip). A real host's tx round-trip already exceeds LOCK_MS.
      const lockElapsed = Date.now() - openedAt;
      window.clearTimeout(lockTimer.current);
      lockTimer.current = window.setTimeout(() => {
        setRound(current =>
          current && current.id === id ? { ...current, sessionKey, status: 'waiting' } : current,
        );
        playAnticipation();
      }, Math.max(0, LOCK_MS - lockElapsed));
    } catch (e) {
      setRound(null);
      setError(e instanceof Error ? e.message : 'The bet could not be placed.');
    }
  }, [hostApi, wager, prediction, snapshot]);

  const replay = useCallback(() => {
    setRound(null);
    setError(null);
    startAmbient();
  }, []);

  // --- derived view state ----------------------------------------------------
  const worldPhase: WorldPhase =
    round === null || (round.status === 'settled' && !round.result)
      ? 'idle'
      : round.status === 'opening' || round.status === 'waiting'
        ? 'anticipation'
        : round.status === 'holding'
          ? 'holding'
          : round.status === 'breaking'
            ? 'breaking'
            : 'settled';

  const shownOutcome = round?.result?.outcome ?? null;
  const potential = wager ? payoutFor(wager, prediction) : 0n;

  const fmt = (v: bigint) => {
    const s = formatUnits(v, decimals);
    const n = Number(s);
    return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : s;
  };

  const totalDamage = REALITIES.reduce<number>((sum, id) => sum + damage[id], 0);

  const canBet =
    !!hostApi &&
    !!wager &&
    !busy &&
    ready &&
    (balance === undefined || wager <= balance);

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1 className="wordmark">Fracture</h1>
          <p className="tagline">Reality doesn&rsquo;t bend. It breaks.</p>
        </div>
        <div className="balance">
          {demo && <span className="demo-pill">Demo</span>}
          {balance !== undefined && (
            <>
              <strong>
                {fmt(balance)} {symbol}
              </strong>
            </>
          )}
        </div>
      </header>

      {/*
        Two regions below the header: the world (big, dominant) and the
        controls (law cards + wager, grouped together) — stacked on mobile,
        side by side once there's enough width to actually use, the same
        split the SDK's own Coinflip reference example uses (big visual one
        side, compact control column the other) instead of a single narrow
        centered column with dead space either side of it on a wide viewport.
      */}
      <div className="layout">
        <div className="world-wrap">
          <WorldCanvas
            phase={worldPhase}
            outcome={shownOutcome}
            selected={prediction}
            interactive={worldPhase === 'idle'}
            onLock={pick}
            damage={damage}
          />

          {round && (round.status === 'opening' || round.status === 'waiting') && (
            <p className="status">
              <span className="dots">Reality is deciding</span>
            </p>
          )}

          {round?.status === 'settled' && round.result && (
            <div className={`result ${round.result.won ? 'win' : 'lose'}`}>
              <p className="result-headline">
                {REALITY[round.result.outcome].name} broke
              </p>
              <p className="result-detail">
                {round.result.won ? (
                  <>
                    You called it —{' '}
                    <span className="amount amount-win">
                      +{fmt(round.payout ?? 0n)} {symbol}
                    </span>{' '}
                    at {multiplierOf(round.result.prediction).toFixed(4)}&times;
                  </>
                ) : (
                  <>
                    You called {REALITY[round.result.prediction].name} —{' '}
                    <span className="amount amount-lose">
                      &minus;{fmt(round.wager)} {symbol}
                    </span>
                  </>
                )}
              </p>

              {round.result.bucket >= 0 && (
                <RollReadout
                  bucket={round.result.bucket}
                  prediction={round.result.prediction}
                  outcome={round.result.outcome}
                />
              )}
            </div>
          )}
        </div>

        <div className="controls">
          <section className="panel">
            <p className="section-label">Which law breaks next?</p>
            <p className="section-hint">Drag the core above, or tap a card:</p>
            <div className="picks">
              {REALITIES.map(id => (
                <button
                  key={id}
                  type="button"
                  // Brief one-shot flash the instant this prediction is locked
                  // in, distinct from the persistent aria-pressed selection
                  // styling.
                  className={`pick${prediction === id && round?.status === 'opening' ? ' locking' : ''}`}
                  aria-pressed={prediction === id}
                  disabled={busy}
                  onClick={() => pick(id)}
                >
                  <span className="pick-glyph" aria-hidden="true">
                    {GLYPH[id]}
                  </span>
                  <span className="pick-name">{REALITY[id].name}</span>
                  <span className="pick-mult">{multiplierOf(id).toFixed(2)}&times;</span>
                  <span className="pick-chance">{chanceOf(id)}%</span>
                </button>
              ))}
            </div>
            <p key={prediction} className="pick-note">
              {REALITY[prediction].tagline}
            </p>
          </section>

          {/* What this session has done to the world. Only appears once
              something has actually broken, so a first-time player isn't
              shown an empty meter they have no context for. */}
          {totalDamage > 0 && (
            <section className="panel damage-panel">
              <p className="section-label">Damage to your reality</p>
              <ul className="damage-list">
                {REALITIES.map(id => (
                  <li key={id} className="damage-row">
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
            <p className="section-label">Wager</p>
            <div className="wager-row">
              <div className="wager-field">
                <input
                  inputMode="decimal"
                  value={wagerInput}
                  disabled={busy}
                  onChange={e => setWagerInput(e.target.value)}
                  aria-label={`Wager in ${symbol}`}
                />
                <span className="unit">{symbol}</span>
              </div>
              <button type="button" className="chip" disabled={busy} onClick={() => setWagerInput('1.00')}>
                1
              </button>
              <button
                type="button"
                className="chip"
                disabled={busy}
                onClick={() => setWagerInput(v => String(Math.max(0, Number(v || '0') * 2)))}
              >
                2&times;
              </button>
              <button
                type="button"
                className="chip chip-max"
                disabled={busy || balance === undefined}
                onClick={() => balance !== undefined && setWagerInput(formatUnits(balance, decimals))}
              >
                Max
              </button>
            </div>

            {round?.status === 'settled' ? (
              <button type="button" className="cta" onClick={replay}>
                Shift again
              </button>
            ) : (
              <button type="button" className="cta" disabled={!canBet} onClick={() => void submit()}>
                {busy ? 'Breaking…' : `Break ${REALITY[prediction].name}`}
              </button>
            )}

            <p className="payout-preview">
              {wager ? (
                <>
                  Pays <strong>{fmt(potential)} {symbol}</strong> at {multiplierOf(prediction).toFixed(4)}&times; &middot;{' '}
                  {chanceOf(prediction)}% chance
                </>
              ) : (
                'Enter a wager'
              )}
            </p>

            {error && <p className="error">{error}</p>}
          </section>
        </div>
      </div>

      <p className="footnote">
        95.00% RTP on every outcome, fixed by construction: payout = wager &times; 95 / weight, so
        probability &times; payout is exactly 0.95 for all five.
        {demo
          ? ' Demo mode — play money, local RNG, no chain. Real rounds settle on-chain via Chain VRF.'
          : ' Outcomes come from Chain’s VRF and settle on-chain.'}
      </p>
    </div>
  );
}
