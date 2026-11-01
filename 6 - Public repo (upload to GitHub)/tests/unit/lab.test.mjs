import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../../site/lab.js');

const M = 'So11111111111111111111111111111111111111112';
const closed = [
  { quote: 'SOL', pnl: -1, avgBuy: 1, flags: { fast: true, revenge: false, reentry: false, oversized: false } },
  { quote: 'SOL', pnl: 2, avgBuy: 1, flags: { fast: false, revenge: true, reentry: false, oversized: false } },
  { quote: 'SOL', pnl: -3, avgBuy: 6, flags: { fast: false, revenge: false, reentry: true, oversized: true } },
  { quote: 'USDC', pnl: 10, avgBuy: 50, flags: { fast: false, revenge: false, reentry: false, oversized: false } },
];

test('parallel: no rules = actual; each rule removes or scales exactly what it says', () => {
  assert.deepEqual(L.parallel(closed, {}, { SOL: 1 }).SOL, { actual: -2, parallel: -2, removed: 0, capped: 0, kept: 3 });
  assert.equal(L.parallel(closed, { noFast: true }, {}).SOL.parallel, -1);
  assert.equal(L.parallel(closed, { noRevenge: true }, {}).SOL.parallel, -4);
  assert.equal(L.parallel(closed, { noReentry: true }, {}).SOL.parallel, 1);
  // capSize: avgBuy 6 > 2×median(1) → pnl scaled by 2/6
  assert.ok(Math.abs(L.parallel(closed, { capSize: true }, { SOL: 1 }).SOL.parallel - (-1 + 2 - 1)) < 1e-9);
  assert.equal(L.parallel(closed, { noFast: true, noReentry: true }, {}).USDC.parallel, 10, 'quotes are kept separate');
  assert.deepEqual(L.parallel(null, {}, {}), {});
});

test('patterns only state what the profile shows', () => {
  const p = { tradeCount: 10, byQuote: { SOL: { closed: 4 } }, medianHoldSec: 1800, fastFlips: 2, revengeBuys: 1, reentries: 0, oversized: 0, openPositions: 1 };
  const hours = Array(24).fill(0); hours[21] = 3; hours[2] = 1;
  const out = L.patterns(p, hours);
  assert.match(out[0], /21:00–22:00.*75%/);
  assert.ok(out.some(s => /2 of 4 closed positions were flipped/.test(s)));
  assert.ok(out.some(s => /1 position was opened within 15 minutes/.test(s)));
  assert.ok(!out.some(s => /3rd\+/.test(s)), 'zero counts are not mentioned');
  assert.match(L.patterns({ tradeCount: 0 }, [])[0], /nothing to learn/);
});

test('formatters', () => {
  assert.equal(L.fmtDuration(45), '45s');
  assert.equal(L.fmtDuration(600), '10m');
  assert.equal(L.fmtDuration(5400), '1.5h');
  assert.equal(L.fmtDuration(3 * 86400), '3.0d');
  assert.equal(L.fmtQuote(-1.23456, 'SOL'), '−1.2346 SOL');
  assert.equal(L.fmtQuote(2, 'USDC'), '+2.00 USDC');
  assert.equal(L.shortMint(M), 'So11…1112');
  const h = L.localHours([0, 3600, NaN]);
  assert.equal(h.reduce((a, b) => a + b, 0), 2);
});

test('paper: buy applies slippage + fee; sell realizes P&L; cash conserved', () => {
  let s = L.newPaper(0);
  const b = L.buy(s, { mint: M, symbol: 'SOL', usd: 1000, price: 100, now: 1000 });
  s = b.state;
  assert.equal(s.cash, 9000);
  const qty = s.positions[M].qty;
  assert.ok(Math.abs(qty - (1000 - 3) / 101) < 1e-9);
  const r = L.sell(s, { mint: M, pct: 100, price: 110, now: 2000 });
  const expected = qty * 110 * 0.99 * (1 - 0.003);
  assert.ok(Math.abs(r.state.cash - (9000 + expected)) < 1e-6);
  assert.ok(Math.abs(r.state.realized - (expected - 1000)) < 1e-6);
  assert.equal(r.state.positions[M], undefined);
  assert.equal(r.state.journal.length, 2);
  assert.equal(s.journal.length, 1, 'inputs are not mutated');
});

test('paper rules: size cap, cooldown after a loss, daily loss limit, locking', () => {
  let s = L.newPaper(0);
  assert.match(L.buy(s, { mint: M, usd: 3000, price: 1, now: 1 }).error, /25% of equity/);
  s = L.buy(s, { mint: M, usd: 1000, price: 1, now: 1 }).state;
  s = L.sell(s, { mint: M, pct: 100, price: 0.5, now: 1000 }).state; // loss
  const cool = L.buy(s, { mint: M, usd: 10, price: 1, now: 1000 + 60000 });
  assert.ok(cool.blocked && /Cooling down: 14 more minutes/.test(cool.error), cool.error);
  assert.ok(L.buy(s, { mint: M, usd: 10, price: 1, now: 1000 + 16 * 60000 }).state);
  s = { ...s, losses: { day: new Date(1000).toISOString().slice(0, 10), n: 3 }, lastLossAt: 0 };
  assert.match(L.buy(s, { mint: M, usd: 10, price: 1, now: 2000 }).error, /limit of 3 losing trades/);
  const locked = L.lockRules(L.newPaper(0), 24, 0).state;
  assert.match(L.setRules(locked, { maxPct: 100 }, 1000).error, /locked/);
  assert.equal(L.setRules(locked, { maxPct: 100 }, 25 * 3600000).state.rules.maxPct, 100);
  assert.equal(L.setRules(L.newPaper(0), { maxPct: 5000, cooldownMin: -3, maxLossesPerDay: 'x' }, 0).state.rules.maxPct, 100);
});

test('paper: guards and safe loading', () => {
  const s = L.newPaper(0);
  assert.match(L.buy(s, { mint: M, usd: 0, price: 1 }).error, /above \$0/);
  assert.match(L.buy(s, { mint: M, usd: 50, price: 0 }).error, /No live price/);
  assert.match(L.buy(s, { mint: M, usd: 20000, price: 1 }).error, /Not enough paper cash/);
  assert.match(L.sell(s, { mint: M, pct: 50, price: 1 }).error, /no paper position/);
  assert.equal(L.loadPaper('{not json').cash, 10000);
  assert.equal(L.loadPaper({ v: 2 }).cash, 10000);
  const saved = L.buy(s, { mint: M, usd: 100, price: 2, now: 5 }).state;
  assert.equal(L.loadPaper(JSON.stringify(saved)).cash, 9900);
  assert.equal(L.equity(saved, { [M]: 4 }), 9900 + saved.positions[M].qty * 4);
  assert.equal(L.equity(saved, {}), 9900 + 100, 'unpriced positions count at cost');
});
