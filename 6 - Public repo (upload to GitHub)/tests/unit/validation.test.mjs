import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, ADDR, b58encode } from './helpers.mjs';
import { isValidSolanaAddress as workerValid, base58DecodedLength } from '../../worker/src/address.js';

const impls = [['site', core.isValidSolanaAddress], ['worker', workerValid]];

for (const [name, valid] of impls) {
  test(`${name}: accepts real 32-byte addresses`, () => {
    for (const a of Object.values(ADDR)) assert.equal(valid(a), true, a);
  });

  test(`${name}: rejects bad characters, lengths and types`, () => {
    const bad = [
      '', ' ', 'hello', ADDR.wallet.replace(/.$/, '0'), ADDR.wallet.replace(/^./, 'O'), ADDR.wallet.replace(/^./, 'I'),
      ADDR.wallet.replace(/^./, 'l'), ADDR.wallet + 'a', ADDR.wallet.slice(0, 31), '1'.repeat(31), '1'.repeat(33),
      `${ADDR.wallet}\n`, ` ${ADDR.wallet}`, '<script>alert(1)</script>', null, undefined, 42, {}, [ADDR.wallet],
    ];
    for (const b of bad) assert.equal(valid(b), false, JSON.stringify(b));
  });

  test(`${name}: rejects base58 strings of plausible length that decode to the wrong size`, () => {
    // 44 'z' characters decode to > 32 bytes.
    assert.equal(valid('z'.repeat(44)), false);
    // 32 chars of '2' decode to < 32 bytes.
    assert.equal(valid('2'.repeat(32)), false);
  });
}

test('worker and site agree on random base58 strings', () => {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 2000; i++) {
    const len = 30 + Math.floor(rnd() * 16);
    const s = Array.from({ length: len }, () => A[Math.floor(rnd() * 58)]).join('');
    assert.equal(core.isValidSolanaAddress(s), workerValid(s), s);
    assert.equal(core.base58DecodedLength(s), base58DecodedLength(s));
  }
});

test('classifyInput: detects secrets so they are never sent', () => {
  assert.equal(core.classifyInput(ADDR.wallet), 'address');
  assert.equal(core.classifyInput(`  ${ADDR.wallet}  `), 'address');
  assert.equal(core.classifyInput(''), 'empty');
  assert.equal(core.classifyInput('not an address'), 'invalid');
  // A 64-byte base58 secret key (the format wallets export).
  const sk = b58encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256));
  assert.ok(sk.length >= 86 && sk.length <= 88);
  assert.equal(core.classifyInput(sk), 'secret');
  // Solana CLI keypair JSON format.
  assert.equal(core.classifyInput(JSON.stringify(Array.from({ length: 64 }, (_, i) => i))), 'secret');
  // 12- and 24-word mnemonics (dummy words).
  assert.equal(core.classifyInput('apple '.repeat(12).trim()), 'secret');
  assert.equal(core.classifyInput('river '.repeat(24).trim()), 'secret');
  assert.equal(core.classifyInput('river '.repeat(11).trim()), 'invalid');
});
