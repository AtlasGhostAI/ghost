// Paginated wallet history from the Helius Enhanced Transactions API.
// Walks backwards with `before-signature` until an empty page (history is
// complete) or the page budget runs out (history is partial).

export class ProviderError extends Error {
  constructor(kind, status) { super(kind); this.kind = kind; this.status = status; }
}

export async function fetchPage({ host, apiKey, address, before, limit = 100, timeoutMs = 12000 }) {
  const url = new URL(`https://${host}/v0/addresses/${encodeURIComponent(address)}/transactions`);
  url.searchParams.set('api-key', apiKey);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('token-accounts', 'balanceChanged');
  if (before) url.searchParams.set('before-signature', before);
  let res;
  try {
    res = await fetch(url.toString(), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new ProviderError(e && e.name === 'TimeoutError' ? 'timeout' : 'network');
  }
  if (!res.ok) throw new ProviderError('status', res.status);
  if (!/application\/json/i.test(res.headers.get('content-type') || '')) throw new ProviderError('format');
  const text = await res.text();
  if (text.length > 4 * 1024 * 1024) throw new ProviderError('format');
  let data;
  try { data = JSON.parse(text); } catch { throw new ProviderError('format'); }
  if (!Array.isArray(data)) throw new ProviderError('format');
  return data;
}

/**
 * Returns { txs, pages, complete, stoppedBy } — `complete` is true only when the
 * provider returned an empty page, i.e. there is nothing older to read.
 * The first page's errors are thrown; later-page errors end the walk early.
 */
export async function fetchHistory({ host, apiKey, address, maxPages, page = fetchPage }) {
  const txs = [];
  let before = null, pages = 0, complete = false, stoppedBy = 'budget';
  while (pages < maxPages) {
    let data;
    try {
      data = await page({ host, apiKey, address, before });
    } catch (e) {
      if (pages === 0) throw e;
      stoppedBy = 'provider-error';
      break;
    }
    pages += 1;
    if (data.length === 0) { complete = true; stoppedBy = 'end'; break; }
    txs.push(...data.slice(0, 100));
    const last = data[data.length - 1];
    before = last && typeof last.signature === 'string' ? last.signature : null;
    if (!before) { stoppedBy = 'no-cursor'; break; }
  }
  return { txs, pages, complete, stoppedBy };
}
