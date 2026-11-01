import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDR, NOW, tx, swap } from './helpers.mjs';
import { buildReport, summarize, lamportsToSol, utcDay, PAGE_LIMIT, ARCHETYPES } from '../../worker/src/report.js';
import { normalizeTransaction, parseTimestamp, WSOL_MINT } from '../../worker/src/normalize.js';

const W = ADDR.wallet;
const report = page => buildReport(page, W, NOW);

test('empty results → mystery wallet, zero counts, no window', () => {
  for (const page of [[], null, undefined, 'x', {}]) {
    const r = report(page);
    assert.equal(r.archetype, 'mystery-wallet');
    assert.deepEqual(r.stats.map(s => s.value), ['0', '0', '0']);
    assert.equal(r.coverage.windowStartUtc, null);
    assert.equal(r.coverage.partial, true);
  }
});

test('no swaps → quiet observer', () => {
  assert.equal(report([tx(), tx()]).archetype, 'quiet-observer');
});

test('rapid clicker: ≥5 swaps within the last 24h', () => {
  const r = report(Array.from({ length: 5 }, () => swap({ timestamp: NOW - 100 })));
  assert.equal(r.archetype, 'rapid-clicker');
});

test('24h boundary: exactly 86400s ago is NOT counted as recent', () => {
  const s = summarize([swap({ timestamp: NOW - 86400 }), swap({ timestamp: NOW - 86399 })], W, NOW);
  assert.equal(s.recent24, 1);
});

test('burst trader: ≥8 swaps on ≤2 UTC days (older than 24h)', () => {
  const base = Date.UTC(2026, 8, 10, 12) / 1000;
  const page = [...Array(4)].map(() => swap({ timestamp: base })).concat([...Array(4)].map(() => swap({ timestamp: base + 86400 })));
  const r = report(page);
  assert.equal(r.archetype, 'burst-trader');
  assert.equal(r.stats[1].value, '2');
});

test('UTC day bucketing at midnight', () => {
  const midnight = Date.UTC(2026, 8, 10) / 1000;
  assert.equal(utcDay(midnight - 1), '2026-09-09');
  assert.equal(utcDay(midnight), '2026-09-10');
  const s = summarize([swap({ timestamp: midnight - 1 }), swap({ timestamp: midnight })], W, NOW);
  assert.equal(s.swapDayCount, 2);
});

test('explorer fallback for spread-out swaps', () => {
  const page = [1, 3, 5, 7].map(d => swap({ timestamp: NOW - d * 86400 - 10 }));
  assert.equal(report(page).archetype, 'on-chain-explorer');
});

test('failed transactions are excluded from activity counts and can drive the failure archetype', () => {
  const page = [...Array(5)].map(() => swap({ transactionError: { error: 'custom program error: 0x1771' } })).concat([swap(), swap(), tx()]);
  const r = report(page);
  assert.equal(r.archetype, 'failure-collector');
  assert.equal(r.stats[0].value, '2');
  assert.equal(r.coverage.failed, 5);
  // Newer Wallet-API style `error` field is honored too.
  assert.equal(normalizeTransaction(tx({ transactionError: undefined, error: 'x' }), W, NOW).status, 'failed');
  assert.equal(normalizeTransaction(tx({ transactionError: null, error: null }), W, NOW).status, 'success');
});

test('timestamp validation: seconds only, positive, not in the future, not milliseconds', () => {
  assert.equal(parseTimestamp(NOW - 5, NOW), NOW - 5);
  assert.equal(parseTimestamp(NOW + 299, NOW), NOW + 299);   // small clock skew allowed
  for (const bad of [NOW + 301, 0, -1, (NOW - 5) * 1000, 1.5, '1790000000', null, undefined, NaN, Infinity]) {
    assert.equal(parseTimestamp(bad, NOW), null, String(bad));
  }
  const r = report([swap({ timestamp: 'yesterday' }), swap({ timestamp: NOW * 1000 }), swap({ timestamp: NOW + 10_000 }), swap()]);
  assert.equal(r.stats[0].value, '1');
  assert.equal(r.coverage.skipped, 3);
});

test('malformed records are skipped, not guessed', () => {
  const r = report([null, 5, 'tx', [], swap()]);
  assert.equal(r.stats[2].value, '1');
  assert.equal(r.coverage.skipped, 4);
});

test('pagination boundaries: 0, 1, 99, 100, 101 records', () => {
  for (const [n, expectReturned, more] of [[0, 0, false], [1, 1, false], [99, 99, false], [100, 100, true], [101, 100, true]]) {
    const r = report(Array.from({ length: n }, () => tx()));
    assert.equal(r.coverage.returned, expectReturned, `n=${n}`);
    assert.equal(r.coverage.possiblyMore, more, `n=${n}`);
    assert.equal(r.coverage.pagesFetched, 1);
    assert.equal(r.coverage.partial, true);
    assert.equal(r.coverage.pageLimit, PAGE_LIMIT);
  }
});

test('fees: summed only where the wallet paid, including failed txs; integer SOL formatting', () => {
  const page = [tx({ fee: 5000 }), tx({ fee: 7000, transactionError: { error: 'x' } }), tx({ fee: 9999, feePayer: ADDR.token }), tx({ fee: -1 }), tx({ fee: 1.5 })];
  const s = summarize(page, W, NOW);
  assert.equal(s.feesPaidLamports, 12000);
  assert.equal(s.feeTxCount, 2);
  assert.equal(lamportsToSol(12000), '0.000012');
  assert.equal(lamportsToSol(1_000_000_000), '1');
  assert.equal(lamportsToSol(1_500_000_001), '1.500000001');
});

test('normalization: native/token directions and WSOL flag', () => {
  const r = normalizeTransaction(swap({
    nativeTransfers: [{ fromUserAccount: W, toUserAccount: ADDR.token, amount: 10 }, { fromUserAccount: ADDR.token, toUserAccount: W, amount: 3 }, { fromUserAccount: W, toUserAccount: W, amount: 99 }, { fromUserAccount: W, toUserAccount: 'x', amount: -5 }],
    tokenTransfers: [{ fromUserAccount: W, toUserAccount: 'pool', mint: WSOL_MINT, tokenAmount: 0.5 }, { fromUserAccount: 'pool', toUserAccount: W, mint: 'MintB', tokenAmount: 'NaN' }, { fromUserAccount: 'a', toUserAccount: 'b', mint: 'Other' }],
    events: { swap: {} },
  }), W, NOW);
  assert.deepEqual(r.native, { inLamports: 3, outLamports: 10 });
  assert.deepEqual(r.tokens.map(t => [t.direction, t.isWsol, t.uiAmount]), [['out', true, 0.5], ['in', false, null]]);
  assert.equal(r.touchesWsol, true);
  assert.equal(r.hasSwapEvent, true);
});

test('report never contains P&L / win-rate language or the full address', () => {
  const r = report([swap(), swap({ timestamp: NOW - 90000 })]);
  const text = JSON.stringify(r);
  assert.ok(!text.includes(W), 'full address leaked');
  assert.ok(!/win rate|profit(able)?\b(?! *,? *loss)|\broi\b|guarantee/i.test(text.replace(/no profit, loss/i, '')));
  assert.ok(Object.values(ARCHETYPES).includes(r.title));
  assert.equal(r.createdAt, new Date(NOW * 1000).toISOString());
});
