/**
 * Drives the real game in a real browser.
 *
 * Checks the things that fail silently and would otherwise only be discovered
 * by a judge:
 *   1. Standalone mode actually plays a full round outside any host iframe
 *      (jam eligibility requires a playable demo on the bare URL).
 *   2. The page is genuinely embeddable in a cross-origin iframe — the gallery
 *      preview breaks silently if X-Frame-Options sneaks in.
 *   3. Each of the five transformations is actually applied to the DOM.
 *   4. No console errors during a round.
 *
 * Usage: node scripts/verify-ui.mjs [url]
 */
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://localhost:3200/';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  console.log(`FRACTURE — browser verification of ${URL}\n`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  const errors = [];
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', e => errors.push(String(e)));

  // --- 1. standalone load ---------------------------------------------------
  console.log('1. Standalone load (no host, mobile viewport)');
  const t0 = Date.now();
  // 'domcontentloaded' + an explicit mount wait, not 'load': 'load' blocks on
  // the Google Fonts stylesheet, so it measures third-party network weather
  // rather than how fast the game becomes visible. This timing is the number
  // the "loads near-instantly" requirement actually cares about.
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.world', { timeout: 15000 });
  ok(true, `world rendered in ${Date.now() - t0}ms`);

  await page.waitForSelector('.demo-pill', { timeout: 5000 });
  ok(true, 'fell back to standalone demo mode (no host present)');

  const widget = await page.locator('script[src*="jam.chain.wtf/widget.js"]').count();
  ok(widget === 1, 'jam widget script tag is on the page');

  const picks = await page.locator('.pick').count();
  ok(picks === 5, `five prediction cards rendered`);

  // no horizontal overflow at phone width
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  ok(!overflow, 'no horizontal page scroll at 390px');

  // --- 2. play one full round per outcome ----------------------------------
  console.log('\n2. Playing a full round for each prediction');
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    // The primary key goes straight into another round once one settles, so
    // wait for it to be live again rather than clicking a separate reset.
    await page.locator('.cta:not([disabled])').waitFor({ timeout: 15000 });
    await page.locator('.pick').nth(i).click();
    const label = await page.locator('.pick').nth(i).locator('.pick-name').innerText();

    // The previous round's banner unmounts the moment a new round opens;
    // waiting for that first is what keeps the read below from picking up
    // the last round's result.
    await page.locator('.cta').click();
    await page.locator('.result').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

    // anticipation beat
    await page.waitForSelector(".world[data-phase='anticipation']", { timeout: 5000 });

    // the world breaks
    await page.waitForSelector('.world[data-break]', { timeout: 10000 });
    const broke = await page.locator('.world').getAttribute('data-break');
    seen.add(broke);

    // result banner
    await page.waitForSelector('.result', { timeout: 10000 });
    const headline = await page.locator('.result-headline').innerText();
    const detail = await page.locator('.result-detail').innerText();
    ok(
      !!broke && !!headline,
      `predicted ${label.padEnd(7)} -> ${broke.padEnd(7)} | ${headline.trim()}`,
      detail.trim(),
    );
  }

  // --- 2b. a win must actually credit the balance --------------------------
  // Regression guard for a shipped bug: winnings are withheld from the
  // displayed balance until the game calls `revealOutcome` at the end of its
  // result presentation, so forgetting that call makes a win look like a
  // loss — the balance only ever ticks down. Bet the highest-probability
  // outcome until one lands, then assert the balance really went UP.
  // (Moved here when the drag-to-lock Core was removed; it never had
  // anything to do with dragging.)
  console.log('\n2b. A winning round credits the balance');
  let sawWin = false;
  for (let attempt = 0; attempt < 12 && !sawWin; attempt++) {
    await page.locator('.cta:not([disabled])').waitFor({ timeout: 15000 });
    await page.locator('.pick').first().click(); // Gravity, 45%
    const before = Number((await page.locator('.balance').innerText()).replace(/[^\d.]/g, ''));
    await page.locator('.cta').click();
    await page.locator('.result').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    await page.locator('.result').waitFor({ state: 'visible', timeout: 20000 });
    const detail = (await page.locator('.result-detail').innerText()).trim();
    await page.waitForTimeout(400); // let the reveal's balance push land
    const after = Number((await page.locator('.balance').innerText()).replace(/[^\d.]/g, ''));

    if (detail.includes('You called it')) {
      sawWin = true;
      ok(
        after > before,
        'a win increases the balance (revealOutcome released the winnings)',
        `${before} -> ${after} (net +${(after - before).toFixed(4)})`,
      );
    }
  }
  if (!sawWin) ok(false, 'no Gravity win in 12 attempts at 45% (investigate)');

  // --- 3. every transformation reachable ------------------------------------
  console.log('\n3. Transformation coverage');
  // Drive each break state directly so all five animations are exercised even
  // if the VRF did not happen to produce them above.
  for (const key of ['gravity', 'time', 'scale', 'orbit', 'void']) {
    const applied = await page.evaluate(k => {
      const world = document.querySelector('.world');
      if (!world) return null;
      world.setAttribute('data-break', k);
      const stage = world.querySelector('.world-stage');
      const target =
        k === 'gravity'
          ? world.querySelector('.house')
          : k === 'scale'
            ? world.querySelector('.house')
            : stage;
      const name = target ? getComputedStyle(target).animationName : '';
      return { name, duration: target ? getComputedStyle(target).animationDuration : '' };
    }, key);
    ok(
      !!applied && applied.name !== 'none' && applied.name !== '',
      `${key.padEnd(7)} drives a keyframe animation`,
      `${applied?.name} ${applied?.duration}`,
    );
  }
  await page.evaluate(() => document.querySelector('.world')?.removeAttribute('data-break'));

  // --- 4. cross-origin iframe embedding ------------------------------------
  console.log('\n4. Cross-origin iframe embedding (the gallery preview path)');
  // The harness page must be served from a real origin. `page.setContent` runs
  // at `about:blank`, whose origin is opaque — and `frame-ancestors *` does not
  // match opaque origins, so that route reports a false failure no matter how
  // the headers are set. A second localhost port is a genuine cross-origin
  // embed and is what the gallery actually does.
  const harness = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      `<!doctype html><title>embed test</title><body style="margin:0">
         <iframe id="f" src="${URL}" style="width:390px;height:760px;border:0"></iframe>
       </body>`,
    );
  });
  await new Promise(resolve => harness.listen(0, '127.0.0.1', resolve));
  const harnessUrl = `http://127.0.0.1:${harness.address().port}/`;

  const embedPage = await context.newPage();
  await embedPage.goto(harnessUrl, { waitUntil: 'domcontentloaded' });
  let embedded = false;
  let embedError = '';
  try {
    await embedPage.frameLocator('#f').locator('.world').waitFor({ timeout: 10000 });
    embedded = true;
  } catch (e) {
    embedError = String(e).split('\n')[0];
  }
  ok(
    embedded,
    `game renders inside a cross-origin iframe (${harnessUrl} -> ${URL})`,
    embedError,
  );

  const res = await embedPage.request.get(URL);
  const xfo = res.headers()['x-frame-options'];
  const csp = res.headers()['content-security-policy'];
  ok(!xfo, 'no X-Frame-Options header', xfo ? `found: ${xfo}` : 'absent');
  ok(
    !!csp && csp.includes('frame-ancestors'),
    'CSP frame-ancestors is set explicitly',
    csp ?? 'absent',
  );

  // --- 5. console hygiene ---------------------------------------------------
  console.log('\n5. Console');
  const real = errors.filter(e => !/favicon|widget\.js|ERR_NAME_NOT_RESOLVED|net::/i.test(e));
  ok(real.length === 0, 'no console errors during play', real.slice(0, 3).join(' | '));

  harness.close();
  await browser.close();

  console.log(
    failures === 0 ? '\nBrowser verification passed.\n' : `\n${failures} CHECK(S) FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
