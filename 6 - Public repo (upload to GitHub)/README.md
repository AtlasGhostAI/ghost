# GHOST — wallet analysis for Solana traders

Paste any public Solana address. GHOST reads the wallet's on-chain history, rebuilds every trade, and shows how you actually trade.

**Live:** https://atlas-ghost.ghostroast.workers.dev · **X:** [@AtlasGhostAI](https://x.com/AtlasGhostAI)

## Read-only by design

This repo is public so anyone can check these claims:

- **No wallet connect, no signing, no private keys.** The site only takes a public address. A pasted seed phrase or private key is detected in the browser, wiped, and never sent (`site/core.js`).
- **GHOST never moves funds.** The API only calls read endpoints: Helius transaction history and Jupiter prices (`worker/src/history.js`, `worker/src/prices.js`).
- **Addresses are not stored.** The address is hashed (SHA-256) for a short cache key and is never written to logs (`worker/src/app.js`). Share cards never print it.
- **API keys stay server-side.** Keys live in Cloudflare secrets, never in the site code (`site/config.js` holds only public values).
- **Abuse protection.** Cloudflare Turnstile, per-IP rate limits, strict CSP and body-size limits (`worker/src/security.js`, `worker/src/ratelimit.js`).

## What it does

| Feature | Status | Code |
|---|---|---|
| Roast: trader type from recent swaps | Live | `worker/src/report.js` |
| Deep memory: up to 500 txs, habits by hour, hold time, flags | Beta | `worker/src/ledger.js` |
| Parallel you: replay closed trades with rules switched on | Beta | `site/lab.js` |
| Paper lab: $10K practice at live prices, lockable rules | Beta | `site/lab.js`, `site/lab-ui.js` |
| GHOST check · Ghost pages · GHOST coach | Roadmap (Nov 23 · Nov 30 · Dec 14) | — |

**How trades are rebuilt:** each swap is read from the wallet's own balance changes, then grouped into positions per token and quote (SOL, USDC, USDT) using average cost. Flags: flips under 10 minutes, buys within 15 minutes of a losing close, 3rd+ re-entries, buys over 2× your median size. Sells with no buy inside the window are excluded rather than guessed.

## Run it

```bash
npm install
npm test              # unit tests
npm run test:smoke    # browser tests (Playwright)
npm run serve         # site at http://localhost:8080
```

API: `worker/` is a Cloudflare Worker. Copy `worker/.dev.vars.example` to `worker/.dev.vars`, add your own `HELIUS_API_KEY`, then `npx wrangler dev`.

## Layout

```
site/     static site (HTML/CSS/JS, no framework)
worker/   Cloudflare Worker API (analyze, price, token)
tests/    unit + browser tests
docs/     security audit, ledger design, notes
```

Not financial advice. GHOST shows what your wallet did; it doesn't predict anything.
