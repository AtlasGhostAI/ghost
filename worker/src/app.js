/**
 * GHOST — Worker request handler (imported by index.js and the tests).
 *
 * POST /api/analyze  {address, depth?: 'quick'|'deep', turnstileToken?}
 *                    quick → partial activity report (one page)
 *                    deep  → report + deep memory (paginated ledger, profile)
 * GET  /api/price?ids=mint1,mint2   → live USD prices (Paper Lab)
 * GET  /api/token?mint=…            → token symbol/name (Paper Lab)
 * GET  /api/coin?mint=…             → GHOST coin check (factual risk flags)
 * GET  /api/wallet?address=…&mint=… → SOL + token balance (transparency page)
 * GET  /health                      → {ok:true}
 *
 * The Helius key lives only in the HELIUS_API_KEY secret. It is never
 * returned, logged, or sent to the browser. Logs never include wallet
 * addresses, IPs, or provider URLs.
 */
import { isValidSolanaAddress } from './address.js';
import { buildReport, utcDay } from './report.js';
import { buildLedger, buildProfile } from './ledger.js';
import { fetchPage, fetchHistory, ProviderError } from './history.js';
import { parseIds, fetchPrices, fetchTokenInfo } from './prices.js';
import { BASE_HEADERS, parseOrigins, corsHeaders, json, isJsonContentType, readBodyCapped, clientKey, sha256Hex } from './security.js';
import { TokenBucketLimiter, checkRateLimit } from './ratelimit.js';
import { consumeDailyQuota } from './quota.js';
import { verifyTurnstile } from './turnstile.js';
import { fetchCoinRaw, analyzeCoin, fetchWalletBalances } from './coin.js';

export const MAX_BODY_BYTES = 1024;
const DEFAULT_HELIUS_HOST = 'api-mainnet.helius-rpc.com';
const ALLOWED_KEYS = new Set(['address', 'turnstileToken', 'depth']);
const MAX_CLOSED_RETURNED = 300;

function log(env, evt, fields = {}) {
  if (env.LOG_LEVEL === 'off') return;
  // Deliberately minimal: no address, no IP, no URL, no key.
  console.log(JSON.stringify({ evt, ...fields }));
}

function providerErrorResponse(env, e, ch, started, now) {
  if (e.kind === 'timeout' || e.kind === 'network') {
    log(env, 'provider_error', { kind: e.kind, ms: now() - started });
    return json({ error: 'The blockchain data provider could not be reached or did not respond in time. Please retry or use the sample roast.' }, 504, ch);
  }
  if (e.kind === 'status') {
    log(env, 'provider_status', { status: e.status, ms: now() - started });
    if (e.status === 429) return json({ error: 'GHOST is busy right now. Please try again in a minute.' }, 503, { ...ch, 'Retry-After': '60' });
    if (e.status === 401 || e.status === 403) return json({ error: 'Live analysis is temporarily unavailable.' }, 503, ch);
    return json({ error: 'Blockchain data provider is unavailable. Please try again later.' }, 502, ch);
  }
  log(env, 'provider_bad_format');
  return json({ error: 'Unexpected blockchain data format' }, 502, ch);
}

export function buildDeep(history, address, nowSec) {
  const ledger = buildLedger(history.txs, address, nowSec);
  const times = history.txs.map(t => t && t.timestamp).filter(t => Number.isInteger(t) && t > 0 && t <= nowSec + 300);
  const closed = ledger.closed.slice(-MAX_CLOSED_RETURNED);
  return {
    coverage: {
      pages: history.pages,
      transactions: history.txs.length,
      complete: history.complete,
      partial: !history.complete,
      stoppedBy: history.stoppedBy,
      windowStartUtc: times.length ? utcDay(Math.min(...times)) : null,
      windowEndUtc: times.length ? utcDay(Math.max(...times)) : null,
      closedTruncated: ledger.closed.length > closed.length,
    },
    skipped: { ...ledger.skipped, excludedSells: ledger.excludedSells, partialSells: ledger.partialSells },
    profile: buildProfile(ledger),
    tradeTimes: ledger.trades.map(t => t.ts),
    closed,
    open: ledger.open.slice(0, 50),
    method: 'Positions are average-cost, per token and quote asset (SOL/USDC/USDT), from the wallet’s own balance changes. Sells with no buy inside the window have unknown cost and are excluded. Account rent is included in SOL amounts.',
  };
}

export function createWorker({
  bucket = new TokenBucketLimiter({ capacity: 10, refillPerSec: 10 / 60 }),
  priceBucket = new TokenBucketLimiter({ capacity: 40, refillPerSec: 40 / 60 }),
  coinBucket = new TokenBucketLimiter({ capacity: 12, refillPerSec: 12 / 60 }),
  now = () => Date.now(),
} = {}) {
  const edgeCache = ttl => (ttl > 0 && globalThis.caches && globalThis.caches.default) || null;
  async function cacheGet(cache, key) { return cache ? cache.match(key) : null; }
  async function cachePut(cache, key, text, ttl, ctx) {
    if (!cache) return;
    const put = cache.put(key, new Response(text, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` } }));
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put); else await put;
  }

  async function analyze(request, env, ch, ctx) {
    if (!isJsonContentType(request.headers.get('content-type'))) {
      return json({ error: 'Content-Type must be application/json' }, 415, ch);
    }
    if (!env.HELIUS_API_KEY) return json({ error: 'Live analysis is not configured yet. Try the sample roast.' }, 503, ch);

    const body = await readBodyCapped(request, MAX_BODY_BYTES);
    if (!body.ok) return json({ error: body.reason === 'too_large' ? 'Request too large' : 'Invalid request body' }, body.reason === 'too_large' ? 413 : 400, ch);
    let payload;
    try { payload = JSON.parse(body.text); } catch { return json({ error: 'Invalid JSON body' }, 400, ch); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(k => !ALLOWED_KEYS.has(k))) {
      return json({ error: 'Unexpected request fields' }, 400, ch);
    }
    const address = typeof payload.address === 'string' ? payload.address.trim() : '';
    if (!isValidSolanaAddress(address)) return json({ error: 'Invalid public Solana wallet address' }, 400, ch);
    const depth = payload.depth === undefined ? 'quick' : payload.depth;
    if (depth !== 'quick' && depth !== 'deep') return json({ error: 'depth must be "quick" or "deep"' }, 400, ch);
    const maxPages = depth === 'deep' ? Math.max(2, Math.min(10, Number(env.DEEP_PAGES || 5) || 5)) : 1;

    const rl = await checkRateLimit(env, clientKey(request), { take: k => bucket.take(k, depth === 'deep' ? 4 : 1) });
    if (!rl.ok) {
      log(env, 'rate_limited');
      return json({ error: 'Too many requests. Please wait a minute and try again.' }, 429, { ...ch, 'Retry-After': String(rl.retryAfterSec) });
    }

    const ts = await verifyTurnstile(env, payload.turnstileToken, request.headers.get('CF-Connecting-IP'));
    if (!ts.ok) return json({ error: 'Human verification failed. Please retry the check and submit again.' }, 403, ch);

    // Short-lived edge cache keyed by a hash of the address: repeated lookups do not spend provider credits.
    const ttl = Math.max(0, Math.min(3600, Number(env.CACHE_TTL_SECONDS ?? 300) || 0));
    const cache = edgeCache(ttl);
    const cacheKey = cache ? new Request(`https://cache.atlas-ghost.internal/v3/${depth}/${await sha256Hex(address)}`) : null;
    const hit = await cacheGet(cache, cacheKey);
    if (hit) {
      log(env, 'cache_hit', { depth });
      return new Response(hit.body, { status: 200, headers: { ...BASE_HEADERS, ...ch, 'X-Atlas-Cache': 'HIT' } });
    }

    const quota = await consumeDailyQuota(env, maxPages);
    if (!quota.ok) {
      log(env, 'daily_quota_exhausted');
      return json({ error: 'GHOST has reached today’s free analysis capacity. Try the sample roast or come back tomorrow.' }, 503, { ...ch, 'Retry-After': '3600' });
    }

    const host = /^[a-z0-9.-]+$/i.test(env.HELIUS_API_HOST || '') ? env.HELIUS_API_HOST : DEFAULT_HELIUS_HOST;
    const started = now();
    let history;
    try {
      history = depth === 'deep'
        ? await fetchHistory({ host, apiKey: env.HELIUS_API_KEY, address, maxPages })
        : await fetchPage({ host, apiKey: env.HELIUS_API_KEY, address }).then(txs => ({ txs, pages: 1, complete: false, stoppedBy: 'budget' }));
    } catch (e) {
      if (e instanceof ProviderError) return providerErrorResponse(env, e, ch, started, now);
      throw e;
    }

    const nowSec = Math.floor(now() / 1000);
    const report = buildReport(history.txs.slice(0, 100), address, nowSec);
    if (depth === 'deep') report.deep = buildDeep(history, address, nowSec);
    const bodyText = JSON.stringify(report);
    log(env, 'analyzed', { depth, pages: history.pages, ms: now() - started, returned: history.txs.length });
    await cachePut(cache, cacheKey, bodyText, ttl, ctx);
    return new Response(bodyText, { status: 200, headers: { ...BASE_HEADERS, ...ch, 'X-Atlas-Cache': 'MISS' } });
  }

  async function market(request, env, ch, ctx, pathname, url) {
    const rl = priceBucket.take(clientKey(request));
    if (!rl.ok) return json({ error: 'Too many price requests. Slow down a little.' }, 429, { ...ch, 'Retry-After': String(rl.retryAfterSec) });
    const isPrice = pathname === '/api/price';
    let ids, mint;
    if (isPrice) {
      ids = parseIds(url.searchParams.get('ids'));
      if (!ids) return json({ error: 'ids must be 1–20 valid token mint addresses' }, 400, ch);
    } else {
      mint = (url.searchParams.get('mint') || '').trim();
      if (!isValidSolanaAddress(mint)) return json({ error: 'mint must be a valid token mint address' }, 400, ch);
    }
    const ttl = isPrice ? 20 : 3600;
    const cache = edgeCache(ttl);
    const key = cache ? new Request(`https://cache.atlas-ghost.internal/v3/${isPrice ? 'price/' + ids.join(',') : 'token/' + mint}`) : null;
    const hit = await cacheGet(cache, key);
    if (hit) return new Response(hit.body, { status: 200, headers: { ...BASE_HEADERS, ...ch, 'X-Atlas-Cache': 'HIT' } });
    let data;
    try {
      data = isPrice ? { prices: await fetchPrices(env, ids), at: new Date(now()).toISOString() } : { token: await fetchTokenInfo(env, mint) };
    } catch (e) {
      log(env, 'market_error', { status: e && e.status });
      return json({ error: e && e.status === 429 ? 'Price service is busy. Try again in a few seconds.' : 'Price service is unavailable right now.' }, e && e.status === 429 ? 503 : 502, ch);
    }
    const text = JSON.stringify(data);
    await cachePut(cache, key, text, ttl, ctx);
    return new Response(text, { status: 200, headers: { ...BASE_HEADERS, ...ch, 'X-Atlas-Cache': 'MISS' } });
  }

  async function coinRoutes(request, env, ch, ctx, pathname, url) {
    const rl = coinBucket.take(clientKey(request));
    if (!rl.ok) return json({ error: 'Too many checks. Wait a minute and try again.' }, 429, { ...ch, 'Retry-After': String(rl.retryAfterSec) });
    const isCoin = pathname === '/api/coin';
    const addr = (url.searchParams.get(isCoin ? 'mint' : 'address') || '').trim();
    if (!isValidSolanaAddress(addr)) return json({ error: isCoin ? 'Paste a valid token mint address (CA)' : 'Invalid wallet address' }, 400, ch);
    const mint = isCoin ? addr : (url.searchParams.get('mint') || '').trim();
    if (!isCoin && mint && !isValidSolanaAddress(mint)) return json({ error: 'Invalid token mint' }, 400, ch);
    if (!isCoin && !env.HELIUS_API_KEY) return json({ error: 'Not configured' }, 503, ch);
    const ttl = 60;
    const cache = edgeCache(ttl);
    const key = cache ? new Request(`https://cache.atlas-ghost.internal/v3/${isCoin ? 'coin/' + addr : 'wallet/' + addr + '/' + (mint || '-')}`) : null;
    const hit = await cacheGet(cache, key);
    if (hit) return new Response(hit.body, { status: 200, headers: { ...BASE_HEADERS, ...ch, 'X-Atlas-Cache': 'HIT' } });
    let data;
    try {
      data = isCoin ? analyzeCoin(await fetchCoinRaw(env, addr), addr, now()) : await fetchWalletBalances(env, addr, mint || null);
    } catch (e) {
      log(env, 'coin_error', { status: e && e.status });
      return json({ error: 'Chain data is unavailable right now. Try again in a minute.' }, 502, ch);
    }
    if (isCoin && !data.sources.market && !data.sources.chain) return json({ error: 'Couldn’t load data for that token right now. Try again in a minute.' }, 502, ch);
    const text = JSON.stringify(data);
    await cachePut(cache, key, text, ttl, ctx);
    return new Response(text, { status: 200, headers: { ...BASE_HEADERS, ...ch, 'X-Atlas-Cache': 'MISS' } });
  }

  return {
    async fetch(request, env, ctx) {
      const allowed = parseOrigins(env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN);
      const origin = request.headers.get('Origin') || '';
      const ch = corsHeaders(origin, allowed);
      const url = new URL(request.url);
      const { pathname } = url;
      const routes = { '/api/analyze': 'POST', '/api/price': 'GET', '/api/token': 'GET', '/api/coin': 'GET', '/api/wallet': 'GET' };

      if (request.method === 'OPTIONS') {
        if (!routes[pathname] || !allowed.includes(origin)) return new Response(null, { status: 403, headers: { Vary: 'Origin' } });
        return new Response(null, { status: 204, headers: ch });
      }
      if (pathname === '/health') {
        if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405, { ...ch, Allow: 'GET, HEAD' });
        return json({ ok: true, service: 'atlas-ghost-api' }, 200, ch);
      }
      if (!routes[pathname]) return json({ error: 'Not found' }, 404, ch);
      if (request.method !== routes[pathname]) return json({ error: 'Method not allowed' }, 405, { ...ch, Allow: `${routes[pathname]}, OPTIONS` });

      if (!allowed.length) {
        log(env, 'misconfigured_origins');
        return json({ error: 'Live analysis is not configured on this server.' }, 503, ch);
      }
      if (!allowed.includes(origin)) return json({ error: 'Origin not allowed' }, 403, ch);
      try {
        if (pathname === '/api/analyze') return await analyze(request, env, ch, ctx);
        if (pathname === '/api/coin' || pathname === '/api/wallet') return await coinRoutes(request, env, ch, ctx, pathname, url);
        return await market(request, env, ch, ctx, pathname, url);
      } catch (e) {
        log(env, 'unhandled', { name: e && e.name });
        return json({ error: 'Could not complete the request. Please retry or use the sample roast.' }, 500, ch);
      }
    },
  };
}
