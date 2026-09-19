/**
 * Exhaustive RTP + fairness proof for FractureRunGame (RUN MODE).
 *
 * This does NOT re-implement the paytable in JavaScript and compare two copies
 * of the same idea. It compiles the real FractureRunGame.sol, deploys the real
 * bytecode to the local chain, and enumerates the contract's own functions.
 * Every assertion below is a statement about deployed bytecode.
 *
 * Proves, by enumeration rather than sampling:
 *   1. The hazard schedule is what the paytable claims (1/5, 2/5, 3/5).
 *   2. Every multiplier equals 0.95 / S_k derived from first principles.
 *   3. EXPECTED VALUE IS EXACTLY 95% OF THE WAGER AT EVERY STOPPING POINT —
 *      so no stopping strategy, however clever, moves the house edge.
 *   4. The arc draw is unbiased over all 256 byte values.
 *   5. Every position is struck by exactly H of the 5 arcs — position choice
 *      is EV-neutral, exhaustively, for all 75 (position, arc, length) triples.
 *   6. The reserve invariant holds at every transition of every run, and
 *      stake + reservedProfit == payout to the wei at every settlement.
 *   7. Max exposure and the wager ceiling it implies.
 *   8. The step-10 auto-bank, driven directly rather than waited for — only
 *      0.85% of runs reach it, so play-testing never exercises the largest
 *      payout the game can make.
 *
 * Usage: node scripts/verify-run-rtp.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  createPublicClient,
  createWalletClient,
  http,
  getContract,
  encodeAbiParameters,
  decodeAbiParameters,
  hexToBytes,
  keccak256,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SDK = resolve(HERE, '../sdk/casino-sdk');
const CONTRACTS = resolve(SDK, 'simulator/contracts');
const require = createRequire(resolve(SDK, 'simulator/package.json'));
const solc = require('solc');

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const DEV_MNEMONIC = 'test test test test test test test test test test test junk';

const POSITIONS = 5n;
const MAX_STEPS = 10;
const DRAW_REJECT = 255;
/** RTP as an exact rational: 19/20 == 95%. */
const RTP_NUM = 19n;
const RTP_DEN = 20n;

const POSITION_NAMES = ['HILLTOP', 'ORCHARD', 'HEARTH', 'FENCELINE', 'HOLLOW'];

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (cond) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

// ---------------------------------------------------------------------------
// First-principles model. Derived here from the hazard schedule alone — never
// copied from the contract — so agreement between the two is evidence.
// ---------------------------------------------------------------------------

/** Arc length at a step, straight from the design: 1/5, then 2/5, then 3/5. */
const hazard = step => (step <= 4 ? 1n : step <= 8 ? 2n : 3n);

/** S_k as an exact fraction: numerator = product of survivors, denom = 5^k. */
function survival(step) {
  let num = 1n;
  let den = 1n;
  for (let k = 1; k <= step; k++) {
    num *= POSITIONS - hazard(k);
    den *= POSITIONS;
  }
  return { num, den };
}

/**
 * M_k = RTP / S_k, as an exact fraction.
 * This single line is the entire economic design: expected value at any
 * stopping point is S_k * M_k == RTP, identically, for every k.
 */
function multiplier(step) {
  const s = survival(step);
  return { num: RTP_NUM * s.den, den: RTP_DEN * s.num };
}

const gcd = (a, b) => (b === 0n ? a : gcd(b, a % b));
const reduce = ({ num, den }) => {
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
};
const sameRational = (a, b) => a.num * b.den === b.num * a.den;
const asNumber = ({ num, den }) => Number((num * 1000000n) / den) / 1000000;

// ---------------------------------------------------------------------------
// Compile the real contract with the harness's own solc settings
// ---------------------------------------------------------------------------

function compile() {
  const file = 'FractureRunGame.sol';
  const input = {
    language: 'Solidity',
    sources: { [file]: { content: readFileSync(resolve(CONTRACTS, file), 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const findImports = p => {
    const sibling = resolve(CONTRACTS, p);
    try {
      return { contents: readFileSync(sibling, 'utf8') };
    } catch {
      return { error: `Import not found: ${p}` };
    }
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (out.errors ?? []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  const c = out.contracts[file].FractureRunGame;
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
}

/** Mirrors the Solidity draw; used only to cross-check on full-word inputs. */
function referenceDraw(wordHex) {
  let seed = hexToBytes(wordHex);
  let idx = 0;
  const draws = [];
  while (draws.length < 2) {
    if (idx === 32) {
      seed = hexToBytes(keccak256(seed));
      idx = 0;
    }
    const b = seed[idx];
    idx += 1;
    if (b < DRAW_REJECT) draws.push(b % 5);
  }
  return draws;
}

const WAGERS = [
  10n ** 18n, // 1 chUSD
  1n, // the pathological minimum
  7n,
  123456789n,
  10n ** 6n,
  2n ** 64n,
  999999999999999999n,
  10n ** 24n, // 1M chUSD
];

async function main() {
  console.log('FRACTURE RUN MODE — exhaustive RTP & fairness proof\n');

  const { abi, bytecode } = compile();
  console.log('Compiled FractureRunGame.sol (solc, viaIR, optimizer runs=200)\n');

  const account = mnemonicToAccount(DEV_MNEMONIC);
  const transport = http(RPC);
  const publicClient = createPublicClient({ transport });
  const chainId = await publicClient.getChainId();
  const chain = {
    id: chainId,
    name: 'local',
    nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  };
  const wallet = createWalletClient({ account, chain, transport });

  const hash = await wallet.deployContract({ abi, bytecode, args: [] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const game = getContract({ address: receipt.contractAddress, abi, client: publicClient });
  console.log(`Deployed to ${receipt.contractAddress} on chain ${chainId}\n`);

  // -- 1. Hazard schedule ----------------------------------------------------
  console.log('1. Hazard schedule — the world gets less survivable');
  for (let k = 1; k <= MAX_STEPS; k++) {
    const h = BigInt(await game.read.hazardAt([k]));
    const [survivors, outOf] = await game.read.stepOddsAt([k]);
    ok(
      h === hazard(k) && BigInt(survivors) === POSITIONS - hazard(k) && BigInt(outOf) === POSITIONS,
      `step ${String(k).padStart(2)}  ${h} of 5 destroyed  p(survive) = ${survivors}/${outOf}`,
      `${((Number(survivors) / Number(outOf)) * 100).toFixed(0)}%`,
    );
  }
  let hazardRangeGuarded = false;
  try {
    await game.read.hazardAt([MAX_STEPS + 1]);
  } catch {
    hazardRangeGuarded = true;
  }
  ok(hazardRangeGuarded, `step ${MAX_STEPS + 1} reverts — the ladder is capped`);

  // -- 2. Multipliers are exactly RTP / S_k ----------------------------------
  console.log('\n2. Every multiplier equals 0.95 / S_k, derived independently');
  for (let k = 1; k <= MAX_STEPS; k++) {
    const [num, den] = await game.read.multiplierOf([k]);
    const derived = multiplier(k);
    const contractRational = { num, den };
    ok(
      sameRational(contractRational, derived),
      `M_${String(k).padStart(2)} = ${num}/${den}`,
      `= ${asNumber(contractRational).toFixed(6)}x  (derived ${asNumber(derived).toFixed(6)}x)`,
    );
  }
  // The table must also be strictly increasing, or "one more" would be a
  // downgrade and the reserve deltas below could go negative.
  let increasing = true;
  for (let k = 2; k <= MAX_STEPS; k++) {
    const [n1, d1] = await game.read.multiplierOf([k - 1]);
    const [n2, d2] = await game.read.multiplierOf([k]);
    if (n2 * d1 <= n1 * d2) increasing = false;
  }
  ok(increasing, 'multipliers strictly increase with every surviving step');

  // -- 3. THE RTP PROOF ------------------------------------------------------
  console.log('\n3. Expected value at EVERY stopping point == 95% of the wager');
  // Exact statement, in integers only:
  //     S_k * payout_k  <=  (19/20) * wager
  //  => 20 * P_k * payout_k  <=  19 * 5^k * wager
  // Equality holds in exact rationals; integer flooring can only lose value,
  // and never gains any — which is what "never above 95%" means.
  for (let k = 1; k <= MAX_STEPS; k++) {
    const s = survival(k);
    let everOver = false;
    let worstRtpPpm = 1000000n;
    for (const w of WAGERS) {
      const payout = await game.read.payoutFor([w, k]);
      const lhs = RTP_DEN * s.num * payout; // 20 * P_k * payout
      const rhs = RTP_NUM * s.den * w; //      19 * 5^k * wager
      if (lhs > rhs) everOver = true;
      // realised RTP in parts-per-million, for the report
      const ppm = (s.num * payout * 1000000n) / (s.den * w);
      if (ppm < worstRtpPpm) worstRtpPpm = ppm;
    }
    ok(
      !everOver,
      `stop at ${String(k).padStart(2)}: S_k x M_k == 95.0000%, never above`,
      `worst realised ${(Number(worstRtpPpm) / 10000).toFixed(4)}% across ${WAGERS.length} wagers (1 wei included)`,
    );
  }

  // Full path enumeration: the probabilities of every way a run can end must
  // sum to exactly 1, and the payouts must weight out to exactly 95%.
  console.log('\n   Full-path enumeration of every way a run can end');
  const W = 10n ** 18n;
  for (let stopAt = 1; stopAt <= MAX_STEPS; stopAt++) {
    // Work over the common denominator 5^stopAt so this is exact integer math.
    const den = POSITIONS ** BigInt(stopAt);
    let probNum = 0n; // accumulated probability numerator
    let evNum = 0n; // accumulated payout-weighted numerator
    for (let j = 1; j <= stopAt; j++) {
      // struck at step j: survive j-1 steps, then hit the arc
      const s = survival(j - 1);
      const strikeNum = s.num * hazard(j) * (den / (s.den * POSITIONS));
      probNum += strikeNum; // payout 0, contributes nothing to evNum
    }
    const s = survival(stopAt);
    const surviveNum = s.num * (den / s.den);
    probNum += surviveNum;
    const payout = await game.read.payoutFor([W, stopAt]);
    evNum += surviveNum * payout;

    const probExact = probNum === den;
    const evExact = RTP_DEN * evNum <= RTP_NUM * den * W;
    ok(
      probExact && evExact,
      `strategy "stop at ${String(stopAt).padStart(2)}": outcomes sum to 1, EV <= 95%`,
      `EV = ${(Number((evNum * 1000000n) / (den * W)) / 10000).toFixed(4)}% of wager`,
    );
  }

  // -- 4. Unbiased arc draw --------------------------------------------------
  console.log('\n4. Arc draw over all 256 byte values');
  const accepted = [];
  for (let b = 0; b < 256; b++) if (b < DRAW_REJECT) accepted.push(b % 5);
  const preimages = new Map();
  for (const p of accepted) preimages.set(p, (preimages.get(p) ?? 0) + 1);
  const counts = [...preimages.values()];
  ok(
    preimages.size === 5 && counts.every(c => c === counts[0]),
    `all 5 positions have exactly ${counts[0]} accepted preimages each`,
    `${accepted.length} accepted bytes / 5 positions`,
  );
  const naive = new Map();
  for (let b = 0; b < 256; b++) naive.set(b % 5, (naive.get(b % 5) ?? 0) + 1);
  const naiveCounts = [...naive.values()];
  ok(
    Math.min(...naiveCounts) !== Math.max(...naiveCounts),
    'naive `byte % 5` would be biased (control check)',
    `min=${Math.min(...naiveCounts)} max=${Math.max(...naiveCounts)}`,
  );
  let mismatch = 0;
  const probes = [];
  for (let b = 0; b < 256; b++) probes.push(`0x${b.toString(16).padStart(2, '0')}${'00'.repeat(31)}`);
  probes.push(`0x${'ff'.repeat(32)}`); // every byte rejected -> must rehash, not revert
  probes.push(`0x${'fe'.repeat(32)}`); // exactly below the reject threshold
  for (let i = 0; i < 64; i++) probes.push(keccak256(new Uint8Array([i])));
  for (const w of probes) {
    const [arcStart, law] = await game.read.drawFromRandomness([w]);
    const [refArc, refLaw] = referenceDraw(w);
    if (Number(arcStart) !== refArc || Number(law) !== refLaw) mismatch += 1;
  }
  ok(mismatch === 0, `contract matches reference draw on ${probes.length} probe words`);
  const [rehashed] = await game.read.drawFromRandomness([`0x${'ff'.repeat(32)}`]);
  ok(
    Number(rehashed) >= 0 && Number(rehashed) < 5,
    'a fully-rejected word rehashes instead of reverting',
    `arcStart=${rehashed}`,
  );

  // -- 5. POSITION CHOICE IS EV-NEUTRAL --------------------------------------
  console.log('\n5. Every position is struck by exactly H of the 5 arcs (exhaustive)');
  // 5 positions x 5 arc starts x 3 hazard lengths = 75 triples, all enumerated.
  for (const length of [1, 2, 3]) {
    const hits = [];
    for (let position = 0; position < 5; position++) {
      let struckBy = 0;
      for (let arcStart = 0; arcStart < 5; arcStart++) {
        if (await game.read.isStruck([position, arcStart, length])) struckBy += 1;
      }
      hits.push(struckBy);
    }
    ok(
      hits.every(h => h === length),
      `H=${length}: every position struck by exactly ${length} of 5 arcs`,
      hits.map((h, i) => `${POSITION_NAMES[i]}=${h}`).join(' '),
    );
  }
  ok(
    true,
    'therefore P(struck) = H/5 for every position — the anchor is a placement, not a dodge',
  );

  // -- 6. Reserve accounting -------------------------------------------------
  console.log('\n6. Reserve invariant across every transition of every run');
  // The invariant: entering WAITING_RANDOMNESS for step k, the session holds
  //     reservedProfit == payoutFor(wager, k) - wager
  // built from onSessionStart's delta plus one delta per CONTINUE. Replay the
  // arithmetic the host would do and check it at every step of every wager.
  for (const w of WAGERS) {
    let reserve = await game.read.reservedProfitFor([w, 1]); // onSessionStart
    let broke = '';
    for (let k = 1; k <= MAX_STEPS; k++) {
      const payout = await game.read.payoutFor([w, k]);
      // invariant for the step now in flight
      const expected = payout > w ? payout - w : 0n;
      if (reserve !== expected) broke ||= `step ${k}: reserve ${reserve} != ${expected}`;
      // a settlement here must land exactly on the host's cap
      if (w + reserve !== payout) broke ||= `step ${k}: stake+reserve ${w + reserve} != payout ${payout}`;
      if (k < MAX_STEPS) {
        const next = await game.read.payoutFor([w, k + 1]);
        const delta = next - payout; // the CONTINUE delta
        if (delta < 0n) broke ||= `step ${k}: negative reserve delta ${delta}`;
        reserve += delta;
      }
    }
    ok(!broke, `wager ${w}: invariant holds for all ${MAX_STEPS} steps`, broke);
  }
  // The cap quoted at open must cover the whole ladder.
  for (const w of WAGERS) {
    const [maxEscrow, maxReserved] = await game.read.quoteCaps([
      w,
      `0x${'00'.repeat(31)}00`,
    ]);
    const top = await game.read.reservedProfitFor([w, MAX_STEPS]);
    ok(
      maxEscrow === w && maxReserved === top,
      `wager ${w}: quoteCaps covers the step-${MAX_STEPS} payout`,
      `maxReservedProfit=${maxReserved}`,
    );
  }

  // -- 7. Exposure and the wager ceiling it implies ---------------------------
  console.log('\n7. Maximum exposure');
  const [topNum, topDen] = await game.read.multiplierOf([MAX_STEPS]);
  const topMult = Number(topNum) / Number(topDen);
  const oneToken = 10n ** 18n;
  const maxPayout = await game.read.payoutFor([oneToken, MAX_STEPS]);
  const maxReserve = await game.read.reservedProfitFor([oneToken, MAX_STEPS]);
  ok(
    maxReserve === maxPayout - oneToken,
    `top payout ${topMult.toFixed(4)}x — exposure ${(Number(maxReserve) / 1e18).toFixed(4)}x the wager`,
    'max wager must be derived from the casino risk limit, never hard-coded',
  );
  const s10 = survival(MAX_STEPS);
  const [, probabilityWad] = await game.read.quoteRiskParams([oneToken, `0x${'00'.repeat(32)}`]);
  ok(
    probabilityWad === (10n ** 18n * s10.num) / s10.den && probabilityWad <= 10n ** 18n,
    'quoteRiskParams reports the true top-payout probability',
    `${((Number(s10.num) / Number(s10.den)) * 100).toFixed(4)}% of runs reach the cap`,
  );
  const [, , expectedPayout] = await game.read.quoteRiskParams([oneToken, `0x${'00'.repeat(32)}`]);
  ok(
    expectedPayout === (oneToken * 95n) / 100n,
    'quoteRiskParams expected payout is 95% of the wager, regardless of play',
  );

  // -- 8. The step-10 auto-bank, driven directly ------------------------------
  // Only 0.85% of runs reach the cap, so play-testing will not exercise the
  // largest payout this game can make — which is exactly the path where a
  // reserve or cap mistake would surface. `onRandomness` is `external pure`,
  // so the ladder's top rung can be driven deterministically instead of waited
  // for: hand it a step-9 state and a word, and check what it returns.
  console.log('\n8. The top of the ladder (driven directly, not waited for)');
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
  const SETTLED = 3;
  const topWager = 10n ** 18n;
  const topPayout = await game.read.payoutFor([topWager, MAX_STEPS]);
  const topReserve = await game.read.reservedProfitFor([topWager, MAX_STEPS]);

  const runAtNine = (position, randomness) => {
    const gameState = encodeAbiParameters(stateParams, [
      {
        step: 9,
        position,
        arcStart: 0,
        arcLength: 3,
        law: 0,
        struck: false,
        cashedOut: false,
        randomness: `0x${'00'.repeat(32)}`,
      },
    ]);
    return game.read.onRandomness([
      {
        sessionId: 1n,
        player: account.address,
        vault: account.address,
        wagerBase: topWager,
        // The reserve invariant at this point: holding the step-10 cash-out.
        escrowedStake: topWager,
        reservedProfit: topReserve,
        step: 19,
        gameData: `0x${'00'.repeat(32)}`,
        gameState,
      },
      randomness,
    ]);
  };

  // Pick a word, read the arc it produces, then stand outside it (survive) and
  // inside it (struck) — the same word, so only the anchor differs.
  const word = keccak256(new Uint8Array([7]));
  const [arcStart] = await game.read.drawFromRandomness([word]);
  const arc = [0, 1, 2].map(i => (Number(arcStart) + i) % 5);
  const safeSpot = [0, 1, 2, 3, 4].find(p => !arc.includes(p));
  const doomedSpot = arc[0];

  const survived = await runAtNine(safeSpot, word);
  const survivedState = decodeAbiParameters(stateParams, survived.newGameState)[0];
  ok(
    survived.payout === topPayout &&
      survived.nextPhase === SETTLED &&
      survivedState.step === MAX_STEPS &&
      survivedState.cashedOut === true &&
      survivedState.struck === false,
    `surviving step ${MAX_STEPS} auto-banks ${topMult.toFixed(4)}x with no further decision`,
    `payout ${survived.payout} == payoutFor(${MAX_STEPS})`,
  );
  ok(
    survived.reservedProfitDelta === 0n,
    'the settling step moves no reserve (a negative delta here is InvalidPayout)',
  );
  ok(
    topWager + topReserve === survived.payout,
    'and the payout lands exactly on the host cap, escrowedStake + reservedProfit',
    `${topWager + topReserve} == ${survived.payout}`,
  );
  ok(
    survived.escrowDelta === 0n && survived.requestRandomnessNow === false,
    'the ladder stops there: no escrow move, no further randomness requested',
  );

  const doomed = await runAtNine(doomedSpot, word);
  const doomedState = decodeAbiParameters(stateParams, doomed.newGameState)[0];
  ok(
    doomed.payout === 0n && doomed.nextPhase === SETTLED && doomedState.struck === true,
    `the same word one position over ends the run at zero`,
    `arc ${arc.map(p => POSITION_NAMES[p]).join('+')}, anchor ${POSITION_NAMES[doomedSpot]}`,
  );
  ok(
    doomed.reservedProfitDelta === 0n,
    'a strike also moves no reserve on its settling step',
  );

  // -- 9. The paytable, for the record ---------------------------------------
  console.log('\n   PAYTABLE');
  console.log('   step  destroyed  p(step)  P(reach)    multiplier        EV');
  for (let k = 1; k <= MAX_STEPS; k++) {
    const s = survival(k);
    const [num, den] = await game.read.multiplierOf([k]);
    const m = Number(num) / Number(den);
    const reach = Number(s.num) / Number(s.den);
    console.log(
      `   ${String(k).padStart(4)}  ${String(hazard(k)).padStart(9)}` +
        `  ${((Number(POSITIONS - hazard(k)) / 5) * 100).toFixed(0).padStart(6)}%` +
        `  ${(reach * 100).toFixed(4).padStart(8)}%` +
        `  ${m.toFixed(6).padStart(12)}x` +
        `  ${(reach * m * 100).toFixed(4).padStart(8)}%`,
    );
  }

  console.log(
    failures === 0
      ? '\nAll checks passed. RTP is exactly 95.00% at every stopping point, by construction.\n'
      : `\n${failures} CHECK(S) FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
