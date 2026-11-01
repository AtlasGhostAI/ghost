/* GHOST Lab UI — Deep Memory, Parallel Ghost and Paper Lab panels.
 * All logic lives in lab.js; this file only renders and wires events.
 * Every value from the API is escaped before it reaches innerHTML. */
(() => {
  'use strict';
  const L = window.GhostLab, C = window.AtlasCore;
  if (!L || !C) return;
  const cfg = Object.assign({ apiBase: '' }, window.ATLAS_CONFIG || {});
  const features = Object.assign({ deep: true, parallel: true, paper: true }, cfg.features || {});
  const apiBase = /^https:\/\/[^\s/]+$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(cfg.apiBase || '').replace(/\/+$/, '')) ? cfg.apiBase.replace(/\/+$/, '') : '';
  const $ = id => document.getElementById(id);
  const esc = C.escapeHtml;
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* private mode: lab still works for this visit */ } },
  };
  const SOL_MINT = 'So11111111111111111111111111111111111111112';

  // ------------------------------------------------------------------ sample
  const now = Math.floor(Date.now() / 1000);
  const S = (pnl, holdSec, f = {}, avgBuy = 0.5) => ({ mint: 'Samp1e' + Math.random().toString(36).slice(2, 8), quote: 'SOL', pnl, holdSec, closedAt: now - 3600, avgBuy, flags: { fast: holdSec < 600, revenge: false, reentry: false, oversized: false, ...f } });
  const SAMPLE = {
    coverage: { transactions: 412, windowStartUtc: 'sample', windowEndUtc: 'sample', complete: false, pages: 5 },
    profile: {
      tradeCount: 86, buys: 47, sells: 39, tokensTraded: 19, byQuote: { SOL: { closed: 12, up: 4, down: 8, flat: 0, realized: -3.2 } },
      medianHoldSec: 1260, fastFlips: 5, revengeBuys: 3, reentries: 2, oversized: 2, openPositions: 4, medianBuy: { SOL: 0.5 }, topTokens: [],
    },
    tradeTimes: Array.from({ length: 86 }, (_, i) => now - (i * 5400) - ((i % 7) * 600)),
    closed: [S(-0.9, 240), S(1.4, 8400, { revenge: true }), S(-1.1, 380), S(-0.6, 3200, { reentry: true }), S(0.8, 15000), S(-2.4, 2100, { oversized: true }, 1.6),
      S(-0.3, 420), S(0.5, 9000), S(-0.7, 300, { revenge: true }), S(-0.4, 5200, { reentry: true }), S(0.9, 21000, { revenge: true }), S(-0.4, 7400)],
  };

  // ------------------------------------------------------------------ deep memory
  let deep = SAMPLE, sample = true;
  const validDeep = d => d && typeof d === 'object' && d.profile && typeof d.profile === 'object' && Array.isArray(d.closed) && d.coverage && typeof d.coverage === 'object';
  const num = v => (Number.isFinite(v) ? v : 0);

  // The CSP forbids inline style attributes; CSSOM writes are allowed.
  function sizeBars(root, prop) {
    root.querySelectorAll('[data-v]').forEach(el => { const v = Math.max(0, Math.min(100, Number(el.dataset.v) || 0)); el.style.setProperty(prop, v + '%'); });
  }

  function statTile(label, value, tone = '') {
    return `<div class="stat ${tone}"><strong>${esc(value)}</strong><small>${esc(label)}</small></div>`;
  }

  function renderMemory(since) {
    const p = deep.profile, sol = (p.byQuote && p.byQuote.SOL) || null;
    const closedTotal = Object.values(p.byQuote || {}).reduce((a, q) => a + num(q.closed), 0);
    $('memory-badge').textContent = sample ? 'SAMPLE' : 'LIVE';
    $('memory-badge').classList.toggle('is-live', !sample);
    const cv = deep.coverage;
    $('memory-coverage').textContent = sample ? 'Fictional numbers until you run a wallet with Deep memory on'
      : `${num(cv.transactions)} transactions · ${cv.windowStartUtc || '?'} → ${cv.windowEndUtc || '?'} UTC · ${cv.complete ? 'full history' : 'newest ' + num(cv.transactions) + ' only (partial)'}`;
    const tiles = [
      statTile('TRADES READ', String(num(p.tradeCount))),
      statTile('CLOSED POSITIONS', String(closedTotal)),
      statTile('UP / DOWN (SOL)', sol ? `${num(sol.up)} / ${num(sol.down)}` : '—'),
      statTile('REALIZED (SOL)', sol ? L.fmtQuote(num(sol.realized), 'SOL') : '—', sol ? (sol.realized > 0 ? 'up' : sol.realized < 0 ? 'down' : '') : ''),
      statTile('MEDIAN HOLD', L.fmtDuration(p.medianHoldSec)),
      statTile('FLIPS < 10 MIN', String(num(p.fastFlips))),
    ];
    for (const [q, v] of Object.entries(p.byQuote || {})) if (q !== 'SOL') tiles.push(statTile(`REALIZED (${q})`, L.fmtQuote(num(v.realized), q), v.realized > 0 ? 'up' : v.realized < 0 ? 'down' : ''));
    $('memory-stats').innerHTML = tiles.join('');

    const hours = L.localHours(deep.tradeTimes);
    const max = Math.max(1, ...hours);
    $('memory-hours').innerHTML = hours.map((h, i) => `<span data-v="${(h / max) * 100}" title="${String(i).padStart(2, '0')}:00 · ${h} trades"></span>`).join('');
    sizeBars($('memory-hours'), '--h');

    $('memory-patterns').innerHTML = L.patterns(p, hours).map(t => `<li>${esc(t)}</li>`).join('') || '<li>Nothing stands out yet.</li>';
    const sinceEl = $('memory-since');
    if (since) {
      sinceEl.textContent = `SINCE YOUR LAST CHECK: ${since.closed >= 0 ? '+' : ''}${since.closed} CLOSED POSITIONS · ${L.fmtQuote(since.realized, 'SOL')} REALIZED`;
      sinceEl.classList.remove('hidden');
    } else sinceEl.classList.add('hidden');

    const rows = [...deep.closed].sort((a, b) => num(b.closedAt) - num(a.closedAt)).slice(0, 8).map(c => {
      const flags = Object.entries(c.flags || {}).filter(([, v]) => v).map(([k]) => `<span class="flag">${esc({ fast: 'FAST FLIP', revenge: 'REVENGE', reentry: 'RE-ENTRY', oversized: 'OVERSIZED' }[k] || k)}</span>`).join('');
      return `<tr><td class="mono keep-case">${sample ? 'SAMPLE' : esc(L.shortMint(c.mint))}</td><td>${esc(L.fmtDuration(c.holdSec))}</td><td class="${c.pnl > 0 ? 'up' : c.pnl < 0 ? 'down' : ''}">${esc(L.fmtQuote(c.pnl, c.quote))}</td><td>${flags || '—'}</td></tr>`;
    });
    $('memory-closed').querySelector('tbody').innerHTML = rows.join('') || '<tr><td colspan="4">No closed positions in this window.</td></tr>';
    if (deep.method && !sample) $('memory-method').textContent = String(deep.method).slice(0, 400);
  }

  // ------------------------------------------------------------------ parallel
  const parOn = { noFast: true, noRevenge: false, noReentry: false, capSize: false };
  function buildParallelRules() {
    const fs = $('parallel-rules');
    const legend = fs.querySelector('legend');
    fs.innerHTML = '';
    fs.appendChild(legend);
    for (const [k, sc] of Object.entries(L.SCENARIOS)) {
      const id = 'par-' + k;
      const lab = document.createElement('label');
      lab.className = 'check-line';
      lab.innerHTML = `<input type="checkbox" id="${id}" ${parOn[k] ? 'checked' : ''} /> <span><b>${esc(sc.label)}</b></span>`;
      lab.querySelector('input').addEventListener('change', e => { parOn[k] = e.target.checked; renderParallel(); });
      fs.appendChild(lab);
    }
  }
  function renderParallel() {
    $('parallel-badge').textContent = sample ? 'SAMPLE' : 'LIVE';
    $('parallel-badge').classList.toggle('is-live', !sample);
    const res = L.parallel(deep.closed, parOn, deep.profile.medianBuy || {});
    const out = Object.entries(res).map(([q, r]) => {
      const max = Math.max(Math.abs(r.actual), Math.abs(r.parallel), 1e-9);
      const bar = (v, cls) => `<div class="par-bar ${cls} ${v < 0 ? 'neg' : 'pos'}"><span data-v="${(Math.abs(v) / max) * 100}"></span></div>`;
      const delta = r.parallel - r.actual;
      return `<div class="par-row">
        <p class="label mono">${esc(q)}</p>
        <div class="par-line"><span class="mono">YOU</span>${bar(r.actual, 'you')}<b class="${r.actual >= 0 ? 'up' : 'down'}">${esc(L.fmtQuote(r.actual, q))}</b></div>
        <div class="par-line"><span class="mono">PARALLEL</span>${bar(r.parallel, 'ghost')}<b class="${r.parallel >= 0 ? 'up' : 'down'}">${esc(L.fmtQuote(r.parallel, q))}</b></div>
        <p class="par-verdict">${Math.abs(delta) < 1e-9 ? 'No difference with these rules.' : delta > 0 ? `Your habits cost you <b class="up">${esc(L.fmtQuote(delta, q).replace('+', ''))}</b> here.` : `Your instincts beat these rules by <b class="up">${esc(L.fmtQuote(-delta, q).replace('+', ''))}</b>. Rare. Enjoy it.`} <span class="muted">${r.removed} skipped · ${r.capped} capped · ${r.kept} kept</span></p>
      </div>`;
    });
    $('parallel-results').innerHTML = out.join('') || '<p>No closed positions to replay yet.</p>';
    sizeBars($('parallel-results'), '--w');
  }

  window.addEventListener('ghost:deep', e => {
    const d = e.detail && e.detail.deep;
    if (!validDeep(d)) return;
    deep = d; sample = false;
    let since = null;
    const key = e.detail.key ? 'ghost-mem-' + String(e.detail.key).replace(/[^a-f0-9]/g, '').slice(0, 24) : '';
    if (key) {
      try { since = L.sinceLast(JSON.parse(store.get(key) || 'null'), d.profile, 'SOL'); } catch { since = null; }
      store.set(key, JSON.stringify({ byQuote: d.profile.byQuote, fastFlips: d.profile.fastFlips, at: Date.now() }));
    }
    renderMemory(since);
    renderParallel();
  });

  // ------------------------------------------------------------------ paper lab
  const PKEY = 'ghost-paper-v1';
  let paper = L.loadPaper(store.get(PKEY));
  const prices = {};
  let selected = null, busy = false;
  const save = () => store.set(PKEY, JSON.stringify(paper));
  const msg = (text, tone = '') => { const m = $('paper-msg'); m.textContent = text; m.className = 'paper-msg ' + tone; };

  async function api(path) {
    const res = await fetch(apiBase + path, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) throw new Error((data && typeof data.error === 'string' && data.error.length < 160) ? data.error : 'Price service unavailable.');
    return data;
  }

  async function refreshPrices(extra = []) {
    const ids = [...new Set([...Object.keys(paper.positions), ...extra])].slice(0, 20);
    if (!ids.length || !apiBase) return;
    try {
      const d = await api('/api/price?ids=' + ids.join(','));
      for (const [m, p] of Object.entries((d && d.prices) || {})) if (p && Number.isFinite(p.usdPrice)) prices[m] = p.usdPrice;
    } catch (e) { msg(e.message, 'warn'); }
    renderPaper();
  }

  function renderPaper() {
    const eq = L.equity(paper, prices);
    const ret = ((eq - paper.startCash) / paper.startCash) * 100;
    $('paper-stats').innerHTML = [
      statTile('EQUITY', L.fmtUsd(eq), eq > paper.startCash ? 'up' : eq < paper.startCash ? 'down' : ''),
      statTile('CASH', L.fmtUsd(paper.cash)),
      statTile('REALIZED', L.fmtUsd(paper.realized, true), paper.realized > 0 ? 'up' : paper.realized < 0 ? 'down' : ''),
      statTile('RETURN', `${ret >= 0 ? '+' : '−'}${Math.abs(ret).toFixed(2)}%`, ret > 0 ? 'up' : ret < 0 ? 'down' : ''),
    ].join('');
    const rows = Object.entries(paper.positions).map(([m, p]) => {
      const px = prices[m], val = Number.isFinite(px) ? p.qty * px : null, pnl = val === null ? null : val - p.cost;
      return `<tr data-mint="${esc(m)}"><td><button type="button" class="link-btn" data-pick="${esc(m)}">${esc(p.symbol)}</button></td><td>${val === null ? 'no price' : esc(L.fmtUsd(val))}</td><td>${esc(L.fmtUsd(p.cost))}</td><td class="${pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}">${pnl === null ? '—' : esc(L.fmtUsd(pnl, true))}</td></tr>`;
    });
    $('paper-positions').querySelector('tbody').innerHTML = rows.join('') || '<tr><td colspan="4">No open paper positions.</td></tr>';
    $('paper-journal').innerHTML = paper.journal.slice(0, 12).map(j => {
      const t = new Date(j.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      if (j.side === 'lock') return `<li><span class="mono">${esc(t)}</span> Locked your rules for ${esc(String(j.hours))}h.</li>`;
      const extra = j.side === 'sell' ? ` · <b class="${j.pnl >= 0 ? 'up' : 'down'}">${esc(L.fmtUsd(j.pnl, true))}</b>` : '';
      return `<li><span class="mono">${esc(t)}</span> ${j.side === 'buy' ? 'Bought' : 'Sold'} ${esc(L.fmtUsd(j.usd))} of ${esc(j.symbol)}${extra}</li>`;
    }).join('') || '<li>Your trades will show up here, with GHOST watching.</li>';

    for (const k of ['maxPct', 'maxLossesPerDay', 'cooldownMin']) {
      const el = $('rule-' + k);
      if (document.activeElement !== el) el.value = paper.rules[k];
      el.disabled = paper.rulesLockedUntil > Date.now();
    }
    const locked = paper.rulesLockedUntil > Date.now();
    $('rules-save').disabled = locked; $('rules-lock').disabled = locked;
    $('rules-status').textContent = locked ? `LOCKED UNTIL ${new Date(paper.rulesLockedUntil).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}. NO TAKE-BACKS.` : 'UNLOCKED. LOCK THEM WHEN YOU MEAN IT.';

    if (selected) {
      $('paper-token').classList.remove('hidden');
      $('paper-sym').textContent = selected.symbol;
      $('paper-mint-short').textContent = L.shortMint(selected.mint);
      $('paper-price').textContent = Number.isFinite(prices[selected.mint]) ? L.fmtUsd(prices[selected.mint]) : 'no live price';
      $('paper-sells').classList.toggle('hidden', !paper.positions[selected.mint]);
    }
  }

  async function loadToken(mint) {
    mint = String(mint || '').trim();
    if (C.classifyInput(mint) === 'secret') { $('paper-mint').value = ''; msg('That looks like a private key. It was cleared and not sent. Paste a token mint address instead.', 'warn'); return; }
    if (!C.isValidSolanaAddress(mint)) { msg('That is not a valid token mint address.', 'warn'); return; }
    msg('Loading token…');
    try {
      const [t] = await Promise.all([api('/api/token?mint=' + mint), refreshPrices([mint])]);
      const info = t && t.token;
      selected = { mint, symbol: (info && info.symbol) || (paper.positions[mint] && paper.positions[mint].symbol) || L.shortMint(mint) };
      msg(Number.isFinite(prices[mint]) ? '' : 'No reliable live price for this token. GHOST won’t let you trade it on paper.', Number.isFinite(prices[mint]) ? '' : 'warn');
      renderPaper();
    } catch (e) { msg(e.message, 'warn'); }
  }

  function commit(r, okText) {
    if (r.error) { msg(r.error, r.blocked ? 'ghost' : 'warn'); return false; }
    paper = r.state; save(); renderPaper(); if (okText) msg(okText, 'ok');
    return true;
  }

  function wirePaper() {
    if (!features.paper) { $('lab').classList.add('hidden'); return; }
    if (!apiBase) {
      $('paper-off').classList.remove('hidden');
      for (const id of ['paper-load', 'paper-rules']) [...$(id).elements].forEach(el => { el.disabled = true; });
      $('paper-sol').disabled = true;
    }
    $('paper-load').addEventListener('submit', e => { e.preventDefault(); loadToken($('paper-mint').value); });
    $('paper-sol').addEventListener('click', () => { $('paper-mint').value = SOL_MINT; loadToken(SOL_MINT); });
    $('paper-positions').addEventListener('click', e => { const b = e.target.closest('[data-pick]'); if (b) { $('paper-mint').value = b.dataset.pick; loadToken(b.dataset.pick); } });
    $('paper-buy').addEventListener('submit', async e => {
      e.preventDefault();
      if (!selected || busy) return;
      busy = true;
      try {
        await refreshPrices([selected.mint]);
        const usd = parseFloat(String($('paper-usd').value).replace(/[$,\s]/g, ''));
        if (commit(L.buy(paper, { mint: selected.mint, symbol: selected.symbol, usd, price: prices[selected.mint], prices }), `Paper-bought ${L.fmtUsd(usd)} of ${selected.symbol}. GHOST is watching.`)) $('paper-usd').value = '';
      } finally { busy = false; }
    });
    $('paper-sells').addEventListener('click', async e => {
      const b = e.target.closest('[data-pct]');
      if (!b || !selected || busy) return;
      busy = true;
      try {
        await refreshPrices([selected.mint]);
        const r = L.sell(paper, { mint: selected.mint, pct: Number(b.dataset.pct), price: prices[selected.mint] });
        commit(r, r.pnl === undefined ? '' : r.pnl >= 0 ? `Closed for ${L.fmtUsd(r.pnl, true)}. Don’t let it go to your head.` : `Closed for ${L.fmtUsd(r.pnl, true)}. Your cooldown starts now.`);
      } finally { busy = false; }
    });
    $('paper-rules').addEventListener('submit', e => {
      e.preventDefault();
      commit(L.setRules(paper, { maxPct: $('rule-maxPct').value, maxLossesPerDay: $('rule-maxLossesPerDay').value, cooldownMin: $('rule-cooldownMin').value }), 'Rules saved.');
    });
    const lockBtn = $('rules-lock');
    let lockArmed = false;
    lockBtn.addEventListener('click', () => {
      if (!lockArmed) { lockArmed = true; lockBtn.textContent = 'TAP AGAIN TO LOCK'; setTimeout(() => { lockArmed = false; lockBtn.textContent = 'LOCK FOR 24H'; }, 4000); return; }
      lockArmed = false; lockBtn.textContent = 'LOCK FOR 24H';
      commit(L.lockRules(paper, 24), 'Rules locked for 24 hours. GHOST will enforce them.');
    });
    const resetBtn = $('paper-reset');
    let resetArmed = false;
    resetBtn.addEventListener('click', () => {
      if (!resetArmed) { resetArmed = true; resetBtn.textContent = 'TAP AGAIN TO RESET'; setTimeout(() => { resetArmed = false; resetBtn.textContent = 'RESET LAB'; }, 4000); return; }
      resetArmed = false; resetBtn.textContent = 'RESET LAB';
      const keepLock = paper.rulesLockedUntil > Date.now() ? { rules: paper.rules, rulesLockedUntil: paper.rulesLockedUntil } : {};
      paper = { ...L.newPaper(), ...keepLock }; selected = null; $('paper-token').classList.add('hidden'); save(); renderPaper(); msg('Fresh $10,000. Locked rules stay locked.', 'ok');
    });
    setInterval(() => { if (!document.hidden && Object.keys(paper.positions).length) refreshPrices(selected ? [selected.mint] : []); }, 30000);
    renderPaper();
    refreshPrices();
  }

  // ------------------------------------------------------------------ boot
  if (!features.deep) $('memory').classList.add('hidden');
  if (!features.parallel) $('parallel').classList.add('hidden');
  buildParallelRules();
  renderMemory(null);
  renderParallel();
  wirePaper();
  window.__labTest = { getPaper: () => paper };
})();
