/**
 * Jam-eligibility checks in a real browser.
 *
 * These are the things that fail silently and would otherwise only be
 * discovered by a judge:
 *   1. The bare URL loads and is playable with no host present.
 *   2. The page is genuinely embeddable in a cross-origin iframe — the gallery
 *      preview breaks silently if X-Frame-Options sneaks in.
 *   3. Each of the five transformations is actually applied to the DOM.
 *   4. The declared RTP is stated on the page and matches the manifest.
 *   5. No console errors.
 *
 * Playing the game itself — the ladder, the decision, cash-out, strikes and
 * the balance credit — is `scripts/verify-run.mjs`. Splitting them keeps this
 * file about eligibility and that one about the mechanic.
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

  const picks = await page.locator('.pick-anchor').count();
  ok(picks === 5, `five anchor positions rendered`);

  const cta = (await page.locator('.cta').innerText()).trim();
  ok(/run/i.test(cta), 'the primary key opens a run', `reads "${cta}"`);

  // no horizontal overflow at phone width
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  ok(!overflow, 'no horizontal page scroll at 390px');

  // --- 2. the declared RTP is on the page and matches the manifest ---------
  // Jam eligibility requires the declared math to match the paytable, so the
  // number a judge reads on the page has to be the number in the manifest.
  console.log('\n2. Declared RTP');
  const footnote = (await page.locator('.footnote').innerText()).trim();
  ok(/95\.00% RTP/.test(footnote), 'the page states its RTP', footnote.slice(0, 90));
  ok(
    /every stopping point/i.test(footnote),
    'and states that it holds at every stopping point, which is the whole claim',
  );
  // `URL` is the target page in this file, not the global — build the path by hand.
  const manifestUrl = `${URL.replace(/\/+$/, '')}/game.manifest.json`;
  const manifest = await (await page.request.get(manifestUrl)).json();
  ok(manifest.jam?.rtp === 0.95, 'the manifest declares the same 95%', `manifest says ${manifest.jam?.rtp}`);
  ok(
    manifest.capabilities?.submitAction === true,
    'the manifest declares submitAction — without it the host will not route a step',
  );
  const [lo, hi] = manifest.jam?.rtpBand ?? [];
  ok(lo === 0.93 && hi === 0.98, 'and sits inside the 93-98% band');

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
