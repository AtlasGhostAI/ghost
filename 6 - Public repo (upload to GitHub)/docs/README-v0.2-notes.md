# ATLAS / GHOST Roast — v0.2

A free, zero-signup roast of Solana wallet activity with a downloadable share card. It's **read-only**: no wallet connection, no signing, no custody, no trading, no token. Every number shown is a count taken from data, labelled with where it came from. The live mode reads **one recent page** of public transactions and says so.

> **Nothing has been deployed by this update.** Everything below was run locally: unit tests, browser smoke tests, `wrangler deploy --dry-run`, and the Worker under `wrangler dev`. Helius itself was not reachable from the test environment, so the live path was tested against mocked Helius responses.

## What works, what needs configuration, what is planned

| Feature | Status |
|---|---|
| Landing page, sample roast, 1200×630 PNG card, share link/sheet | **Works with no setup** (static files only) |
| Onboarding steps, secret-paste guard, invite banner from a challenge link | **Works with no setup** |
| Live analysis of a public wallet (newest ≤100 txs, partial) | **Needs config:** Worker + `HELIUS_API_KEY` + `ALLOWED_ORIGINS` + `site/config.js` |
| Per-client rate limit (5/min) + strict global daily cap | **Needs config:** on by default in `wrangler.toml` once the Worker is deployed |
| Human verification (Turnstile) | **Optional config:** site key in `config.js` + `TURNSTILE_SECRET_KEY` |
| 5-min edge cache per address (hashed key) | **Needs a custom domain:** the Cache API is a no-op on `*.workers.dev` |
| Full history, verified ledger, P&L, win rate, token research, paper trading | **Planned only:** see `docs/LEDGER_SCHEMA.md` |

## Project layout

```
site/                 ← upload THIS folder to Cloudflare Pages / GitHub Pages
  index.html  styles.css  app.js  core.js  config.js  favicon.svg  og-card.png  _headers
worker/               ← the optional API (Cloudflare Worker)
  src/index.js        entry (exports handler + DailyQuota Durable Object only)
  src/app.js          routing, origin/CORS, body caps, provider calls, cache
  src/address.js      base58 + 32-byte address validation
  src/normalize.js    Helius tx → WalletActivity record
  src/report.js       deterministic counts + archetype rules
  src/ratelimit.js    token bucket + Rate Limiting binding
  src/quota.js        global daily cap (Durable Object)
  src/turnstile.js    optional Turnstile verification
  wrangler.toml  .dev.vars.example
tests/unit/           node:test, zero dependencies (52 tests)
tests/smoke/          Playwright + axe-core browser tests (14 checks)
scripts/serve.mjs     local static server that applies site/_headers (CSP)
scripts/worker-local-check.sh   curl probes against `wrangler dev`
docs/AUDIT.md  docs/LEDGER_SCHEMA.md  docs/ONBOARDING_AND_SHARING.md
CHANGELOG.md
```

## 1. Run locally (sample mode, ~1 minute)

Requires Node 22+ (only for the tests and the CSP-faithful server; the site itself has no build step).

```bash
cd atlas-ghost
npm run serve            # → http://localhost:8080  (applies the production CSP)
# or, without Node:  cd site && python3 -m http.server 8080
```

Open the page, keep **Explore sample roast** selected, and press **SUMMON MY GHOST**. Then try **Download share card**.

## 2. Run the tests

```bash
npm test                          # unit tests, no install needed
npm install                       # once: playwright + axe-core (dev only)
npx playwright install chromium   # once: browser for smoke tests
npm run test:smoke                # browser smoke tests; screenshots → tests/smoke/output/
npm run test:smoke -- --update-og # also regenerates site/og-card.png from the sample card
```

What's covered:

- **Unit:** wallet validation on client and server (with fuzzing to check they agree), secret detection, HTML escaping/XSS, report-shape validation, archetype classification, empty results, timestamp validation (ms, future, negative, string), UTC day boundaries, the 24 h boundary, pagination boundaries (0/1/99/100/101), fee attribution, WSOL flags, every API error status, CORS, content type, chunked body caps, rate limiting, Turnstile, cache, daily quota, and "no key or address in responses/logs".
- **Smoke:** a real PNG download (signature + 1200×630 dimensions checked), share text without an address, live mode disabled when unconfigured, a pasted secret never sent, mocked live API with XSS payloads (no execution), 429/502-HTML/bad-JSON/network-failure UI states, the invite link, 320/375/768 px layouts (no horizontal scroll, result scrolled into view, tap targets ≥40 px), and axe-core (0 serious/critical violations). All of it runs under the production CSP, and any console error, CSP violation or dialog fails the test.

## 3. Publish the static site (free)

**Cloudflare Pages (recommended):** Workers & Pages → Create → Pages → *Upload assets* → upload the **contents of `site/`** (no build command). Or with the CLI:

```bash
npx wrangler pages deploy site --project-name atlas-ghost
```

`site/_headers` is picked up automatically and sets the CSP. After the first deploy, change `og:image` in `index.html` to the absolute URL (`https://<your-site>.pages.dev/og-card.png`) and redeploy, because link previews need an absolute image URL.

GitHub Pages works for sample mode too, but it ignores `_headers`, so you lose the CSP.

## 4. Enable live wallet analysis (optional)

```bash
cd worker
npm install                                   # wrangler (>= 4.36 needed for [[ratelimits]])
npx wrangler login
# 1. Edit wrangler.toml:
#    ALLOWED_ORIGINS = "https://<your-site>.pages.dev"   (exact, comma-separate several)
#    DAILY_PROVIDER_CALL_LIMIT = "<fits your Helius credits>"
#    namespace_id under [[ratelimits]] must be unique in your Cloudflare account
npx wrangler secret put HELIUS_API_KEY        # paste at the prompt; never in any file
npm run check                                 # dry-run bundle + binding validation
npx wrangler deploy                           # note the https://…workers.dev URL
```

Then in `site/config.js` set `apiBase: 'https://atlas-ghost-api.<subdomain>.workers.dev'` and redeploy the site. If the Worker sits on a custom domain, also add that domain to `connect-src` in `site/_headers`.

**Local Worker development:**

```bash
cd worker && cp .dev.vars.example .dev.vars   # fill in a key; ALLOWED_ORIGINS=http://localhost:8080
npx wrangler dev --port 8787
# other terminal, from the project root:
bash scripts/worker-local-check.sh            # health, CORS, 415, 413 (chunked), 400, 429
```

and set `apiBase: 'http://localhost:8787'` in `site/config.js` while testing.

**Turnstile (recommended before sharing widely):** create a widget in the Cloudflare dashboard for your Pages hostname, put the **site key** in `config.js` → `turnstileSiteKey`, and run `npx wrangler secret put TURNSTILE_SECRET_KEY`.

**Before a wide launch, check:** Helius credit usage against `DAILY_PROVIDER_CALL_LIMIT`; Workers Logs for `rate_limited` / `daily_quota_exhausted` / `provider_status` events; that the Helius host (`HELIUS_API_HOST`) matches your dashboard; and that your plan includes Durable Objects and the Rate Limiting binding. Free-plan terms change, so verify them.

## Abuse controls (Worker)

In request order: exact-origin allowlist (fails closed when unset) → `application/json` only → 1 KB body cap counted while streaming → strict field whitelist + base58/32-byte address check → in-isolate token bucket + Cloudflare Rate Limiting binding per IP (IPv6 grouped by /64), failing closed → optional Turnstile → hashed edge cache → **global daily provider-call cap** (Durable Object, failing closed) → Helius with a 12 s timeout, a 4 MB response cap and a JSON content-type check. Logs are one-line JSON events with no addresses, IPs, URLs or keys. CORS is a browser courtesy, not an abuse control. The limits above are what actually protect the API.

## Data integrity rules (unchanged in spirit, now enforced by tests)

- Live reports are always `partial: true`, covering one page of ≤100 transactions.
- Failed transactions are excluded from activity counts and reported. Records with invalid timestamps are skipped and reported.
- No P&L, win rate, balances, strategy quality or token safety. A unit test fails if report text contains P&L or win-rate wording.
- Report text comes from fixed rules. No LLM is involved, and any future LLM must only rephrase audited numbers.

## Security and legal notes

- Never ask for seed phrases or private keys. The UI actively refuses them.
- A wallet address can be linked to a person. The Worker doesn't log addresses, and share cards and links never include them.
- Not financial advice. Write a privacy policy and terms before a public launch; the in-page note is a summary, not a legal document.

See `CHANGELOG.md` for everything that changed, and `docs/AUDIT.md` for the findings behind each change.
