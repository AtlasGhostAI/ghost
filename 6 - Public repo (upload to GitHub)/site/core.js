/* ATLAS / GHOST — pure, DOM-free helpers shared by app.js and the unit tests.
 * Classic script (works from file:// and plain static hosting). In the
 * browser it defines window.AtlasCore; under Node it is module.exports. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AtlasCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const MAP = new Map(Array.from(ALPHABET, (c, i) => [c, i]));
  const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

  function base58DecodedLength(s) {
    if (typeof s !== 'string' || s.length === 0 || s.length > 128) return -1;
    let n = 0n;
    for (const ch of s) {
      const v = MAP.get(ch);
      if (v === undefined) return -1;
      n = n * 58n + BigInt(v);
    }
    let bytes = 0;
    while (n > 0n) { n >>= 8n; bytes++; }
    let zeros = 0;
    for (const ch of s) { if (ch === '1') zeros++; else break; }
    return zeros + bytes;
  }

  /** Syntax + decoded-length check (32 bytes). Not an on-curve check: PDAs are valid but off-curve. */
  function isValidSolanaAddress(s) {
    return typeof s === 'string' && s.length >= 32 && s.length <= 44 && BASE58_RE.test(s) && base58DecodedLength(s) === 32;
  }

  /**
   * Classifies raw input BEFORE anything leaves the browser.
   * 'secret' = looks like a private key, keypair JSON or seed phrase — never sent anywhere.
   */
  function classifyInput(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return 'empty';
    if (isValidSolanaAddress(s)) return 'address';
    if (BASE58_RE.test(s) && s.length >= 80 && s.length <= 90 && base58DecodedLength(s) === 64) return 'secret';
    if (/^\[\s*\d{1,3}(\s*,\s*\d{1,3}){31,}\s*,?\s*\]$/.test(s)) return 'secret';
    const words = s.split(/\s+/);
    if ([12, 15, 18, 21, 24].includes(words.length) && words.every(w => /^[a-z]{3,8}$/i.test(w))) return 'secret';
    return 'invalid';
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"'`]/g, c => ESC[c]);
  }

  const ARCHETYPES = {
    'chart-chaser': 'THE CHART CHASER',
    'mystery-wallet': 'THE MYSTERY WALLET',
    'failure-collector': 'THE FAILED-TX COLLECTOR',
    'quiet-observer': 'THE QUIET OBSERVER',
    'rapid-clicker': 'THE RAPID CLICKER',
    'burst-trader': 'THE BURST TRADER',
    'on-chain-explorer': 'THE ON-CHAIN EXPLORER',
  };

  const clip = (v, max) => {
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    const s = String(v);
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  };

  /** Validates and normalizes a report from the API. Returns null for anything malformed. */
  function normalizeReport(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.mode !== 'demo' && data.mode !== 'live') return null;
    const title = clip(data.title, 60), roast = clip(data.roast, 220), insight = clip(data.insight, 400);
    const disclosure = clip(data.disclosure, 300), identity = clip(data.identity || '', 40);
    if (!title || !roast || !insight || !disclosure) return null;
    if (!Array.isArray(data.stats) || data.stats.length < 2 || data.stats.length > 4) return null;
    const stats = data.stats.map(s => s && { label: clip(s.label, 24), value: clip(s.value, 12) });
    if (stats.some(s => !s || !s.label || s.value === null)) return null;
    const evidence = (Array.isArray(data.evidence) ? data.evidence : []).slice(0, 6).map(e => clip(e, 200)).filter(Boolean);
    const archetype = Object.prototype.hasOwnProperty.call(ARCHETYPES, data.archetype) ? data.archetype : null;
    const created = typeof data.createdAt === 'string' && !Number.isNaN(Date.parse(data.createdAt)) ? new Date(data.createdAt).toISOString() : null;
    const cov = data.coverage && typeof data.coverage === 'object' ? data.coverage : null;
    return {
      mode: data.mode, archetype, title, identity, stats, roast, insight, evidence, disclosure, createdAt: created,
      // Live reports are ALWAYS partial (one provider page), whatever the server says.
      partial: data.mode === 'live' || !!(cov && cov.partial),
      window: cov && typeof cov.windowStartUtc === 'string' && typeof cov.windowEndUtc === 'string'
        ? { start: clip(cov.windowStartUtc, 10), end: clip(cov.windowEndUtc, 10) } : null,
    };
  }

  function renderReportHtml(r) {
    const live = r.mode === 'live';
    return `<div class="result-head"><div><div class="section-kicker">GHOST REPORT / ${live ? 'LIVE · PARTIAL' : 'DEMO'}</div>`
      + `<h3 id="result-title" tabindex="-1">${escapeHtml(r.title)}</h3><p>${escapeHtml(r.identity)}</p></div>`
      + `<span class="demo-badge">${live ? 'OBSERVED' : 'SAMPLE'}</span></div>`
      + `<div class="stats">${r.stats.map(s => `<div class="stat"><strong>${escapeHtml(s.value)}</strong><small>${escapeHtml(s.label)}</small></div>`).join('')}</div>`
      + `<div class="roast-box"><div class="roast-label">✦ GHOST'S VERDICT</div><blockquote>${escapeHtml(r.roast)}</blockquote><p>${escapeHtml(r.insight)}</p></div>`
      + `<div class="evidence"><strong>WHAT THIS IS BASED ON</strong><ul>${r.evidence.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul><p>${escapeHtml(r.disclosure)}</p></div>`
      + `<div class="result-actions"><button type="button" id="save">↓ Download share card</button><button type="button" id="share">Share challenge ↗</button></div>`
      + `<p class="share-note">Shared links and cards never include the wallet address.</p>`;
  }

  /** Greedy word wrap using an injected text measurer; ellipsizes past maxLines. */
  function wrapText(measure, text, maxWidth, maxLines) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const w of words) {
      const next = line ? line + ' ' + w : w;
      if (measure(next) > maxWidth && line) { lines.push(line); line = w; } else line = next;
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) {
      const kept = lines.slice(0, maxLines);
      let last = kept[maxLines - 1];
      while (last && measure(last + '…') > maxWidth) last = last.replace(/\s*\S+$/, '');
      kept[maxLines - 1] = (last || '') + '…';
      return kept;
    }
    return lines;
  }

  /** Share URL carries only a whitelisted archetype slug — never an address or stats. */
  function buildShareUrl(base, report) {
    const clean = String(base).split('#')[0];
    return report && report.archetype ? `${clean}#try?r=${report.archetype}` : `${clean}#try`;
  }

  function parseShareHash(hash) {
    const m = /^#try\?r=([a-z-]{3,40})$/.exec(String(hash || ''));
    return m && Object.prototype.hasOwnProperty.call(ARCHETYPES, m[1]) ? m[1] : null;
  }

  /** Maps HTTP/network failures to user-safe messages. Server messages are shown only if short and plain. */
  function friendlyError(status, serverMessage) {
    if (status === 0) return 'Could not reach the GHOST API. Check your connection or try the sample roast.';
    if (status === 'timeout') return 'GHOST took too long to answer. Please retry or try the sample roast.';
    if (typeof serverMessage === 'string' && serverMessage.length > 0 && serverMessage.length <= 200 && !/[<>]/.test(serverMessage)) return serverMessage;
    if (status === 429) return 'Too many requests. Please wait a minute and try again.';
    if (status >= 500) return 'Live analysis is temporarily unavailable. Try the sample roast.';
    return 'Unable to analyze this wallet right now.';
  }

  return { base58DecodedLength, isValidSolanaAddress, classifyInput, escapeHtml, normalizeReport, renderReportHtml, wrapText, buildShareUrl, parseShareHash, friendlyError, ARCHETYPES };
});
