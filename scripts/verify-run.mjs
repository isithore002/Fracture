/**
 * Drives RUN MODE in a real browser.
 *
 * Checks the things that fail silently and would otherwise only be discovered
 * by a judge or a player mid-run:
 *   1. Standalone mode plays a full run outside any host iframe.
 *   2. Surviving advances the ladder and offers the decision.
 *   3. Cashing out at an arbitrary depth pays the ladder's value and credits
 *      the balance (the `revealOutcome` regression guard).
 *   4. A strike ends the run at zero.
 *   5. The ladder's numbers match the declared paytable exactly.
 *   6. The arc that lands is never visible before it resolves.
 *   7. No console errors across a whole run.
 *
 * Usage: node scripts/verify-run.mjs [url] [--shots <dir>]
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const shotIndex = args.indexOf('--shots');
const SHOTS = shotIndex >= 0 ? args[shotIndex + 1] : null;
const URL = args.find(a => a.startsWith('http')) ?? 'http://localhost:3200/';

/** The declared paytable. Must match FractureRunGame.multiplierOf exactly. */
const MULTIPLIER = [
  null,
  19 / 16,
  95 / 64,
  475 / 256,
  2375 / 1024,
  11875 / 3072,
  59375 / 9216,
  296875 / 27648,
  1484375 / 82944,
  7421875 / 165888,
  37109375 / 331776,
];
const MAX_STEPS = 10;

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

/** First number in a string — these readouts hold several ("1.19 chUSD · 1.19x"). */
const num = t => {
  const m = String(t).match(/[\d.]+/);
  return m ? Number(m[0]) : NaN;
};

/** Waits for the run to reach a decision point or end. */
async function settleStep(page, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.locator('.decision').isVisible().catch(() => false)) return 'decision';
    if (await page.locator('.result').isVisible().catch(() => false)) return 'over';
    await page.waitForTimeout(150);
  }
  return 'timeout';
}

async function main() {
  console.log(`FRACTURE RUN MODE — browser verification of ${URL}\n`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const errors = [];
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', e => errors.push(String(e)));

  // --- 1. standalone load ---------------------------------------------------
  console.log('1. Standalone load');
  const t0 = Date.now();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.world', { timeout: 15000 });
  ok(true, `world rendered in ${Date.now() - t0}ms`);

  await page.waitForSelector('.demo-pill', { timeout: 5000 });
  ok(true, 'fell back to standalone demo mode (no host present)');

  const widget = await page.locator('script[src*="jam.chain.wtf/widget.js"]').count();
  ok(widget === 1, 'jam widget script tag is on the page');

  const anchors = await page.locator('.pick-anchor').count();
  ok(anchors === 5, 'five anchor positions rendered');

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  ok(!overflow, 'no horizontal page scroll');

  if (SHOTS) {
    await page.waitForTimeout(2200);
    await page.screenshot({ path: `${SHOTS}/run-01-idle.png` });
  }

  // --- 2. the arc is never visible before it resolves -----------------------
  console.log('\n2. The arc cannot be seen before it is drawn');
  await page.locator('.cta').click();
  await page.waitForSelector(".world[data-phase='anticipation']", { timeout: 6000 });
  const leaked = await page.evaluate(() => {
    const world = document.querySelector('.world');
    return {
      struck: world?.getAttribute('data-struck'),
      hitPips: document.querySelectorAll('.anchor-spot.hit').length,
    };
  });
  ok(
    leaked.struck === null && leaked.hitPips === 0,
    'nothing on screen names the arc while the VRF word is still in flight',
    `data-struck=${leaked.struck} hit-markers=${leaked.hitPips}`,
  );
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/run-02-awaiting.png` });

  // --- 3. surviving advances the ladder -------------------------------------
  console.log('\n3. Surviving advances the ladder');
  let outcome = await settleStep(page);
  ok(outcome !== 'timeout', `the first step resolved (${outcome})`);

  if (outcome === 'decision') {
    const ladder = await page.locator('.ladder').innerText();
    ok(
      /1\.1875/.test(ladder),
      'step 1 banks at the declared 1.1875x',
      ladder.replace(/\n/g, ' | '),
    );
    ok(
      /1\.4844/.test(ladder),
      'one more is offered at the declared 1.4844x',
    );
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/run-03-decision.png` });
  }

  // --- 4. every rung matches the declared paytable --------------------------
  console.log('\n4. The ladder matches the declared paytable');
  let depth = outcome === 'decision' ? 1 : 0;
  let mismatched = '';
  while (outcome === 'decision' && depth < MAX_STEPS) {
    const shown = num(await page.locator('.ladder-cell .ladder-value').first().innerText());
    const want = MULTIPLIER[depth];
    if (Math.abs(shown - want) > 0.0002) {
      mismatched ||= `step ${depth}: showed ${shown}, paytable says ${want.toFixed(4)}`;
    }
    await page.locator('.cta.more').click();
    outcome = await settleStep(page);
    if (outcome === 'decision') depth += 1;
  }
  ok(!mismatched, `every rung reached (to step ${depth}) matched the paytable`, mismatched);

  // --- 5. a strike ends the run at zero, or the cap auto-banks --------------
  console.log('\n5. The run ends');
  ok(outcome === 'over', 'the run reached a terminal state', `after ${depth} survived steps`);
  if (outcome === 'over') {
    const headline = (await page.locator('.result-headline').innerText()).trim();
    const detail = (await page.locator('.result-detail').innerText()).trim();
    const struck = /fractured/i.test(headline);
    ok(
      struck || /ladder|banked/i.test(headline),
      `ended as "${headline}"`,
      detail.slice(0, 120),
    );
    if (struck) {
      ok(/−|-/.test(detail), 'a strike reports the stake lost, not a payout');
    }
    const rows = await page.locator('.arclog-row').count();
    ok(rows === depth + (struck ? 1 : 0), `the run log has one row per resolved step`, `${rows} rows`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/run-04-over.png` });
  }

  // --- 6. cashing out pays the ladder and credits the balance ---------------
  // Bet again until a run survives at least one step, then bank it and assert
  // the balance actually went UP. This is the `revealOutcome` regression guard:
  // the host withholds winnings from its balance display until the game says
  // its presentation has finished, so forgetting that call makes a win look
  // exactly like a loss.
  console.log('\n6. Cashing out credits the balance');
  let banked = false;
  for (let attempt = 0; attempt < 12 && !banked; attempt++) {
    await page.locator('.cta:not([disabled])').waitFor({ timeout: 15000 });
    const before = num(await page.locator('.balance').innerText());
    // The wager field is gone once the run owns the stake, which is correct —
    // so read it while it is still on screen.
    const stake = num(await page.locator('.wager-field input').inputValue());
    await page.locator('.cta').click();
    const first = await settleStep(page);
    if (first !== 'decision') continue;

    const mult = num(await page.locator('.ladder-cell .ladder-value').first().innerText());
    const owed = num(await page.locator('.cash .key-sub').innerText());
    await page.locator('.cash').click();
    await page.locator('.result').waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(500); // the reveal's balance push

    const after = num(await page.locator('.balance').innerText());

    ok(
      after > before,
      'banking a run increases the balance (revealOutcome released the winnings)',
      `${before} -> ${after} at ${mult}x`,
    );
    // `before` was read before the stake left the balance, so the net movement
    // is payout minus stake — which is also the only honest way to state it.
    ok(
      Math.abs(after - before - (owed - stake)) < 0.01,
      'the net credit is exactly the cash-out value minus the stake',
      `staked ${stake}, promised ${owed}, net ${(after - before).toFixed(4)}`,
    );
    banked = true;
  }
  if (!banked) ok(false, 'no run survived a first step in 12 attempts at 80% (investigate)');

  // --- 7. console hygiene ---------------------------------------------------
  console.log('\n7. Console');
  const real = errors.filter(e => !/favicon|widget\.js|ERR_NAME_NOT_RESOLVED|net::/i.test(e));
  ok(real.length === 0, 'no console errors across the whole session', real.slice(0, 3).join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nRun mode verified.\n' : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
