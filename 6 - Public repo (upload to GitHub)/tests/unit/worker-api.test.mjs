import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker, MAX_BODY_BYTES } from '../../worker/src/app.js';
import { TokenBucketLimiter } from '../../worker/src/ratelimit.js';
import { DailyQuota } from '../../worker/src/quota.js';
import { ADDR, swap, tx } from './helpers.mjs';

const ORIGIN = 'https://atlas.pages.dev';
const KEY = 'SECRET-helius-key-1234567890';
const baseEnv = () => ({ ALLOWED_ORIGINS: ORIGIN, HELIUS_API_KEY: KEY, CACHE_TTL_SECONDS: '0' });

let realFetch, calls, logs, realLog, providerResponse;
beforeEach(() => {
  realFetch = globalThis.fetch; realLog = console.log;
  calls = []; logs = [];
  providerResponse = () => new Response(JSON.stringify([swap(), tx()]), { status: 200, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return providerResponse(url, init); };
  console.log = (...a) => logs.push(a.join(' '));
  delete globalThis.caches;
});
afterEach(() => { globalThis.fetch = realFetch; console.log = realLog; delete globalThis.caches; });

const worker = (opts) => createWorker({ bucket: new TokenBucketLimiter({ capacity: 1000 }), ...opts });
function post(body, { origin = ORIGIN, ct = 'application/json', headers = {} } = {}) {
  const h = { ...headers };
  if (origin) h.Origin = origin;
  if (ct) h['Content-Type'] = ct;
  return new Request('https://api.example/api/analyze', { method: 'POST', headers: h, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
const call = async (w, req, env = baseEnv()) => { const res = await w.fetch(req, env, { waitUntil() {} }); return { res, data: await res.json().catch(() => null) }; };

test('happy path returns a partial live report with CORS for the allowed origin', async () => {
  const { res, data } = await call(worker(), post({ address: ADDR.wallet }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(data.mode, 'live');
  assert.equal(data.coverage.partial, true);
  assert.equal(calls.length, 1);
  const u = new URL(calls[0]);
  assert.equal(u.searchParams.get('limit'), '100');
  assert.equal(u.pathname, `/v0/addresses/${ADDR.wallet}/transactions`);
});

test('secrets and addresses never appear in responses or logs', async () => {
  const { data } = await call(worker(), post({ address: ADDR.wallet }));
  const out = JSON.stringify(data) + logs.join('\n');
  assert.ok(!out.includes(KEY));
  assert.ok(!logs.join('\n').includes(ADDR.wallet));
  assert.ok(!JSON.stringify(data).includes(ADDR.wallet));
  providerResponse = () => new Response('err', { status: 500 });
  const { data: e } = await call(worker(), post({ address: ADDR.wallet }));
  assert.ok(!JSON.stringify(e).includes(KEY) && !logs.join('\n').includes(KEY));
});

test('preflight: allowed origin 204, others 403 without CORS headers', async () => {
  const w = worker();
  const ok = await w.fetch(new Request('https://api.example/api/analyze', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), baseEnv());
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  for (const o of ['https://evil.example', 'null', '']) {
    const bad = await w.fetch(new Request('https://api.example/api/analyze', { method: 'OPTIONS', headers: o ? { Origin: o } : {} }), baseEnv());
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  }
});

test('routing: health, 404, 405', async () => {
  const w = worker();
  assert.equal((await w.fetch(new Request('https://api.example/health'), baseEnv())).status, 200);
  assert.equal((await w.fetch(new Request('https://api.example/health', { method: 'POST' }), baseEnv())).status, 405);
  assert.equal((await w.fetch(new Request('https://api.example/nope'), baseEnv())).status, 404);
  const r = await w.fetch(new Request('https://api.example/api/analyze'), baseEnv());
  assert.equal(r.status, 405);
  assert.equal(r.headers.get('allow'), 'POST, OPTIONS');
});

test('origin enforcement: wrong/missing origin 403; unset or placeholder allowlist fails closed 503', async () => {
  const w = worker();
  assert.equal((await call(w, post({ address: ADDR.wallet }, { origin: 'https://evil.example' }))).res.status, 403);
  assert.equal((await call(w, post({ address: ADDR.wallet }, { origin: null }))).res.status, 403);
  for (const ALLOWED_ORIGINS of ['', 'https://YOUR-SITE.pages.dev', undefined]) {
    const { res } = await call(w, post({ address: ADDR.wallet }, { origin: '' }), { ...baseEnv(), ALLOWED_ORIGINS });
    assert.equal(res.status, 503, String(ALLOWED_ORIGINS));
  }
  // Legacy single ALLOWED_ORIGIN still honored.
  const legacy = { HELIUS_API_KEY: KEY, ALLOWED_ORIGIN: ORIGIN + '/', CACHE_TTL_SECONDS: '0' };
  assert.equal((await call(w, post({ address: ADDR.wallet }), legacy)).res.status, 200);
  assert.equal(calls.length, 1);
});

test('content-type, size, JSON and field validation', async () => {
  const w = worker();
  assert.equal((await call(w, post({ address: ADDR.wallet }, { ct: 'text/plain' }))).res.status, 415);
  assert.equal((await call(w, post({ address: ADDR.wallet }, { ct: null }))).res.status, 415);
  assert.equal((await call(w, post('x'.repeat(MAX_BODY_BYTES + 1)))).res.status, 413);
  assert.equal((await call(w, post('{not json'))).res.status, 400);
  assert.equal((await call(w, post('[]'))).res.status, 400);
  assert.equal((await call(w, post({ address: ADDR.wallet, admin: true }))).res.status, 400);
  assert.equal((await call(w, post({ address: 'bad' }))).res.status, 400);
  assert.equal((await call(w, post({ address: 123 }))).res.status, 400);
  assert.equal(calls.length, 0, 'provider never called for invalid input');
});

test('not configured: missing HELIUS_API_KEY → 503, provider not called', async () => {
  const { res, data } = await call(worker(), post({ address: ADDR.wallet }), { ALLOWED_ORIGINS: ORIGIN });
  assert.equal(res.status, 503);
  assert.match(data.error, /not configured/);
  assert.equal(calls.length, 0);
});

test('rate limiting: in-isolate bucket → 429 with Retry-After; binding denial → 429', async () => {
  const w = createWorker({ bucket: new TokenBucketLimiter({ capacity: 2, refillPerSec: 2 / 60 }) });
  const req = () => post({ address: ADDR.wallet }, { headers: { 'CF-Connecting-IP': '198.51.100.7' } });
  assert.equal((await call(w, req())).res.status, 200);
  assert.equal((await call(w, req())).res.status, 200);
  const { res } = await call(w, req());
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) >= 1);
  const other = await call(w, post({ address: ADDR.wallet }, { headers: { 'CF-Connecting-IP': '198.51.100.8' } }));
  assert.equal(other.res.status, 200);

  const denied = await call(worker(), post({ address: ADDR.wallet }), { ...baseEnv(), RATE_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal(denied.res.status, 429);
});

test('turnstile: required when secret set; failure 403, success proceeds', async () => {
  const env = { ...baseEnv(), TURNSTILE_SECRET_KEY: 'ts-secret' };
  let verifyOk = false;
  providerResponse = (url) => String(url).includes('siteverify')
    ? new Response(JSON.stringify({ success: verifyOk }), { headers: { 'content-type': 'application/json' } })
    : new Response(JSON.stringify([swap()]), { headers: { 'content-type': 'application/json' } });
  assert.equal((await call(worker(), post({ address: ADDR.wallet }), env)).res.status, 403);
  assert.equal((await call(worker(), post({ address: ADDR.wallet, turnstileToken: 'tok-1234567890' }), env)).res.status, 403);
  verifyOk = true;
  assert.equal((await call(worker(), post({ address: ADDR.wallet, turnstileToken: 'tok-1234567890' }), env)).res.status, 200);
});

test('provider error mapping', async () => {
  const cases = [
    [() => new Response('x', { status: 429 }), 503],
    [() => new Response('x', { status: 401 }), 503],
    [() => new Response('x', { status: 500 }), 502],
    [() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }), 502],
    [() => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } }), 502],
    [() => new Response('{bad', { status: 200, headers: { 'content-type': 'application/json' } }), 502],
    [() => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, 504],
    [() => { throw new TypeError('network'); }, 504],
  ];
  for (const [resp, status] of cases) {
    providerResponse = resp;
    const { res, data } = await call(worker(), post({ address: ADDR.wallet }));
    assert.equal(res.status, status);
    assert.equal(typeof data.error, 'string');
  }
});

test('empty provider page is a valid, honest report', async () => {
  providerResponse = () => new Response('[]', { headers: { 'content-type': 'application/json' } });
  const { res, data } = await call(worker(), post({ address: ADDR.wallet }));
  assert.equal(res.status, 200);
  assert.equal(data.archetype, 'mystery-wallet');
  assert.match(data.insight, /not evidence of an inactive wallet/);
});

test('edge cache: second lookup is served from cache without a provider call', async () => {
  const store = new Map();
  globalThis.caches = { default: { match: async k => { const v = store.get(k.url); return v ? new Response(v) : undefined; }, put: async (k, r) => { store.set(k.url, await r.text()); } } };
  const env = { ...baseEnv(), CACHE_TTL_SECONDS: '300' };
  const a = await call(worker(), post({ address: ADDR.wallet }), env);
  const b = await call(worker(), post({ address: ADDR.wallet }), env);
  assert.equal(a.res.headers.get('x-atlas-cache'), 'MISS');
  assert.equal(b.res.headers.get('x-atlas-cache'), 'HIT');
  assert.equal(calls.length, 1);
  assert.deepEqual(a.data, b.data);
  assert.ok([...store.keys()].every(k => !k.includes(ADDR.wallet)), 'cache key is hashed');
});

test('global daily quota (Durable Object) blocks provider calls once exhausted', async () => {
  const mem = new Map();
  const dobj = new DailyQuota({ storage: { get: async k => mem.get(k), put: async (k, v) => { mem.set(k, v); } } });
  const env = { ...baseEnv(), DAILY_PROVIDER_CALL_LIMIT: '2', GLOBAL_QUOTA: { idFromName: n => n, get: () => ({ fetch: (u, init) => dobj.fetch(new Request(u, init)) }) } };
  assert.equal((await call(worker(), post({ address: ADDR.wallet }), env)).res.status, 200);
  assert.equal((await call(worker(), post({ address: ADDR.wallet }), env)).res.status, 200);
  const third = await call(worker(), post({ address: ADDR.wallet }), env);
  assert.equal(third.res.status, 503);
  assert.match(third.data.error, /capacity/);
  assert.equal(calls.length, 2);
  // Quota failure fails closed.
  const broken = { ...baseEnv(), GLOBAL_QUOTA: { idFromName: n => n, get: () => ({ fetch: async () => { throw new Error('down'); } }) } };
  assert.equal((await call(worker(), post({ address: ADDR.wallet }), broken)).res.status, 503);
});

test('DailyQuota resets on a new UTC day', async () => {
  const mem = new Map([['quota', { day: '2000-01-01', count: 999 }]]);
  const d = new DailyQuota({ storage: { get: async k => mem.get(k), put: async (k, v) => { mem.set(k, v); } } });
  const r = await (await d.fetch(new Request('https://q/', { method: 'POST', body: '{"limit":5}' }))).json();
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
});

test('entry module exports only what workerd accepts (default handler + Durable Object class)', async () => {
  const mod = await import('../../worker/src/index.js');
  assert.deepEqual(Object.keys(mod).sort(), ['DailyQuota', 'default']);
  assert.equal(typeof mod.default.fetch, 'function');
  assert.equal(typeof mod.DailyQuota, 'function');
});

test('deep mode paginates, returns a ledger, and costs more rate-limit tokens', async () => {
  let page = 0;
  providerResponse = (url) => {
    const u = new URL(String(url));
    page += 1;
    const body = page === 1 ? [swap({ signature: 'p1a' }), tx({ signature: 'p1b' })] : page === 2 ? [tx({ signature: 'p2a' })] : [];
    if (page > 1) assert.ok(u.searchParams.get('before-signature'), 'cursor sent on later pages');
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  const { res, data } = await call(worker(), post({ address: ADDR.wallet, depth: 'deep' }));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(data.deep.coverage.complete, true);
  assert.equal(data.deep.coverage.transactions, 3);
  assert.ok(data.deep.profile && Array.isArray(data.deep.closed));
  assert.ok(!JSON.stringify(data).includes(ADDR.wallet));
  // quick mode is still one call and has no deep block
  calls = []; page = 0;
  const q = await call(worker(), post({ address: ADDR.wallet }));
  assert.equal(calls.length, 1); assert.equal(q.data.deep, undefined);
  assert.equal((await call(worker(), post({ address: ADDR.wallet, depth: 'everything' }))).res.status, 400);
  // capacity 6: one deep (4) + quick (1) + quick (1) fits, next deep does not
  const w = createWorker({ bucket: new TokenBucketLimiter({ capacity: 6, refillPerSec: 0.0001 }) });
  const h = { headers: { 'CF-Connecting-IP': '203.0.113.50' } };
  providerResponse = () => new Response('[]', { headers: { 'content-type': 'application/json' } });
  assert.equal((await call(w, post({ address: ADDR.wallet, depth: 'deep' }, h))).res.status, 200);
  assert.equal((await call(w, post({ address: ADDR.wallet }, h))).res.status, 200);
  assert.equal((await call(w, post({ address: ADDR.wallet }, h))).res.status, 200);
  assert.equal((await call(w, post({ address: ADDR.wallet, depth: 'deep' }, h))).res.status, 429);
});

const getReq = (path, origin = ORIGIN) => new Request('https://api.example' + path, { headers: origin ? { Origin: origin } : {} });

test('price + token endpoints: validation, origin, shape, upstream errors', async () => {
  const MINT = 'So11111111111111111111111111111111111111112';
  providerResponse = (url) => {
    const u = String(url);
    if (u.includes('/price/v3')) return new Response(JSON.stringify({ [MINT]: { usdPrice: 150.5, priceChange24h: 1.2, decimals: 9 }, junk: { usdPrice: 'x' } }), { headers: { 'content-type': 'application/json' } });
    if (u.includes('/tokens/v2/search')) return new Response(JSON.stringify([{ id: MINT, symbol: 'SOL<script>', name: 'Wrapped SOL', decimals: 9 }]), { headers: { 'content-type': 'application/json' } });
    return new Response('nope', { status: 404 });
  };
  const w = worker();
  const p = await call(w, getReq(`/api/price?ids=${MINT}`));
  assert.equal(p.res.status, 200);
  assert.deepEqual(p.data.prices[MINT], { usdPrice: 150.5, change24h: 1.2 });
  assert.equal(p.res.headers.get('access-control-allow-origin'), ORIGIN);
  const t = await call(w, getReq(`/api/token?mint=${MINT}`));
  assert.equal(t.data.token.symbol, 'SOL<script>'.replace(/[^\x20-\x7E]/g, ''), 'printable ASCII only; escaping happens at render');
  assert.equal((await call(w, getReq('/api/price?ids=nope'))).res.status, 400);
  assert.equal((await call(w, getReq('/api/price?ids=' + Array(21).fill(MINT).join(',')))).res.status, 400);
  assert.equal((await call(w, getReq(`/api/price?ids=${MINT}`, 'https://evil.example'))).res.status, 403);
  assert.equal((await w.fetch(new Request(`https://api.example/api/price?ids=${MINT}`, { method: 'POST', headers: { Origin: ORIGIN } }), baseEnv())).status, 405);
  providerResponse = () => new Response('slow down', { status: 429 });
  assert.equal((await call(w, getReq(`/api/price?ids=${MINT}`))).res.status, 503);
  providerResponse = () => { throw new TypeError('down'); };
  assert.equal((await call(w, getReq(`/api/price?ids=${MINT}`))).res.status, 502, 'network failure upstream → 502, never a crash');
});

test('price endpoint has its own rate limit', async () => {
  const w = createWorker({ priceBucket: new TokenBucketLimiter({ capacity: 2, refillPerSec: 0.0001 }) });
  providerResponse = () => new Response('{}', { headers: { 'content-type': 'application/json' } });
  const M = 'So11111111111111111111111111111111111111112';
  assert.equal((await call(w, getReq(`/api/price?ids=${M}`))).res.status, 200);
  assert.equal((await call(w, getReq(`/api/price?ids=${M}`))).res.status, 200);
  assert.equal((await call(w, getReq(`/api/price?ids=${M}`))).res.status, 429);
});
