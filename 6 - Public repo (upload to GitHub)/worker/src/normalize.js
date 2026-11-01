// Normalizes one Helius Enhanced Transaction into a small, documented
// WalletActivity record (see docs/LEDGER_SCHEMA.md). Anything we cannot
// verify is recorded as null/unknown — never guessed.

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const MAX_FUTURE_SKEW_S = 300;      // tolerate small clock drift
export const MAX_PLAUSIBLE_TS = 1e11;      // larger values look like milliseconds or garbage

/** Helius timestamps are Unix seconds (block time). Returns integer seconds or null. */
export function parseTimestamp(ts, nowSec) {
  if (typeof ts !== 'number' || !Number.isInteger(ts)) return null;
  if (ts <= 0 || ts >= MAX_PLAUSIBLE_TS) return null;
  if (ts > nowSec + MAX_FUTURE_SKEW_S) return null;
  return ts;
}

const str = (v, max = 100) => (typeof v === 'string' && v.length ? v.slice(0, max) : null);
const lamports = v => (Number.isSafeInteger(v) && v >= 0 ? v : null);

export function normalizeTransaction(tx, wallet, nowSec) {
  if (!tx || typeof tx !== 'object' || Array.isArray(tx)) return null;

  // Helius Enhanced Transactions use `transactionError`; the newer Wallet API uses `error`.
  const failed = tx.transactionError != null || tx.error != null;
  const feePayer = str(tx.feePayer, 64);
  const feeLamports = lamports(tx.fee);

  let nativeIn = 0, nativeOut = 0;
  for (const t of Array.isArray(tx.nativeTransfers) ? tx.nativeTransfers : []) {
    const amt = lamports(t && t.amount);
    if (amt === null) continue;
    if (t.toUserAccount === wallet && t.fromUserAccount !== wallet) nativeIn += amt;
    else if (t.fromUserAccount === wallet && t.toUserAccount !== wallet) nativeOut += amt;
  }

  const tokens = [];
  for (const t of Array.isArray(tx.tokenTransfers) ? tx.tokenTransfers : []) {
    if (!t || typeof t !== 'object') continue;
    const mint = str(t.mint, 64);
    const toW = t.toUserAccount === wallet, fromW = t.fromUserAccount === wallet;
    if (!toW && !fromW) continue;
    tokens.push({
      mint,
      direction: toW && fromW ? 'self' : toW ? 'in' : 'out',
      // tokenAmount is a UI (decimal-adjusted) number in Helius responses; keep as-is, flag non-finite.
      uiAmount: Number.isFinite(t.tokenAmount) ? t.tokenAmount : null,
      isWsol: mint === WSOL_MINT,
    });
  }

  return {
    signature: str(tx.signature, 100),
    timestamp: parseTimestamp(tx.timestamp, nowSec),
    slot: Number.isSafeInteger(tx.slot) && tx.slot >= 0 ? tx.slot : null,
    status: failed ? 'failed' : 'success',
    type: (str(tx.type, 64) || 'UNKNOWN').toUpperCase(),
    source: str(tx.source, 64) || 'UNKNOWN',
    walletPaidFee: feePayer !== null && feePayer === wallet,
    feeLamports,
    native: { inLamports: nativeIn, outLamports: nativeOut },
    tokens,
    touchesWsol: tokens.some(t => t.isWsol),
    hasSwapEvent: !!(tx.events && typeof tx.events === 'object' && tx.events.swap),
  };
}
