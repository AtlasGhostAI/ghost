/* GHOST coin check + transparency panels. Renders /api/coin and /api/wallet.
 * Every API value is escaped before it reaches innerHTML. Shareable via ?check=<mint>. */
(() => {
  'use strict';
  const C = window.AtlasCore;
  if (!C) return;
  const cfg = Object.assign({ apiBase: '', contractAddress: '', devWallet: '', lockUrl: '', feeLedger: [] }, window.ATLAS_CONFIG || {});
  const apiBase = /^https:\/\/[^\s/]+$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(cfg.apiBase || '').replace(/\/+$/, '')) ? cfg.apiBase.replace(/\/+$/, '') : '';
  const $ = id => document.getElementById(id);
  const esc = C.escapeHtml;
  const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const money = v => (Number.isFinite(v) ? (v >= 1e6 ? '$' + (v / 1e6).toFixed(v >= 1e7 ? 1 : 2) + 'M' : v >= 1e3 ? '$' + (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'K' : '$' + Math.round(v)) : '—');
  const pct = v => (Number.isFinite(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(v)) + '%' : '—');
  const age = h => (Number.isFinite(h) ? (h < 1 ? Math.round(h * 60) + 'm' : h < 48 ? Math.round(h) + 'h' : Math.round(h / 24) + 'd') : '—');
  const tile = (label, value, tone = '') => `<div class="stat ${tone}"><strong>${esc(value)}</strong><small>${esc(label)}</small></div>`;
  const VERDICT = { 'high-risk': ['HIGH RISK', 'bad'], caution: ['CAUTION', 'warn'], 'no-major-flags': ['NO MAJOR FLAGS', 'good'] };
  const ICON = { red: '✕', warn: '!', ok: '✓' };

  async function api(path) {
    const res = await fetch(apiBase + path, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    let data = null; try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new Error((data && typeof data.error === 'string' && data.error.length < 140) ? data.error : 'GHOST couldn’t check that right now.');
    return data;
  }

  // ------------------------------------------------------------- coin check
  const SAMPLE = {
    token: { symbol: 'SAMPLE', name: 'Made-up coin' }, verdict: 'high-risk', mint: '',
    market: { marketCap: 41000, liquidityUsd: 2100, volume24h: 610000, ageHours: 3, change: { h6: -94 }, stage: 'graduated' },
    flags: [
      { level: 'red', text: 'Down 94% in the last 6 hours: this looks like a dump in progress.' },
      { level: 'red', text: 'Liquidity is only $2,100: selling even a little will move the price a lot.' },
      { level: 'warn', text: '24h volume is 290× its liquidity: much of it may be bots or wash trading.' },
      { level: 'ok', text: 'Mint authority is off: supply is fixed.' },
      { level: 'ok', text: 'Freeze authority is off: tokens can’t be frozen.' },
    ],
  };
  let last = null;

  function renderCheck(d, live) {
    const [vText, vTone] = VERDICT[d.verdict] || VERDICT.caution;
    const sym = d.token ? '$' + d.token.symbol : 'Unknown token';
    $('check-badge').textContent = live ? 'LIVE' : 'SAMPLE';
    $('check-badge').classList.toggle('is-live', !!live);
    $('check-sub').textContent = live ? `Checked ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${d.market ? ' · ' + d.market.stage : ''}` : 'A made-up coin until you check a real one';
    $('check-head').innerHTML = `<div><p class="check-sym">${esc(sym)}</p><p class="check-name mono">${esc(d.token ? d.token.name : '')}</p></div><span class="verdict ${vTone} mono">${esc(vText)}</span>`;
    const m = d.market || {};
    $('check-stats').innerHTML = [
      tile('Market cap', money(m.marketCap)), tile('Liquidity', money(m.liquidityUsd)), tile('24h volume', money(m.volume24h)),
      tile('Change 6h', pct(m.change && m.change.h6), m.change && m.change.h6 < 0 ? 'neg' : 'pos'), tile('Age', age(m.ageHours)),
      d.holders ? tile('Top 10 after pool', d.holders.top10ExTop1Pct + '%') : '',
    ].join('');
    $('check-flags').innerHTML = (d.flags || []).map(f => `<li class="flag ${esc(f.level)}"><span class="mono" aria-hidden="true">${ICON[f.level] || '·'}</span>${esc(f.text)}</li>`).join('');
    const dex = $('check-dex');
    if (live && d.mint) { dex.href = 'https://dexscreener.com/solana/' + encodeURIComponent(d.mint); dex.classList.remove('hidden'); } else dex.classList.add('hidden');
    $('check-share').classList.toggle('hidden', !live);
    last = live ? d : null;
  }

  async function runCheck(mint) {
    const msg = $('check-msg');
    msg.textContent = '';
    if (!B58.test(mint)) { msg.textContent = 'That doesn’t look like a Solana token address.'; return; }
    if (!apiBase) { msg.textContent = 'Live checks aren’t enabled on this site yet.'; return; }
    const btn = $('check-go'); btn.disabled = true; btn.textContent = 'CHECKING…';
    try {
      const d = await api('/api/coin?mint=' + encodeURIComponent(mint));
      renderCheck(d, true);
      try { const u = new URL(location.href); u.searchParams.set('check', mint); history.replaceState(null, '', u); } catch { /* ignore */ }
    } catch (e) { msg.textContent = e.message; } finally { btn.disabled = false; btn.textContent = 'CHECK IT'; }
  }

  function shareText(d) {
    const [vText] = VERDICT[d.verdict] || VERDICT.caution;
    const reds = (d.flags || []).filter(f => f.level === 'red').map(f => '✕ ' + f.text.split(':')[0]);
    const warns = (d.flags || []).filter(f => f.level === 'warn').map(f => '! ' + f.text.split(':')[0]);
    return [`GHOST check: $${d.token ? d.token.symbol : '?'} → ${vText}`, ...reds, ...warns, '', `atlasghost.xyz/?check=${d.mint}`].join('\n');
  }

  function initCheck() {
    if (!$('check-form')) return;
    renderCheck(SAMPLE, false);
    $('check-form').addEventListener('submit', e => { e.preventDefault(); runCheck($('check-mint').value.trim()); });
    $('check-share').addEventListener('click', async () => {
      if (!last) return;
      const t = shareText(last);
      try { await navigator.clipboard.writeText(t); $('check-msg').textContent = 'Copied. Paste it anywhere.'; } catch { $('check-msg').textContent = t; }
    });
    let q = null; try { q = new URL(location.href).searchParams.get('check'); } catch { /* ignore */ }
    if (q && B58.test(q)) { $('check-mint').value = q; runCheck(q); }
  }

  // ----------------------------------------------------------- transparency
  async function initProof() {
    if (!$('proof-panel')) return;
    const ca = B58.test(cfg.contractAddress || '') ? cfg.contractAddress : '';
    const dev = B58.test(cfg.devWallet || '') ? cfg.devWallet : '';
    const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener" class="keep-case">${esc(text)} ↗</a>`;
    const short = a => a.slice(0, 4) + '…' + a.slice(-4);
    const rows = [
      ['Token (CA)', ca ? link('https://solscan.io/token/' + ca, short(ca)) : '<span class="muted">Posted at launch</span>'],
      ['Dev wallet', dev ? link('https://solscan.io/account/' + dev, short(dev)) : '<span class="muted">Posted at launch</span>'],
      ['Token lock', /^https:\/\//.test(cfg.lockUrl || '') ? link(cfg.lockUrl, 'View lock') : '<span class="muted">Posted after launch</span>'],
      ['Source code', link('https://github.com/AtlasGhostAI/ghost', 'github.com/AtlasGhostAI/ghost')],
      ['Liquidity', '<span>Burned automatically by pump.fun at graduation</span>'],
    ];
    $('proof-rows').innerHTML = rows.map(([k, v]) => `<div class="proof-row"><span class="mono">${esc(k)}</span>${v}</div>`).join('');
    const ledger = Array.isArray(cfg.feeLedger) ? cfg.feeLedger.filter(r => r && typeof r.item === 'string') : [];
    $('proof-ledger').innerHTML = ledger.length
      ? ledger.map(r => `<tr><td class="mono">${esc(String(r.date || ''))}</td><td>${esc(r.item)}</td><td class="mono">${esc(Number(r.sol || 0).toFixed(2))} SOL</td></tr>`).join('')
      : '<tr><td colspan="3" class="muted">Creator fees and what they pay for will be listed here after launch.</td></tr>';
    $('proof-badge').textContent = dev ? 'LIVE' : 'AT LAUNCH';
    $('proof-badge').classList.toggle('is-live', !!dev);
    const roast = $('proof-roast');
    roast.classList.toggle('hidden', !dev);
    if (dev) roast.addEventListener('click', () => { const w = $('wallet'); if (w) { w.value = dev; w.dispatchEvent(new Event('input', { bubbles: true })); $('try').scrollIntoView({ behavior: 'smooth' }); } });
    const stats = $('proof-stats');
    if (!dev || !apiBase) { stats.innerHTML = tile('Dev SOL', '—') + tile('Dev $GHOST', '—') + tile('% of supply', '—'); return; }
    try {
      const w = await api('/api/wallet?address=' + encodeURIComponent(dev) + (ca ? '&mint=' + encodeURIComponent(ca) : ''));
      const share = Number.isFinite(w.token) ? (w.token / 1e9) * 100 : null;
      stats.innerHTML = tile('Dev SOL', Number.isFinite(w.sol) ? w.sol.toFixed(2) : '—') + tile('Dev $GHOST', Number.isFinite(w.token) ? Math.round(w.token).toLocaleString('en-US') : '—') + tile('% of supply', share === null ? '—' : share.toFixed(2) + '%');
    } catch { stats.innerHTML = tile('Dev SOL', '—') + tile('Dev $GHOST', '—') + tile('% of supply', '—'); }
  }

  const start = () => { initCheck(); initProof(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
