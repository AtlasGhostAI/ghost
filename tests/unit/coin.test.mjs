import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCoin } from '../../worker/src/coin.js';
import { createWorker } from '../../worker/src/app.js';
import { TokenBucketLimiter } from '../../worker/src/ratelimit.js';

const MINT = 'So11111111111111111111111111111111111111112';
const NOW = Date.UTC(2026, 10, 3, 19, 0, 0);
const pair = (o = {}) => ({
  chainId: 'solana', dexId: 'pumpswap', pairAddress: 'P1', baseToken: { address: MINT, symbol: 'GHST', name: 'Ghost' },
  priceUsd: '0.001', marketCap: 1_000_000, liquidity: { usd: 120_000 }, volume: { h24: 900_000 },
  txns: { h24: { buys: 4000, sells: 3500 } }, priceChange: { h1: 2, h6: 10, h24: 40 },
  pairCreatedAt: NOW - 20 * 3600000, info: { websites: [{ url: 'https://x.example' }], socials: [{ type: 'twitter', url: 'https://x.com/g' }] }, ...o,
});
const mintInfo = (mintAuth = null, freeze = null, supply = '1000000000000000') => ({ value: { data: { parsed: { type: 'mint', info: { mintAuthority: mintAuth, freezeAuthority: freeze, supply, decimals: 6 } } } } });
const largest = (amts) => ({ value: amts.map(a => ({ amount: String(a) })) });

test('healthy coin: no reds, authorities off, holder spread uses accounts after the pool', () => {
  const r = analyzeCoin({ pairs: [pair()], mintInfo: mintInfo(), largest: largest([300e12, 20e12, 10e12, ...Array(8).fill(5e12)]) }, MINT, NOW);
  assert.equal(r.counts.red, 0);
  assert.equal(r.verdict, 'no-major-flags');
  assert.deepEqual(r.authorities, { mint: 'off', freeze: 'off' });
  assert.equal(r.holders.top1Pct, 30);
  assert.equal(r.holders.top10ExTop1Pct, 7);
  assert.equal(r.market.stage, 'graduated');
  assert.equal(r.links.website, 'https://x.example');
  assert.match(r.note, /Not a safety rating/);
});

test('dump + thin liquidity + authorities on + concentrated + wash volume → high-risk with factual text', () => {
  const r = analyzeCoin({
    pairs: [pair({ liquidity: { usd: 2000 }, marketCap: 1800, volume: { h24: 600_000 }, priceChange: { h1: -90, h6: -96, h24: -95 }, info: {} })],
    mintInfo: mintInfo('Auth', 'Freeze'), largest: largest([100e12, ...Array(10).fill(60e12)]),
  }, MINT, NOW);
  const t = r.flags.map(f => f.level + ':' + f.text).join('\n');
  assert.equal(r.verdict, 'high-risk');
  assert.match(t, /red:Mint authority is ON/);
  assert.match(t, /red:Freeze authority is ON/);
  assert.match(t, /red:Liquidity is only \$2,000/);
  assert.match(t, /red:Down 96% in the last 6 hours/);
  assert.match(t, /warn:24h volume is 300× its liquidity/);
  assert.match(t, /red:The next 10 biggest holders .* own 60%/);
  assert.match(t, /warn:No website or socials/);
  assert.ok(!/safe/i.test(t), 'never calls a coin safe');
});

test('bonding-curve coins skip the liquidity check; brand-new and missing pairs are flagged', () => {
  const r = analyzeCoin({ pairs: [pair({ dexId: 'pumpfun', liquidity: { usd: 500 }, pairCreatedAt: NOW - 20 * 60000 })], mintInfo: null, largest: null }, MINT, NOW);
  assert.equal(r.market.stage, 'bonding curve');
  assert.ok(!r.flags.some(f => /Liquidity/.test(f.text)));
  assert.ok(r.flags.some(f => /Less than 1 hour old/.test(f.text)));
  assert.equal(r.authorities, null);
  const none = analyzeCoin({ pairs: [], mintInfo: mintInfo(), largest: null }, MINT, NOW);
  assert.ok(none.flags.some(f => /No trading pairs found/.test(f.text)));
  assert.equal(none.market, null);
});

test('ignores pairs for other tokens and sanitizes strings', () => {
  const r = analyzeCoin({ pairs: [pair({ baseToken: { address: 'other', symbol: 'X', name: 'X' } }), pair({ baseToken: { address: MINT, symbol: 'G\u0007<b>', name: 'n' } })] }, MINT, NOW);
  assert.equal(r.market.pairs, 1);
  assert.equal(r.token.symbol, 'G<b>');
});

// --- route tests
const ORIGIN = 'https://atlasghost.xyz';
let realFetch, calls;
beforeEach(() => {
  realFetch = globalThis.fetch; calls = []; delete globalThis.caches;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('dexscreener')) return new Response(JSON.stringify({ pairs: [pair()] }), { status: 200 });
    const body = JSON.parse(init.body);
    const result = body.method === 'getAccountInfo' ? mintInfo() : body.method === 'getTokenLargestAccounts' ? largest([300e12, 20e12])
      : body.method === 'getBalance' ? { value: 2_500_000_000 } : { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: 42_000_000 } } } } } }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });
const env = { ALLOWED_ORIGINS: ORIGIN, HELIUS_API_KEY: 'KEY-abcdef', CACHE_TTL_SECONDS: '0' };
const get = (path, origin = ORIGIN) => new Request('https://api.example' + path, { headers: { Origin: origin } });

test('/api/coin: validates, enforces origin, returns report without leaking the key', async () => {
  const w = createWorker({ coinBucket: new TokenBucketLimiter({ capacity: 100 }), now: () => NOW });
  assert.equal((await w.fetch(get('/api/coin?mint=nope'), env, {})).status, 400);
  assert.equal((await w.fetch(get('/api/coin?mint=' + MINT, 'https://evil.example'), env, {})).status, 403);
  const res = await w.fetch(get('/api/coin?mint=' + MINT), env, {});
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes('KEY-abcdef'));
  const d = JSON.parse(text);
  assert.equal(d.token.symbol, 'GHST');
  assert.ok(calls.some(u => u.includes('/latest/dex/tokens/' + MINT)));
});

test('/api/coin rate limit and /api/wallet balances', async () => {
  const w = createWorker({ coinBucket: new TokenBucketLimiter({ capacity: 1, refillPerSec: 0 }), now: () => NOW });
  assert.equal((await w.fetch(get('/api/coin?mint=' + MINT), env, {})).status, 200);
  assert.equal((await w.fetch(get('/api/coin?mint=' + MINT), env, {})).status, 429);
  const w2 = createWorker({ coinBucket: new TokenBucketLimiter({ capacity: 100 }) });
  const r = await w2.fetch(get(`/api/wallet?address=${MINT}&mint=${MINT}`), env, {});
  assert.deepEqual(await r.json(), { address: MINT, sol: 2.5, token: 42_000_000, mint: MINT });
  assert.equal((await w2.fetch(get('/api/wallet?address=bad'), env, {})).status, 400);
});
