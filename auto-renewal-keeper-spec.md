# Auto-Renewal Keeper Service — Full Spec

## 0. Context & Positioning

This extends the read-only Blob Management System with the one feature that
is genuinely hard to replicate and therefore the actual monetizable core of
the product: **automatic, unattended renewal of Walrus blobs before they
expire**, without the user needing to sign a transaction every time.

The base dashboard (list blobs, manual renew/delete, notifications) is easy
to clone — it's pure reads plus thin transaction-building, and at least one
free tool in Mysten's own `awesome-walrus` list already does it. The
auto-renewal keeper is not easy to clone well: it requires an on-chain
custody/delegation mechanism, an off-chain execution service with uptime
guarantees, and a fee model — three things a weekend clone won't bother
building. This is where you build a moat and where you charge money.

Walrus's own docs explicitly anticipate this pattern: blob storage can be
extended at any time by attaching a longer-duration storage resource, and
**"smart contracts can use this mechanism to extend blob availability
indefinitely, as long as funds are available."** That sentence is the
entire product thesis — we're building the contract and the keeper that
makes it real.

---

## 1. Goals & Non-Goals

**Goals**
- Let a user deposit WAL once, set a policy ("keep this blob alive
  indefinitely, renew N epochs at a time, starting when M epochs remain"),
  and never think about it again.
- Make renewal execution **permissionless and trust-minimized** — anyone
  (not just your bot) can trigger a due renewal, so the system doesn't
  depend on your infrastructure being the sole point of failure or trust.
- Bake a protocol fee directly into the on-chain renewal call, so revenue
  is collected trustlessly regardless of who executes it.
- Give the user full custody: they can withdraw unused WAL and reclaim
  their blob object at any time; nothing is permanently locked.

**Non-goals (v1)**
- Cross-chain funding (WAL must already be on Sui / in the user's wallet).
- Renewing blobs the vault doesn't itself hold — see the ownership
  trade-off in §3.2 before deciding whether that's acceptable to you.
- Dynamic per-epoch pricing strategies (e.g. renew more when WAL is cheap)
  — flag as a v2 feature, not v1.

---

## 2. Two Architectural Tracks (and which one to build)

### Track A — On-chain Vault Contract (recommended)
A Move module holds the user's WAL balance and the blob object itself. A
public, permissionless `entry` function checks whether a blob is due for
renewal and, if so, extends it using the vault's own WAL — no user
signature needed per renewal, because the **vault**, not the user, is the
transaction sender for the inner Walrus call.

- **Trust model:** non-custodial in the sense that matters — the Move
  module's logic is public and auditable, the user can withdraw or reclaim
  at any time, and no off-chain party ever holds funds or keys.
- **Execution model:** permissionless — your keeper bot calls it for
  reliability and collects the fee, but a user (or a competitor, or a
  public good actor) could call it too if your bot is ever down. This is a
  feature, not a bug: it removes "what if their server dies" as an
  objection when you sell this.
- **Effort:** highest — real Move development, needs an audit before
  handling meaningful WAL volume.

### Track B — Custodial Relayer (faster to ship, weaker moat)
User grants your backend a capped spending allowance (e.g. via a
pre-signed batch of future transactions, or literally trusts your hot
wallet with deposited WAL). Your server's cron renews on schedule.

- **Trust model:** custodial — you hold user funds or signing capability.
  Bigger liability, bigger trust ask, and it undercuts your own "no
  centralized database, no custodial risk" pitch from the base dashboard.
- **Effort:** low — no Move work, just a scheduled job and a funded hot
  wallet.
- **Use case:** acceptable only as a fast v0 demo/pilot with a handful of
  design-partner users who explicitly opt into a custodial beta, clearly
  labeled as such. Do not scale this track — migrate design-partner users
  to Track A once it's audited.

**Recommendation:** build Track B only if you need a two-week demo for
early users or investors; build Track A as the real product. The rest of
this spec details Track A.

---

## 3. On-Chain Design (Track A)

### 3.1 Move Module: `auto_renewal::vault`

**Core object — `RenewalVault`** (shared object, one per user-blob pair,
or one vault holding many blobs — see §3.3 for the tradeoff):

```move
struct RenewalVault has key {
    id: UID,
    beneficiary: address,        // only address that can withdraw/reclaim
    blob: Option<Blob>,           // the Walrus Blob object, held in custody
    wal_balance: Balance<WAL>,    // prepaid renewal funds
    policy: RenewalPolicy,
    total_renewals_executed: u64,
    total_fees_paid: u64,
    created_at_epoch: u64,
}

struct RenewalPolicy has store, copy, drop {
    renew_threshold_epochs: u64,  // trigger renewal when <= this many epochs remain
    renew_by_epochs: u64,         // how many epochs to add per renewal
    max_total_epochs: Option<u64>,// safety cap: stop auto-renewing past this end_epoch
    active: bool,                 // beneficiary can pause without withdrawing
}
```

**Entry functions:**

```move
public entry fun create_vault(
    blob: Blob,
    initial_wal: Coin<WAL>,
    renew_threshold_epochs: u64,
    renew_by_epochs: u64,
    max_total_epochs: Option<u64>,
    ctx: &mut TxContext
)
// Transfers the blob and WAL into a new shared RenewalVault.
// Emits VaultCreated { vault_id, beneficiary, blob_id }.

public entry fun deposit(vault: &mut RenewalVault, coin: Coin<WAL>)
// Anyone can top up a vault's WAL balance (e.g. a team funding a
// teammate's vault). Emits Deposited { vault_id, amount, depositor }.

public entry fun update_policy(
    vault: &mut RenewalVault,
    new_policy: RenewalPolicy,
    ctx: &TxContext
)
// Beneficiary-only (asserts ctx.sender() == vault.beneficiary).

public entry fun withdraw(
    vault: &mut RenewalVault,
    amount: u64,
    ctx: &mut TxContext
)
// Beneficiary-only. Withdraws WAL back to beneficiary's own coin.

public entry fun reclaim_blob(vault: &mut RenewalVault, ctx: &mut TxContext)
// Beneficiary-only. Transfers the Blob object back to the beneficiary's
// address and deactivates the policy. Used to "cancel" auto-renewal
// entirely and go back to manual management.

public entry fun execute_renewal(
    vault: &mut RenewalVault,
    system: &mut System,           // Walrus system object
    ctx: &mut TxContext
)
// PERMISSIONLESS — callable by anyone, including your keeper bot.
// 1. Asserts policy.active == true.
// 2. Asserts current_epoch(system) + policy.renew_threshold_epochs
//    >= blob.storage.end_epoch  (i.e. renewal is actually due — reverts
//    otherwise, so a keeper can't spam-call for no reason).
// 3. If max_total_epochs is set, caps renew_by_epochs so the resulting
//    end_epoch never exceeds it; if already at cap, deactivates policy
//    and emits PolicyExhausted instead of renewing.
// 4. Computes the WAL cost of extending by renew_by_epochs
//    (via the system object's pricing) and asserts wal_balance is
//    sufficient; if not, emits InsufficientBalance and does NOT renew
//    (so the tx doesn't just fail silently — the keeper sees the event
//    and can alert the user).
// 5. Splits protocol_fee (see §4) off wal_balance, transfers it to the
//    treasury address, and pays the remainder toward the Walrus extend
//    call, calling the equivalent of extendBlobTransaction logic against
//    vault.blob using vault.wal_balance.
// 6. Pays a keeper_fee (see §4.2) to ctx.sender() — this is what makes
//    execution permissionless-but-incentivized: whoever calls this
//    function successfully gets paid a small amount, so your keeper bot
//    profits from being fast/reliable, and third parties are welcome to
//    compete on that same incentive as a decentralization backstop.
// 7. Increments total_renewals_executed, total_fees_paid.
// 8. Emits RenewalExecuted { vault_id, blob_id, new_end_epoch,
//    protocol_fee_paid, keeper_fee_paid, executor }.
```

**Events** (all indexed by your off-chain service, none contain PII —
just object IDs, addresses, epochs, and amounts):
`VaultCreated`, `Deposited`, `PolicyUpdated`, `Withdrawn`, `BlobReclaimed`,
`RenewalExecuted`, `InsufficientBalance`, `PolicyExhausted`.

### 3.2 The Ownership Trade-off (be upfront about this with users)

To let a permissionless function renew a blob without per-call signatures,
the vault contract must hold the `Blob` object, not the user's own wallet.
This means:

- The blob is technically owned by the vault (a shared object), not the
  user's address, for as long as auto-renewal is active.
- The user retains full control via `reclaim_blob` and `withdraw` —
  nothing is locked beyond what they choose.
- Anyone reading raw chain state will see the vault as the blob's owner,
  not the user's wallet. Your dashboard UI should clearly attribute it
  back to the user via the `beneficiary` field so this doesn't look like
  the blob "disappeared" from their wallet.
- This is the same tradeoff every auto-compounding/auto-restaking vault in
  DeFi makes, and users are generally comfortable with it as long as
  withdraw/reclaim is always available and cheap. Say this explicitly in
  your UI copy — don't let users discover it themselves.

### 3.3 One Vault Per Blob vs. One Vault Per User

- **Per-blob vault (recommended for v1):** simplest Move logic, cleanest
  events, easiest to reason about for fee accounting and for the
  `max_total_epochs` safety cap. Slightly more gas overhead per vault
  object and more objects for a power user with many blobs.
- **Per-user vault holding many blobs (v2 candidate):** better UX for
  power users (one deposit funds everything), but the Move logic gets
  materially more complex (per-blob sub-policies inside one object,
  partial-failure handling when one blob's renewal fails but others in
  the same vault succeed). Don't build this until Track A v1 has real
  usage data justifying it.

---

## 4. Monetization Mechanics

### 4.1 Protocol Fee (primary revenue line)
A small percentage (suggest starting at 3–5%, tune post-launch) of each
renewal's WAL cost is split off *inside the Move call* and sent to a
treasury address you control, before the remainder pays for the actual
Walrus extend. This is trustless — it happens on-chain regardless of who
calls `execute_renewal`, so you earn revenue even on renewals your own
keeper didn't execute.

### 4.2 Keeper Fee (execution incentive, not your revenue — but see below)
A smaller fixed amount (or fixed WAL amount) paid to whichever address
successfully calls `execute_renewal`. If you run the only reliable keeper
bot, this fee effectively **also** flows to you in practice, on top of
the protocol fee — so in the common case where your bot wins the race to
call renewals, you're earning both fee streams. Third parties are free to
compete for the keeper fee, which is what keeps the system honest and
gives you a credible "even if we disappear, your blobs still renew"
selling point.

### 4.3 Subscription Layer (secondary revenue line)
The on-chain fees above work regardless of who the user is. On top of
that, sell a subscription for things the contract itself can't provide:

- **Guaranteed low-latency execution** — your keeper checks due vaults
  every few minutes rather than users relying on best-effort third-party
  callers.
- **Team dashboards** — multi-vault views grouped by `team_id`, alerting
  routed to a team Slack/webhook, seat-based pricing.
- **Priority notifications** — SMS/webhook alerts on `InsufficientBalance`
  or `PolicyExhausted` events before a blob actually lapses, not after.
- **Custom policies** — e.g. "renew this blob forever, but never let the
  vault hold more than X WAL at once" or scheduled top-ups from a linked
  wallet.

### 4.4 Example Revenue Math (illustrative only — validate with real WAL pricing)
If a renewal costs 100 WAL and your protocol fee is 4%, that's 4 WAL per
renewal event. A user with a blob renewing monthly generates 48 WAL/year
in protocol fees alone, before subscription revenue. At even modest scale
(hundreds of active vaults), this is a real, recurring, on-chain-verifiable
revenue stream — and unlike a SaaS dashboard fee, users can independently
audit exactly what they're being charged and why, which is a strong trust
argument when selling into a crypto-native audience.

---

## 5. Off-Chain Keeper Service

### 5.1 Responsibilities
- Poll all `RenewalVault` objects (via `getOwnedObjects`/dynamic field
  queries or an indexer) to find ones where
  `current_epoch + renew_threshold_epochs >= end_epoch` and `active == true`.
- For each due vault, build and submit an `execute_renewal` transaction,
  paying its own gas (SUI), and collect the keeper fee as reimbursement +
  margin.
- Retry with backoff on transient RPC/epoch-transition errors (same
  `RetryableWalrusClientError` pattern as the base dashboard).
- Detect and alert on emitted `InsufficientBalance` / `PolicyExhausted`
  events, forwarding to the existing Notification Service so the user
  gets an email/webhook *before* their blob actually lapses, not after.

### 5.2 Architecture
```
┌────────────────────────────────────────────────────────┐
│                Keeper Worker (cron / queue)              │
│  1. Scan vaults due for renewal (indexer query)          │
│  2. Batch-build execute_renewal transactions             │
│  3. Submit, using a dedicated gas-funded hot wallet       │
│     (this wallet pays SUI gas only — it never holds       │
│     user WAL, since that lives in the vault contract)     │
│  4. Emit internal metrics: renewals attempted/succeeded/  │
│     failed, fee revenue collected, latency vs due-time    │
└──────────────────────┬───────────────────────────────────┘
                        │
                        ▼
┌────────────────────────────────────────────────────────┐
│         Existing Indexer + Notification Service           │
│  Reuses the base dashboard's infra — just add a listener  │
│  for RenewalExecuted / InsufficientBalance / Exhausted    │
└────────────────────────────────────────────────────────┘
```

### 5.3 Keeper Wallet Risk
The keeper's hot wallet only ever spends its own SUI for gas and receives
keeper fees in return — it never custodies user WAL. This bounds your
operational risk to "keeper wallet runs out of gas / goes offline," which
degrades to *slower* renewals (someone else can still call the
permissionless function), not lost funds. State this explicitly in your
security documentation — it's a meaningfully different risk profile than
Track B and worth emphasizing to prospective users.

---

## 6. API Additions (extends the base dashboard's API)

```
POST /api/vaults
  Body: { wallet_address, blob_id, initial_wal_amount,
          renew_threshold_epochs, renew_by_epochs, max_total_epochs? }
  → Returns unsigned transaction for create_vault (user signs to fund it)

GET /api/vaults/{wallet_address}
  → Returns all vaults where beneficiary == wallet_address, with
    current WAL balance, policy, next renewal due epoch, history

POST /api/vaults/{vault_id}/deposit
  Body: { wallet_address, amount }
  → Returns unsigned transaction for deposit

POST /api/vaults/{vault_id}/policy
  Body: { wallet_address, renew_threshold_epochs, renew_by_epochs,
          max_total_epochs?, active }
  → Returns unsigned transaction for update_policy (beneficiary-only,
    server should verify wallet_address == vault.beneficiary before
    bothering to build the tx)

POST /api/vaults/{vault_id}/withdraw
  Body: { wallet_address, amount }
  → Returns unsigned transaction for withdraw

POST /api/vaults/{vault_id}/reclaim
  Body: { wallet_address }
  → Returns unsigned transaction for reclaim_blob

GET /api/vaults/{vault_id}/history
  → Paginated RenewalExecuted / InsufficientBalance / PolicyExhausted
    events for this vault, sourced from the indexer
```

All of these follow the same pattern as the base dashboard's transaction
endpoints: server verifies ownership/authorization against on-chain state,
builds an unsigned `Transaction`, returns base64 bytes, client signs with
their own wallet via dapp-kit. The server never signs on the user's
behalf for anything that moves their WAL or blob ownership.

---

## 7. Security Considerations

- **Contract audit is non-negotiable before mainnet with real WAL.** This
  module custodies user funds and objects; a bug here is a fund-loss bug,
  not a UX bug. Budget for a professional Move audit before launch.
- **Reentrancy / call-ordering:** `execute_renewal` must fully update
  `wal_balance` and emit its event before any external call that could
  re-enter (standard Move object-capability patterns mitigate most of
  this, but explicitly test it).
- **Griefing via spam calls:** since `execute_renewal` is permissionless,
  guard against someone repeatedly calling it on a vault that isn't yet
  due — the epoch-threshold assertion in step 2 already reverts these,
  but confirm the revert doesn't still cost the caller meaningful gas
  that could be used to DoS your own keeper's retry loop.
- **Balance depletion is a silent failure mode by default** — a vault
  that runs low on WAL just stops renewing with no dramatic on-chain
  event unless you explicitly emit `InsufficientBalance` (as designed
  above) and alert on it. Treat this as a P0 notification path, not an
  afterthought — a user who thinks they're auto-renewed but isn't is
  worse than a user with no auto-renewal at all.
- **`max_total_epochs` is a safety rail for users, not just a feature** —
  without it, a mis-set policy could silently drain a large deposit over
  years. Make it a required field with a sane default, not optional.

---

## 8. Failure Modes & Edge Cases

| Scenario | Handling |
|---|---|
| Vault WAL balance insufficient at renewal time | `execute_renewal` reverts renewal (not the whole tx pointlessly), emits `InsufficientBalance`, keeper forwards to Notification Service |
| `max_total_epochs` reached | Policy auto-deactivates, `PolicyExhausted` emitted, user notified, blob remains renewed up to the cap — not left to expire mid-cycle |
| Your keeper bot is offline | Permissionless design means the blob still isn't at risk of the *contract* failing — but no one is proactively calling it, so blobs will lapse unless a third party calls it. Mitigate with keeper redundancy (§9), not by relying on external good samaritans |
| WAL/SUI price spikes make the deposited balance cover fewer epochs than expected | Surface projected "renewals remaining at current price" in the dashboard so users see this coming, don't just find out when `InsufficientBalance` fires |
| User wants out entirely | `reclaim_blob` + `withdraw` — always available, no lock-up period |
| Sui epoch-transition RPC flakiness | Same `RetryableWalrusClientError` retry pattern as the base dashboard's indexer |

---

## 9. Keeper Reliability (mitigating §8's single-keeper risk)

Even though execution is permissionless, don't ship with a single keeper
instance as your only reliable caller — that reintroduces a central point
of failure in practice even if not in theory.

- Run at least 2 independent keeper workers (different hosts/regions),
  both racing to call due renewals — only one succeeds on-chain per
  vault, the other's tx simply fails harmlessly (already-renewed guard).
- Monitor keeper wallet SUI gas balance and alert well before it's empty.
- Publish keeper uptime/renewal-latency metrics publicly (e.g. a simple
  status page) — this is a trust-building feature for a crypto-native
  audience used to being burned by opaque "trust us" infra.

---

## 10. Implementation Roadmap

**Phase 1 (2–3 weeks): Move contract**
- `create_vault`, `deposit`, `withdraw`, `reclaim_blob`, `update_policy`
- `execute_renewal` with fee splitting and all guard conditions
- Full unit test suite on Sui testnet, including adversarial cases
  (insufficient balance, cap exhaustion, unauthorized withdraw attempts)

**Phase 2 (1 week): Keeper worker**
- Vault-scanning indexer query
- Transaction submission + retry logic
- Metrics + alerting hooks into existing Notification Service

**Phase 3 (1 week): API + dashboard UI**
- Vault CRUD endpoints (§6)
- Dashboard: "Enable auto-renew" flow, deposit/withdraw UI, policy editor,
  renewal history view, projected-runway indicator

**Phase 4 (2+ weeks, gate before mainnet launch): Audit**
- Professional Move audit of the vault module
- Testnet dry run with design-partner users and real (testnet) WAL volume
- Public disclosure of audit results before accepting mainnet deposits

**Phase 5: Launch**
- Start protocol fee low (3–4%) to build trust and usage data, revisit
  pricing once you have real renewal volume to model against.

---

## 11. What to Reuse From the Base Dashboard Spec

Everything in the original spec's Indexer Service, Notification Service,
and Epoch Tracker carries over unchanged — this auto-renewal system is an
additive module, not a replacement. The vault/keeper layer just adds new
event types for the indexer to watch and new alert triggers for the
notification service to fire on. No changes needed to the read-only
`/api/blobs/*` endpoints from the original spec.
