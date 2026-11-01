# Code audit — ATLAS / GHOST v0.1

Scope: the v0.1 ZIP (`index.html`, `styles.css`, `app.js`, `worker/index.js`, `worker/wrangler.toml`, `config.example.js`).
Line numbers refer to the **original v0.1 files**. `index.html` was minified onto 9 lines, so its references are by line plus element.
Every item below is fixed in v0.2 unless marked *open*.

Severity scale: **Critical**, meaning it can be abused at scale now or causes data/secret exposure. **High** means a broken core flow or a cost/abuse risk once public. **Medium** means a real bug or weakness with limited blast radius. **Low** covers polish, hardening and edge cases.

No Critical issues were found. The v0.1 author already avoided the most common mistakes: the key is server-side only, HTML is escaped, the share link has no address, and there are no P&L claims.

## High

| # | Area | Where | Finding | Fix in v0.2 |
|---|------|-------|---------|-------------|
| H1 | Abuse / cost | `worker/index.js:35-39` | No rate limiting, bot protection, quota or caching. Anyone can script unlimited calls and drain Helius credits. CORS does not stop non-browser clients, and the `Origin` header is trivially forged by curl. | Per-client token bucket + Cloudflare Rate Limiting binding (5/min); strict global **daily provider-call cap** in a Durable Object (fails closed); optional Turnstile; 5-min hashed edge cache. `worker/src/ratelimit.js`, `quota.js`, `turnstile.js` |
| H2 | Broken flow | `app.js:40-42` | With no `config.js`, live mode POSTs to the static host's `/api/analyze`, gets an HTML 404/405 page, and `res.json()` throws. The user then sees *"Unexpected token '<'…"*. | Live radio disabled and explained when no API is configured; responses are parsed only if `Content-Type` is JSON; HTML error bodies are never shown. |
| H3 | Input safety | `worker/index.js:32-33` | The body cap trusts `Content-Length` only. A chunked request has none, so `request.json()` reads an unbounded body. | `readBodyCapped()` counts streamed bytes (1 KB cap), rejects invalid UTF-8. Verified in `wrangler dev` with a chunked 5 KB body → 413. |
| H4 | Config fail-open | `worker/index.js:30` | If `ALLOWED_ORIGIN` is unset, `allowed === ''` and a request with **no** Origin header (curl, scripts) passes the check. | Allowlist parsed strictly; an empty list or the shipped placeholder → 503 for every analysis request. |

## Medium

| # | Area | Where | Finding | Fix |
|---|------|-------|---------|-----|
| M1 | CORS | `worker/index.js:6` | Disallowed origins receive `Access-Control-Allow-Origin: null`. Sandboxed iframes and `file://` pages have origin `null`, so this *grants* them read access to `/health` and error bodies. | CORS headers emitted only for allowlisted origins; disallowed preflights get 403. |
| M2 | Content type | `worker/index.js:33` | Any `Content-Type` is accepted, including `text/plain`. That makes the endpoint callable as a CORS "simple request" with no preflight. | Only `application/json` is accepted (415 otherwise). |
| M3 | Data quality | `worker/index.js:11` | `Number.isFinite(tx.timestamp)` accepts 0, negatives, fractions, millisecond values and future times. These skew the day counts and the 24h window. | `parseTimestamp()` accepts integer seconds only, in the range (0, now+300s], and rejects ms-scale values. Skipped records are counted and disclosed. |
| M4 | Data quality | `worker/index.js:11-22` | Failed transactions are silently dropped and malformed records silently ignored, so the report can't say what it excluded. | The report's `coverage` reports `failed`, `skipped`, `returned`, `windowStartUtc/EndUtc` and `possiblyMore`. Evidence lines state the exclusions. |
| M5 | Provider errors | `worker/index.js:40,43` | Every provider failure becomes a generic 502, so a 429 (provider busy), auth errors, timeouts and HTML bodies look identical. No status logging. | Mapped: provider 429→503 + Retry-After, 401/403→503, timeout/network→504, non-JSON/non-array→502. Minimal structured logs (no address, IP or URL). |
| M6 | Response trust | `app.js:22-25,42-43` | `render()` assumes the API shape; a missing `stats` throws a TypeError. Fields aren't length-limited. | `normalizeReport()` validates the shape, clips lengths and whitelists archetypes. Malformed → a clear error and nothing is rendered. |
| M7 | Accessibility | `index.html:5` (`label.input-wrap`) | The wallet input's accessible name is "◎" (the label wraps an icon). The visible "SOLANA WALLET ADDRESS" is a `div`. The hint isn't linked. | A real `<label for>`, plus `aria-describedby` pointing at the hint. |
| M8 | Accessibility | `index.html:5` (`#result`) | Results appear silently for screen readers; focus stays on the button. | `aria-live="polite"`, `aria-busy`, focus moves to the result heading. |
| M9 | UX | `index.html:5`, `app.js:34` | There is no `<form>`, so Enter in the input does nothing. The radios have no fieldset/legend. | Real `<form>` with submit, plus a `fieldset`/`legend`. |
| M10 | Mobile | `app.js:36,43` | Sample mode never scrolls to the result. On phones (single column) the result renders below the fold and the button appears to do nothing. | Both modes scroll to the result (instantly if `prefers-reduced-motion`). Smoke test asserts the result title is in the viewport at 320/375/768 px. |
| M11 | Mobile | `styles.css` (`.input-wrap input{font-size:13px}`) | Inputs under 16 px make iOS Safari zoom the page on focus. | 16 px input text. |
| M12 | Share | `app.js:31` | `navigator.clipboard?.writeText(msg).then(...)`: when clipboard is unavailable (HTTP on a LAN IP during phone testing), optional chaining short-circuits the whole chain and the button silently does nothing. | Native share sheet with the PNG attached on mobile → clipboard → inline manual-copy field. |
| M13 | Browser support | `app.js:41` | `AbortSignal.timeout` is missing in Safari < 16. The TypeError surfaces as the error message. | Feature-detected with an `AbortController` fallback; friendly timeout message. |
| M14 | Safety UX | `index.html:5` (`maxlength="64"`) | Nothing stops a user from pasting a private key or seed phrase. The 64-char cap even truncates an 88-char key to something that *looks* like an attempt. | `classifyInput()` detects base58 64-byte keys, CLI keypair JSON and 12–24-word phrases. The input is cleared with a warning, and the secret is never sent (smoke-tested). |
| M15 | Validation | `app.js:10`, `worker/index.js:5` | The regex accepts any 32–44-char base58 string, including ones that don't decode to 32 bytes. | Base58 decode + 32-byte length check, identical on client and server (fuzz-tested for agreement). |
| M16 | Headers | static site | No CSP or other security headers on the site. | `site/_headers` (Cloudflare Pages): strict CSP (no inline script/style), `nosniff`, `no-referrer`, `frame-ancestors 'none'`, Permissions-Policy. The local server and smoke tests run under the same CSP. |

## Low

| # | Area | Where | Finding | Fix |
|---|------|-------|---------|-----|
| L1 | Card | `app.js:53-56` | Long titles/stats overflow the canvas; a roast over 4 lines collides with the footer. | Title/stat text shrink-to-fit; roast wraps to at most 3 lines with an ellipsis (`wrapText`, unit-tested). |
| L2 | Card | `app.js:51` | The "◈" glyph can render as a missing-glyph box on some systems. | Diamond drawn as a canvas path. |
| L3 | Card | `app.js:59` | `toDataURL` + unattached `<a>` click is unreliable on older Firefox and heavy on iOS. | `toBlob` → object URL → attached anchor; URL revoked afterwards. |
| L4 | Card | `app.js:57` | The live card's footer had no date range. | Shows "One recent page … (start → end UTC)". |
| L5 | Copy | `app.js:31` | "Copied!" never resets. The button said "link" but copied a sentence. | Resets after 2.5 s; relabelled "Share challenge". |
| L6 | State | `app.js:44` | After a failed live call, the previous result stays next to the new error with nothing to say it's stale. | Errors are shown on the form; results only replace on success; the button can't get stuck disabled (smoke-tested). |
| L7 | A11y | `index.html:3-9` | Decorative glyphs and the mascot are read aloud ("club suit", "diamond with dot"); no skip link; no visible focus style on custom controls. | `aria-hidden` on decoration, skip link, `:focus-visible` ring. axe-core: 0 serious/critical violations. |
| L8 | A11y | `styles.css` (`.ghost-wrap` animation, `scroll-behavior`) | Ignores `prefers-reduced-motion`. | Respected. |
| L9 | A11y | `styles.css` (`.hint,.micro`, `.step-tag`) | Low-contrast 10–11 px text (#8290a9 / #7484a2 on #141d32). | Lightened to #9aa8bf. |
| L10 | Claims | `index.html:4` (`.floating.f1/.f2`) | Hero badges "⚡ RISK DETECTED" and "↗ TRADE INSIGHT" imply features that don't exist. | "⚡ NO SIGNING", "↗ PUBLIC DATA ONLY". The copy says "rule-based", and roadmap phases are marked NOW/PLANNED. |
| L11 | Unused | `app.js:6,9`; empty `app/api/analyze/`, `lib/`, `public/` dirs | Dead code (`lastReport`, `fmt`) and leftover empty folders. | Removed. |
| L12 | Privacy | `worker/index.js:22` | `identity` shows 5+5 chars of the address. | 4+4, shown on screen only, never on the card or link. |
| L13 | Ops | `worker/index.js` | No way to change the Helius host or silence logs without a code edit. | `HELIUS_API_HOST`, `LOG_LEVEL`, `CACHE_TTL_SECONDS`, `DAILY_PROVIDER_CALL_LIMIT` vars. |
| L14 | Runtime | (found while testing v0.2) | workerd treats every named export of the entry module as an entrypoint and refuses to start if one is a constant. | `worker/src/index.js` exports only `default` + `DailyQuota`; a unit test guards it. |

## Provider limits and open items

- **One page only (open, by design).** The Worker reads the newest ≤100 enhanced transactions with `token-accounts=balanceChanged`. Helius may return fewer than `limit` even when more history exists, so the report treats every live result as partial. `possiblyMore` is informational only.
- **Classification coverage (open).** Helius' own docs warn that its parsers don't cover every DeFi program. Swaps are counted only where Helius labels `type: "SWAP"`. Unlabelled swaps show up as other types and are not guessed.
- **Token-account history before ~Dec 2022 (open).** Per Helius docs, `balanceChanged`/`all` rely on owner metadata that wasn't recorded before slot 111,491,819.
- **Helius host (verify).** The code uses `api-mainnet.helius-rpc.com` (from v0.1). Helius docs pages show several hosts (`api-mainnet.helius-rpc.com`, `mainnet.helius-rpc.com`, legacy `api.helius.xyz`). Confirm the host in your dashboard; it's the `HELIUS_API_HOST` var.
- **API key in the query string (accepted risk).** Helius documents `?api-key=`. The URL is built server-side and never logged, but Cloudflare's optional request tracing could capture subrequest URLs. Keep tracing off for this Worker, or check whether your Helius plan supports header auth.
- **Rate Limiting binding semantics.** It's per Cloudflare location and eventually consistent (Cloudflare docs), which is why the Durable Object daily cap exists as the hard ceiling.
- **Cache API on workers.dev.** It's a no-op there. The 5-min cache only takes effect once the Worker is on a custom domain.
- **Privacy policy / terms (open).** The in-page "What happens to an address" note is a plain-language summary, not a legal document.
