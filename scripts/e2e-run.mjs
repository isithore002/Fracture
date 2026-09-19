/**
 * End-to-end test for FractureRunGame against the local stack: multi-step
 * sessions, one real VRF request per step, real facet checks.
 *
 * This drives the LocalCasinoHost exactly as the host app does, so it exercises
 * the real caps, risk params, phase transitions and the payout cap — not a mock.
 *
 * The two things it exists to catch:
 *
 *   THE RESERVE INVARIANT. Run mode's reserve GROWS as the ladder climbs, so
 *   unlike a single-shot game there is a reserve delta on every CONTINUE and
 *   any one of them being wrong is an InvalidPayout revert on a real player's
 *   winning bet. The session snapshot the host emits carries `reservedProfit`,
 *   so this asserts `stake + reservedProfit == payoutFor(step)` on chain at
 *   every step of every run.
 *
 *   THE FUTURE-RANDOMNESS LEAK. The whole design rests on a step's word not
 *   existing until after the anchor is committed. This asserts that at a
 *   decision point there is no pending randomness request anywhere in public
 *   chain state, and that the request for the next step is first created by
 *   the very transaction that commits the anchor.
 *
 * Usage: node scripts/e2e-run.mjs [runs]
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseAbiItem,
  decodeAbiParameters,
  decodeEventLog,
  encodeAbiParameters,
  formatUnits,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SDK = resolve(HERE, '../sdk/casino-sdk');
const deployed = JSON.parse(
  readFileSync(resolve(SDK, 'simulator/local-node/deployed.json'), 'utf8'),
);

const POSITION_NAMES = ['HILLTOP', 'ORCHARD', 'HEARTH', 'FENCELINE', 'HOLLOW'];
const LAW_NAMES = ['GRAVITY', 'TIME', 'SCALE', 'ORBIT', 'VOID'];
const MAX_STEPS = 10;
const ACTION_CASH_OUT = 0;
const ACTION_CONTINUE = 1;

/** The declared paytable, as exact rationals. Mirrors `multiplierOf`. */
const MULT = [
  null,
  [19n, 16n],
  [95n, 64n],
  [475n, 256n],
  [2375n, 1024n],
  [11875n, 3072n],
  [59375n, 9216n],
  [296875n, 27648n],
  [1484375n, 82944n],
  [7421875n, 165888n],
  [37109375n, 331776n],
];
const payoutFor = (wager, step) => (wager * MULT[step][0]) / MULT[step][1];
const hazardAt = step => (step <= 4 ? 1 : step <= 8 ? 2 : 3);

const DEV_MNEMONIC = 'test test test test test test test test test test test junk';
const WAGER = 10n ** 17n; // 0.1 chUSD — run mode reserves ~110x per bet

const hostAbi = parseAbi([
  'function openSession(address game, address vault, uint256 wager, bytes gameData) returns (uint256 sessionId, bytes32 requestId)',
  'function submitAction(bytes encodedSession, bytes actionData) returns (bytes32 requestId)',
  'event CasinoSessionOpened(uint256 indexed sessionId, address indexed game, address indexed player, address vault, uint256 wager)',
  'event CasinoSessionAdvanced(uint256 indexed sessionId, uint32 indexed step, bytes32 requestId, bytes32 randomness, bytes session)',
  'event CasinoSessionSettled(uint256 indexed sessionId, address indexed game, address indexed player, uint8 phase, uint256 payout, bytes32 randomness, bytes gameState)',
]);
const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

/** RunState as encoded by the contract. */
const stateParams = [
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
];

/**
 * `CasinoSession` is NOT abi-encoded — CasinoSessionCodec hand-packs it big-endian
 * into 235 fixed bytes plus two length-prefixed tails, because the bytes are
 * emitted, echoed and hashed three times per step. Offsets below mirror the
 * layout comment in CasinoSessionCodec.sol exactly.
 */
function decodeSession(hex) {
  const b = hex.slice(2);
  const at = (offset, length) => `0x${b.slice(offset * 2, (offset + length) * 2)}`;
  const uint = (offset, length) => BigInt(at(offset, length));

  const gameDataLength = Number(uint(235, 2));
  const gameDataAt = 237;
  const gameStateLenAt = gameDataAt + gameDataLength;
  const gameStateLength = Number(uint(gameStateLenAt, 2));
  const gameStateAt = gameStateLenAt + 2;

  return {
    sessionId: uint(0, 8),
    player: at(8, 20),
    vault: at(28, 20),
    game: at(48, 20),
    token: at(68, 20),
    wagerBase: uint(88, 16),
    escrowedStake: uint(104, 16),
    reservedProfit: uint(120, 16),
    maxEscrowStake: uint(136, 16),
    maxReservedProfit: uint(152, 16),
    deadlineBlock: uint(168, 5),
    step: Number(uint(173, 4)),
    phase: Number(uint(177, 1)),
    riskMaxPayout: uint(178, 16),
    riskProbabilityWad: uint(194, 8),
    riskSubVarianceScaled: uint(202, 32),
    gameData: at(gameDataAt, gameDataLength),
    gameState: at(gameStateAt, gameStateLength),
  };
}

const game = deployed.games.find(g => g.name === 'FractureRunGame')?.address;
if (!game) {
  throw new Error(
    'FractureRunGame is not deployed — is the local node running? ' +
      `Deployed games: ${deployed.games.map(g => g.name).join(', ')}`,
  );
}

const account = mnemonicToAccount(DEV_MNEMONIC);
const transport = http(deployed.rpcUrl);
const chain = {
  id: deployed.chainId,
  name: 'local',
  nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 },
  rpcUrls: { default: { http: [deployed.rpcUrl] } },
};
const publicClient = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account, chain, transport });

let failures = 0;
const ok = (cond, label) => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
};

const advancedEvent = parseAbiItem(
  'event CasinoSessionAdvanced(uint256 indexed sessionId, uint32 indexed step, bytes32 requestId, bytes32 randomness, bytes session)',
);
const settledEvent = parseAbiItem(
  'event CasinoSessionSettled(uint256 indexed sessionId, address indexed game, address indexed player, uint8 phase, uint256 payout, bytes32 randomness, bytes gameState)',
);

/** Waits for the session to advance past `afterStep`, or settle. */
async function waitForNext(sessionId, fromBlock, afterStep) {
  for (let i = 0; i < 400; i++) {
    const settled = await publicClient.getLogs({
      address: deployed.host,
      event: settledEvent,
      args: { sessionId },
      fromBlock,
      toBlock: 'latest',
    });
    if (settled.length) return { kind: 'settled', log: settled[settled.length - 1] };

    const advanced = await publicClient.getLogs({
      address: deployed.host,
      event: advancedEvent,
      args: { sessionId },
      fromBlock,
      toBlock: 'latest',
    });
    const newer = advanced.filter(l => Number(l.args.step) > afterStep);
    if (newer.length) return { kind: 'advanced', log: newer[newer.length - 1] };

    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`session ${sessionId} stalled after step ${afterStep}`);
}

const decodeState = bytes => decodeAbiParameters(stateParams, bytes)[0];

/**
 * Plays one run, continuing until `stopAt` steps have been survived (then
 * cashing out) or the run is struck. Returns everything observed on chain.
 */
async function playRun(stopAt, startPosition = 2) {
  const gameData = encodeAbiParameters([{ type: 'uint8' }], [startPosition]);
  const before = await publicClient.readContract({
    address: deployed.token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });

  const openHash = await wallet.writeContract({
    address: deployed.host,
    abi: hostAbi,
    functionName: 'openSession',
    args: [game, deployed.vault, WAGER, gameData],
  });
  const openReceipt = await publicClient.waitForTransactionReceipt({ hash: openHash });
  const openedAbi = hostAbi.find(a => a.type === 'event' && a.name === 'CasinoSessionOpened');
  const opened = openReceipt.logs
    .map(l => {
      try {
        return decodeEventLog({ abi: [openedAbi], data: l.data, topics: l.topics });
      } catch {
        return null;
      }
    })
    .find(Boolean);
  if (!opened) throw new Error('no CasinoSessionOpened in the open receipt');

  const sessionId = opened.args.sessionId;
  const fromBlock = openReceipt.blockNumber;
  const observations = [];
  let hostStep = 1; // openSession already emitted step 1 (WAITING_RANDOMNESS)
  let survived = 0;
  let ended = null;
  let payout = 0n;
  let finalState = null;
  /** requestIds seen, and which transaction first created each. */
  const requestOrigins = [];

  // Step 1's request is created by `openSession` itself — the transaction that
  // commits the opening anchor — and its advance log is inside this receipt
  // rather than anything the poll below will see. Read it here or a run that
  // is struck on step 1 looks like it drew no randomness at all.
  const advancedAbi = hostAbi.find(a => a.type === 'event' && a.name === 'CasinoSessionAdvanced');
  for (const l of openReceipt.logs) {
    try {
      const ev = decodeEventLog({ abi: [advancedAbi], data: l.data, topics: l.topics });
      if (ev.args.requestId !== `0x${'00'.repeat(32)}`) {
        requestOrigins.push({ requestId: ev.args.requestId, txHash: openReceipt.transactionHash });
      }
    } catch {
      /* not an advance log */
    }
  }

  for (;;) {
    const next = await waitForNext(sessionId, fromBlock, hostStep);

    if (next.kind === 'settled') {
      finalState = decodeState(next.log.args.gameState);
      payout = next.log.args.payout;
      ended = finalState.struck ? 'struck' : 'banked';
      break;
    }

    hostStep = Number(next.log.args.step);
    const session = decodeSession(next.log.args.session);
    const state = decodeState(session.gameState);

    if (next.log.args.requestId !== `0x${'00'.repeat(32)}`) {
      requestOrigins.push({ requestId: next.log.args.requestId, txHash: next.log.transactionHash });
    }

    // WAITING_PLAYER_ACTION == 2
    if (session.phase !== 2) continue;

    survived = state.step;
    observations.push({
      step: survived,
      escrowedStake: session.escrowedStake,
      reservedProfit: session.reservedProfit,
      maxReservedProfit: session.maxReservedProfit,
      arcStart: state.arcStart,
      arcLength: state.arcLength,
      law: state.law,
      position: state.position,
      // Public chain state at the decision point: no request is pending.
      pendingRequestId: next.log.args.requestId,
      encoded: next.log.args.session,
    });

    const action = survived >= stopAt ? ACTION_CASH_OUT : ACTION_CONTINUE;
    const actionData = encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint8' }],
      [action, (state.position + 1) % 5],
    );
    const actionHash = await wallet.writeContract({
      address: deployed.host,
      abi: hostAbi,
      functionName: 'submitAction',
      args: [next.log.args.session, actionData],
    });
    const actionReceipt = await publicClient.waitForTransactionReceipt({ hash: actionHash });
    observations[observations.length - 1].actionTx = actionReceipt.transactionHash;
    observations[observations.length - 1].action = action;
  }

  const after = await publicClient.readContract({
    address: deployed.token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });

  return { sessionId, survived, ended, payout, finalState, observations, before, after, requestOrigins };
}

async function main() {
  console.log('FRACTURE RUN MODE — end-to-end test (real VRF, real facet)\n');
  console.log(`host   ${deployed.host}`);
  console.log(`game   ${game}`);
  console.log(`player ${account.address}`);
  console.log(`wager  ${formatUnits(WAGER, 18)} chUSD\n`);

  const allowance = await publicClient.readContract({
    address: deployed.token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, deployed.host],
  });
  if (allowance < WAGER * 1000n) {
    const h = await wallet.writeContract({
      address: deployed.token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [deployed.host, 2n ** 255n],
    });
    await publicClient.waitForTransactionReceipt({ hash: h });
    console.log('Approved host to spend chUSD\n');
  }

  const RUNS = Number(process.argv[2] ?? 8);
  const runs = [];

  // --- 1. the loop works ----------------------------------------------------
  console.log(`1. Playing ${RUNS} runs, cashing out at increasing depths`);
  for (let i = 0; i < RUNS; i++) {
    const stopAt = (i % MAX_STEPS) + 1;
    const r = await playRun(stopAt);
    runs.push(r);
    const tail = r.ended === 'banked'
      ? `banked ${formatUnits(r.payout, 18)} at step ${r.survived}`
      : `struck on step ${r.survived + 1} by ${LAW_NAMES[r.finalState.law]}`;
    ok(
      r.ended !== null,
      `run ${String(i + 1).padStart(2)} (target step ${String(stopAt).padStart(2)}): ${tail}`,
    );
  }

  // --- 2. THE RESERVE INVARIANT, on chain, at every step --------------------
  console.log('\n2. Reserve invariant on chain at every decision point');
  let broke = '';
  let checked = 0;
  for (const r of runs) {
    for (const o of r.observations) {
      checked += 1;
      const want = payoutFor(WAGER, o.step);
      if (o.escrowedStake + o.reservedProfit !== want) {
        broke ||=
          `session ${r.sessionId} step ${o.step}: stake+reserve ` +
          `${o.escrowedStake + o.reservedProfit} != payout ${want}`;
      }
      if (o.reservedProfit > o.maxReservedProfit) {
        broke ||= `session ${r.sessionId} step ${o.step}: reserve exceeds the cap quoted at open`;
      }
    }
  }
  ok(!broke, `stake + reservedProfit == payoutFor(step) at all ${checked} decision points`);
  if (broke) console.log(`        ${broke}`);

  const capOk = runs.every(r =>
    r.observations.every(o => o.maxReservedProfit === payoutFor(WAGER, MAX_STEPS) - WAGER),
  );
  ok(capOk, 'maxReservedProfit quoted at open covers the full ladder, on every session');

  // --- 3. payouts match the paytable ---------------------------------------
  console.log('\n3. Payouts and balances');
  let payoutBad = '';
  for (const r of runs) {
    const expected = r.ended === 'banked' ? payoutFor(WAGER, r.survived) : 0n;
    if (r.payout !== expected) {
      payoutBad ||= `session ${r.sessionId}: paid ${r.payout}, paytable says ${expected}`;
    }
    if (r.after - r.before !== expected - WAGER) {
      payoutBad ||= `session ${r.sessionId}: balance moved ${r.after - r.before}, expected ${expected - WAGER}`;
    }
  }
  ok(!payoutBad, 'every settlement paid exactly payoutFor(step) and moved the balance to match');
  if (payoutBad) console.log(`        ${payoutBad}`);

  const struckRuns = runs.filter(r => r.ended === 'struck');
  ok(
    struckRuns.every(r => r.payout === 0n),
    `a strike ends the run at zero (${struckRuns.length} of ${runs.length} runs were struck)`,
  );

  // --- 4. the arc actually decided the outcome -----------------------------
  console.log('\n4. The arc is what decided each step');
  let arcBad = '';
  for (const r of runs) {
    for (const o of r.observations) {
      // A survived step: the anchor must have been OUTSIDE the arc.
      const inArc = (o.position + 5 - o.arcStart) % 5 < o.arcLength;
      if (inArc) arcBad ||= `session ${r.sessionId} step ${o.step}: survived while inside the arc`;
      if (o.arcLength !== hazardAt(o.step)) {
        arcBad ||= `session ${r.sessionId} step ${o.step}: arc length ${o.arcLength}, schedule says ${hazardAt(o.step)}`;
      }
    }
    if (r.ended === 'struck') {
      const s = r.finalState;
      const inArc = (s.position + 5 - s.arcStart) % 5 < s.arcLength;
      if (!inArc) arcBad ||= `session ${r.sessionId}: struck while outside the arc`;
    }
  }
  ok(!arcBad, 'every survival was outside its arc and every strike was inside one');
  if (arcBad) console.log(`        ${arcBad}`);

  // --- 5. THE ADVERSARIAL TEST ---------------------------------------------
  // Reading public chain state mid-run must not reveal the next step.
  console.log('\n5. Adversarial: public chain state never holds a future outcome');
  const ZERO = `0x${'00'.repeat(32)}`;
  let leak = '';
  let decisions = 0;
  for (const r of runs) {
    for (const o of r.observations) {
      decisions += 1;
      // At a decision point the session is WAITING_PLAYER_ACTION and carries
      // NO randomness request — there is nothing in flight to read ahead of.
      if (o.pendingRequestId !== ZERO) {
        leak ||= `session ${r.sessionId} step ${o.step}: a randomness request was already pending at the decision point`;
      }
    }
  }
  ok(!leak, `no randomness request is pending at any of the ${decisions} decision points`);
  if (leak) console.log(`        ${leak}`);

  // Every request must have been created by the transaction that committed an
  // anchor (openSession, or a CONTINUE) — never earlier, and never in a batch.
  let originBad = '';
  for (const r of runs) {
    const continues = r.observations.filter(o => o.action === ACTION_CONTINUE);
    for (const o of continues) {
      const born = r.requestOrigins.find(x => x.txHash === o.actionTx);
      if (!born) {
        originBad ||= `session ${r.sessionId} step ${o.step}: no randomness request created by the CONTINUE transaction`;
      }
    }
    // One request per resolved step, no more: nothing is drawn in advance.
    const resolved = r.survived + (r.ended === 'struck' ? 1 : 0);
    if (r.requestOrigins.length !== resolved) {
      originBad ||= `session ${r.sessionId}: ${r.requestOrigins.length} randomness requests for ${resolved} resolved steps`;
    }
  }
  ok(
    !originBad,
    "each step's word is requested by the very transaction that commits the anchor, one per step",
  );
  if (originBad) console.log(`        ${originBad}`);

  // --- 6. forfeit quotes the banked value ----------------------------------
  console.log('\n6. Forfeit quotes the real banked value');
  const forfeitAbi = parseAbi([
    'function quoteForfeitPayout((uint256,address,address,uint256,uint256,uint256,uint32,bytes,bytes) ctx) view returns (uint256)',
  ]);
  let forfeitBad = '';
  let forfeitChecked = 0;
  for (const r of runs) {
    for (const o of r.observations.slice(0, 2)) {
      const s = decodeSession(o.encoded);
      const quote = await publicClient.readContract({
        address: game,
        abi: forfeitAbi,
        functionName: 'quoteForfeitPayout',
        args: [
          [
            s.sessionId,
            s.player,
            s.vault,
            s.wagerBase,
            s.escrowedStake,
            s.reservedProfit,
            s.step,
            s.gameData,
            s.gameState,
          ],
        ],
      });
      forfeitChecked += 1;
      const want = payoutFor(WAGER, o.step);
      if (quote !== want) {
        forfeitBad ||= `session ${r.sessionId} step ${o.step}: quoted ${quote}, banked value is ${want}`;
      }
    }
  }
  ok(
    !forfeitBad,
    `an abandoned run quotes its banked value, not zero (${forfeitChecked} checked)`,
  );
  if (forfeitBad) console.log(`        ${forfeitBad}`);

  // --- 7. how deep did we get ----------------------------------------------
  const deepest = runs.reduce((m, r) => Math.max(m, r.survived), 0);
  const totalSteps = runs.reduce((n, r) => n + r.survived + (r.ended === 'struck' ? 1 : 0), 0);
  console.log(
    `\n   ${runs.length} runs, ${totalSteps} resolved steps, deepest ${deepest}, ` +
      `${struckRuns.length} struck, ${runs.length - struckRuns.length} banked`,
  );

  console.log(
    failures === 0
      ? '\nRun mode settles correctly on chain, with the reserve exact at every step.\n'
      : `\n${failures} CHECK(S) FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
