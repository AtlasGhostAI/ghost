import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDR, NOW } from './helpers.mjs';
import { walletDeltas, extractTrade, buildLedger, buildProfile, QUOTES } from '../../worker/src/ledger.js';
import { fetchHistory, ProviderError } from '../../worker/src/history.js';
import { buildDeep } from '../../worker/src/app.js';
import { WSOL_MINT } from '../../worker/src/normalize.js';

const W = ADDR.wallet;
const MINT_A = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'; // any valid 32-byte address works as a mint id here
const MINT_B = '11111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
let n = 0;
/** A Helius-shaped swap: wallet gains/loses `tok` of `mint` and `sol` SOL (lamports via accountData). */
function swapTx({ ts = NOW - 3600, mint = MINT_A, tok, sol = 0, usdc = 0, fee = 5000, failed = false, wsol = 0 } = {}) {
  n += 1;
  const tbc = [];
  if (tok) tbc.push({ userAccount: W, tokenAccount: 'ata' + n, mint, rawTokenAmount: { tokenAmount: String(Math.round(tok * 1e6)), decimals: 6 } });
  if (usdc) tbc.push({ userAccount: W, tokenAccount: 'usdc' + n, mint: USDC, rawTokenAmount: { tokenAmount: String(Math.round(usdc * 1e6)), decimals: 6 } });
  if (wsol) tbc.push({ userAccount: W, tokenAccount: 'wsol' + n, mint: WSOL_MINT, rawTokenAmount: { tokenAmount: String(Math.round(wsol * 1e9)), decimals: 9 } });
  tbc.push({ userAccount: 'pool', tokenAccount: 'p', mint, rawTokenAmount: { tokenAmount: '-1', decimals: 6 } }); // other parties are ignored
  return {
    signature: 'sig' + n, timestamp: ts, type: 'SWAP', fee, feePayer: W, transactionError: failed ? { error: 'x' } : null,
    accountData: [{ account: W, nativeBalanceChange: Math.round(sol * 1e9) - fee, tokenBalanceChanges: tbc }, { account: 'pool', nativeBalanceChange: 999 }],
  };
}

test('walletDeltas: uses accountData, removes the fee, merges wrapped SOL', () => {
  const d = walletDeltas(swapTx({ tok: 1000, sol: -1.5 }), W);
  assert.ok(Math.abs(d.sol + 1.5) < 1e-12, String(d.sol));
  assert.ok(Math.abs(d.tokens.get(MINT_A) - 1000) < 1e-9);
  const w = walletDeltas(swapTx({ tok: 10, sol: 0, wsol: -0.25 }), W);
  assert.ok(Math.abs(w.sol + 0.25) < 1e-12);
  assert.equal(w.tokens.has(WSOL_MINT), false);
});

test('walletDeltas falls back to transfer lists when accountData is absent', () => {
  const tx = { feePayer: W, fee: 5000, nativeTransfers: [{ fromUserAccount: W, toUserAccount: 'pool', amount: 2e9 }], tokenTransfers: [{ fromUserAccount: 'pool', toUserAccount: W, mint: MINT_A, tokenAmount: 50 }] };
  const d = walletDeltas(tx, W);
  assert.equal(d.sol, -2);
  assert.equal(d.tokens.get(MINT_A), 50);
});

test('extractTrade: clean buys/sells only; failed, complex and dust are skipped with reasons', () => {
  assert.deepEqual(extractTrade(swapTx({ tok: 100, sol: -1 }), W, NOW).trade.side, 'buy');
  const s = extractTrade(swapTx({ tok: -100, sol: 2 }), W, NOW).trade;
  assert.equal(s.side, 'sell'); assert.equal(s.quote, 'SOL'); assert.ok(Math.abs(s.amount - 2) < 1e-9);
  assert.equal(extractTrade(swapTx({ tok: 100, usdc: -50 }), W, NOW).trade.quote, 'USDC');
  assert.equal(extractTrade(swapTx({ tok: 100, sol: -1, failed: true }), W, NOW).skip, 'failed');
  assert.equal(extractTrade(swapTx({ tok: 100, sol: 1 }), W, NOW).skip, 'complex', 'same-sign legs are not a swap');
  assert.equal(extractTrade(swapTx({ tok: 100, sol: -1, usdc: -5 }), W, NOW).skip, 'complex', 'two quote legs');
  assert.equal(extractTrade(swapTx({ sol: -1 }), W, NOW).skip, 'no-token');
  assert.equal(extractTrade(swapTx({ tok: 100, sol: -0.000001 }), W, NOW).skip, 'no-quote', 'rent-sized SOL leg is not a price');
  assert.equal(extractTrade({ ...swapTx({ tok: 1, sol: -1 }), timestamp: 'x' }, W, NOW).skip, 'untimed');
  assert.ok(QUOTES[USDC] === 'USDC');
});

test('buildLedger: average cost, partial sells, closing, excluded pre-window sells', () => {
  const t0 = NOW - 86400;
  const txs = [
    swapTx({ ts: t0, tok: 100, sol: -1 }),          // buy 100 @ 1 SOL
    swapTx({ ts: t0 + 60, tok: 100, sol: -3 }),     // buy 100 @ 3 SOL → avg 0.02/token, cost 4
    swapTx({ ts: t0 + 120, tok: -50, sol: 2 }),     // sell 50 for 2  (cost out 1)
    swapTx({ ts: t0 + 3600, tok: -150, sol: 1 }),   // sell 150 for 1 (cost out 3) → closed, pnl = 3 - 4 = -1
    swapTx({ ts: t0 + 100, mint: MINT_B, tok: -10, sol: 5 }), // sell with no buy in window → excluded
  ];
  const L = buildLedger(txs.reverse(), W, NOW); // provider order is newest-first; ledger sorts
  assert.equal(L.trades.length, 5);
  assert.equal(L.closed.length, 1);
  const c = L.closed[0];
  assert.ok(Math.abs(c.cost - 4) < 1e-9 && Math.abs(c.proceeds - 3) < 1e-9 && Math.abs(c.pnl + 1) < 1e-9, JSON.stringify(c));
  assert.equal(c.holdSec, 3600);
  assert.equal(c.pnlPct, -25);
  assert.equal(L.excludedSells, 1);
  assert.equal(L.open.length, 0);
});

test('buildLedger: oversell is capped to the known quantity and counted', () => {
  const L = buildLedger([swapTx({ ts: NOW - 100, tok: 10, sol: -1 }), swapTx({ ts: NOW - 50, tok: -20, sol: 4 })], W, NOW);
  assert.equal(L.partialSells, 1);
  assert.ok(Math.abs(L.closed[0].proceeds - 2) < 1e-9, 'only half the sell is matched to known cost');
});

test('flags + profile: fast flips, revenge buys, re-entries, open positions', () => {
  const t = NOW - 50000;
  const txs = [
    swapTx({ ts: t, tok: 10, sol: -1 }), swapTx({ ts: t + 100, tok: -10, sol: 0.5 }),            // lot 1: loss, fast
    swapTx({ ts: t + 400, tok: 10, sol: -1 }), swapTx({ ts: t + 5000, tok: -10, sol: 2 }),       // lot 2: revenge (300s after loss), win
    swapTx({ ts: t + 9000, tok: 10, sol: -1 }), swapTx({ ts: t + 20000, tok: -10, sol: 1.5 }),   // lot 3: re-entry
    swapTx({ ts: t + 21000, mint: MINT_B, tok: 5, sol: -0.5 }),                                   // still open
  ];
  const L = buildLedger(txs, W, NOW);
  assert.deepEqual(L.closed.map(c => [c.flags.fast, c.flags.revenge, c.flags.reentry]), [[true, false, false], [false, true, false], [false, false, true]]);
  const P = buildProfile(L);
  assert.equal(P.byQuote.SOL.closed, 3);
  assert.equal(P.byQuote.SOL.up, 2);
  assert.equal(P.byQuote.SOL.down, 1);
  assert.ok(Math.abs(P.byQuote.SOL.realized - 1) < 1e-9);
  assert.equal(P.fastFlips, 1); assert.equal(P.revengeBuys, 1); assert.equal(P.reentries, 1);
  assert.equal(P.openPositions, 1);
  assert.equal(P.medianHoldSec, 4600);
  assert.equal(P.topTokens[0].mint, MINT_A);
});

test('fetchHistory paginates with before-signature until an empty page', async () => {
  const pages = [[{ signature: 'a' }, { signature: 'b' }], [{ signature: 'c' }], []];
  const seen = [];
  const h = await fetchHistory({ host: 'h', apiKey: 'k', address: W, maxPages: 5, page: async ({ before }) => { seen.push(before); return pages.shift(); } });
  assert.deepEqual(seen, [null, 'b', 'c']);
  assert.equal(h.txs.length, 3);
  assert.equal(h.complete, true);
  assert.equal(h.pages, 3);
});

test('fetchHistory: page budget → partial; later-page error → partial; first-page error throws', async () => {
  const full = () => Array.from({ length: 100 }, (_, i) => ({ signature: 's' + Math.random() + i }));
  const a = await fetchHistory({ host: 'h', apiKey: 'k', address: W, maxPages: 3, page: async () => full() });
  assert.equal(a.txs.length, 300); assert.equal(a.complete, false); assert.equal(a.stoppedBy, 'budget');
  let calls = 0;
  const b = await fetchHistory({ host: 'h', apiKey: 'k', address: W, maxPages: 5, page: async () => { if (++calls === 2) throw new ProviderError('timeout'); return full(); } });
  assert.equal(b.txs.length, 100); assert.equal(b.stoppedBy, 'provider-error'); assert.equal(b.complete, false);
  await assert.rejects(fetchHistory({ host: 'h', apiKey: 'k', address: W, maxPages: 5, page: async () => { throw new ProviderError('status', 500); } }), ProviderError);
});

test('buildDeep: honest coverage and no address in output', () => {
  const txs = [swapTx({ ts: NOW - 7200, tok: 10, sol: -1 }), swapTx({ ts: NOW - 3600, tok: -10, sol: 2 })];
  const d = buildDeep({ txs, pages: 2, complete: true, stoppedBy: 'end' }, W, NOW);
  assert.equal(d.coverage.complete, true);
  assert.equal(d.coverage.transactions, 2);
  assert.equal(d.closed.length, 1);
  assert.equal(d.profile.byQuote.SOL.up, 1);
  assert.ok(!JSON.stringify(d).includes(W));
  assert.match(d.method, /average-cost/);
});
