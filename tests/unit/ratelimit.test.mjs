import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucketLimiter, checkRateLimit } from '../../worker/src/ratelimit.js';
import { clientKey, parseOrigins, readBodyCapped, isJsonContentType } from '../../worker/src/security.js';

test('token bucket: capacity, refill, retry-after, per-key isolation', () => {
  let t = 0;
  const b = new TokenBucketLimiter({ capacity: 3, refillPerSec: 1, now: () => t });
  assert.ok(b.take('a').ok); assert.ok(b.take('a').ok); assert.ok(b.take('a').ok);
  const denied = b.take('a');
  assert.equal(denied.ok, false);
  assert.equal(denied.retryAfterSec, 1);
  assert.ok(b.take('b').ok, 'other keys unaffected');
  t = 1000; assert.ok(b.take('a').ok, 'refilled after 1s');
  t = 1_000_000; for (let i = 0; i < 3; i++) assert.ok(b.take('a').ok);
  assert.equal(b.take('a').ok, false, 'never exceeds capacity after long idle');
});

test('token bucket bounds memory', () => {
  const b = new TokenBucketLimiter({ maxKeys: 10 });
  for (let i = 0; i < 100; i++) b.take('k' + i);
  assert.equal(b.buckets.size, 10);
});

test('checkRateLimit consults the platform binding and fails closed on errors', async () => {
  const bucket = new TokenBucketLimiter({ capacity: 100 });
  assert.deepEqual(await checkRateLimit({}, 'k', bucket), { ok: true });
  assert.equal((await checkRateLimit({ RATE_LIMITER: { limit: async () => ({ success: false }) } }, 'k', bucket)).ok, false);
  assert.equal((await checkRateLimit({ RATE_LIMITER: { limit: async () => { throw new Error('x'); } } }, 'k', bucket)).ok, false);
  let seenKey;
  await checkRateLimit({ RATE_LIMITER: { limit: async o => { seenKey = o.key; return { success: true }; } } }, 'ip4:1.2.3.4', bucket);
  assert.equal(seenKey, 'ip4:1.2.3.4');
});

test('clientKey groups IPv6 by /64 and handles missing IPs', () => {
  const k = ip => clientKey(new Request('https://x/', { headers: ip ? { 'CF-Connecting-IP': ip } : {} }));
  assert.equal(k('203.0.113.9'), 'ip4:203.0.113.9');
  assert.equal(k('2001:db8:abcd:12::1'), k('2001:0db8:abcd:0012:ffff:ffff:ffff:ffff'));
  assert.notEqual(k('2001:db8:abcd:12::1'), k('2001:db8:abcd:13::1'));
  assert.equal(k('::1'), 'ip6:0:0:0:0');
  assert.equal(k(''), 'ip:unknown');
});

test('parseOrigins: exact origins only, placeholders ignored, lowercased', () => {
  assert.deepEqual(parseOrigins('https://A.pages.dev/, http://localhost:8080 ,javascript:alert(1),https://x.com/path,null,*'), ['https://a.pages.dev', 'http://localhost:8080']);
  assert.deepEqual(parseOrigins('https://YOUR-SITE.pages.dev'), []);
  assert.deepEqual(parseOrigins(undefined), []);
});

test('isJsonContentType is strict', () => {
  assert.ok(isJsonContentType('application/json'));
  assert.ok(isJsonContentType('application/json; charset=utf-8'));
  for (const c of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/jsonp', '', null]) assert.equal(isJsonContentType(c), false, String(c));
});

test('readBodyCapped enforces limit with and without Content-Length (chunked)', async () => {
  const ok = await readBodyCapped(new Request('https://x/', { method: 'POST', body: '{"a":1}' }), 100);
  assert.deepEqual(ok, { ok: true, text: '{"a":1}' });
  const declared = await readBodyCapped(new Request('https://x/', { method: 'POST', body: 'x', headers: { 'content-length': '5000' } }), 100);
  assert.equal(declared.ok, false);
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(50)); c.close(); } });
  const chunked = await readBodyCapped(new Request('https://x/', { method: 'POST', body: stream, duplex: 'half' }), 100);
  assert.deepEqual(chunked, { ok: false, reason: 'too_large' });
  const badUtf8 = await readBodyCapped(new Request('https://x/', { method: 'POST', body: new Uint8Array([0xff, 0xfe]) }), 100);
  assert.deepEqual(badUtf8, { ok: false, reason: 'bad_encoding' });
});
