/**
 * Full-loop end-to-end test for FractureGame against the local stack:
 * openSession -> real VRF fulfillment -> settlement -> payout.
 *
 * This drives the LocalCasinoHost exactly as the host app does, so it exercises
 * the real facet checks (caps, risk params, phase transitions, payout cap) and
 * the real Verify Network VRF node — not a mock.
 *
 * It keeps betting VOID until the 19x top multiplier actually lands, because
 * the two InvalidPayout traps in CONTRACT_CONSTRAINTS.md only surface on the
 * largest win and casual testing misses them.
 *
 * Usage: node scripts/e2e-round.mjs [rounds]
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

const NAMES = ['GRAVITY', 'TIME', 'SCALE', 'ORBIT', 'VOID'];
const WEIGHTS = [45n, 25n, 15n, 10n, 5n];
const RTP_NUM = 95n;
const payoutFor = (wager, o) => (wager * RTP_NUM) / WEIGHTS[o];

const DEV_MNEMONIC = 'test test test test test test test test test test test junk';
const WAGER = 10n ** 18n; // 1 chUSD

const hostAbi = parseAbi([
  'function openSession(address game, address vault, uint256 wager, bytes gameData) returns (uint256 sessionId, bytes32 requestId)',
  'event CasinoSessionOpened(uint256 indexed sessionId, address indexed game, address indexed player, address vault, uint256 wager)',
  'event CasinoSessionSettled(uint256 indexed sessionId, address indexed game, address indexed player, uint8 phase, uint256 payout, bytes32 randomness, bytes gameState)',
]);
const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

// FractureState as encoded by the contract
const stateParams = [
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
];

const game = deployed.games.find((g) => g.name === 'FractureGame')?.address;
if (!game) throw new Error('FractureGame is not deployed — is the local node running?');

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

async function playRound(prediction) {
  const gameData = encodeAbiParameters([{ type: 'uint8' }], [prediction]);
  const before = await publicClient.readContract({
    address: deployed.token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });

  const hash = await wallet.writeContract({
    address: deployed.host,
    abi: hostAbi,
    functionName: 'openSession',
    args: [game, deployed.vault, WAGER, gameData],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const openedEvent = hostAbi.find((a) => a.type === 'event' && a.name === 'CasinoSessionOpened');
  const opened = receipt.logs
    .map((l) => {
      try {
        return decodeEventLog({ abi: [openedEvent], data: l.data, topics: l.topics });
      } catch {
        return null;
      }
    })
    .find(Boolean);
  if (!opened) throw new Error('no CasinoSessionOpened event in the open receipt');
  const sessionId = opened.args.sessionId;

  // The local VRF node fulfils asynchronously; wait for the settle event.
  const settled = await waitForSettle(sessionId, receipt.blockNumber);
  const [state] = decodeAbiParameters(stateParams, settled.args.gameState);

  const after = await publicClient.readContract({
    address: deployed.token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });

  return { sessionId, state, payout: settled.args.payout, before, after };
}

async function waitForSettle(sessionId, fromBlock) {
  const event = parseAbiItem(
    'event CasinoSessionSettled(uint256 indexed sessionId, address indexed game, address indexed player, uint8 phase, uint256 payout, bytes32 randomness, bytes gameState)',
  );
  for (let i = 0; i < 300; i++) {
    const logs = await publicClient.getLogs({
      address: deployed.host,
      event,
      args: { sessionId },
      fromBlock,
      toBlock: 'latest',
    });
    if (logs.length) return logs[0];
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`session ${sessionId} never settled`);
}

async function main() {
  console.log('FRACTURE — end-to-end round test (real VRF, real facet)\n');
  console.log(`host ${deployed.host}`);
  console.log(`game ${game}`);
  console.log(`player ${account.address}\n`);

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

  // --- 1. one round per outcome: the loop works for every prediction --------
  console.log('1. One round for each of the five predictions');
  const seen = new Map();
  for (let p = 0; p < 5; p++) {
    const r = await playRound(p);
    const expected = r.state.won ? payoutFor(WAGER, p) : 0n;
    const delta = r.after - r.before;
    const expectedDelta = expected - WAGER;
    ok(
      r.state.resolved && r.state.prediction === p,
      `${NAMES[p].padEnd(7)} settled — rolled ${NAMES[r.state.outcome]} (bucket ${r.state.bucket}), ${r.state.won ? 'WIN' : 'loss'}`,
    );
    ok(
      r.payout === expected,
      `${NAMES[p].padEnd(7)} payout ${formatUnits(r.payout, 18)} matches payoutFor()`,
    );
    ok(delta === expectedDelta, `${NAMES[p].padEnd(7)} balance moved by exactly ${formatUnits(expectedDelta, 18)}`);
    seen.set(r.state.outcome, (seen.get(r.state.outcome) ?? 0) + 1);
  }

  // --- 2. force the 19x top multiplier through the real payout cap ----------
  console.log('\n2. Forcing a VOID win (19x) — the payout-cap trap path');
  let voidWin = null;
  let attempts = 0;
  const maxAttempts = 400;
  while (!voidWin && attempts < maxAttempts) {
    attempts += 1;
    const r = await playRound(4);
    if (r.state.won) voidWin = r;
  }
  if (!voidWin) {
    ok(false, `no VOID win in ${maxAttempts} rounds (astronomically unlikely — investigate)`);
  } else {
    const expected = payoutFor(WAGER, 4);
    ok(voidWin.payout === expected, `VOID paid ${formatUnits(voidWin.payout, 18)} (19x) on attempt ${attempts}`);
    ok(
      voidWin.after - voidWin.before === expected - WAGER,
      `net +${formatUnits(expected - WAGER, 18)} chUSD — no InvalidPayout revert at top multiplier`,
    );
  }

  // --- 3. bucket distribution sanity over the accumulated rounds ------------
  console.log(`\n3. Observed outcomes over ${5 + attempts} rounds`);
  console.log(`  ${[...seen.entries()].map(([o, c]) => `${NAMES[o]}:${c}`).join('  ')} (+ ${attempts} VOID-prediction rounds)`);

  console.log(
    failures === 0
      ? '\nEnd-to-end loop verified: bet -> VRF -> outcome -> payout.\n'
      : `\n${failures} CHECK(S) FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
