/**
 * Drives Fracture inside the real SDK simulator: the production-faithful host
 * harness, the real LocalCasinoHost facet, the real Verify Network VRF node and
 * the deployed FractureGame contract.
 *
 * Demo mode proves the UI. This proves the integration — that the Penpal
 * bridge connects, `openSession` is signed by the host, the VRF round-trips,
 * and the settled on-chain gameState drives the right transformation.
 *
 * Usage: node scripts/verify-simulator.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const SDK = resolve(HERE, '../sdk/casino-sdk');
const deployed = JSON.parse(
  readFileSync(resolve(SDK, 'simulator/local-node/deployed.json'), 'utf8'),
);
const gameAddress = deployed.games.find(g => g.name === 'FractureGame')?.address;

const SIMULATOR = 'http://localhost:3300';
const GAME = 'http://localhost:3200';
const ROUNDS = Number(process.argv[2] ?? 3);

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  if (!gameAddress) throw new Error('FractureGame is not deployed — run `npm start` in the SDK');

  console.log('FRACTURE — simulator integration (real bridge, real VRF, real contract)\n');
  console.log(`simulator ${SIMULATOR}`);
  console.log(`game      ${GAME}`);
  console.log(`contract  ${gameAddress}\n`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));

  const url = `${SIMULATOR}/?game=${encodeURIComponent(GAME)}&gameAddress=${gameAddress}`;
  await page.goto(url, { waitUntil: 'load' });

  // The game runs in the harness's iframe.
  const frame = page.frameLocator(`iframe[src*="3200"]`);
  await frame.locator('.world').waitFor({ timeout: 30000 });
  ok(true, 'game mounted inside the simulator iframe');

  // If the bridge connected, the demo badge must NOT be present: the host is real.
  await page.waitForTimeout(2500);
  const demoBadge = await frame.locator('.demo-pill').count();
  ok(demoBadge === 0, 'connected to the real host bridge (not the demo fallback)');

  // Balance comes from the host snapshot, so a number here proves setState flowed.
  const balanceText = (await frame.locator('.balance').innerText()).trim();
  ok(/\d/.test(balanceText), 'host pushed a balance snapshot', balanceText.replace(/\s+/g, ' '));

  console.log(`\nPlaying ${ROUNDS} on-chain round(s)`);
  for (let i = 0; i < ROUNDS; i++) {
    const pick = i % 5;
    await frame.locator('.pick').nth(pick).click();
    const label = (await frame.locator('.pick').nth(pick).locator('.pick-name').innerText()).trim();

    const before = (await frame.locator('.balance').innerText()).trim();
    // Wait for the host snapshot to make the bet button live rather than
    // racing it — wallet status and balance arrive a beat after mount.
    await frame.locator('.cta:not([disabled])').waitFor({ timeout: 30000 });
    await frame.locator('.cta').click();

    await frame.locator(".world[data-phase='anticipation']").waitFor({ timeout: 20000 });

    // Real VRF round-trip through the local node.
    await frame.locator('.world[data-break]').waitFor({ timeout: 60000 });
    const broke = await frame.locator('.world').getAttribute('data-break');

    await frame.locator('.result').waitFor({ timeout: 20000 });
    const headline = (await frame.locator('.result-headline').innerText()).trim();
    const detail = (await frame.locator('.result-detail').innerText()).trim();
    const won = detail.includes('You called it');

    // The host withholds winnings from its balance display until the game
    // calls `revealOutcome`, and that call only happens once the result
    // presentation ends — so read the balance AFTER the banner, and give the
    // push a moment to land.
    await page.waitForTimeout(600);
    const after = (await frame.locator('.balance').innerText()).trim();

    ok(
      !!broke && !!headline,
      `round ${i + 1}: called ${label.padEnd(7)} -> ${String(broke).padEnd(7)} | ${detail}`,
      `balance ${before.replace(/\s+/g, ' ')} -> ${after.replace(/\s+/g, ' ')}`,
    );

    // The assertion that was missing, and that let a real bug through: a win
    // must actually INCREASE the displayed balance. Previously this only
    // checked that a round completed, so a win that silently paid nothing
    // still passed — the payout was final on-chain, but the player saw only
    // the wager leave.
    const beforeNum = Number(before.replace(/[^\d.]/g, ''));
    const afterNum = Number(after.replace(/[^\d.]/g, ''));
    if (won) {
      ok(
        afterNum > beforeNum,
        `round ${i + 1}: a WIN increased the displayed balance`,
        `${beforeNum} -> ${afterNum} (net ${(afterNum - beforeNum).toFixed(4)})`,
      );
    } else {
      ok(
        afterNum < beforeNum,
        `round ${i + 1}: a loss decreased the displayed balance`,
        `${beforeNum} -> ${afterNum} (net ${(afterNum - beforeNum).toFixed(4)})`,
      );
    }

    await frame.locator('.cta').click();
    await frame.locator('.world:not([data-break])').waitFor({ timeout: 10000 });
  }

  const real = errors.filter(e => !/favicon|widget\.js|net::/i.test(e));
  ok(real.length === 0, 'no page errors during on-chain play', real.slice(0, 2).join(' | '));

  await browser.close();
  console.log(
    failures === 0
      ? '\nSimulator integration verified.\n'
      : `\n${failures} CHECK(S) FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
