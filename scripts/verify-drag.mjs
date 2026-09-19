/**
 * Drives the drag-to-lock Core with real pointer events — mouse.move/down/up,
 * not React event simulation — so this proves the actual DOM/pointer-capture
 * mechanism, not just that the callback wiring compiles.
 *
 * Checks:
 *   1. Dragging near an anchor and releasing locks that prediction (the
 *      tap-card's aria-pressed flips to match, proving onLock -> pick -> the
 *      same state everything else already reads).
 *   2. Releasing far from every anchor does NOT change the prediction (a
 *      miss), and the Core visibly returns to rest.
 *   3. The Core is inert (no drag) once a bet is in flight.
 *   4. A full round can be placed after locking via drag (drag -> Break ->
 *      real settle), proving the locked prediction actually reaches the bet.
 *   5. No console errors, no new horizontal scroll.
 *
 * Usage: node scripts/verify-drag.mjs [url]
 */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://localhost:3200/';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

async function dragCoreTo(page, anchorSelector) {
  const anchorBox = await page.locator(anchorSelector).boundingBox();
  const coreBox = await page.locator('.fracture-core').boundingBox();
  const coreCenter = { x: coreBox.x + coreBox.width / 2, y: coreBox.y + coreBox.height / 2 };
  const anchorCenter = { x: anchorBox.x + anchorBox.width / 2, y: anchorBox.y + anchorBox.height / 2 };

  await page.mouse.move(coreCenter.x, coreCenter.y);
  await page.mouse.down();
  // Move in a few steps, like a real drag, not a teleport.
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(
      coreCenter.x + (anchorCenter.x - coreCenter.x) * t,
      coreCenter.y + (anchorCenter.y - coreCenter.y) * t,
    );
    await page.waitForTimeout(30);
  }
  return anchorCenter;
}

async function main() {
  console.log(`FRACTURE — drag-to-lock core verification of ${URL}\n`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  const errors = [];
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', e => errors.push(String(e)));

  // 'domcontentloaded' rather than 'load': 'load' also waits on the Google
  // Fonts stylesheet, which can hang indefinitely in a sandboxed run and has
  // nothing to do with the game being ready. The explicit waits below are a
  // stronger readiness signal anyway — they wait for the app to actually
  // mount, not merely for every third-party subresource to settle.
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.world', { timeout: 15000 });
  await page.waitForSelector('.fracture-core', { timeout: 10000 });
  ok(true, 'anchors + core rendered while idle');

  const hint = await page.locator('.drag-hint').count();
  ok(hint === 1, 'one-time drag hint is present before first drag');

  // --- 1. drag onto Time and release --------------------------------------
  console.log('\n1. Drag onto an anchor and release (lock)');
  const before = await page.locator('.pick[aria-pressed="true"] .pick-name').innerText();
  await dragCoreTo(page, '.anchor-time');
  await page.mouse.up();
  await page.waitForTimeout(150);

  const hintAfterDrag = await page.locator('.drag-hint').count();
  ok(hintAfterDrag === 0, 'hint disappears after the first drag');

  const pressedName = await page.locator('.pick[aria-pressed="true"] .pick-name').innerText();
  // Compared case-insensitively: the fascia lettering is rendered uppercase
  // by CSS, and `innerText` returns rendered text. Which law is armed is the
  // thing under test; its letter case is an art-direction decision.
  ok(
    pressedName.toLowerCase() === 'time',
    `dragging onto the Time anchor locked the prediction (was "${before}")`,
    `tap-card now shows aria-pressed on "${pressedName}"`,
  );

  const previewText = await page.locator('.payout-preview').innerText();
  ok(previewText.includes('3.8000'), 'wager preview reflects the drag-locked prediction (Time, 3.80x)', previewText.replace(/\s+/g, ' '));

  // --- 2. drag and release far from every anchor (miss) --------------------
  console.log('\n2. Drag and release far from every anchor (miss)');
  const frame = await page.locator('.world-frame').boundingBox();
  const coreBox = await page.locator('.fracture-core').boundingBox();
  const coreCenter = { x: coreBox.x + coreBox.width / 2, y: coreBox.y + coreBox.height / 2 };
  const deadZone = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };

  await page.mouse.move(coreCenter.x, coreCenter.y);
  await page.mouse.down();
  await page.mouse.move(deadZone.x, deadZone.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400); // let the .core-snap transition finish

  const stillTime = await page.locator('.pick[aria-pressed="true"] .pick-name').innerText();
  ok(
    stillTime.toLowerCase() === 'time',
    'a miss does not change the locked prediction',
    `still "${stillTime}"`,
  );

  const coreBoxAfter = await page.locator('.fracture-core').boundingBox();
  const timeAnchorBox = await page.locator('.anchor-time').boundingBox();
  const coreCenterAfter = { x: coreBoxAfter.x + coreBoxAfter.width / 2, y: coreBoxAfter.y + coreBoxAfter.height / 2 };
  const timeAnchorCenter = { x: timeAnchorBox.x + timeAnchorBox.width / 2, y: timeAnchorBox.y + timeAnchorBox.height / 2 };
  const restDist = Math.hypot(coreCenterAfter.x - timeAnchorCenter.x, coreCenterAfter.y - timeAnchorCenter.y);
  ok(restDist < 6, 'the Core snapped back to rest at the still-locked anchor (Time)', `center offset ${restDist.toFixed(1)}px`);

  // --- 2b. touch target: grab from an offset point, not the exact centre ---
  console.log('\n2b. Core hit target is a real 44px zone, not just the 22px visual dot');
  const coreBoxTT = await page.locator('.fracture-core').boundingBox();
  const coreCenterTT = { x: coreBoxTT.x + coreBoxTT.width / 2, y: coreBoxTT.y + coreBoxTT.height / 2 };
  // 15px off-centre: outside the old 11px visual radius, inside the new 22px
  // hit-box radius — this is exactly the finger-imprecision case the fix is
  // for. If the hitbox were still only the visual dot, this press would miss.
  const offset = { x: coreCenterTT.x + 15, y: coreCenterTT.y - 15 };
  const gravityAnchor = await page.locator('.anchor-gravity').boundingBox();
  const gravityCenter = { x: gravityAnchor.x + gravityAnchor.width / 2, y: gravityAnchor.y + gravityAnchor.height / 2 };

  await page.mouse.move(offset.x, offset.y);
  await page.mouse.down();
  await page.mouse.move(gravityCenter.x, gravityCenter.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const offsetGrabLocked = await page.locator('.pick[aria-pressed="true"] .pick-name').innerText();
  ok(
    offsetGrabLocked.toLowerCase() === 'gravity',
    'pressing 15px off the visual dot centre still grabs and drags the core',
    `locked "${offsetGrabLocked}"`,
  );

  // --- 3. drag onto Void, then place a real bet through it ------------------
  console.log('\n3. Lock Void via drag, then place a real bet');
  await dragCoreTo(page, '.anchor-void');
  await page.mouse.up();
  await page.waitForTimeout(150);
  const voidLocked = await page.locator('.pick[aria-pressed="true"] .pick-name').innerText();
  ok(voidLocked.toLowerCase() === 'void', 'drag-locked Void', `pressed card is "${voidLocked}"`);

  await page.locator('.cta:not([disabled])').waitFor({ timeout: 10000 });
  await page.locator('.cta').click();
  await page.locator(".world[data-phase='anticipation']").waitFor({ timeout: 5000 });
  await page.locator('.world[data-break]').waitFor({ timeout: 15000 });
  const broke = await page.locator('.world').getAttribute('data-break');
  await page.locator('.result').waitFor({ timeout: 15000 });
  const detail = (await page.locator('.result-detail').innerText()).trim();
  ok(!!broke, `the drag-locked bet went through the real round loop -> ${broke} broke`, detail);

  // --- 4. inert while a bet is in flight ------------------------------------
  console.log('\n4. Core is inert once a round starts');
  // Anchors/core are unmounted while not idle — confirms nothing is grabbable mid-round.
  const coreDuringRound = await page.locator('.fracture-core').count();
  ok(coreDuringRound === 0, 'core/anchors are not present while the world is not idle');

  await page.locator('.cta').click(); // "Shift again"
  await page.locator('.fracture-core').waitFor({ timeout: 5000 });
  ok(true, 'core/anchors return once the world is idle again');

  // --- 4b. a win must actually credit the balance in demo mode too ---------
  // The demo host mirrors the real host: winnings are withheld from the
  // displayed balance until the game calls `revealOutcome` at the end of its
  // result presentation. Bet the highest-probability outcome repeatedly until
  // one lands, then assert the balance really went UP.
  console.log('\n4b. A winning round credits the balance (demo host)');
  let sawWin = false;
  for (let attempt = 0; attempt < 12 && !sawWin; attempt++) {
    await page.locator('.pick').first().click(); // Gravity, 45%
    const before = Number((await page.locator('.balance').innerText()).replace(/[^\d.]/g, ''));
    await page.locator('.cta:not([disabled])').waitFor({ timeout: 10000 });
    await page.locator('.cta').click();
    await page.locator('.result').waitFor({ timeout: 20000 });
    const detail = (await page.locator('.result-detail').innerText()).trim();
    await page.waitForTimeout(400); // let the reveal's balance push land
    const after = Number((await page.locator('.balance').innerText()).replace(/[^\d.]/g, ''));

    if (detail.includes('You called it')) {
      sawWin = true;
      ok(
        after > before,
        'a win increases the demo balance (revealOutcome released the winnings)',
        `${before} -> ${after} (net +${(after - before).toFixed(4)})`,
      );
    }
    await page.locator('.cta').click(); // Shift again
    await page.locator('.world:not([data-break])').waitFor({ timeout: 8000 });
  }
  if (!sawWin) ok(false, 'no Gravity win in 12 attempts at 45% (investigate)');

  // --- 5. hygiene ------------------------------------------------------------
  console.log('\n5. Hygiene');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  ok(!overflow, 'no horizontal page scroll introduced at 390px');

  const real = errors.filter(e => !/favicon|widget\.js|net::/i.test(e));
  ok(real.length === 0, 'no console errors across the drag flow', real.slice(0, 3).join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nDrag-to-lock core verified.\n' : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
