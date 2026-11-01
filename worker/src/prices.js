// Live token prices and names for the Paper Lab, proxied from Jupiter so the
// browser never talks to a third party and responses can be cached at the edge.
// Keyless Jupiter access is limited (~0.5 req/s), hence caching + a per-client limit.

import { isValidSolanaAddress } from './address.js';

const JUP = 'https://api.jup.ag';
export const MAX_IDS = 20;

function jupHeaders(env) {
  const h = { Accept: 'application/json' };
  if (env.JUPITER_API_KEY) h['x-api-key'] = env.JUPITER_API_KEY;
  return h;
}

export function parseIds(raw) {
  const ids = String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length || ids.length > MAX_IDS) return null;
  if (!ids.every(isValidSolanaAddress)) return null;
  return [...new Set(ids)].sort();
}

/** { mint: { usdPrice, change24h } } — tokens without a reliable price are omitted. */
export async function fetchPrices(env, ids) {
  const res = await fetch(`${JUP}/price/v3?ids=${ids.join(',')}`, { headers: jupHeaders(env), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw Object.assign(new Error('price_status'), { status: res.status });
  const data = await res.json();
  const out = {};
  if (data && typeof data === 'object') {
    for (const id of ids) {
      const p = data[id];
      if (p && Number.isFinite(p.usdPrice) && p.usdPrice > 0) {
        out[id] = { usdPrice: p.usdPrice, change24h: Number.isFinite(p.priceChange24h) ? p.priceChange24h : null };
      }
    }
  }
  return out;
}

/** { mint, symbol, name, decimals } or null when Jupiter doesn't know the token. */
export async function fetchTokenInfo(env, mint) {
  const res = await fetch(`${JUP}/tokens/v2/search?query=${mint}`, { headers: jupHeaders(env), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw Object.assign(new Error('token_status'), { status: res.status });
  const data = await res.json();
  const hit = Array.isArray(data) ? data.find(t => t && t.id === mint) : null;
  if (!hit) return null;
  const clean = (v, n) => (typeof v === 'string' ? v.replace(/[^\x20-\x7E]/g, '').slice(0, n) : '');
  return { mint, symbol: clean(hit.symbol, 16) || '???', name: clean(hit.name, 48), decimals: Number.isInteger(hit.decimals) ? hit.decimals : null };
}
