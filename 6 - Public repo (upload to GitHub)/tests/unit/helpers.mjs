import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const core = require('../../site/core.js');

export const ADDR = {
  system: '11111111111111111111111111111111',              // 32 zero bytes
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  wsol: 'So11111111111111111111111111111111111111112',
  wallet: '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY',   // Helius docs example address
};

export const NOW = 1_790_000_000; // fixed clock: 2026-09-21T14:13:20Z

let n = 0;
export function tx(over = {}) {
  n += 1;
  return {
    signature: `sig${n}`, timestamp: NOW - 3600, slot: 300_000_000 + n, type: 'TRANSFER', source: 'SYSTEM_PROGRAM',
    fee: 5000, feePayer: ADDR.wallet, transactionError: null, nativeTransfers: [], tokenTransfers: [], events: {},
    ...over,
  };
}
export const swap = (over = {}) => tx({ type: 'SWAP', source: 'JUPITER', ...over });

export function b58encode(bytes) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}
