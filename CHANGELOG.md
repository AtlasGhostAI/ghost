# Changelog

## 0.5.0 — coin check + transparency

- **Added** `GET /api/coin?mint=`: DexScreener market data + Solana RPC mint facts → factual flags (liquidity, 6h dumps, volume/liquidity ratio, holder concentration excluding the pool, mint/freeze authority, age, socials). 60s cache, own rate limit, origin-checked.
- **Added** `GET /api/wallet?address=&mint=`: SOL + token balance for the transparency section.
- **Added** site "Check a coin" section with shareable `?check=<mint>` links and copyable results.
- **Added** "Nothing hidden" transparency section (CA, dev wallet, lock link, source, creator-fee ledger), driven by `config.js`.
- **Changed** roadmap: coin check shipped early; GHOST alerts (Telegram) next. Removed the top tagline.

## 0.4.0 — the Lab: deep memory, parallel ghost, paper trading

### API (atlas-ghost-api)
- **Added** `depth: "deep"` on `POST /api/analyze`: reads up to 5 pages (500 transactions, `DEEP_PAGES`), builds an average-cost ledger per token and quote (SOL, USDC, USDT) and returns coverage, a trader profile, trade times and closed/open positions. Costs 4 rate-limit tokens.
- **Added** `GET /api/price?ids=` (Jupiter price v3, 20s edge cache) and `GET /api/token?mint=` (Jupiter token search, 1h cache, sanitized output) for the paper lab. Separate price rate bucket.
- **Added** behaviour flags on closed positions: fast flips (<10 min), revenge buys (within 15 min of a loss), 3rd+ re-entries, oversized buys (>2× median).

### Site
- **Added** Deep memory section: coverage, stats, local-time trading hours, plain-language patterns and "since last check" (stored only in your browser).
- **Added** Parallel ghost: replays your closed positions with rules switched on, using your real fills.
- **Added** Paper lab: $10,000 paper account with live prices, 1% slippage + 0.3% fee, your own rules (size cap, cooldown after a loss, daily loss limit) and a 24h rule lock. Stored only in your browser.
- **Added** Cloudflare Turnstile human check for live roasts (site key in `config.js`; enforced once `TURNSTILE_SECRET_KEY` is set on the API).
- **Changed** roadmap: live / beta / next / research labels; GHOST check, coach and execution stay on the roadmap.

## 0.2.0 — security, correctness and test pass

Finding IDs refer to `docs/AUDIT.md`.

### Worker
- **Added** a per-client rate limit: in-isolate token bucket + Cloudflare Rate Limiting binding (5/min, IPv6 grouped by /64), failing closed (H1).
- **Added** a global daily Helius-call cap in a SQLite-backed Durable Object (`DAILY_PROVIDER_CALL_LIMIT`, default 500), failing closed (H1).
- **Added** optional Turnstile verification (`TURNSTILE_SECRET_KEY`) (H1).
- **Added** a 5-minute edge cache keyed by SHA-256 of the address (`CACHE_TTL_SECONDS`); only effective on custom domains (H1).
- **Fixed** the body-size limit bypass via chunked encoding: bytes are now counted while streaming (1 KB cap) and invalid UTF-8 is rejected (H3).
- **Fixed** the fail-open origin check: the allowlist is strict, supports several origins (`ALLOWED_ORIGINS`), and the placeholder is treated as unset (H4).
- **Fixed** `ACAO: null` being sent to disallowed origins; disallowed preflights now get 403 (M1).
- **Added** strict `application/json` request content type (415), a field whitelist, and 405 with an `Allow` header (M2).
- **Added** base58 decode with a 32-byte length check for addresses (M15).
- **Added** provider error mapping (429→503 + Retry-After, auth→503, timeout/network→504, non-JSON→502), a 4 MB response cap, and a response content-type check (M5).
- **Added** minimal structured logs with no address, IP, URL or key; `LOG_LEVEL=off` silences them (M5).
- **Added** response security headers: CSP `default-src 'none'`, `no-referrer`, `nosniff`, `no-store`.
- **Changed** report schema v2: `archetype`, `coverage` (partial, returned, failed, skipped, UTC window, possiblyMore), fee and failed-tx evidence lines, a new "failed-tx collector" archetype, and a 4+4 truncated identity (M3, M4, L12).
- **Changed** timestamp handling: integer seconds only; 0, negative, ms-scale, non-integer or >5 min in the future are skipped and counted (M3).
- **Added** `normalize.js`, which maps Helius transactions to documented `WalletActivity` records (native/token directions, fee payer, WSOL, failed status for `transactionError` or `error`).
- **Changed** the code split into modules; the entry exports only `default` + `DailyQuota`, which workerd requires (L14).
- **Added** config vars `HELIUS_API_HOST` and `LOG_LEVEL`; `.dev.vars.example` (L13).

### Site
- **Moved** all deployable files to `site/`, so `worker/`, `tests/` and `docs/` can't be uploaded by accident.
- **Fixed** live mode on a site without an API: the radio is disabled with an explanation, and non-JSON bodies are never parsed or shown (H2).
- **Added** `normalizeReport()`, which validates and length-clips API responses before rendering (M6).
- **Added** accessibility: real label + `aria-describedby`, `fieldset`/`legend`, `<form>` submit (Enter works), `aria-live` result with focus on its heading, skip link, `:focus-visible`, `aria-hidden` on decoration, reduced-motion support, and better small-text contrast. axe-core reports 0 serious/critical violations (M7–M9, L7–L9).
- **Fixed** mobile: the result scrolls into view in both modes, 16 px input (no iOS zoom), small-screen tweaks (M10, M11).
- **Added** a secret-paste guard for base58 private keys, keypair JSON and seed phrases: they're cleared, warned about and never sent (M14).
- **Changed** sharing: native share sheet with the PNG on mobile → clipboard → inline manual copy; the challenge link carries only a whitelisted archetype slug; an invite banner shows for recipients (M12).
- **Added** `AbortSignal.timeout` fallback and friendly timeout/network messages (M13).
- **Changed** the card: `toBlob` download, shrink-to-fit title/stats, 3-line roast with ellipsis, a vector diamond logo, and the UTC date range on live cards (L1–L4).
- **Added** onboarding: a 3-step indicator, paste auto-selects live mode, and an inline "What happens to an address" note.
- **Added** `_headers` with a strict CSP (no inline script/style), `nosniff`, `no-referrer`, `frame-ancestors 'none'`, and Permissions-Policy (M16).
- **Added** `og-card.png` generated from the real sample card, plus Twitter card meta.
- **Changed** copy: hero badges no longer imply risk detection; GHOST is described as rule-based; roadmap phases are marked NOW/PLANNED (L10).
- **Changed** `config.js` to be committed with empty, non-secret defaults (`window.ATLAS_CONFIG`); the v0.1 `window.ATLAS_API_BASE` is still honored.
- **Removed** dead code and the empty `app/`, `lib/` and `public/` folders (L11).

### Tooling
- **Added** `npm test`: 52 `node:test` unit tests with zero dependencies.
- **Added** `npm run test:smoke`: 14 Playwright + axe-core checks under the production CSP.
- **Added** `scripts/serve.mjs` (applies `_headers` locally) and `scripts/worker-local-check.sh` (curl probes for `wrangler dev`).
- **Added** docs: `AUDIT.md`, `LEDGER_SCHEMA.md` and `ONBOARDING_AND_SHARING.md`.
