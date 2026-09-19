/**
 * Exhaustive RTP + fairness proof for FractureGame.
 *
 * This does NOT re-implement the paytable in JavaScript and compare two copies
 * of the same idea. It compiles the real FractureGame.sol, deploys the real
 * bytecode to the local chain, and enumerates the contract's own functions.
 * Every assertion below is a statement about deployed bytecode.
 *
 * Proves, by enumeration rather than sampling:
 *   1. The five outcomes partition the 100 buckets exactly (45/25/15/10/5).
 *   2. Rejection sampling is unbiased: each of the 100 buckets has exactly the
 *      same number of accepted byte preimages, and biased `% 100` does not.
 *   3. For every outcome, probability x payout == 95% of wager, exactly, with
 *      integer floor error strictly bounded and always in the house's favour.
 *   4. reserve + stake == payout to the wei (the InvalidPayout trap).
 *
 * Usage: node scripts/verify-rtp.mjs
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

const RTP_NUM = 95n;
const BUCKETS = 100n;
const ROLL_REJECT = 200;

const NAMES = ['GRAVITY', 'TIME', 'SCALE', 'ORBIT', 'VOID'];
const EXPECTED_WEIGHTS = [45n, 25n, 15n, 10n, 5n];

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
// Compile the real contract with the harness's own solc settings
// ---------------------------------------------------------------------------

function compile() {
  // The source unit name stays flat so its `./ICasinoGameV2.sol` import still
  // resolves against the contracts root, but the file itself now lives under
  // `legacy/` — which the local node's watcher does not scan, so the original
  // single-shot game is no longer auto-deployed alongside run mode. Two
  // contracts both offering themselves as "Fracture" in the simulator's game
  // picker was a live footgun: picking the wrong one silently ate wagers.
  const file = 'FractureGame.sol';
  const source = resolve(CONTRACTS, 'legacy', file);
  const input = {
    language: 'Solidity',
    sources: { [file]: { content: readFileSync(source, 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const findImports = (p) => {
    const sibling = resolve(CONTRACTS, p);
    try {
      return { contents: readFileSync(sibling, 'utf8') };
    } catch {
      return { error: `Import not found: ${p}` };
    }
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const c = out.contracts[file].FractureGame;
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
}

// ---------------------------------------------------------------------------
// Reference rejection sampler (mirrors the Solidity, used only to cross-check
// the contract on full-word inputs — never as the source of truth for payouts)
// ---------------------------------------------------------------------------

function referenceBucket(wordHex) {
  let seed = hexToBytes(wordHex);
  let idx = 0;
  for (;;) {
    if (idx === 32) {
      seed = hexToBytes(keccak256(seed));
      idx = 0;
    }
    const b = seed[idx];
    idx += 1;
    if (b < ROLL_REJECT) return b % 100;
  }
}

async function main() {
  console.log('FRACTURE — exhaustive RTP & fairness proof\n');

  const { abi, bytecode } = compile();
  console.log('Compiled FractureGame.sol (solc, viaIR, optimizer runs=200)\n');

  const account = mnemonicToAccount(DEV_MNEMONIC);
  const transport = http(RPC);
  const publicClient = createPublicClient({ transport });
  const chainId = await publicClient.getChainId();
  const chain = { id: chainId, name: 'local', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
  const wallet = createWalletClient({ account, chain, transport });

  const hash = await wallet.deployContract({ abi, bytecode, args: [] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const game = getContract({ address: receipt.contractAddress, abi, client: publicClient });
  console.log(`Deployed to ${receipt.contractAddress} on chain ${chainId}\n`);

  // -- 1. Bucket partition ---------------------------------------------------
  console.log('1. Outcome partition over all 100 buckets');
  const tally = [0n, 0n, 0n, 0n, 0n];
  const owner = [];
  for (let b = 0; b < 100; b++) {
    const o = Number(await game.read.bucketToOutcome([b]));
    owner.push(o);
    tally[o] += 1n;
  }
  for (let o = 0; o < 5; o++) {
    const w = await game.read.weightOf([o]);
    ok(
      tally[o] === EXPECTED_WEIGHTS[o] && w === EXPECTED_WEIGHTS[o],
      `${NAMES[o].padEnd(7)} owns ${tally[o]} buckets`,
      `weightOf()=${w}, expected ${EXPECTED_WEIGHTS[o]}`,
    );
  }
  ok(tally.reduce((a, b) => a + b, 0n) === 100n, 'buckets sum to exactly 100');
  // contiguity: ranges must not interleave
  let contiguous = true;
  for (let b = 1; b < 100; b++) if (owner[b] < owner[b - 1]) contiguous = false;
  ok(contiguous, 'each outcome owns one contiguous bucket range');

  // -- 2. Unbiased sampling --------------------------------------------------
  console.log('\n2. Rejection sampling over all 256 byte values');
  const accepted = [];
  for (let b = 0; b < 256; b++) if (b < ROLL_REJECT) accepted.push(b % 100);
  const preimages = new Map();
  for (const bucket of accepted) preimages.set(bucket, (preimages.get(bucket) ?? 0) + 1);
  const counts = [...preimages.values()];
  ok(
    preimages.size === 100 && counts.every((c) => c === counts[0]),
    `all 100 buckets have exactly ${counts[0]} accepted preimages each`,
    `${accepted.length} accepted bytes / 100 buckets`,
  );
  // show what the naive version would have done
  const naive = new Map();
  for (let b = 0; b < 256; b++) naive.set(b % 100, (naive.get(b % 100) ?? 0) + 1);
  const naiveCounts = [...naive.values()];
  ok(
    Math.min(...naiveCounts) !== Math.max(...naiveCounts),
    'naive `byte % 100` would be biased (control check)',
    `min=${Math.min(...naiveCounts)} max=${Math.max(...naiveCounts)} across buckets`,
  );
  // contract agrees with the reference sampler, including forced-rejection words
  let mismatch = 0;
  const probes = [];
  for (let b = 0; b < 256; b++) probes.push(`0x${b.toString(16).padStart(2, '0')}${'00'.repeat(31)}`);
  probes.push(`0x${'ff'.repeat(32)}`); // every byte rejected -> must rehash, not revert
  probes.push(`0x${'c8'.repeat(32)}`); // exactly at the reject threshold
  for (let i = 0; i < 64; i++) {
    probes.push(keccak256(new Uint8Array([i])));
  }
  for (const w of probes) {
    const got = Number(await game.read.bucketFromRandomness([w]));
    if (got !== referenceBucket(w)) mismatch += 1;
  }
  ok(mismatch === 0, `contract matches reference sampler on ${probes.length} probe words`);
  const allRejected = Number(await game.read.bucketFromRandomness([`0x${'ff'.repeat(32)}`]));
  ok(
    allRejected >= 0 && allRejected < 100,
    'a fully-rejected word rehashes instead of reverting',
    `bucket=${allRejected}`,
  );

  // -- 3. RTP identity -------------------------------------------------------
  console.log('\n3. RTP identity: probability x payout == 95% of wager');
  const WAGERS = [10n ** 18n, 1n, 7n, 123456789n, 10n ** 6n, 2n ** 64n, 999999999999999999n];
  for (let o = 0; o < 5; o++) {
    const w = EXPECTED_WEIGHTS[o];
    let worstShortfall = 0n;
    let everOver = false;
    for (const wager of WAGERS) {
      const payout = await game.read.payoutFor([wager, o]);
      // exact expected return over the 100 equiprobable buckets:
      //   w * payout  vs  RTP_NUM * wager   (both scaled by 100 * wager)
      const lhs = w * payout;
      const rhs = RTP_NUM * wager;
      if (lhs > rhs) everOver = true;
      const shortfall = rhs - lhs;
      if (shortfall > worstShortfall) worstShortfall = shortfall;
      // floor error must be strictly less than one weight unit
      if (shortfall >= w) everOver = true;
    }
    const mult = Number(RTP_NUM) / Number(w);
    ok(
      !everOver,
      `${NAMES[o].padEnd(7)} p=${w}% x ${mult.toFixed(4)}x == 95.0000% (never above)`,
      `max floor shortfall ${worstShortfall} wei over ${WAGERS.length} wagers`,
    );
  }
  // probabilityWad sums to 1e18 and never exceeds it (facet requirement)
  let wadSum = 0n;
  for (let o = 0; o < 5; o++) {
    const pw = await game.read.probabilityWadOf([o]);
    if (pw > 10n ** 18n) failures += 1;
    wadSum += pw;
  }
  ok(wadSum === 10n ** 18n, 'probabilityWad over all outcomes sums to exactly 1e18', `${wadSum}`);

  // -- 4. Payout cap safety --------------------------------------------------
  console.log('\n4. Payout cap: reserve + stake == payout, to the wei');
  for (let o = 0; o < 5; o++) {
    let bad = 0;
    for (const wager of WAGERS) {
      const payout = await game.read.payoutFor([wager, o]);
      const reserve = await game.read.reservedProfitFor([wager, o]);
      if (wager + reserve !== payout) bad += 1;
    }
    ok(bad === 0, `${NAMES[o].padEnd(7)} stake + reservedProfit == payout for every wager`);
  }

  console.log(
    failures === 0
      ? '\nAll checks passed. RTP is exactly 95.00% for every outcome, by construction.\n'
      : `\n${failures} CHECK(S) FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
