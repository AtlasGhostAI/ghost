// Trade ledger built from the wallet's own balance changes (Helius accountData),
// see docs/LEDGER_SCHEMA.md. Everything is measured in the quote asset the
// wallet actually used (SOL, USDC or USDT) — no external price feed, so no
// price gaps. Anything we cannot attribute cleanly is counted and skipped.

import { WSOL_MINT, parseTimestamp } from './normalize.js';

export const QUOTES = {
  [WSOL_MINT]: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
};
const MIN_QUOTE = { SOL: 0.00001, USDC: 0.01, USDT: 0.01 }; // ignore rent-only / dust legs
const FAST_FLIP_S = 600;      // closed within 10 minutes
const REVENGE_S = 900;        // new position within 15 minutes of a losing close
const REENTRY_N = 3;          // 3rd+ round trip in the same token

const isNum = Number.isFinite;

/** Net balance change of the wallet in one transaction: { sol, tokens: Map<mint, uiDelta> } (fee excluded). */
export function walletDeltas(tx, wallet) {
  let lamports = 0, haveNative = false;
  const tokens = new Map();
  const add = (mint, v) => tokens.set(mint, (tokens.get(mint) || 0) + v);

  for (const a of Array.isArray(tx.accountData) ? tx.accountData : []) {
    if (!a || typeof a !== 'object') continue;
    if (a.account === wallet && isNum(a.nativeBalanceChange)) { lamports += a.nativeBalanceChange; haveNative = true; }
    for (const t of Array.isArray(a.tokenBalanceChanges) ? a.tokenBalanceChanges : []) {
      if (!t || t.userAccount !== wallet || typeof t.mint !== 'string' || !t.rawTokenAmount) continue;
      const amt = Number(t.rawTokenAmount.tokenAmount), dec = Number(t.rawTokenAmount.decimals);
      if (!isNum(amt) || !Number.isInteger(dec) || dec < 0 || dec > 18) continue;
      add(t.mint, amt / 10 ** dec);
    }
  }
  if (!haveNative && tokens.size === 0) {
    // Fallback: transfer lists (less exact; misses rent and wrapped-SOL accounts).
    for (const n of Array.isArray(tx.nativeTransfers) ? tx.nativeTransfers : []) {
      if (!n || !Number.isSafeInteger(n.amount)) continue;
      if (n.toUserAccount === wallet && n.fromUserAccount !== wallet) { lamports += n.amount; haveNative = true; }
      else if (n.fromUserAccount === wallet && n.toUserAccount !== wallet) { lamports -= n.amount; haveNative = true; }
    }
    for (const t of Array.isArray(tx.tokenTransfers) ? tx.tokenTransfers : []) {
      if (!t || typeof t.mint !== 'string' || !isNum(t.tokenAmount)) continue;
      if (t.toUserAccount === wallet && t.fromUserAccount !== wallet) add(t.mint, t.tokenAmount);
      else if (t.fromUserAccount === wallet && t.toUserAccount !== wallet) add(t.mint, -t.tokenAmount);
    }
  } else if (haveNative && tx.feePayer === wallet && Number.isSafeInteger(tx.fee)) {
    lamports += tx.fee; // the network fee is not part of the trade
  }
  let sol = lamports / 1e9;
  if (tokens.has(WSOL_MINT)) { sol += tokens.get(WSOL_MINT); tokens.delete(WSOL_MINT); }
  return { sol, tokens };
}

/** One clean swap of a single token against a single quote asset, or {skip: reason}. */
export function extractTrade(tx, wallet, nowSec) {
  if (!tx || typeof tx !== 'object') return { skip: 'malformed' };
  if (tx.transactionError != null || tx.error != null) return { skip: 'failed' };
  const ts = parseTimestamp(tx.timestamp, nowSec);
  if (ts === null) return { skip: 'untimed' };
  const { sol, tokens } = walletDeltas(tx, wallet);
  const quoteDeltas = { SOL: sol };
  const others = [];
  for (const [mint, d] of tokens) {
    if (Math.abs(d) < 1e-12) continue;
    if (QUOTES[mint] && QUOTES[mint] !== 'SOL') quoteDeltas[QUOTES[mint]] = (quoteDeltas[QUOTES[mint]] || 0) + d;
    else others.push([mint, d]);
  }
  const quotes = Object.entries(quoteDeltas).filter(([q, d]) => Math.abs(d) >= MIN_QUOTE[q]);
  if (others.length === 0) return { skip: 'no-token' };
  if (others.length === 1 && quotes.length === 0) return { skip: 'no-quote' }; // e.g. a transfer or airdrop
  if (others.length !== 1 || quotes.length !== 1) return { skip: 'complex' };
  const [mint, d] = others[0];
  const [quote, qd] = quotes[0];
  if (Math.sign(d) === Math.sign(qd)) return { skip: 'complex' }; // e.g. airdrop + transfer, not a swap
  return {
    trade: {
      sig: typeof tx.signature === 'string' ? tx.signature.slice(0, 100) : null,
      ts, mint, quote,
      side: d > 0 ? 'buy' : 'sell',
      qty: Math.abs(d),
      amount: Math.abs(qd),
    },
  };
}

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (v, d = 9) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/**
 * Average-cost positions per (token, quote). A sell with no known buy inside
 * the window has unknown cost and is excluded, never guessed.
 */
export function buildLedger(txs, wallet, nowSec) {
  const trades = [], skipped = { failed: 0, untimed: 0, malformed: 0, complex: 0, 'no-token': 0, 'no-quote': 0 };
  for (const tx of Array.isArray(txs) ? txs : []) {
    const r = extractTrade(tx, wallet, nowSec);
    if (r.trade) trades.push(r.trade);
    else skipped[r.skip] = (skipped[r.skip] || 0) + 1;
  }
  trades.sort((a, b) => a.ts - b.ts);

  const pos = new Map(), closed = [], lots = new Map();
  let excludedSells = 0, partialSells = 0;
  for (const t of trades) {
    const key = `${t.mint}|${t.quote}`;
    let p = pos.get(key);
    if (t.side === 'buy') {
      if (!p || p.qty <= p.bought * 1e-6) {
        p = { mint: t.mint, quote: t.quote, qty: 0, cost: 0, bought: 0, openedAt: t.ts, buys: 0, sells: 0, proceeds: 0, costOut: 0, buyAmounts: [] };
        pos.set(key, p);
      }
      p.qty += t.qty; p.cost += t.amount; p.bought += t.qty; p.buys += 1; p.buyAmounts.push(t.amount);
      continue;
    }
    if (!p || p.qty <= p.bought * 1e-6) { excludedSells += 1; continue; }
    const covered = Math.min(t.qty, p.qty);
    if (covered < t.qty * (1 - 1e-6)) partialSells += 1;
    const out = p.cost * (covered / p.qty);
    p.proceeds += t.amount * (covered / t.qty);
    p.costOut += out;
    p.cost -= out; p.qty -= covered; p.sells += 1;
    if (p.qty <= p.bought * 1e-6) {
      const lot = (lots.get(t.mint) || 0) + 1;
      lots.set(t.mint, lot);
      closed.push({
        mint: p.mint, quote: p.quote, openedAt: p.openedAt, closedAt: t.ts, holdSec: t.ts - p.openedAt,
        cost: round(p.costOut), proceeds: round(p.proceeds), pnl: round(p.proceeds - p.costOut),
        pnlPct: p.costOut > 0 ? round(((p.proceeds - p.costOut) / p.costOut) * 100, 2) : null,
        buys: p.buys, sells: p.sells, lot, avgBuy: round(p.costOut / p.buys),
      });
      pos.delete(key);
    }
  }
  const open = [...pos.values()].filter(p => p.qty > p.bought * 1e-6).map(p => ({
    mint: p.mint, quote: p.quote, qty: round(p.qty), cost: round(p.cost), openedAt: p.openedAt, buys: p.buys, sells: p.sells,
  }));

  // Behaviour flags used by the profile and the Parallel Ghost.
  const medBuy = {};
  for (const q of ['SOL', 'USDC', 'USDT']) medBuy[q] = median(trades.filter(t => t.quote === q && t.side === 'buy').map(t => t.amount));
  for (const c of [...closed].sort((a, b) => a.openedAt - b.openedAt || a.closedAt - b.closedAt)) {
    // A revenge buy: this position opened within REVENGE_S after an earlier position closed at a loss.
    const priorLoss = closed.filter(o => o !== c && o.pnl < 0 && o.closedAt <= c.openedAt && c.openedAt - o.closedAt <= REVENGE_S);
    c.flags = {
      fast: c.holdSec < FAST_FLIP_S,
      revenge: priorLoss.length > 0,
      reentry: c.lot >= REENTRY_N,
      oversized: medBuy[c.quote] ? c.avgBuy > medBuy[c.quote] * 2 : false,
    };
  }
  return { trades, closed, open, skipped, excludedSells, partialSells, medianBuy: medBuy };
}

export function buildProfile(ledger) {
  const { trades, closed, open } = ledger;
  const byQuote = {};
  for (const c of closed) {
    const q = (byQuote[c.quote] ||= { closed: 0, up: 0, down: 0, flat: 0, realized: 0 });
    q.closed += 1; q.realized += c.pnl;
    if (c.pnl > 0) q.up += 1; else if (c.pnl < 0) q.down += 1; else q.flat += 1;
  }
  for (const q of Object.values(byQuote)) q.realized = round(q.realized);
  const tokenStats = new Map();
  for (const t of trades) {
    const s = tokenStats.get(t.mint) || { mint: t.mint, trades: 0 };
    s.trades += 1; tokenStats.set(t.mint, s);
  }
  return {
    tradeCount: trades.length,
    buys: trades.filter(t => t.side === 'buy').length,
    sells: trades.filter(t => t.side === 'sell').length,
    tokensTraded: tokenStats.size,
    byQuote,
    medianHoldSec: median(closed.map(c => c.holdSec)),
    fastFlips: closed.filter(c => c.flags.fast).length,
    revengeBuys: closed.filter(c => c.flags.revenge).length,
    reentries: closed.filter(c => c.flags.reentry).length,
    oversized: closed.filter(c => c.flags.oversized).length,
    openPositions: open.length,
    medianBuy: Object.fromEntries(Object.entries(ledger.medianBuy).filter(([, v]) => v !== null).map(([k, v]) => [k, round(v)])),
    topTokens: [...tokenStats.values()].sort((a, b) => b.trades - a.trades).slice(0, 5),
  };
}
