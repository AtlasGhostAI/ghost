import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core } from './helpers.mjs';

const XSS = [
  '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', "'-alert(1)-'", '`${alert(1)}`',
  '<a href="javascript:alert(1)">x</a>', '&lt;already&gt;',
];

const good = () => ({
  mode: 'live', archetype: 'burst-trader', title: 'THE BURST TRADER', identity: '86xC…2MMY',
  stats: [{ label: 'RECENT SWAPS', value: '9' }, { label: 'SWAP-DAY COUNT', value: '2' }, { label: 'RECENT TXS', value: '40' }],
  roast: 'r', insight: 'i', evidence: ['e1'], disclosure: 'd', createdAt: '2026-10-01T00:00:00.000Z',
  coverage: { partial: true, windowStartUtc: '2026-09-01', windowEndUtc: '2026-10-01' },
});

test('escapeHtml escapes every HTML-significant character', () => {
  assert.equal(core.escapeHtml(`&<>"'\``), '&amp;&lt;&gt;&quot;&#39;&#96;');
  assert.equal(core.escapeHtml(null), '');
  assert.equal(core.escapeHtml(5), '5');
});

test('renderReportHtml never emits attacker-controlled markup', () => {
  for (const p of XSS) {
    const r = good();
    r.title = p; r.identity = p; r.roast = p; r.insight = p; r.disclosure = p;
    r.stats = [{ label: p, value: p.slice(0, 12) }, { label: p, value: '1' }];
    r.evidence = [p, p];
    const html = core.renderReportHtml(core.normalizeReport(r));
    assert.ok(!/<script|<img|<svg|<a /i.test(html), `raw tag leaked for ${p}`);
    assert.ok(!/<[^>]*\son\w+\s*=/i.test(html), `event handler attribute leaked for ${p}`);
    // Only our own fixed tags may appear.
    const tags = [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map(m => m[1].toLowerCase());
    for (const t of tags) assert.ok(['div', 'h3', 'p', 'span', 'strong', 'small', 'blockquote', 'ul', 'li', 'button'].includes(t), t);
  }
});

test('normalizeReport accepts a valid report and forces live reports to partial', () => {
  const r = core.normalizeReport({ ...good(), coverage: { partial: false } });
  assert.equal(r.partial, true);
  assert.equal(r.archetype, 'burst-trader');
});

test('normalizeReport rejects malformed shapes', () => {
  const cases = [
    null, [], 'x', 42,
    { ...good(), mode: 'admin' },
    { ...good(), title: '' },
    { ...good(), stats: 'nope' },
    { ...good(), stats: [{ label: 'a', value: '1' }] },
    { ...good(), stats: Array(5).fill({ label: 'a', value: '1' }) },
    { ...good(), stats: [{ label: 'a', value: '1' }, null] },
    { ...good(), stats: [{ label: 'a', value: '1' }, { label: 'b', value: {} }] },
    { ...good(), roast: { toString: () => 'x' } },
  ];
  for (const c of cases) assert.equal(core.normalizeReport(c), null, JSON.stringify(c));
});

test('normalizeReport clips oversize strings and drops unknown archetypes/dates', () => {
  const r = core.normalizeReport({ ...good(), title: 'X'.repeat(500), evidence: Array(20).fill('e'), archetype: '__proto__', createdAt: 'not a date' });
  assert.ok(r.title.length <= 60);
  assert.equal(r.evidence.length, 6);
  assert.equal(r.archetype, null);
  assert.equal(r.createdAt, null);
});

test('share URLs carry only a whitelisted archetype, never addresses', () => {
  const url = core.buildShareUrl('https://atlas.example/page?x=1#old', { archetype: 'burst-trader', identity: '86xC…2MMY' });
  assert.equal(url, 'https://atlas.example/page?x=1#try?r=burst-trader');
  assert.equal(core.buildShareUrl('https://a.example/', { archetype: null }), 'https://a.example/#try');
  assert.equal(core.parseShareHash('#try?r=burst-trader'), 'burst-trader');
  for (const h of ['#try?r=<script>', '#try?r=__proto__', '#try?r=constructor', '#try?r=86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY', '#try', '', null]) {
    assert.equal(core.parseShareHash(h), null, String(h));
  }
});

test('friendlyError hides HTML-ish or huge server messages', () => {
  assert.equal(core.friendlyError(400, 'Invalid public Solana wallet address'), 'Invalid public Solana wallet address');
  assert.match(core.friendlyError(502, '<html>Bad gateway</html>'), /temporarily unavailable/);
  assert.match(core.friendlyError(429), /Too many requests/);
  assert.match(core.friendlyError(0), /Could not reach/);
  assert.match(core.friendlyError('timeout'), /too long/);
  assert.match(core.friendlyError(500, 'x'.repeat(500)), /temporarily unavailable/);
});

test('wrapText wraps and ellipsizes at maxLines', () => {
  const measure = s => s.length * 10;
  assert.deepEqual(core.wrapText(measure, 'aa bb cc', 50, 3), ['aa bb', 'cc']);
  const lines = core.wrapText(measure, 'one two three four five six seven eight nine ten', 100, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith('…'));
  assert.ok(lines.every(l => measure(l) <= 100));
  assert.deepEqual(core.wrapText(measure, '', 100, 2), []);
});
