# Onboarding and private-by-default sharing

## Onboarding flow (implemented in v0.2)

Goal: a first-time visitor gets a roast in **one tap**, then is invited to try a real wallet with no account, no wallet connection and no surprises.

1. **Land → "Get roasted".** Sample mode is pre-selected. One tap on *Summon my ghost* renders the sample (no network) and scrolls it into view on phones.
2. **Step indicator** (`STEP 1/2/3 OF 3`) under the card header shows *Try the sample → Paste a public address → Share your card*. It advances as the user goes.
3. **Paste = intent.** Pasting a valid address auto-selects *Analyze public wallet*. On a site without the API, the user gets a plain message instead of a broken request.
4. **Guard rail.** Pasting something that looks like a private key, keypair JSON or seed phrase clears the field immediately, says it wasn't sent, and suggests treating it as compromised.
5. **Transparency inline.** *"What happens to an address I paste?"* is a collapsed `<details>` right under the button, so it's there for people who want it and doesn't get in the way of people who don't.
6. **Optional human check.** If Turnstile is configured, the widget only loads when the user picks live mode, so sample-only visitors never load a third-party script.

## Sharing (implemented)

| Surface | Contains | Never contains |
|---|---|---|
| PNG card (1200×630) | Archetype title, three counts, roast, "partial" footer with UTC date range (live) or "DEMO ONLY" | Address (full or truncated), signatures, balances |
| Challenge link | `https://site/#try?r=<archetype-slug>` | Address, stats, anything user-typed |
| Native share sheet (mobile) | The PNG + text + challenge link | Same as above |
| Invite banner on the receiving end | "A friend got THE BURST TRADER…" from a **whitelisted** slug | Arbitrary text from the URL (unknown slugs are ignored) |

The slug sits in the URL fragment (`#…`), which browsers don't send to servers, so it isn't in your hosting logs either.

## Next shareability ideas (planned, not built)

- **Opt-in "show my short address" toggle** on the card (default off) for people who want to flex a known wallet.
- **Per-archetype OG images** (`/r/burst-trader` static pages, each with its own `og:image`) so link previews show the friend's archetype instead of the generic sample card. Static, so still no addresses involved.
- **QR on the card** pointing at the challenge link.
- **Referral counts** via an anonymous random token in the fragment → Worker → Analytics Engine. Only aggregate counts, never linked to an address.
