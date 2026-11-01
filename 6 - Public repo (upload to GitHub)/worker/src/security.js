// Request hygiene: origin allowlist, CORS, size-capped body reads, headers.

export const BASE_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'cross-origin',
});

/** Parses a comma-separated allowlist. Only exact scheme://host[:port] entries survive. */
export function parseOrigins(value) {
  return String(value || '')
    .split(',')
    .map(s => s.trim().replace(/\/+$/, '').toLowerCase())
    .filter(s => /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(s))
    // Treat the shipped placeholder as "not configured" (someone could register that subdomain).
    .filter(s => !s.includes('your-'));
}

/** CORS headers are only emitted for an allowlisted origin. Never echo arbitrary or "null" origins. */
export function corsHeaders(origin, allowed) {
  const h = { Vary: 'Origin' };
  if (origin && allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}

export function json(value, status, extra = {}) {
  return new Response(JSON.stringify(value), { status, headers: { ...BASE_HEADERS, ...extra } });
}

export function isJsonContentType(value) {
  return /^application\/json\s*(;\s*charset=utf-8\s*)?$/i.test(String(value || '').trim());
}

/**
 * Reads at most maxBytes from the body. Does not trust Content-Length alone
 * (chunked requests omit it), so it also counts bytes while streaming.
 */
export async function readBodyCapped(request, maxBytes) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    return { ok: false, reason: 'too_large' };
  }
  if (!request.body) return { ok: true, text: '' };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return { ok: false, reason: 'too_large' };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
  } catch {
    return { ok: false, reason: 'bad_encoding' };
  }
}

/** Rate-limit key: full IPv4, or the /64 prefix for IPv6 (one host usually owns a whole /64). */
export function clientKey(request) {
  const ip = (request.headers.get('CF-Connecting-IP') || '').trim();
  if (!ip) return 'ip:unknown';
  if (ip.includes(':')) {
    const [head, tail] = ip.toLowerCase().split('::');
    const h = head ? head.split(':') : [];
    let parts = h;
    if (tail !== undefined) {
      const t = tail ? tail.split(':') : [];
      parts = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
    }
    return 'ip6:' + parts.slice(0, 4).map(p => p.replace(/^0+(?=.)/, '')).join(':');
  }
  return 'ip4:' + ip;
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
