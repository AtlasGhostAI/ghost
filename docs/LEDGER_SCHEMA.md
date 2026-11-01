# Wallet activity schema and verified-ledger plan

**Status:** Layer 1 (`WalletActivity`) is **implemented** in `worker/src/normalize.js` and used by the live report. Layers 2–4 are **planned only**. Nothing in the product today calculates P&L, cost basis, balances or win rates, and it must not until the gates in §4 pass.

## 1. Principles

1. **Provenance on every number.** Each derived value names its inputs (signatures, price source + timestamp) so it can be re-derived.
2. **Unknown ≠ zero.** A missing price, unclassified instruction or unpaginated history is recorded as unknown and propagates as unknown. It's never filled in with 0, the last price or a guess.
3. **Coverage before conclusions.** Any metric that needs complete history (P&L, win rate, holding period) is only computed for a wallet whose history is proven complete over the requested window (§3.3).
4. **Failed transactions are real events.** They change nothing except the fee, which is still paid.
5. **Deterministic and replayable.** The same raw inputs plus code version give the same ledger. Raw provider payloads are kept (hashed and content-addressed) so the ledger can be rebuilt when parsers improve.

## 2. Layer 1 — `WalletActivity` (implemented)

One record per provider transaction, from the wallet's point of view.

| Field | Type | Meaning / rule |
|---|---|---|
| `signature` | string \| null | Transaction signature (≤100 chars). |
| `timestamp` | int \| null | Block time, **Unix seconds**. Null if missing, non-integer, ≤0, ms-scale (≥1e11) or more than 300 s in the future. |
| `slot` | int \| null | Slot, if a safe non-negative integer. |
| `status` | `"success"` \| `"failed"` | `failed` if `transactionError` (Enhanced API) or `error` (Wallet API) is non-null. |
| `type` | string | Helius classification, upper-cased (`SWAP`, `TRANSFER`, … or `UNKNOWN`). **Not re-guessed.** |
| `source` | string | Helius source program label (`JUPITER`, `RAYDIUM`, … or `UNKNOWN`). |
| `walletPaidFee` | bool | `feePayer === wallet`. |
| `feeLamports` | int \| null | Network fee in lamports (integer ≥0), regardless of who paid. |
| `native.inLamports` / `outLamports` | int | Sum of `nativeTransfers` to/from the wallet, excluding self-transfers and non-integer amounts. |
| `tokens[]` | `{mint, direction: in\|out\|self, uiAmount, isWsol}` | Token transfers where the wallet is sender or receiver. `uiAmount` is Helius' decimal-adjusted number, or null if not finite. |
| `touchesWsol` | bool | Any token leg uses the wrapped-SOL mint `So111…112`. |
| `hasSwapEvent` | bool | Helius supplied `events.swap`. |

Report-level `coverage` (implemented): `partial` (always `true` today), `pagesFetched`, `pageLimit`, `returned`, `failed`, `skipped`, `windowStartUtc`, `windowEndUtc`, `possiblyMore`.

## 3. Layers 2–4 — the verified ledger (planned)

### 3.1 Storage (proposed: Cloudflare D1 or Postgres)

```sql
-- Raw, immutable provider payloads (for replay when parsers change)
CREATE TABLE raw_tx (
  signature      TEXT PRIMARY KEY,
  slot           INTEGER NOT NULL,
  block_time     INTEGER,                 -- seconds; NULL allowed, never defaulted
  provider       TEXT NOT NULL,           -- 'helius-enhanced-v0'
  payload_sha256 TEXT NOT NULL,
  payload        BLOB NOT NULL,           -- or object storage key
  fetched_at     INTEGER NOT NULL
);

-- Proven-complete windows per wallet (see 3.3)
CREATE TABLE coverage (
  wallet        TEXT NOT NULL,
  from_slot     INTEGER NOT NULL,
  to_slot       INTEGER NOT NULL,
  method        TEXT NOT NULL,            -- 'paginated-to-empty' | 'signature-reconciled'
  signature_cnt INTEGER NOT NULL,
  verified_at   INTEGER NOT NULL,
  PRIMARY KEY (wallet, from_slot)
);

-- Atomic balance movements: one row per (tx, asset, direction) from the wallet's view
CREATE TABLE ledger_leg (
  signature     TEXT NOT NULL REFERENCES raw_tx(signature),
  wallet        TEXT NOT NULL,
  leg_index     INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('swap_in','swap_out','transfer_in','transfer_out','fee','wrap','unwrap','rent','airdrop','unknown')),
  asset         TEXT NOT NULL,            -- mint; 'SOL' for native lamports
  amount_raw    TEXT NOT NULL,            -- integer base units as decimal string (no floats)
  decimals      INTEGER NOT NULL,
  counterparty  TEXT,
  status        TEXT NOT NULL CHECK (status IN ('success','failed')),
  source_rule   TEXT NOT NULL,            -- which parser rule produced this leg
  PRIMARY KEY (signature, wallet, leg_index)
);

-- Prices with provenance; gaps are explicit rows with price NULL
CREATE TABLE price_point (
  asset       TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  quote       TEXT NOT NULL DEFAULT 'USD',
  price       TEXT,                       -- decimal string; NULL = known gap
  source      TEXT NOT NULL,              -- provider + endpoint
  max_age_s   INTEGER NOT NULL,           -- staleness tolerance used
  PRIMARY KEY (asset, ts, quote, source)
);
```

### 3.2 Event handling rules

| Case | Rule |
|---|---|
| **Swaps** | Build from `accountData[].tokenBalanceChanges` + `nativeBalanceChange` (net balance deltas), not from `events.swap` alone. Cross-check the two. On disagreement, emit `kind='unknown'` legs and flag the tx. Multi-hop routes collapse to the wallet's net in/out. |
| **Transfers** | `transfer_in`/`transfer_out`. Transfers between wallets the user has *declared* as theirs are internal (excluded from P&L, kept in the ledger). |
| **Fees** | One `fee` leg (SOL, negative) whenever `feePayer = wallet`, **including failed txs**. Priority fees are included in `fee`. |
| **WSOL** | Wrap (SOL→WSOL) and unwrap (close account → SOL) are `wrap`/`unwrap` legs that net to zero value. WSOL and SOL are the same asset for valuation. ATA rent deposits/refunds are `rent` legs, not trading. |
| **Funding flows** | Inbound transfers from exchanges/other wallets are *deposits*, not income. Without a declared cost basis, deposited tokens have **unknown** basis, and any P&L that depends on them is unknown. |
| **Failed txs** | Only the `fee` leg. All other legs are suppressed. |
| **Price gaps** | Value a leg only if a price exists within `max_age_s` (e.g. 60 s for majors, 300 s for long tail) from a named source. Otherwise the value is NULL and the trade's P&L is NULL. Never interpolate across gaps, and never price illiquid tokens from a single pool without a liquidity floor. |
| **Unknown programs** | `kind='unknown'` legs carrying the net balance delta. They block P&L for affected assets until classified. |
| **Spam/airdrops** | `airdrop` legs with zero basis, excluded from performance until the asset is sold. |

### 3.3 Proving coverage

A wallet window `[from_slot, to_slot]` is **complete** only when:

1. Paginating `before-signature` from the newest signature returned an empty page or reached `from_slot`. Each page's last signature becomes the next cursor. Retries are bounded, and a page error aborts the window rather than skipping it.
2. The signature set matches an independent `getSignaturesForAddress` sweep over the same slots (count + set equality). Missing signatures are fetched individually or the window is marked incomplete.
3. The sum of all ledger legs per asset reproduces the on-chain balance change between `from_slot` and `to_slot` within rounding of 0 base units (SOL: lamport-exact incl. fees/rent).

### 3.4 What becomes claimable, and when

| Metric | Requires |
|---|---|
| Activity counts (today) | One page, labelled partial ✅ |
| Fees paid over window | Complete coverage of the window |
| Realized P&L per closed position | Complete coverage since the position opened, known basis for every lot, no price gaps on its legs |
| Win rate | Realized P&L for ≥ N closed positions, with the share of excluded (unknown) positions disclosed next to it |
| Tax lots | Out of scope; would need jurisdiction rules and user-declared transfers |

## 4. Gates before any P&L feature ships

- [ ] Golden-file tests from real, hand-reconciled wallets (swaps via ≥3 aggregators, WSOL wrap/unwrap, failed txs, ATA create/close, airdrops).
- [ ] Balance reconciliation (§3.3.3) passes for 100% of test windows.
- [ ] UI shows coverage and the excluded/unknown share beside every number.
- [ ] Copy review: no "profit", "win rate" or "returns" wording on partial data. The current unit test that bans that language from reports stays in place.
