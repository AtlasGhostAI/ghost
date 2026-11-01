// Deterministic, rule-based report builder. Every number in the output is a
// count or sum taken directly from the returned page. No P&L, win rate,
// balance, strategy quality or token-safety conclusions are made.

import { normalizeTransaction } from './normalize.js';

export const PAGE_LIMIT = 100;
export const SCHEMA_VERSION = 2;
const DAY_S = 86400;

export const ARCHETYPES = {
  'mystery-wallet': 'THE MYSTERY WALLET',
  'failure-collector': 'THE FAILED-TX COLLECTOR',
  'quiet-observer': 'THE QUIET OBSERVER',
  'rapid-clicker': 'THE RAPID CLICKER',
  'burst-trader': 'THE BURST TRADER',
  'on-chain-explorer': 'THE ON-CHAIN EXPLORER',
};

export const utcDay = t => new Date(t * 1000).toISOString().slice(0, 10);

/** Formats integer lamports as SOL using integer math (no float rounding surprises). */
export function lamportsToSol(l) {
  const whole = Math.floor(l / 1e9), frac = String(l % 1e9).padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

export function summarize(rawPage, address, nowSec, pageLimit = PAGE_LIMIT) {
  const page = Array.isArray(rawPage) ? rawPage.slice(0, pageLimit) : [];
  const records = page.map(tx => normalizeTransaction(tx, address, nowSec));
  const valid = records.filter(Boolean);
  const success = valid.filter(r => r.status === 'success');
  const timedSuccess = success.filter(r => r.timestamp !== null);
  const failed = valid.filter(r => r.status === 'failed');
  const swaps = timedSuccess.filter(r => r.type === 'SWAP');
  const transfers = timedSuccess.filter(r => r.type === 'TRANSFER');
  const swapDays = new Set(swaps.map(r => utcDay(r.timestamp)));
  const recent24 = swaps.filter(r => r.timestamp > nowSec - DAY_S).length;
  const timed = valid.filter(r => r.timestamp !== null).map(r => r.timestamp);
  const feeRecords = valid.filter(r => r.walletPaidFee && r.feeLamports !== null);
  return {
    records: valid,
    returned: Array.isArray(rawPage) ? rawPage.length : 0,
    analyzedPage: page.length,
    malformed: page.length - valid.length,
    successCount: success.length,
    timedSuccessCount: timedSuccess.length,
    untimedCount: success.length - timedSuccess.length,
    failedCount: failed.length,
    swapCount: swaps.length,
    transferCount: transfers.length,
    swapDayCount: swapDays.size,
    recent24,
    wsolTouches: timedSuccess.filter(r => r.touchesWsol).length,
    feesPaidLamports: feeRecords.reduce((a, r) => a + r.feeLamports, 0),
    feeTxCount: feeRecords.length,
    windowStart: timed.length ? utcDay(Math.min(...timed)) : null,
    windowEnd: timed.length ? utcDay(Math.max(...timed)) : null,
    possiblyMore: page.length >= pageLimit,
  };
}

export function classify(s) {
  if (s.analyzedPage > 0 && s.failedCount >= 5 && s.failedCount / s.analyzedPage >= 0.3) {
    return { archetype: 'failure-collector',
      roast: '“Your transactions fail more often than my New Year’s resolutions.”',
      insight: `${s.failedCount} of ${s.analyzedPage} returned transactions failed on-chain. Failed transactions can still cost network fees; this says nothing about trade outcomes.` };
  }
  if (s.timedSuccessCount === 0) {
    return { archetype: 'mystery-wallet',
      roast: '“You gave me nothing to roast. Even your transaction history is playing hard to get.”',
      insight: 'No successful, timestamped transactions were returned in the first page. This is not evidence of an inactive wallet.' };
  }
  if (s.swapCount === 0) {
    return { archetype: 'quiet-observer',
      roast: '“I searched for swaps and found silence. Are you a trader or just emotionally invested?”',
      insight: 'No swaps were classified in the returned recent transactions. Older transactions, other programs and unclassified activity are outside this sample.' };
  }
  if (s.recent24 >= 5) {
    return { archetype: 'rapid-clicker',
      roast: '“Your swap button has had a more productive day than most people.”',
      insight: `Detected ${s.recent24} swaps in the last 24 hours within this recent-transaction sample. Frequency alone does not establish whether trades were good or bad.` };
  }
  if (s.swapCount >= 8 && s.swapDayCount <= 2) {
    return { archetype: 'burst-trader',
      roast: '“You disappeared for days and then tried to speedrun the entire market.”',
      insight: `The returned sample contains ${s.swapCount} swaps across ${s.swapDayCount} swap-active UTC calendar day${s.swapDayCount === 1 ? '' : 's'}. This suggests clustered recent activity, not a measured profitability pattern.` };
  }
  return { archetype: 'on-chain-explorer',
    roast: '“You made moves. Whether they were good moves is a question your transaction list cannot answer.”',
    insight: `The returned sample contains ${s.swapCount} classified swaps across ${s.swapDayCount} UTC calendar day${s.swapDayCount === 1 ? '' : 's'}. This is activity analysis, not performance analysis.` };
}

export function buildReport(rawPage, address, nowSec = Math.floor(Date.now() / 1000), pageLimit = PAGE_LIMIT) {
  const s = summarize(rawPage, address, nowSec, pageLimit);
  const c = classify(s);
  const evidence = [
    `${s.timedSuccessCount} successful timestamped transactions in the first returned page (maximum ${pageLimit})`,
    `${s.swapCount} classified SWAP transactions; ${s.recent24} of them in the 24 hours before this report`,
    s.windowStart ? `Returned page spans ${s.windowStart} to ${s.windowEnd} (UTC)` : 'No usable timestamps in the returned page',
  ];
  if (s.failedCount) evidence.push(`${s.failedCount} failed transaction${s.failedCount === 1 ? '' : 's'} excluded from activity counts`);
  if (s.feeTxCount) evidence.push(`${lamportsToSol(s.feesPaidLamports)} SOL in network fees paid by this wallet across ${s.feeTxCount} returned transaction${s.feeTxCount === 1 ? '' : 's'}`);
  if (s.untimedCount || s.malformed) evidence.push(`${s.untimedCount + s.malformed} record(s) skipped for missing or invalid timestamps/format`);

  return {
    schemaVersion: SCHEMA_VERSION,
    mode: 'live',
    archetype: c.archetype,
    title: ARCHETYPES[c.archetype],
    identity: address.slice(0, 4) + '…' + address.slice(-4),
    stats: [
      { label: 'RECENT SWAPS', value: String(s.swapCount) },
      { label: 'SWAP-DAY COUNT', value: String(s.swapDayCount) },
      { label: 'RECENT TXS', value: String(s.timedSuccessCount) },
    ],
    roast: c.roast,
    insight: c.insight,
    evidence: evidence.slice(0, 6),
    disclosure: 'PARTIAL PUBLIC HISTORY · First page only; no profit, loss, wallet balance, strategy quality or token safety conclusions. Helius may not classify every swap.',
    coverage: {
      partial: true,
      pagesFetched: 1,
      pageLimit,
      returned: s.analyzedPage,
      failed: s.failedCount,
      skipped: s.untimedCount + s.malformed,
      windowStartUtc: s.windowStart,
      windowEndUtc: s.windowEnd,
      possiblyMore: s.possiblyMore,
    },
    createdAt: new Date(nowSec * 1000).toISOString(),
  };
}
