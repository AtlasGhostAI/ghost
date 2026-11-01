// Solana public-address validation (syntax + base58 decoded length).
// A Solana address is the base58 encoding of exactly 32 bytes. We do NOT check
// whether the key is on the ed25519 curve: program-derived addresses are valid
// accounts that are intentionally off-curve.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = new Map([...ALPHABET].map((c, i) => [c, i]));
export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Returns decoded byte length of a base58 string, or -1 if it contains invalid characters. */
export function base58DecodedLength(s) {
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

export function isValidSolanaAddress(s) {
  return typeof s === 'string'
    && s.length >= 32 && s.length <= 44
    && BASE58_RE.test(s)
    && base58DecodedLength(s) === 32;
}
