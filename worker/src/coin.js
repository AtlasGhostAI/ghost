// GHOST coin check: public market data (DexScreener) + on-chain mint facts
// (Helius RPC) turned into plain, factual flags. No "safe" verdicts, ever.

const DEX = 'https://api.dexscreener.com';
const DEFAULT_RPC_HOST = 'mainnet.helius-rpc.com';

const clean = (v, n) => (typeof v === 'string' ? v.replace(/[^\x20-\x7E]/g, '').slice(0, n) : '');
const num = v => (Number.isFinite(+v) ? +v : null);

async function getJson(url, init, timeoutMs = 8000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw Object.assign(new Error('upstream_status'), { status: res.status });
  return res.json();
}

export async function rpc(env, method, params) {
  const host = /^[a-z0-9.-]+$/i.test(env.HELIUS_RPC_HOST || '') ? env.HELIUS_RPC_HOST : DEFAULT_RPC_HOST;
  const data = await getJson(`https://${host}/?api-key=${encodeURIComponent(env.HELIUS_API_KEY)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (data && data.error) throw Object.assign(new Error('rpc_error'), { status: 502 });
  return data && data.result;
}

/** Collects raw inputs. Each source fails independently so one outage still returns a partial check. */
export async function fetchCoinRaw(env, mint) {
  const [dex, mintInfo, largest] = await Promise.allSettled([
    getJson(`${DEX}/latest/dex/tokens/${mint}`, { headers: { Accept: 'application/json' } }),
    env.HELIUS_API_KEY ? rpc(env, 'getAccountInfo', [mint, { encoding: 'jsonParsed' }]) : Promise.reject(new Error('no_key')),
    env.HELIUS_API_KEY ? rpc(env, 'getTokenLargestAccounts', [mint]) : Promise.reject(new Error('no_key')),
  ]);
  return {
    pairs: dex.status === 'fulfilled' && dex.value && Array.isArray(dex.value.pairs) ? dex.value.pairs : null,
    mintInfo: mintInfo.status === 'fulfilled' ? mintInfo.value : null,
    largest: largest.status === 'fulfilled' ? largest.value : null,
  };
}

/** Pure: raw → report. Exported for tests. */
export function analyzeCoin(raw, mint, nowMs) {
  const pairs = (raw.pairs || []).filter(p => p && p.chainId === 'solana' && p.baseToken && p.baseToken.address === mint);
  const main = pairs.slice().sort((a, b) => (num(b.liquidity && b.liquidity.usd) || 0) - (num(a.liquidity && a.liquidity.usd) || 0))[0] || null;
  const flags = [];
  const add = (level, text) => flags.push({ level, text });

  // --- on-chain mint facts
  const parsed = raw.mintInfo && raw.mintInfo.value && raw.mintInfo.value.data && raw.mintInfo.value.data.parsed;
  const info = parsed && parsed.type === 'mint' ? parsed.info : null;
  const authorities = info ? { mint: info.mintAuthority ? 'on' : 'off', freeze: info.freezeAuthority ? 'on' : 'off' } : null;
  if (authorities) {
    if (authorities.mint === 'on') add('red', 'Mint authority is ON: the creator can still create more tokens.');
    else add('ok', 'Mint authority is off: supply is fixed.');
    if (authorities.freeze === 'on') add('red', 'Freeze authority is ON: holders’ tokens can be frozen.');
    else add('ok', 'Freeze authority is off: tokens can’t be frozen.');
  }

  // --- holder concentration (the #1 account is usually the pool or bonding curve)
  let holders = null;
  const supply = info ? num(info.supply) : null;
  const accts = raw.largest && Array.isArray(raw.largest.value) ? raw.largest.value : null;
  if (supply && supply > 0 && accts && accts.length) {
    const amounts = accts.map(a => num(a.amount) || 0).sort((a, b) => b - a);
    const pct = xs => Math.round((xs.reduce((s, x) => s + x, 0) / supply) * 1000) / 10;
    holders = { top1Pct: pct(amounts.slice(0, 1)), top10ExTop1Pct: pct(amounts.slice(1, 11)) };
    if (holders.top10ExTop1Pct >= 50) add('red', `The next 10 biggest holders (after the pool) own ${holders.top10ExTop1Pct}% of supply.`);
    else if (holders.top10ExTop1Pct >= 25) add('warn', `The next 10 biggest holders (after the pool) own ${holders.top10ExTop1Pct}% of supply.`);
    else add('ok', `Holders are spread out: the next 10 biggest own ${holders.top10ExTop1Pct}%.`);
  }

  // --- market
  let market = null;
  if (main) {
    const liq = num(main.liquidity && main.liquidity.usd);
    const mcap = num(main.marketCap) ?? num(main.fdv);
    const vol24 = num(main.volume && main.volume.h24);
    const tx = main.txns && main.txns.h24 ? (num(main.txns.h24.buys) || 0) + (num(main.txns.h24.sells) || 0) : null;
    const ch = main.priceChange || {};
    const ageH = num(main.pairCreatedAt) ? Math.max(0, (nowMs - main.pairCreatedAt) / 3600000) : null;
    market = {
      dex: clean(main.dexId, 24), stage: main.dexId === 'pumpfun' ? 'bonding curve' : 'graduated',
      priceUsd: num(main.priceUsd), marketCap: mcap, liquidityUsd: liq, volume24h: vol24, txns24h: tx,
      change: { h1: num(ch.h1), h6: num(ch.h6), h24: num(ch.h24) }, ageHours: ageH !== null ? Math.round(ageH * 10) / 10 : null,
      pairs: pairs.length,
    };
    if (liq !== null && market.stage === 'graduated') {
      if (liq < 10000) add('red', `Liquidity is only $${Math.round(liq).toLocaleString('en-US')}: selling even a little will move the price a lot.`);
      else if (mcap && liq / mcap < 0.05) add('warn', `Liquidity is under 5% of market cap: the price is easy to push around.`);
      else add('ok', `Liquidity of $${Math.round(liq).toLocaleString('en-US')} is a healthy cushion for this size.`);
    }
    if (ch.h6 !== undefined && num(ch.h6) !== null && num(ch.h6) <= -60) add('red', `Down ${Math.abs(Math.round(num(ch.h6)))}% in the last 6 hours: this looks like a dump in progress.`);
    else if (num(ch.h24) !== null && num(ch.h24) <= -80) add('red', `Down ${Math.abs(Math.round(num(ch.h24)))}% in 24 hours.`);
    if (vol24 && liq && vol24 / liq >= 100) add('warn', `24h volume is ${Math.round(vol24 / liq)}× its liquidity: much of it may be bots or wash trading.`);
    if (ageH !== null && ageH < 1) add('warn', 'Less than 1 hour old: there’s no track record yet.');
    if (vol24 !== null && vol24 < 1000) add('warn', `Barely trading: only $${Math.round(vol24).toLocaleString('en-US')} traded in the last 24 hours.`);
    if (mcap !== null && mcap < 10000) add('warn', `Tiny market cap ($${Math.round(mcap).toLocaleString('en-US')}): one buyer can move the price a lot.`);
  } else {
    add('warn', 'No trading pairs found yet: it may be brand new or not tradable.');
  }

  // --- presence
  const web = main && main.info && Array.isArray(main.info.websites) ? main.info.websites : [];
  const soc = main && main.info && Array.isArray(main.info.socials) ? main.info.socials : [];
  const links = {
    website: web.length ? clean(web[0].url, 120) : null,
    x: (soc.find(s => s && s.type === 'twitter') || {}).url ? clean(soc.find(s => s.type === 'twitter').url, 120) : null,
    telegram: (soc.find(s => s && s.type === 'telegram') || {}).url ? clean(soc.find(s => s.type === 'telegram').url, 120) : null,
  };
  if (main && !links.website && !links.x && !links.telegram) add('warn', 'No website or socials listed.');

  const reds = flags.filter(f => f.level === 'red').length;
  const warns = flags.filter(f => f.level === 'warn').length;
  const verdict = reds >= 2 ? 'high-risk' : reds === 1 || warns >= 2 ? 'caution' : 'no-major-flags';
  return {
    v: 1, mint,
    token: main ? { symbol: clean(main.baseToken.symbol, 16), name: clean(main.baseToken.name, 48) } : null,
    market, holders, authorities, links, flags, verdict,
    counts: { red: reds, warn: warns, ok: flags.filter(f => f.level === 'ok').length },
    sources: { market: !!raw.pairs, chain: !!info, holders: !!holders },
    note: 'Facts from public market data and the Solana chain. Not a safety rating and not advice.',
  };
}

/** Transparency page: SOL + one token's balance for a public wallet. */
export async function fetchWalletBalances(env, address, mint) {
  const [bal, toks] = await Promise.all([
    rpc(env, 'getBalance', [address]),
    mint ? rpc(env, 'getTokenAccountsByOwner', [address, { mint }, { encoding: 'jsonParsed' }]) : Promise.resolve(null),
  ]);
  const sol = bal && Number.isFinite(bal.value) ? bal.value / 1e9 : null;
  let token = null;
  if (toks && Array.isArray(toks.value)) {
    token = toks.value.reduce((s, a) => s + (num(a && a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info && a.account.data.parsed.info.tokenAmount && a.account.data.parsed.info.tokenAmount.uiAmount) || 0), 0);
  }
  return { address, sol, token, mint: mint || null };
}
