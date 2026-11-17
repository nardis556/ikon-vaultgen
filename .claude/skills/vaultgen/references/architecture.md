# vaultgen architecture

Facts below come from the code at HEAD `97d646c` (2026-10-27, `ikon-vaultgen` is its own git repo, remote
`github.com/nardis556/ikon-vaultgen`, branch `master`). `file:line` refers to `ikon-vaultgen/`. Where the
project log (`kperps-test/CLAUDE.md`) adds something the code cannot show, it says "(log, date)".

## Contents
1. What it is
2. Entry point and MODEs
3. Module map
4. Provisioning flow (`MODE=provision`)
5. Animate loop (`MODE=animate`): signals, ladder, taker, churn, session gating
6. FIV vs PSV in the code
7. What is read on-chain vs via REST
8. Contract calls and payload layouts
9. Where README / comments and code disagree

## 1. What it is

- A TypeScript tool (Node 22, run with `tsx`, no build step; `tsx` does NOT type-check — `npx tsc --noEmit`
  shows 14 pre-existing errors, none blocking) that creates demo vaults on Katana Perps and keeps them
  "alive": depositors join / top up / withdraw on multi-day schedules, the manager quotes an
  inventory-skewed post-only ladder and optionally takes small market orders.
- Two vault products: **FIV** (Fixed-Income Vault: depositors are owed principal + interest) and **PSV**
  (Profit-Share Vault: depositors hold shares priced from the vault's value; carry + management fee).
- One strategy = one JSON file in `strategies/` (identity + economics + behaviour). One deployment = one
  directory `docker/<env>/<strategy-dir>/` with its own `compose.yml`, its own manager + depositor keys and
  one long-running `animate` container.
- Environments: dev, staging, sandbox (+ unused demo, demo-staging). All on chain Bokuto (737373), same
  vbUSDC `0xc2a4C310F2512A17Ac0047cf871aCAed3E62bB4B`; only the exchange, provider and adapter differ.
- Running image: `ikon-vaultgen:local` (built 2026-10-21 14:31 CDT). It equals HEAD except
  `src/vault.ts:371-378` (the deposit re-send guard) — verified 2026-11-17 by copying `/app/src` out of a
  running container and diffing. SDK inside the image: `@katanaperps/katana-perps-sdk` 2.1.0.

## 2. Entry point and MODEs

`src/index.ts:5-25` switches on `MODE` (`config.mode`, default `provision`, `src/config.ts:74`):

| MODE | Module | What it does | Sends txs? |
|---|---|---|---|
| `list` | `strategy.ts:listStrategies` | prints `id profile name` of every `strategies/*.json` | no |
| `provision` | `provision.ts:provision` | drift check vs `GET /exchange`, create vault (signed when needed), name it, seed initial depositors, verify, write `out/<strategy>-<instance>.json` | yes if `EXECUTE=1` |
| `fund` | `fund.ts:fund` | pre-fund manager + whole pool with ETH and vbUSDC (idempotent top-up) | yes if `EXECUTE=1` |
| `associate` | `associate.ts:associateAll` | API `associateWallet` for manager + pool, then stamps API key/secret into `.env.MANAGER` / `.env.DEPOSITORS` (fields 3,4) | API writes if `EXECUTE=1` |
| `details` | `details.ts:details` | one authenticated `setVaultDetails` (name + description); no chain calls | API write if `EXECUTE=1` |
| `animate` | `animate.ts:animate` | the daemon (section 5) | yes if `EXECUTE=1` |

- `associate` and `fund` are no-ops under `FRESH_WALLETS=1` (`index.ts:16-21`); `details` refuses it
  (`details.ts:16-17`).
- `config.ts` evaluates every `required()` var at import (`config.ts:17-21,25-113`), so EVERY mode — even
  `list` and `details` — needs `BASE_URL CHAIN_ID RPC_URL EXCHANGE_CONTRACT VAULT_PROVIDER
  LOCAL_DEPOSIT_ADAPTER QUOTE_TOKEN STRATEGY FUNDING_WALLET_KEY` set.
- Everything is DRY-RUN unless `EXECUTE=1`. The dry run performs every read and check and prints the plan.
  It sends nothing, but `provision`, `associate` and `fund` dry runs DO write missing wallet files
  (`GENERATE_WALLETS=1` mints keys into `.env.MANAGER` / `.env.DEPOSITORS` before the dry-run stop).

## 3. Module map

- **`index.ts`** — dispatcher above. Called by the Dockerfile `CMD npx tsx src/index.ts`.
- **`config.ts`** — reads env into `config` (full table in `config.md`). Loads `../.env.STRATEGY` then
  `../.env` with dotenv (no override), i.e. relative to the repo root when run locally; inside the image
  those files do not exist, so containers rely only on compose `env_file`/`environment`. Validates
  `VAULT_TYPE` ∈ {FIV, PSV} (`:115-116`).
- **`strategy.ts`** — `Strategy` type (`:56-88`), `listStrategies`, `loadStrategy(id)` (matches the JSON
  `id`, not the file name, `:98-104`), `vaultDisplayName(s, prefix)` (≤ 30 chars or throws, `:108-114`),
  `validateStrategy` (throws on chain-bound violations, returns warnings, `:116-221`), and the encoders
  `toChainFields` (FIV, `:224-236`) / `toPsvChainFields` (PSV, `:245-254`). Bounds tables `FIV_BOUNDS`
  `:34-42`, `PSV_BOUNDS` `:46-53` (PSV fee caps are stale vs the 2026-10-20 provider — see gotchas).
- **`wallets.ts`** — manager and depositor-pool files in loadgen format `NAME=address,privateKey[,apiKey,apiSecret]`
  at `/app/.env.MANAGER` / `/app/.env.DEPOSITORS` (`:23-24`, bind-mounted per strategy dir).
  `loadManager(generate)` / `loadDepositorPool(size, generate)` read, or mint and persist (mode 600) —
  random, or BIP-44 derived from `POOL_MNEMONIC` with account index = FNV(`strategy:instance`), index 0 =
  manager, 1..N = depositors (`:39-47`). `FRESH_WALLETS=1` mints in memory and persists nothing
  (`:95-102`, `:126-134`). `writeCredentials` rewrites a file with the API pair on every row (`:75-90`).
- **`client.ts`** — `buildClient(apiKey, apiSecret, pk)` → SDK `RestAuthenticatedClient` (bridge adapter =
  `LOCAL_DEPOSIT_ADAPTER`, `sandbox` flag, chain, exchange) plus `nonce()` = uuid v1 (`:9-19`).
- **`vault.ts`** — all chain work: `provider()` (ethers `JsonRpcProvider` over a `FetchRequest` with
  `User-Agent: ikon-vaultgen` and `X-AccessKey: RPC_ACCESS_KEY`, `:183-191`), `rpcRetry` (retries rate
  limits `-32017`, timeouts, resets, 50x; never retries reverts or nonce errors, `:37-53`), `ensureFunded`
  (top up ETH / vbUSDC from the funding wallet only when below target, `:200-211`), `existingVault`
  (`:219-267`), `createVault` (`:269-317`), `depositTo` (`:324-383`), `vaultBalance` (`:385-408`),
  `readVault` (pinned-block aggregate + per-wallet read, `:411-448`), `psvSummary` (`:107-117`),
  `encodePsvConfig` (`:174-181`). Used by provision, fund, animate, churn and the staging labs.
- **`provision.ts`** — section 4. Uses `seededAmounts()` (deterministic per-strategy deposit sizes,
  `:25-34`) so re-runs agree.
- **`fund.ts`** — manager target `seed + 25` vbUSDC + `MGR_ETH`; each pool wallet `FUND_DEPOSITOR_USD` or
  `ceil(amountUsdRange.hi × 1.8 + 5)` + `DEP_ETH` (`:27-29`). Checks the funding wallet can cover the
  worst case first.
- **`associate.ts`** — associates with `bridgeAdapterContractAddress = 0x0` (`:24-33`), treats
  ALREADY/EXISTS/DUPLICATE as success, then writes creds into BOTH files even if some associations
  failed, and exits 0 (`:91-103`). Reads `MANAGER_API_*` / `DEPOSITOR_API_*` straight from env (`:56-59`).
- **`details.ts`** — `MODE=details`: loads the manager without generating, needs its API creds, calls
  `setVaultDetails(name = "<VAULT_NAME_PREFIX> <display.name>", description)` (`:15-31`).
- **`withdraw.ts`** — the SDK internal namespace (`Symbol.for('@katanaPerps/internal')`, `:21-30`);
  `setVaultDetails` (`:32-36`) is the only live export. `withdrawByQuantity` (REST, `:52-74`) is dead code:
  the REST route answered 401 (commit `17b33a9`), churn withdraws on-chain instead.
- **`withdraw-onchain.ts`** — depositor-submitted LOCAL withdrawals straight to the provider (no API, no
  dispatcher to submit; the dispatcher still applies/cancels): FIV `withdrawByQuantity` 12-field struct
  (`:42-105`), PSV `withdrawByShares` 13-field struct incl. trailing `grossQuantity = 0` (`:117-183`).
  EIP-712 typed data from the SDK against the EXCHANGE domain; `staticCall` first, then send with
  `gasLimit 2,000,000`; max gas fee `$0.05` (`MINIMUM_MAXIMUM_GAS_FEE`, `:40`).
- **`decide.ts`** — pure churn decision (feasibility first, then vault-fill and wallet-drift bias, then
  sizing clamped to headroom / `availableToWithdraw`) (`:59-130`).
- **`churn.ts`** — per-wallet schedules in `STATE_DIR/churn-<strategy>-<instance>.json` (history capped at
  500, `:39-51`), `seedSchedule` (first action uniform in `[0, hi]` hours × `TIME_SCALE`, `:54-62`),
  `churnTick` (`:80-190`).
- **`animate.ts`** — the daemon loop (section 5).
- **`mm.ts`** — ladder builder `buildSkewedQuotes` (`:61-114`), `requoteMarket` (`:260-293`),
  `openSeedPositions` (`:143-183`), `takeSignalTrade` (`:193-231`), `fetchBookTop` (`:234-239`),
  `fetchNetPositions` (`:242-253`).
- **`signals.ts`** — candle fetch (`GET /candles`) and the rules `ema-cross | macd | rsi | donchian |
  bollinger | none` → bias −1/0/+1 (`:18-24`, `:96-148`).
- **One-off tools (not used by the daemon):** `associate-one.ts` (associate one wallet into a staging
  account; env `API_KEY API_SECRET WALLET_PK [WALLET] EXECUTE`); `sandbox-set-exit-mult.ts` (written
  2026-09-17 to lower the exit multiplier of the sandbox set of that time via an unsigned
  initiate/finalize upgrade; hard-codes `/home/user/code/kperps-test/ikon-vaultgen`, reads whatever is in
  `docker/sandbox/.env.sandbox` and `docker/sandbox/<dir>/.env.MANAGER` NOW — i.e. it would act on the
  2026-10-26 set — and writes the tracked `docker/sandbox/.exit-mult-upgrade-state.json`; `MODE=status`
  is read-only).
- **Staging lab harnesses (test code, not product):** `staging-lab.ts` (unified mint → battery → exit
  loop; driven by `run-staging-lab-loop.sh`, flock `/tmp/staging-lab.lock`), `staging-vault-lab.ts`,
  `staging-exit-lab.ts`, `staging-invariant-test.ts`, `staging-stagger-test.ts`,
  `staging-reduceonly-test.ts`, `staging-config-cap-test.ts`. Each parses
  `docker/staging/.env.staging` itself (hard-coded absolute path), forces tiny `MGR_ETH`/`DEP_ETH`, mints
  its own throwaway vaults and shares the staging funding wallet.

## 4. Provisioning flow (`MODE=provision`, `provision.ts:36-229`)

1. Load + validate the strategy; refuse if env `VAULT_TYPE` ≠ strategy `vaultType` (`:41-45`). Build the
   display name (prefix + name ≤ 30 chars, `:46`).
2. **Drift check** — unauthenticated `GET {BASE_URL}/exchange` (`:68-100`): pick
   `vaults.fixedIncomeVaultProviderV1ContractAddress` (FIV) or `profitShareVaultProviderV1ContractAddress`
   (PSV); refuse if absent/zero, if it ≠ `VAULT_PROVIDER`, or if `exchangeContractAddress` ≠
   `EXCHANGE_CONTRACT`. Compute the live seed floor `vaultCreationMinimum + vaultCreationFee` (today
   100 + 10) and refuse a smaller seed. It does NOT compare `LOCAL_DEPOSIT_ADAPTER` with
   `bridgeAdapters.localDepositAdapterV1KatanaContractAddress` — check that yourself.
3. **Wallets** — `loadManager(GENERATE_WALLETS)`, pool of `DEPOSITOR_POOL_SIZE || depositors.count`; only
   the first `depositors.count` are seeded now, the rest join later via churn (`:103-112`).
4. **Existing vault?** `existingVault()` (`vault.ts:219-267`): summary read; revert selector `0xe64a6a36`
   = "no vault". A data-less failure is re-read 3× 5 s apart, then the provider is probed with
   `isAddManagedAccountEnabled()`; only a healthy probe means "no vault". Exited/liquidated → refuse
   ("bump INSTANCE and clear .env.MANAGER"). Existing live vault → skip creation, top up depositors only.
5. **Budget** — funding wallet must hold `seed + 10 + Σdeposits + 5×count` vbUSDC and
   `MGR_ETH + count × DEP_ETH` ETH (`:134-145`). Dry run stops here.
6. **Create** (`vault.ts:269-317`): `ensureFunded(manager, MGR_ETH, seed+25)`; encode the config (FIV: SDK
   `encodeFixedIncomeVaultConfigurationFields` with `effectiveTimestampInS: 0`; PSV: hand-encoded 7-field
   tuple); `createPayload` — if the provider answers `eip712Domain()`, the manager signs the config
   (EIP-712, type `FixedIncomeVaultConfiguration` / `ProfitShareVaultConfiguration`) and the payload
   becomes `abi.encode(config, signature)`, else plain `abi.encode(config)` (`:138-162`); **pre-check**:
   `eth_call addManagedAccount(manager, payload)` from the adapter address — a refusal throws with the
   decoded error name and nothing is sent (`:282-291`); `approve(adapter, seed+10)`; `adapter.deposit(seed,
   payload)`; poll liveness 16 × 6 s (FIV summary `[0] && !exited && !liquidated`; PSV manager shares > 0).
   Not live → error naming `ComposeFailed` and where the seed went (manager's exchange balance).
7. **Name** — if `SET_DETAILS=1` and the manager has API creds: `setVaultDetails` (failure is logged, not
   fatal, `:166-175`). Otherwise run `MODE=details` after `associate`.
8. **Seed depositors** (`:178-196`): skip wallets that already hold a balance; `ensureFunded(dep, DEP_ETH,
   amount+5)`; `depositTo` — sleep `SETTLE_MS`, check the wallet still holds the amount on-chain (else a
   prior attempt ComposeFailed into its exchange balance → give up), `approve`, `adapter.deposit(amt,
   depositToManagedAccount payload)`, poll 12 × 6 s for `pending == 0 && numDepositors >= expected &&
   costBasis rose`. Up to 3 attempts (2 in churn). HEAD only: if the vault's pending deposit for the
   wallet rose by the amount, treat it as queued and do NOT re-send (`:371-378`, not in the running image).
9. **Verify** at one pinned block (`readVault`), print conservation (`depositorNetDeposits` vs Σdeposits −
   count × $0.05), write `OUT_DIR/<strategy>-<instance>.json` (manager, provider, exchange, depositors,
   verified state) (`:199-225`).

Order used in practice: `associate` (also generates wallets) → `fund` (optional) → `provision` →
`details` (if creds arrived after provision) → `animate`. The 2026-10-21 dev rollout ran bulk-fund →
provision (parallel, pre-funded so no funding-wallet txs) → associate → details (log, 10-21).

## 5. Animate loop (`MODE=animate`, `animate.ts:43-184`)

Startup: validate strategy + type match; `churnOn = CHURN_ENABLED ?? strategy.churn.enabled`, `mmOn =
MM_ENABLED ?? strategy.marketMaking.enabled` (`:49-50`); load manager + pool WITHOUT generating
(`:63-65`); load/seed churn schedule; MM only if the manager row has API creds (`:73-80`).

Every `TICK_SECONDS` (default 30):
1. `readVault` (on-chain, pinned). Revert `0xe64a6a36` → log "No vault exists" and **return** (process
   exits). Exited or liquidated → **return**. (`:88-110`)
2. **Market making**, at most every `marketMaking.refreshSeconds` (`:112-164`):
   - `GET /markets` (unauthenticated) for the configured markets; skip markets not listed.
   - **RWA session gating**: a market whose `tradingSessionStatus` is set and ≠ `open` (XAU/XAG/WTI close
     daily and at weekends) is skipped for signals, seeding, taker and quoting this cycle; logs
     `<MKT> session <status> — not quoting, reopens ~HH:MMZ` from `approximateNextOpenTime`. Its resting
     orders are NOT cancelled by the daemon (`:115-123`).
   - `fetchNetPositions` = authenticated `getWallets` → signed base quantity per market.
   - Signal per open market (`evaluateSignal`, `GET /candles`) → bias −1/0/+1.
   - **Seed positions** once per process (`SEED_POSITIONS`, compose default 2): for markets with no
     position, one market order of `quoteNotionalUsd` in the signal's direction; bias 0 → none
     (`mm.ts:143-183`). The flag is in memory, so every container restart may open seed positions again.
   - **Taker trade** every `TAKER_EVERY_S` (0 = off): per market, after the cancel and before the new
     ladder, one market order of one clip (`quoteNotionalUsd / index`, step-snapped): with the signal until
     `(|pos| + clip) × index > maxPositionUsd`, then one clip back (trim/re-add at the cap); against the
     signal → reduce first; no signal → work toward flat; sent with `selfTradePrevention: co`
     (`mm.ts:193-231`).
   - **Requote** each market (`mm.ts:260-293`): `cancelOrders({market})` (all of the manager's orders on
     that market) → optional taker → `getOrderBookLevel1` (best bid/ask of OTHER orders, read after our
     cancel) → `buildSkewedQuotes` → one `createOrder` per level, `limit`, `timeInForce: gtx` (post-only).
3. **Churn** after MM (`:169-172`, `churn.ts:80-190`): wallets whose scheduled time passed, at most 4 per
   tick; `readVault` once; headroom = strategy `maximumNetDeposits` − on-chain `depositorNetDeposits`;
   `decide()`; deposit = `ensureFunded(DEP_ETH, amount+5)` + `depositTo(attempts 2)`; withdraw = on-chain
   local withdrawal (FIV by quantity; PSV by shares, see section 6); reschedule (normal = uniform
   `intervalHoursRange` × `TIME_SCALE`; "short" retry = /8). State is saved only when ≥ 1 action succeeded.
4. Errors in a tick are logged `! tick error: …` and the loop continues. `ONESHOT=1` with `EXECUTE≠1`
   exits after one tick (dry-run preview, `:178-181`).

**The ladder** (`buildSkewedQuotes`, `mm.ts:61-114`), per market:
- Midpoint = **index price** from `GET /markets` — never the book mid.
- `maxQty = maxPositionUsd / index`; inventory ratio `r = clamp(net / maxQty, −1, 1)`; `k = skewStrength`.
- Offset multipliers: reducing side (sell when long, buy when short) `1 − k|r|` → pulled toward index;
  adding side `1 + k|r|` → pushed away. Size: adding side × `(1 − 0.5·k|r|)`.
- Level `i` (0-based) of `ordersPerSide`: `step = index × priceRangePct / ordersPerSide`; offset =
  `max(tick, step × (i+1) × mult)`; price = index ∓ offset, snapped away from mid (bids down, asks up) and
  sent as an 8-decimal string; qty = `max(takerOrderMinimum, quoteNotionalUsd/index) × sizeMult × (1 −
  0.05 i)`, snapped down to `stepSize` (never below the taker minimum), 8 decimals.
- **Held inside the book**: bids may not go above `bestOtherAsk − tick`, asks not below `bestOtherBid +
  tick`; a level that would cross is placed AT that bound and the bound moves one tick further out for the
  next level (`:91-101`). The log line then shows `(N held inside the book: bid X / ask Y)`. Consequence:
  when other resting orders sit away from index, that side of the ladder follows them instead of index.
- Levels at/through index are dropped (`bid ≥ index`, `ask ≤ index`, `:103-104`).
- The signal does NOT move the ladder directly; it only sets seed/taker direction, and the resulting
  inventory skews the ladder.

Log line per market: `<MKT> idx=<index> net=<pos> r=<r> LONG|SHORT|flat → buyOffset xA sellOffset xB
[(N held inside the book: bid X / ask Y)] quotes=<n>`; tick header `[<UTC time>] depositors=<n>
owed=$<x>|value=$<x> price=$<p> pending=$<x>`.

**Churn decision** (`decide.ts:59-130`): feasible deposit ⇔ headroom ≥ $1; feasible withdrawal ⇔ wallet
has a balance AND has API creds in its row AND `availableToWithdraw ≥ $1` (`:65-67`; creds are still
required although the withdrawal itself is on-chain and uses none). Nothing feasible → "short" retry if a
limit window is the cause. A wallet with no balance can only join (amount uniform in
`depositors.amountUsdRange`). Otherwise weights `depositWeight × (1 − fill)` vs `withdrawWeight × fill`,
boosted by drift from a deterministic per-wallet target; size = `depositPctOfBalanceRange` /
`withdrawPctOfBalanceRange` of the wallet's balance, clamped and rounded to cents.

## 6. FIV vs PSV in the code

| Aspect | FIV | PSV |
|---|---|---|
| Selected by | `VAULT_TYPE=FIV` (default) | `VAULT_TYPE=PSV` + strategy `"vaultType": "PSV"` (must match, `provision.ts:41-44`, `animate.ts:45-47`) |
| Strategy `vault` block | `interestApyPct exitMultiplier managerWithdrawMultiplier` + common | `carryFeePct managementFeePct` + common |
| Common fields | `maximumNetDeposits unappliedAgeS withdrawalLimitPctDepositors withdrawalLimitPctVault` | same |
| Extra validation | deadlock-band + exit-reachability warnings (`strategy.ts:193-217`) | none |
| Config encoding | SDK `encodeFixedIncomeVaultConfigurationFields`, 9 fields incl. `effectiveTimestampInS = 0` | `encodePsvConfig`, 7-field tuple `(manager, carry, mgmtFee, maxNet, age, depLimit, vaultLimit)`; pips, 1e8 = 100 % |
| EIP-712 type | `FixedIncomeVaultConfiguration` | `ProfitShareVaultConfiguration` (`vault.ts:125-136`) |
| Summary read | fixed indices on the first 14 words: `[0]` isDepositEnabled (code comment says isActive), `[1]` exited, `[2]` liquidated, `[9]` depositorNetDeposits, `[10]` numDepositorWallets, `[12]` totalOwed, `[13]` depositorPending (`vault.ts:55-66`) | `psvSummary()` decodes by field name; word count 20 (providers from 2026-10-20, extra `exchangeCarryFeeMultiplier`) or 19 (older) (`vault.ts:99-117`) |
| Live after create | summary flags | manager's shares > 0 (`loadVaultBalanceForWallet[5]`) |
| Wallet balance ("owed") | `loadVaultBalanceForWalletSummary`: `[0]` costBasis `[2]` locked `[3]` owed `[4]` pending `[5]` availableToWithdraw | same view, PSV layout `[0]` costBasis `[2]` pending `[3]` sharesAvailable `[4]` sharesLocked `[5]` totalShares, × `loadSharePrice`; "owed" = shares × price |
| Churn withdrawal | `withdrawByQuantity(qty)`, `maxShares = 10 × qty` | `withdrawByShares(shares, minimumQuantity = max($1, 50 % of target))`; target ≥ $1.05, shares sized at the same-read price and capped at available, skipped if < $1.05 (`churn.ts:37,152-161`) |
| Drift-check key in `GET /exchange` | `fixedIncomeVaultProviderV1ContractAddress` | `profitShareVaultProviderV1ContractAddress` |
| Daemon log | `owed=$…` | `value=$… price=$…` |

## 7. What is read on-chain vs via REST

| Data / action | Path | Where |
|---|---|---|
| Provider/exchange addresses, creation minimum/fee, deposit fee | REST `GET /exchange` (plain `fetch`) | `provision.ts:68` |
| Vault summary, wallet balances, share price, `eip712Domain`, `isAddManagedAccountEnabled` | RPC `eth_call` | `vault.ts` |
| Vault creation, deposits, ETH/vbUSDC funding, approvals | RPC txs (manager / depositor / funding wallet) | `vault.ts` |
| Depositor withdrawals | RPC tx to the provider (local withdrawal) | `withdraw-onchain.ts` |
| Market list, index price, tick/step/minimums, session status | REST `GET /markets` (plain `fetch`) | `animate.ts:24-41` |
| Candles for signals | REST `GET /candles` (plain `fetch`) | `signals.ts:26-35` |
| Best bid/ask | SDK public `getOrderBookLevel1` | `mm.ts:234-239` |
| Manager positions | SDK auth `getWallets` | `mm.ts:242-253` |
| Orders (cancel, limit gtx, market) | SDK auth `cancelOrders`, `createOrder` | `mm.ts` |
| Wallet association | SDK auth `associateWallet` | `associate.ts` |
| Vault name/description | SDK internal `setVaultDetails` (EIP-712 signed by the manager) | `withdraw.ts:32-36` |

Plain `fetch` calls send `User-Agent: ikon-vaultgen` and no auth. All SDK auth calls use the wallet row's
API pair (one API key = one ACCOUNT; any number of wallets can be associated into it).

## 8. Contract calls and payload layouts

- Adapter: `deposit(uint256 quantityInAssetUnits, bytes payload)` (selector `0x5d303519`, minimal ABI,
  `vault.ts:73`); the caller approves the adapter first. vbUSDC has 6 decimals; protocol amounts are pips
  (1e8).
- Creation payload: `abi.encode(uint8 addManagedAccount, (uint32 LZ_ENDPOINT_ID, address provider, address
  manager, bytes providerPayload, bytes ""))` (`vault.ts:292-296`).
- Deposit payload: `abi.encode(uint8 depositToManagedAccount, (uint32 LZ_ENDPOINT_ID, address depositor,
  address provider, address manager, bytes ""))` (`vault.ts:355-359`).
- A refused compose does not revert the tx: the adapter emits `ComposeFailed` and credits the amount to
  the sender's EXCHANGE balance (README; `vault.ts:7-12`). That is why creation is pre-checked and deposits
  are confirmed from vault state, never from the receipt.
- Withdrawal structs: see `withdraw-onchain.ts:42-44` (FIV, 12 fields) and `:117-119` (PSV, 13 fields).

## 9. Where README / comments and code disagree

- README "Strategies" table (`conservative-income`, `delta-neutral-basis`, `balanced-growth`,
  `high-yield-aggressive`, `market-making-desk`, `retail-starter`) and `docker/sandbox/start.sh` comments
  use OLD ids. Current ids: `ema-trend rsi-pullback macd-crossover donchian-breakout market-making
  bollinger-fade gold-trend psv-*` (run `MODE=list` or read `strategies/*.json`).
- README says depositor withdrawals are authenticated REST; code withdraws on-chain (`churn.ts:139-169`),
  but `decide.ts:65-67` still requires creds on the wallet row.
- README "seeds capped at $1,000" — not enforced in code (only the $110 floor is).
- `config.ts:74` comment lists `provision | animate | list`; the real set is the six in section 2.
- `vault.ts:61` calls summary word `[0]` "isActive"; the SDK typechain names it `isDepositEnabled`.
- `strategy.ts:43-53` PSV bounds (carry ≤ 99.999999 %, fee ≤ 1000 %/yr) are older than the 2026-10-20 PSV
  (carry ≤ 50 %, fee ≤ 10 %/yr per the 2026-10-21 bounds sweep in the log); the creation pre-check catches
  it (`CarryFeeMultiplierOutOfRange` / `ManagementFeeMultiplierOutOfRange`) before anything is sent.
- `signals.ts:9-11` says the bias decides "which way the ladder leans"; the ladder only leans by inventory.
- `provision.ts:72-83` and the staging/sandbox `.env.*.example` say PSV exists on dev only. On 2026-11-17
  staging's `GET /exchange` lists a PSV provider (`0x90ee1F46…`, creation enabled); sandbox still `0x0`.
