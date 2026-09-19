/**
 * Verifies the fast re-bet loop — the two shortcuts that removed the dead
 * time between rounds, both of which touch real stake amounts:
 *
 *   1. The primary key re-arms straight into another round after a settle,
 *      with no intermediate reset step.
 *   2. "Let it ride" stakes exactly what was just won, and the resulting
 *      round is a normal independent round (not a streak/multi-step thing).
 *
 * Usage: node scripts/verify-ride.mjs [url]
 */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://localhost:3200/';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const num = t => Number(String(t).replace(/[^\d.]/g, ''));

async function settleOnce(page) {
  await page.locator('.cta:not([disabled])').waitFor({ timeout: 15000 });
  await page.locator('.cta').click();
  await page.locator('.result').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  await page.locator('.result').waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(400); // reveal's balance push
  return (await page.locator('.result-detail').innerText()).trim();
}

async function main() {
  console.log(`FRACTURE — fast re-bet loop verification of ${URL}\n`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.world', { timeout: 15000 });

  // --- 1. the primary key re-arms without a reset step ---------------------
  console.log('1. One tap goes straight into the next round');
  await settleOnce(page);
  const ctaAfterSettle = await page.locator('.cta').innerText();
  ok(
    /FRACTURE/i.test(ctaAfterSettle),
    'after a settle the primary key is already a fracture key again',
    `reads "${ctaAfterSettle.trim()}"`,
  );
  const enabled = await page.locator('.cta').isEnabled();
  ok(enabled, 'and it is immediately pressable (no intermediate reset)');

  // --- 2. let it ride stakes exactly the winnings --------------------------
  console.log('\n2. "Let it ride" stakes exactly what was just won');
  let rode = false;
  for (let attempt = 0; attempt < 14 && !rode; attempt++) {
    await page.locator('.pick').first().click(); // Gravity, 45%
    const detail = await settleOnce(page);
    if (!detail.includes('You called it')) continue;

    const rideBtn = page.locator('.ride');
    ok((await rideBtn.count()) === 1, 'the ride key appears after a win');
    const rideLabel = await rideBtn.innerText();
    const won = num(rideLabel);

    await rideBtn.click();
    await page.locator('.result').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    const stakedText = await page.locator('.wager-field input').inputValue();
    ok(
      Math.abs(num(stakedText) - won) < 0.0001,
      'the next round is staked at the winnings',
      `won ${won} -> wager ${stakedText}`,
    );

    // It must be an ordinary round, not a streak: it settles on its own.
    await page.locator('.result').waitFor({ state: 'visible', timeout: 20000 });
    ok(true, 'the ridden stake settles as a normal independent round');
    rode = true;
  }
  if (!rode) ok(false, 'no Gravity win in 14 attempts at 45% (investigate)');

  // --- 3. the ride key is absent after a loss ------------------------------
  console.log('\n3. The ride key is offered only after a win');
  let sawLoss = false;
  for (let attempt = 0; attempt < 14 && !sawLoss; attempt++) {
    await page.locator('.pick').nth(4).click(); // Void, 5% — usually a loss
    const detail = await settleOnce(page);
    if (detail.includes('You called it')) continue;
    sawLoss = true;
    ok((await page.locator('.ride').count()) === 0, 'no ride key after a loss');
  }
  if (!sawLoss) ok(false, 'no Void loss in 14 attempts (investigate)');

  const real = errors.filter(e => !/favicon|widget\.js|net::/i.test(e));
  ok(real.length === 0, 'no console errors across the loop', real.slice(0, 3).join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nFast re-bet loop verified.\n' : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
