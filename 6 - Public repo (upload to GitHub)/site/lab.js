/* GHOST Lab — pure logic for Deep Memory, Parallel Ghost and the Paper Lab.
 * No DOM, no network. Browser: window.GhostLab. Node tests: module.exports. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GhostLab = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const QUOTE_DECIMALS = { SOL: 4, USDC: 2, USDT: 2 };
  const fmtQuote = (v, q) => {
    if (!Number.isFinite(v)) return '—';
    const d = QUOTE_DECIMALS[q] ?? 4;
    const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    return `${v > 0 ? '+' : v < 0 ? '−' : ''}${s} ${q}`;
  };
  const fmtUsd = (v, signed = false) => {
    if (!Number.isFinite(v)) return '—';
    const s = Math.abs(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: Math.abs(v) < 1 ? 4 : 2 });
    return signed ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${s}` : (v < 0 ? '−' : '') + s;
  };
  function fmtDuration(sec) {
    if (!Number.isFinite(sec)) return '—';
    if (sec < 60) return `${Math.round(sec)}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    if (sec < 86400) return `${(sec / 3600).toFixed(sec < 36000 ? 1 : 0)}h`;
    return `${(sec / 86400).toFixed(sec < 864000 ? 1 : 0)}d`;
  }
  const shortMint = m => (typeof m === 'string' && m.length > 10 ? `${m.slice(0, 4)}…${m.slice(-4)}` : String(m || ''));

  /** Trades per local hour (0–23). getHours() uses the viewer's time zone. */
  function localHours(times) {
    const h = Array(24).fill(0);
    for (const t of Array.isArray(times) ? times : []) if (Number.isFinite(t)) h[new Date(t * 1000).getHours()] += 1;
    return h;
  }

  /** Factual observations from the profile. Only states things the numbers show. */
  function patterns(profile, hours) {
    const out = [];
    if (!profile) return out;
    const closed = Object.values(profile.byQuote || {}).reduce((a, q) => a + q.closed, 0);
    if (profile.tradeCount === 0) { out.push('No clean token swaps found in this window, so there is nothing to learn from yet.'); return out; }
    if (Array.isArray(hours) && hours.some(Boolean)) {
      const top = hours.indexOf(Math.max(...hours));
      const share = Math.round((hours[top] / hours.reduce((a, b) => a + b, 0)) * 100);
      out.push(`Your busiest hour is ${String(top).padStart(2, '0')}:00–${String((top + 1) % 24).padStart(2, '0')}:00 (your time), with ${share}% of your trades.`);
    }
    if (profile.medianHoldSec !== null && profile.medianHoldSec !== undefined) out.push(`Half of your closed positions were held less than ${fmtDuration(profile.medianHoldSec)}.`);
    if (profile.fastFlips) out.push(`${profile.fastFlips} of ${closed} closed positions were flipped in under 10 minutes.`);
    if (profile.revengeBuys) out.push(`${profile.revengeBuys} position${profile.revengeBuys === 1 ? ' was' : 's were'} opened within 15 minutes of closing a loser.`);
    if (profile.reentries) out.push(`${profile.reentries} round trip${profile.reentries === 1 ? ' was' : 's were'} your 3rd+ attempt at the same token.`);
    if (profile.oversized) out.push(`${profile.oversized} position${profile.oversized === 1 ? ' was' : 's were'} more than twice your usual buy size.`);
    if (profile.openPositions) out.push(`${profile.openPositions} position${profile.openPositions === 1 ? ' is' : 's are'} still open, so not counted in results.`);
    return out;
  }

  /** Difference vs. a previous snapshot (stored in the viewer's browser). */
  function sinceLast(prev, profile, q = 'SOL') {
    if (!prev || !profile || !profile.byQuote) return null;
    const a = prev.byQuote && prev.byQuote[q], b = profile.byQuote[q];
    if (!a || !b) return null;
    return { closed: b.closed - a.closed, realized: b.realized - a.realized, fastFlips: (profile.fastFlips || 0) - (prev.fastFlips || 0) };
  }

  const SCENARIOS = {
    noFast: { label: 'Skip flips under 10 minutes', test: c => c.flags && c.flags.fast },
    noRevenge: { label: 'Skip revenge buys (within 15 min of a loss)', test: c => c.flags && c.flags.revenge },
    noReentry: { label: 'Skip 3rd+ attempts at the same token', test: c => c.flags && c.flags.reentry },
    capSize: { label: 'Cap positions at 2× your usual buy', test: () => false, scale: true },
  };

  /**
   * Replays your closed positions with rules switched on. Uses your real
   * execution prices; a skipped position contributes 0, a capped one scales.
   * Returns { [quote]: { actual, parallel, removed, capped, kept } }.
   */
  function parallel(closed, on, medianBuy) {
    const res = {};
    for (const c of Array.isArray(closed) ? closed : []) {
      if (!c || !Number.isFinite(c.pnl)) continue;
      const r = (res[c.quote] ||= { actual: 0, parallel: 0, removed: 0, capped: 0, kept: 0 });
      r.actual += c.pnl;
      const skip = Object.keys(SCENARIOS).some(k => on[k] && SCENARIOS[k].test(c));
      if (skip) { r.removed += 1; continue; }
      let pnl = c.pnl;
      const med = medianBuy && medianBuy[c.quote];
      if (on.capSize && med && c.avgBuy > 2 * med) { pnl *= (2 * med) / c.avgBuy; r.capped += 1; }
      r.parallel += pnl; r.kept += 1;
    }
    for (const r of Object.values(res)) { r.actual = Math.round(r.actual * 1e9) / 1e9; r.parallel = Math.round(r.parallel * 1e9) / 1e9; }
    return res;
  }

  // ---------------- Paper Lab ----------------
  const DAY = 86400000;
  const START_CASH = 10000;
  function newPaper(now = Date.now()) {
    return {
      v: 1, createdAt: now, cash: START_CASH, startCash: START_CASH, positions: {}, journal: [],
      realized: 0, rules: { maxPct: 25, maxLossesPerDay: 3, cooldownMin: 15 }, rulesLockedUntil: 0,
      lastLossAt: 0, losses: { day: '', n: 0 }, costs: { slippagePct: 1, feePct: 0.3 },
    };
  }
  const dayKey = now => new Date(now).toISOString().slice(0, 10);

  /** Accepts only a structurally valid saved state; anything else → fresh lab. */
  function loadPaper(raw, now = Date.now()) {
    try {
      const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!s || s.v !== 1 || !Number.isFinite(s.cash) || typeof s.positions !== 'object' || !Array.isArray(s.journal)) return newPaper(now);
      const base = newPaper(now);
      return { ...base, ...s, rules: { ...base.rules, ...s.rules }, costs: { ...base.costs, ...s.costs }, losses: { ...base.losses, ...s.losses } };
    } catch { return newPaper(now); }
  }

  function equity(state, prices) {
    let v = state.cash;
    for (const [mint, p] of Object.entries(state.positions)) {
      const px = prices && prices[mint];
      v += Number.isFinite(px) ? p.qty * px : p.cost; // unpriced → valued at cost, flagged in UI
    }
    return v;
  }

  const clone = s => JSON.parse(JSON.stringify(s));
  const note = (s, entry) => { s.journal.unshift(entry); s.journal = s.journal.slice(0, 50); };

  function checkRules(state, usd, eq, now) {
    const r = state.rules;
    if (state.losses.day === dayKey(now) && state.losses.n >= r.maxLossesPerDay) {
      return `Locked out: you hit your own limit of ${r.maxLossesPerDay} losing trades today. GHOST is holding you to it.`;
    }
    if (state.lastLossAt && now - state.lastLossAt < r.cooldownMin * 60000) {
      const mins = Math.ceil((r.cooldownMin * 60000 - (now - state.lastLossAt)) / 60000);
      return `Cooling down: ${mins} more minute${mins === 1 ? '' : 's'} after a loss, by your own rule. Revenge trading is how ghosts are made.`;
    }
    if (usd > (eq * r.maxPct) / 100 + 1e-9) return `Too big: your rule caps a trade at ${r.maxPct}% of equity (${fmtUsd((eq * r.maxPct) / 100)}).`;
    return null;
  }

  function buy(state, { mint, symbol, usd, price, now = Date.now(), prices }) {
    if (!(usd > 0)) return { error: 'Enter an amount above $0.' };
    if (!(price > 0)) return { error: 'No live price for this token right now.' };
    if (usd > state.cash + 1e-9) return { error: `Not enough paper cash. You have ${fmtUsd(state.cash)}.` };
    const blocked = checkRules(state, usd, equity(state, prices), now);
    if (blocked) return { error: blocked, blocked: true };
    const s = clone(state);
    const fill = price * (1 + s.costs.slippagePct / 100);
    const fee = usd * (s.costs.feePct / 100);
    const qty = (usd - fee) / fill;
    const p = s.positions[mint] || { qty: 0, cost: 0, symbol: symbol || shortMint(mint), openedAt: now };
    p.qty += qty; p.cost += usd; p.symbol = symbol || p.symbol;
    s.positions[mint] = p;
    s.cash -= usd;
    note(s, { t: now, side: 'buy', mint, symbol: p.symbol, usd, price: fill, qty });
    return { state: s };
  }

  function sell(state, { mint, pct, price, now = Date.now() }) {
    const p = state.positions[mint];
    if (!p) return { error: 'You have no paper position in this token.' };
    if (!(pct > 0 && pct <= 100)) return { error: 'Choose how much to sell.' };
    if (!(price > 0)) return { error: 'No live price for this token right now.' };
    const s = clone(state);
    const q = s.positions[mint];
    const frac = pct / 100, qty = q.qty * frac, costOut = q.cost * frac;
    const fill = price * (1 - s.costs.slippagePct / 100);
    const proceeds = qty * fill * (1 - s.costs.feePct / 100);
    const pnl = proceeds - costOut;
    q.qty -= qty; q.cost -= costOut;
    if (pct >= 100 || q.qty <= 1e-12) delete s.positions[mint];
    s.cash += proceeds; s.realized += pnl;
    if (pnl < 0) {
      s.lastLossAt = now;
      const d = dayKey(now);
      s.losses = { day: d, n: (s.losses.day === d ? s.losses.n : 0) + 1 };
    }
    note(s, { t: now, side: 'sell', mint, symbol: q.symbol, usd: proceeds, price: fill, qty, pnl });
    return { state: s, pnl };
  }

  function setRules(state, rules, now = Date.now()) {
    if (state.rulesLockedUntil > now) return { error: 'Your rules are locked. That was the point.' };
    const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d);
    const s = clone(state);
    s.rules = {
      maxPct: clamp(rules.maxPct, 1, 100, s.rules.maxPct),
      maxLossesPerDay: clamp(rules.maxLossesPerDay, 1, 20, s.rules.maxLossesPerDay),
      cooldownMin: clamp(rules.cooldownMin, 0, 240, s.rules.cooldownMin),
    };
    return { state: s };
  }

  function lockRules(state, hours = 24, now = Date.now()) {
    if (state.rulesLockedUntil > now) return { error: 'Already locked.' };
    const s = clone(state);
    s.rulesLockedUntil = now + hours * 3600000;
    note(s, { t: now, side: 'lock', hours });
    return { state: s };
  }

  return {
    fmtQuote, fmtUsd, fmtDuration, shortMint, localHours, patterns, sinceLast,
    SCENARIOS, parallel,
    START_CASH, DAY, newPaper, loadPaper, equity, buy, sell, setRules, lockRules, checkRules,
  };
});
