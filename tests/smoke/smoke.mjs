#!/usr/bin/env node
// Browser smoke tests (Playwright + axe-core). Serves site/ with the real
// _headers CSP, mocks the Worker API with page.route (no real network calls).
// Usage: npm run test:smoke   (first time: npx playwright install chromium)
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startServer } from '../../scripts/serve.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(here, '../../site');
const OUT = path.join(here, 'output');
const API = 'https://atlas-test-api.example.workers.dev';
const ADDRESS = '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY';
const UPDATE_OG = process.argv.includes('--update-og');

let failures = 0, passes = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n').join('\n      ')}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

function pngInfo(buf) {
  const sig = buf.subarray(0, 8).toString('hex');
  return { isPng: sig === '89504e470d0a1a0a', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const liveConfig = `window.ATLAS_CONFIG = { apiBase: '${API}', turnstileSiteKey: '' };`;
const offConfig = `window.ATLAS_CONFIG = { apiBase: '', turnstileSiteKey: '' };`;
const XSS = '<img src=x onerror="window.__pwned=1">';
const liveReport = {
  schemaVersion: 2, mode: 'live', archetype: 'burst-trader', title: 'THE BURST TRADER ' + XSS, identity: '86xC…2MMY',
  stats: [{ label: 'RECENT SWAPS', value: '9' }, { label: 'SWAP-DAY COUNT', value: '2' }, { label: 'RECENT TXS', value: '41' }],
  roast: '“You disappeared for days and then tried to speedrun the entire market.” <script>window.__pwned=2</script>',
  insight: 'The returned sample contains 9 swaps across 2 swap-active UTC calendar days.',
  evidence: ['41 successful timestamped transactions in the first returned page (maximum 100)', `<svg onload="window.__pwned=3">`],
  disclosure: 'PARTIAL PUBLIC HISTORY · First page only.',
  coverage: { partial: true, pagesFetched: 1, pageLimit: 100, returned: 41, windowStartUtc: '2026-10-20', windowEndUtc: '2026-10-26' },
  createdAt: '2026-10-26T00:00:00.000Z',
};

async function newPage(browser, { mobile = null, live = false, onApi = null, config = null } = {}) {
  const ctx = await browser.newContext(mobile
    ? { viewport: mobile, isMobile: true, hasTouch: true, deviceScaleFactor: 2, acceptDownloads: true }
    : { viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await ctx.newPage();
  const problems = [], apiCalls = [];
  page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('dialog', d => { problems.push('dialog: ' + d.message()); d.dismiss(); });
  page.on('request', r => { if (r.url().includes('/api/analyze')) apiCalls.push(r.postData()); });
  // Every test pins its own config (live or sample-only), whatever site/config.js ships with.
  await page.route(/\/config\.js(\?.*)?$/, r => r.fulfill({ contentType: 'text/javascript', body: config || (live ? liveConfig : offConfig) }));
  if (onApi) await page.route(`${API}/**`, onApi);
  return { ctx, page, problems, apiCalls };
}

async function noHorizontalScroll(page) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert(sw <= iw, `horizontal overflow: scrollWidth ${sw} > innerWidth ${iw}`);
}

async function runAxe(page) {
  await page.addScriptTag({ content: await readFile(require.resolve('axe-core/axe.min.js'), 'utf8') }).catch(async () => {
    // CSP blocks inline injection; evaluate the source directly instead.
    await page.evaluate(await readFile(require.resolve('axe-core/axe.min.js'), 'utf8'));
  });
  const res = await page.evaluate(async () => window.axe.run(document, { resultTypes: ['violations'] }));
  return res.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
}

const server = await startServer(SITE, 0);
const BASE = `http://127.0.0.1:${server.address().port}/`;
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
console.log(`Smoke tests against ${BASE}`);

try {
  await check('sample mode renders and the PNG download is a real 1200x630 PNG', async () => {
    const { page, problems, ctx } = await newPage(browser);
    await page.goto(BASE);
    await page.click('#analyze');
    await page.waitForSelector('#result-title');
    assert((await page.textContent('#result-title')) === 'THE CHART CHASER', 'demo title missing');
    assert((await page.textContent('#step-tag')) === 'STEP 3 OF 3', 'step indicator should advance (live disabled → step 3)');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
    assert(dl.suggestedFilename() === 'ghost-chart-chaser.png', 'filename ' + dl.suggestedFilename());
    const file = path.join(OUT, dl.suggestedFilename());
    await dl.saveAs(file);
    const buf = await readFile(file);
    const info = pngInfo(buf);
    assert(info.isPng, 'not a PNG');
    assert(info.width === 1200 && info.height === 630, `dims ${info.width}x${info.height}`);
    assert(buf.length > 20000, 'PNG suspiciously small: ' + buf.length);
    if (UPDATE_OG) await copyFile(file, path.join(SITE, 'og-card.png'));
    await page.screenshot({ path: path.join(OUT, 'desktop-demo.png'), fullPage: false });
    assert(problems.length === 0, problems.join('\n'));
    await ctx.close();
  });

  await check('share button copies a link with an archetype only (no address)', async () => {
    const { page, problems, ctx } = await newPage(browser);
    await page.goto(BASE);
    await page.click('#analyze');
    await page.click('#share');
    await page.waitForFunction(() => /Copied/.test(document.getElementById('share').textContent) || document.getElementById('manual-copy-input'));
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
    const manual = await page.$('#manual-copy-input');
    const text = clip || (manual ? await manual.inputValue() : '');
    assert(text.includes('#try?r=chart-chaser'), 'share text: ' + text);
    assert(!/[1-9A-HJ-NP-Za-km-z]{32,44}/.test(text.replace(/https?:\/\/\S+/, '')), 'looks like an address in share text');
    assert(problems.length === 0, problems.join('\n'));
    await ctx.close();
  });

  await check('live mode is disabled and explained when no API is configured', async () => {
    const { page, problems, apiCalls, ctx } = await newPage(browser);
    await page.goto(BASE);
    assert(await page.isDisabled('#mode-live'), 'live radio should be disabled');
    await page.fill('#wallet', ADDRESS);
    await page.waitForSelector('#error:not(.hidden)');
    assert(/not enabled/i.test(await page.textContent('#error')), 'missing not-enabled message');
    assert(apiCalls.length === 0, 'no API call expected');
    assert(problems.length === 0, problems.join('\n'));
    await ctx.close();
  });

  await check('pasting a private key / seed phrase clears it and never sends it', async () => {
    const { page, apiCalls, ctx } = await newPage(browser, { live: true, onApi: r => r.fulfill({ json: liveReport }) });
    await page.goto(BASE);
    await page.fill('#wallet', 'apple '.repeat(12).trim());
    assert((await page.inputValue('#wallet')) === '', 'seed phrase not cleared');
    assert(/private key or seed phrase/.test(await page.textContent('#error')), 'missing warning');
    await page.fill('#wallet', JSON.stringify(Array.from({ length: 64 }, (_, i) => i)));
    assert((await page.inputValue('#wallet')) === '', 'keypair JSON not cleared');
    await page.click('#analyze');
    assert(apiCalls.length === 0, 'secret must never reach the API');
    await ctx.close();
  });

  await check('live mode (mocked API): auto-switches on paste, renders escaped report, no script execution', async () => {
    const { page, problems, apiCalls, ctx } = await newPage(browser, { live: true, onApi: r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(liveReport) }) });
    await page.goto(BASE);
    await page.fill('#wallet', ADDRESS);
    assert(await page.isChecked('#mode-live'), 'did not auto-switch to live');
    await page.click('#analyze');
    await page.waitForSelector('#result-title');
    assert(JSON.parse(apiCalls[0]).address === ADDRESS, 'wrong payload');
    const pwned = await page.evaluate(() => window.__pwned);
    assert(pwned === undefined, 'XSS executed: ' + pwned);
    assert(await page.$$eval('#result img, #result script, #result svg', els => els.length) === 0, 'injected element in DOM');
    assert((await page.textContent('#result-title')).includes('<img'), 'payload should render as text');
    assert(/LIVE · PARTIAL/.test(await page.textContent('#result')), 'partial label missing');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
    const buf = await readFile(await dl.path());
    assert(pngInfo(buf).isPng, 'live card not a PNG');
    await page.screenshot({ path: path.join(OUT, 'desktop-live.png') });
    assert(problems.length === 0, problems.join('\n'));
    await ctx.close();
  });

  const errorCases = [
    ['429 JSON', r => r.fulfill({ status: 429, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"Too many requests. Please wait a minute and try again."}' }), /Too many requests/],
    ['502 HTML page', r => r.fulfill({ status: 502, contentType: 'text/html', headers: { 'access-control-allow-origin': '*' }, body: '<html><b>Bad gateway</b></html>' }), /temporarily unavailable/],
    ['200 non-report JSON', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"hello":"world"}' }), /unexpected format/],
    ['network failure', r => r.abort('failed'), /Could not reach/],
  ];
  for (const [name, handler, expect] of errorCases) {
    await check(`live API error state: ${name}`, async () => {
      const { page, ctx } = await newPage(browser, { live: true, onApi: handler });
      await page.goto(BASE);
      await page.fill('#wallet', ADDRESS);
      await page.click('#analyze');
      await page.waitForSelector('#error:not(.hidden)');
      const msg = await page.textContent('#error');
      assert(expect.test(msg), `got: ${msg}`);
      assert(!(await page.isDisabled('#analyze')), 'button stuck disabled');
      await ctx.close();
    });
  }

  await check('lab sections render a labelled SAMPLE state at rest (no errors, bars sized under CSP)', async () => {
    const { page, problems, ctx } = await newPage(browser);
    await page.goto(BASE);
    assert((await page.textContent('#memory-badge')) === 'SAMPLE', 'memory badge');
    assert((await page.$$eval('#memory-hours span', els => els.length)) === 24, 'hours bars');
    const sized = await page.$$eval('#memory-hours span', els => els.filter(e => e.style.getPropertyValue('--h')).length);
    assert(sized === 24, 'bars sized via CSSOM: ' + sized);
    assert((await page.$$eval('#memory-patterns li', els => els.length)) > 2, 'patterns');
    assert(/YOU/.test(await page.textContent('#parallel-results')), 'parallel results');
    assert(problems.length === 0, problems.join('\n'));
    await ctx.close();
  });

  await check('deep memory (mocked): live profile, parallel toggles recompute, mint text escaped', async () => {
    const XM = '<img src=x onerror="window.__pwned=9">';
    const now = Math.floor(Date.now() / 1000);
    const deepReport = { ...liveReport, title: 'THE BURST TRADER', deep: {
      coverage: { pages: 3, transactions: 240, complete: true, windowStartUtc: '2026-09-01', windowEndUtc: '2026-10-29' },
      profile: { tradeCount: 20, buys: 10, sells: 10, tokensTraded: 3, byQuote: { SOL: { closed: 3, up: 1, down: 2, flat: 0, realized: -1.5 } }, medianHoldSec: 300, fastFlips: 2, revengeBuys: 1, reentries: 0, oversized: 0, openPositions: 0, medianBuy: { SOL: 1 }, topTokens: [] },
      tradeTimes: [now - 100, now - 4000, now - 90000],
      closed: [
        { mint: XM, quote: 'SOL', pnl: -2, holdSec: 120, closedAt: now - 50, avgBuy: 1, flags: { fast: true, revenge: false, reentry: false, oversized: false } },
        { mint: 'MintB', quote: 'SOL', pnl: 1.5, holdSec: 9000, closedAt: now - 60, avgBuy: 1, flags: { fast: false, revenge: true, reentry: false, oversized: false } },
        { mint: 'MintC', quote: 'SOL', pnl: -1, holdSec: 200, closedAt: now - 70, avgBuy: 1, flags: { fast: true, revenge: false, reentry: false, oversized: false } },
      ],
      method: 'Average-cost positions.' } };
    let sentDepth = null;
    const { page, problems, ctx } = await newPage(browser, { live: true, onApi: r => { sentDepth = JSON.parse(r.request().postData()).depth; r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(deepReport) }); } });
    await page.goto(BASE);
    await page.fill('#wallet', ADDRESS);
    assert(await page.isChecked('#deep'), 'deep on by default');
    await page.click('#analyze');
    await page.waitForFunction(() => document.getElementById('memory-badge').textContent === 'LIVE');
    assert(sentDepth === 'deep', 'depth sent: ' + sentDepth);
    assert(/240 transactions/.test(await page.textContent('#memory-coverage')), 'coverage');
    assert(/−1\.5000 SOL/.test(await page.textContent('#memory-stats')), 'realized shown');
    assert(await page.evaluate(() => window.__pwned) === undefined, 'XSS executed');
    assert(await page.$$eval('#memory-closed img', els => els.length) === 0, 'injected img');
    // default rule: skip fast flips → parallel = +1.5 vs actual −1.5
    assert(/\+1\.5000 SOL/.test(await page.textContent('#parallel-results')), 'parallel default');
    await page.uncheck('#par-noFast');
    assert(!/\+1\.5000 SOL/.test(await page.textContent('#parallel-results')), 'toggle recomputes');
    await page.locator('#memory').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, 'desktop-memory.png'), fullPage: false });
    assert(problems.length === 0, problems.join('\n'));
    await ctx.close();
  });

  await check('paper lab (mocked prices): load, buy, rule block, sell, persists across reload', async () => {
    const SOLM = 'So11111111111111111111111111111111111111112';
    let px = 100;
    const handler = r => {
      const u = r.request().url();
      const body = u.includes('/api/token') ? { token: { mint: SOLM, symbol: 'SOL', name: 'Wrapped SOL', decimals: 9 } } : { prices: { [SOLM]: { usdPrice: px, change24h: 1 } } };
      r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    };
    const { page, problems, ctx } = await newPage(browser, { live: true, onApi: handler });
    await page.goto(BASE);
    await page.click('#paper-sol');
    await page.waitForFunction(() => /\$100/.test(document.getElementById('paper-price').textContent));
    await page.fill('#paper-usd', '5000');
    await page.click('#paper-buy button');
    await page.waitForFunction(() => /25% of equity/.test(document.getElementById('paper-msg').textContent));
    await page.fill('#paper-usd', '1000');
    await page.click('#paper-buy button');
    await page.waitForFunction(() => /Paper-bought/.test(document.getElementById('paper-msg').textContent));
    assert(/\$9,000/.test(await page.textContent('#paper-stats')), 'cash after buy');
    px = 80;
    await page.click('[data-pct="100"]');
    await page.waitForFunction(() => /Closed for −/.test(document.getElementById('paper-msg').textContent));
    await page.fill('#paper-usd', '100');
    await page.click('#paper-buy button');
    await page.waitForFunction(() => /Cooling down/.test(document.getElementById('paper-msg').textContent));
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#paper-journal li').length >= 2);
    assert(/Sold/.test(await page.textContent('#paper-journal')), 'journal persisted');
    await page.locator('#lab').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, 'desktop-paper.png') });
    assert(problems.length === 0, problems.join('\n'));
    await ctx.close();
  });

  await check('invite link shows the archetype banner (and ignores junk hashes)', async () => {
    const { page, ctx } = await newPage(browser);
    await page.goto(BASE + '#try?r=burst-trader');
    assert(/THE BURST TRADER/.test(await page.textContent('#invite')), 'invite banner missing');
    await page.goto('about:blank');
    await page.goto(BASE + '#try?r=<img src=x>');
    assert(await page.isHidden('#invite'), 'junk hash should not show banner');
    await ctx.close();
  });

  for (const [label, vp] of [['iPhone SE 375', { width: 375, height: 667 }], ['small 320', { width: 320, height: 640 }], ['tablet 768', { width: 768, height: 1024 }]]) {
    await check(`responsive ${label}: no horizontal scroll; result scrolled into view`, async () => {
      const { page, problems, ctx } = await newPage(browser, { mobile: vp });
      await page.goto(BASE);
      await noHorizontalScroll(page);
      await page.screenshot({ path: path.join(OUT, `mobile-${vp.width}-hero.png`) });
      await page.locator('#analyze').scrollIntoViewIfNeeded();
      await page.tap('#analyze');
      await page.waitForSelector('#result-title');
      await page.waitForTimeout(700);
      const visible = await page.evaluate(() => { const r = document.getElementById('result-title').getBoundingClientRect(); return r.top >= -1 && r.top < window.innerHeight; });
      assert(visible, 'result title not in viewport after submit');
      await noHorizontalScroll(page);
      const tapTargets = await page.$$eval('#analyze, #save, #share', els => els.map(e => e.getBoundingClientRect().height));
      assert(tapTargets.every(h => h >= 40), 'tap target too small: ' + tapTargets);
      await page.screenshot({ path: path.join(OUT, `mobile-${vp.width}-result.png`) });
      assert(problems.length === 0, problems.join('\n'));
      await ctx.close();
    });
  }

  await check('coin check (mocked): renders flags escaped, deep link auto-runs, transparency shows dev wallet', async () => {
    const MINT = 'So11111111111111111111111111111111111111112';
    const DEV = '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY';
    const coin = { v: 1, mint: MINT, token: { symbol: 'EVIL' + XSS, name: 'x' }, verdict: 'high-risk',
      market: { marketCap: 1800, liquidityUsd: 2000, volume24h: 600000, ageHours: 3, change: { h6: -96 }, stage: 'graduated' },
      holders: { top1Pct: 10, top10ExTop1Pct: 60 }, flags: [{ level: 'red', text: 'Down 96% in the last 6 hours ' + XSS }, { level: 'ok', text: 'Mint authority is off' }], counts: {}, sources: { market: true, chain: true } };
    const cfg = `window.ATLAS_CONFIG = { apiBase: '${API}', turnstileSiteKey: '', contractAddress: '${MINT}', devWallet: '${DEV}', feeLedger: [{ date: '2026-11-04', item: 'DexScreener listing', sol: 3.1 }] };`;
    const { page, ctx, problems } = await newPage(browser, { config: cfg, onApi: r => {
      const u = r.request().url();
      const body = u.includes('/api/coin') ? coin : u.includes('/api/wallet') ? { address: DEV, sol: 1.234, token: 50000000, mint: MINT } : {};
      return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    } });
    await page.goto(BASE + '?check=' + MINT);
    await page.waitForFunction(() => document.getElementById('check-badge').textContent === 'LIVE');
    const flags = await page.$$eval('#check-flags li', els => els.map(e => e.className + '|' + e.textContent));
    assert(flags.length === 2 && flags[0].startsWith('flag red') && flags[0].includes('<img'), 'flags not rendered as text: ' + flags);
    assert(await page.evaluate(() => !window.__pwned), 'script executed');
    assert((await page.textContent('#check-head')).includes('HIGH RISK'));
    await page.click('#check-share');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert(clip.includes('atlasghost.xyz/?check=' + MINT) && clip.includes('HIGH RISK'), 'share text: ' + clip);
    await page.waitForFunction(() => document.getElementById('proof-stats').textContent.includes('5.00%'));
    assert((await page.textContent('#proof-ledger')).includes('DexScreener listing'));
    assert(!(await page.$eval('#proof-roast', e => e.classList.contains('hidden'))), 'roast button hidden');
    await page.click('#proof-roast');
    assert((await page.inputValue('#wallet')) === DEV);
    await page.locator('#check').screenshot({ path: path.join(OUT, 'coin-check.png') });
    await page.locator('#proof').screenshot({ path: path.join(OUT, 'proof.png') });
    assert(problems.length === 0, problems.join('\n'));
    await ctx.close();
  });

  await check('accessibility: no serious/critical axe violations (initial + rendered result)', async () => {
    const { page, ctx } = await newPage(browser);
    await page.goto(BASE);
    const before = await runAxe(page);
    await page.click('#analyze');
    await page.waitForSelector('#result-title');
    const after = await runAxe(page);
    const all = [...before, ...after];
    await writeFile(path.join(OUT, 'axe.json'), JSON.stringify(all, null, 2));
    assert(all.length === 0, all.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(', ')}`).join('\n'));
    await ctx.close();
  });
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${passes} passed, ${failures} failed. Screenshots: ${path.relative(process.cwd(), OUT)}/`);
process.exit(failures ? 1 : 0);
