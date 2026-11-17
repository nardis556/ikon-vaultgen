# vaultgen gotchas

Each entry: symptom → cause → fix → where. "log" = `kperps-test/CLAUDE.md` (date given). Paths relative to
`ikon-vaultgen/`. Ordered roughly by how likely they bite today.

## Contents
- A. Deployment state: 1 adapter switch · 2 re-send fix not deployed · 3 env/image need recreate · 4 provision refuses on dev · 5 GHCR staleness
- B. Wallets, funding, chain: 6 EISDIR · 7 nonce collisions · 8 existingVault misread · 9 creation minimum · 10 MGR_ETH/DEP_ETH burn · 11 low dev funding · 12 RPC/API rate limits · 13 dev faucet · 14 Python 403
- C. Trading: 15 self-trade prevention · 16 stale orders pull the ladder · 17 taker price limit · 18 seed positions on every restart · 19 stale XAU candles · 20 closed RWA session · 21 precision
- D. Churn and vault rules: 22 PSV withdrawals below $1 · 23 depositors without creds never withdraw · 24 exit-eligible during a stall · 25 PSV bounds stale · 26 multiplier design · 27 churn state not saved
- E. Ops and tooling: 28 staging API secret mix-up · 29 restart loop · 30 FRESH_WALLETS dir · 31 pool size raised · 32 name length · 33 required vars in every mode · 34 `docker logs --since` · 35 retired dirs · 36 stale docs/examples · 37 type errors

## A. Deployment state

### 1. Dev churn deposits failed after the 2026-11-13 adapter switch (fixed 2026-11-17)
- **Symptom:** dev daemon logs `! attempt 1 did not settle (compose race)`, `! attempt 2 …`, then `✗ DEPOSITORnnn top-up`. In the logs of 2026-11-15→17 every dev daemon had 0 successful churn deposits (4–14 failures each) while staging/sandbox deposits succeeded and dev withdrawals still worked.
- **Cause:** dev governance replaced the Exchange's bridge adapters on 2026-11-13 22:18 UTC; `GET /exchange` → `bridgeAdapters.localDepositAdapterV1KatanaContractAddress` is now `0x8d74c0A36B460457cf29cb93d9a3FB02Faf5b71d`. The dev daemons' `LOCAL_DEPOSIT_ADAPTER` still names the old `0x4Ef81360…` (log 11-14: 43 vault deposits, $690.22 from 22 vaultgen wallets refused and double-sent; the money sits as pending plain deposits on the depositors' Exchange balances). `provision.ts` never checks the adapter.
- **Fix:** set `LOCAL_DEPOSIT_ADAPTER=0x8d74c0A36B460457cf29cb93d9a3FB02Faf5b71d` in `docker/dev/.env.dev` (check `docker/dev/.env` does not override it: `grep -c '^LOCAL_DEPOSIT_ADAPTER=' docker/dev/.env`), then recreate the 11 dev daemons with `EXECUTE=1` (#3) — ask the user first. Recover the stranded Exchange balances separately (withdraw + sweep). Before any provision, compare the adapter with `GET /exchange` yourself.
- **Status:** fixed on 2026-11-17 at 18:56 UTC — `docker/dev/.env.dev` now names `0x8d74c0A3…` (backup `.env.dev.bak-2026-11-17`, mode 600), and the 11 dev daemons were recreated with `EXECUTE=1 SEED_POSITIONS=2 … up -d --force-recreate --no-deps animate` (same image). The deposits refused before the fix are still pending plain deposits on the depositors' Exchange balances. The same break will recur at the next adapter switch on any env: check `docker exec <c> printenv LOCAL_DEPOSIT_ADAPTER` against `GET /exchange` whenever deposits start failing.
- **Where:** `src/config.ts:39`, `src/vault.ts:73-75,299-300,360`; log 2026-11-13/14 (A60).

### 2. The deposit re-send fix is in source but NOT deployed
- **Symptom:** the same churn deposit sent twice ~100 s apart (dev dispatcher stall 2026-10-26: $6.23 ×2, $11.22 ×2 …).
- **Cause:** the running `depositTo` re-sends when the apply is not visible after 12 × 6 s; churn passes `attempts: 2` and `ensureFunded(amount + 5)` leaves room for a second send.
- **Fix:** `src/vault.ts:371-378` (do not re-send when the vault's pending deposit for the wallet rose by the amount), committed in `97d646c` (2026-10-27). The running `ikon-vaultgen:local` (built 2026-10-21 14:31 CDT) lacks exactly these lines — verified 2026-11-17 by diffing `/app/src` from the containers. Deploy = `docker build -t ikon-vaultgen:local .` + recreate the daemons; ask first (log 10-26: "do NOT redeploy vaultgen for now"). Note: the guard only covers dispatcher lag. A deposit refused into the Exchange balance (#1) is still re-sent whenever the wallet still holds ≥ the amount on-chain (always for top-ups ≤ $5, since churn funds amount + 5).
- **Where:** `src/vault.ts:324-383`, `src/churn.ts:128-133`; log 2026-10-26.

### 3. Env edits, a rebuilt image or `compose up` without EXECUTE do not do what you expect
- **Symptom:** after editing `.env.<env>`/`.env` or rebuilding, `docker restart` changes nothing; or after `docker compose up -d animate` the daemon logs `mode : DRY-RUN — nothing will be sent` and never quotes.
- **Cause:** env files are read and the image is bound when the container is CREATED; `docker start/restart` reuse both. The animate service sets `EXECUTE=${EXECUTE:-0}` from the host shell, which beats `.env.STRATEGY`.
- **Fix:** `cd docker/<env>/<dir> && EXECUTE=1 docker compose -p <p><dir> up -d --no-deps --force-recreate animate` (or `EXECUTE=1 ./animate.sh`). To resume a stopped daemon unchanged use `docker start <c>` (keeps `EXECUTE=1`).
- **Where:** `docker/*/*/compose.yml` (animate `environment:`); commit `344e7ed`.

### 4. Provisioning refuses on dev since 2026-11-14
- **Symptom:** `VAULT_PROVIDER mismatch — env says 0xC1e9…, the API serves 0x63DA…` (FIV) or `0x7C73…` vs `0x9332…` (PSV).
- **Cause:** the dev release of 2026-11-14 made `GET /exchange` name new providers (FIV `0x63DA1779…`, PSV `0x93329968…`). The live dev vaults stay on the 2026-10-20 providers (still whitelisted, daemons unaffected), but the drift guard blocks re-provision/top-ups. Creation flags 2026-11-17: `0x63DA` on, `0x9332` OFF, old FIV `0xC1e9` OFF, old PSV `0x7C73` on.
- **Fix:** new vaults go on the API-named provider (operations.md §9). PSV on dev cannot be created until creation is switched on (ask the user). Do not bypass the guard: deposits to a provider the backend does not service never apply.
- **Where:** `src/provision.ts:72-92`; log 2026-11-14.

### 5. A stale image runs silently (GHCR, `pull_policy: missing`)
- **Symptom:** `FATAL: Unknown MODE "associate" (provision | fund | animate | list)`, `Unknown STRATEGY "psv-…"`, or creation refused on a signed-creation provider.
- **Cause:** compose reuses any cached image. The local copy of `ghcr.io/nardis556/ikon-vaultgen:latest` is from 2026-10-14 (no signed creation, no strategies 09-13).
- **Fix:** dev/staging/sandbox run `ikon-vaultgen:local` — rebuild locally. Demo envs: `./demo.sh pull` (needs GHCR auth) or switch `image:`.
- **Where:** README "Keeping the image current"; commit `7845b1b`.

## B. Wallets, funding, chain

### 6. EISDIR on a new strategy dir
- **Symptom:** `EISDIR: illegal operation on a directory, read` at start; root-owned DIRECTORIES `.env.MANAGER/` and `.env.DEPOSITORS/` appear in the dir.
- **Cause:** compose bind-mounts `./.env.MANAGER` and `./.env.DEPOSITORS`; when the host file is missing docker creates a directory, and `wallets.ts` `readFileSync` fails on it.
- **Fix:** before the first compose run: `touch .env.MANAGER .env.DEPOSITORS && chmod 600 .env.MANAGER .env.DEPOSITORS`. If the directories already exist, remove the two empty directories (root-owned: `sudo rmdir`) and create the files.
- **Where:** compose `volumes:`; `src/wallets.ts:23-24,50-53`; log 2026-10-16 gotcha (1).

### 7. Nonce collisions on a shared funding wallet
- **Symptom:** a provision or fund run dies mid-way (nonce too low / replacement underpriced / already known) and leaves a half-seeded vault; or churn top-ups fail while a provision runs.
- **Cause:** `ensureFunded` sends from the funding wallet; daemons (churn top-ups) and provision/fund/labs on the same wallet race for nonces. `rpcRetry` retries only rate-limit and transport errors.
- **Fix:** one writer per funding wallet. Staging `0x42936143…` and sandbox `0x5C097189…` are dedicated; dev uses Test Wallet 2 `0x2d9a1d2c…`, which the foundry-tests labs also use (log 11-17) — stop the dev daemons or pause the labs while provisioning dev, or pre-fund every wallet first (then provision sends no funding tx). Never run two provisions in parallel unless pre-funded.
- **Where:** `src/vault.ts:37-53,200-211`; log 2026-10-16 gotcha (2).

### 8. `existingVault` misread a live vault as missing (fixed)
- **Symptom (2026-10-15, dev):** re-running provision to set names re-ran creation and re-seeded all depositors: rsi-pullback +$600 + 10 deposits, market-making +$800 + 3 deposits (test money stayed inside those vaults).
- **Cause:** under RPC rate limiting `loadVaultSummary` failed without revert data; the old code took "no data + healthy probe" as "no vault".
- **Fix (in code and image):** 3 re-reads 5 s apart before the liveness probe. Still: never re-run provision to rename — use `MODE=details`; use the keyed RPC; one provision at a time.
- **Where:** `src/vault.ts:219-267` (re-read loop `:251-256`); `src/details.ts`; log 2026-10-16 (4).

### 9. The 100-vbUSDC creation minimum (seed ≥ $110)
- **Symptom:** the creation tx succeeds, no vault appears, the adapter emits `ComposeFailed("Initial deposit below minimum")`, the seed lands in the manager's Exchange balance.
- **Cause:** `vaultCreationMinimum` $100 applies after the $10 `vaultCreationFee` is taken from the seed.
- **Fix:** `seed.managerSeedUsd ≥ 110` (validated, and re-checked against live `GET /exchange` fees). A stranded seed is recoverable from the manager's Exchange balance. Related: on dev since 2026-11-13 the compose library keeps the $10 fee when the vault is created but its seed deposit is refused (log 11-14).
- **Where:** `src/strategy.ts:28-29,135-140`, `src/provision.ts:93-100`; log 2026-06-06 (E12).

### 10. Default MGR_ETH / DEP_ETH burn the funding wallet's ETH
- **Symptom:** funding ETH drains ~0.05–0.09 ETH/day with ~14 daemons (2026-09-15/16); dead wallets each park 0.002–0.004 ETH.
- **Cause:** defaults `MGR_ETH=0.004`, `DEP_ETH=0.002` (also in every example env); churn tops EVERY acting depositor up to `DEP_ETH`; a Bokuto tx costs about 0.00001 ETH or less.
- **Fix:** lower them in `.env.<env>` (e.g. `MGR_ETH=0.0005`, `DEP_ETH=0.0002`; keep a margin — the node pre-checks gasLimit × maxFee + an L1 estimate per tx; the staging labs run at 0.00003) and recreate the daemons. Sweep ETH from retired wallets back.
- **Where:** `src/config.ts:61-62`, `src/vault.ts:200-205`, `src/churn.ts:128`; log 2026-09-16.

### 11. Dev funding wallet may be nearly empty
- **Symptom:** `funding wallet short $…` in provision dry runs; churn top-ups fail on the vbUSDC transfer.
- **Cause:** Test Wallet 2 held ~$502 after the user moved its vbUSDC on 2026-11-17 00:19 UTC (log); dev churn draws from it.
- **Fix:** check `cast call 0xc2a4C310F2512A17Ac0047cf871aCAed3E62bB4B "balanceOf(address)(uint256)" 0x2d9a1d2c74b20a1be24ffc4e680a716fcc068f8f --rpc-url https://rpc-bokuto.katanarpc.com/` before relying on dev churn; ask before topping it up.
- **Where:** `src/provision.ts:134-145`; log 2026-11-17.

### 12. RPC and API rate limits
- **Symptom:** `… rate-limited/transient (attempt n/6) — retrying`, JSON-RPC `-32017`; `! tick error: GET /markets failed: HTTP 429` (vgdev-ema-trend 2026-11-17); 429s on `/markets` `/candles` when many daemons start together.
- **Cause:** the public Bokuto RPC rate-limits inside HTTP 200; ~18 daemons each read 16 wallets per tick. REST limits on bursts.
- **Fix:** keyed Conduit RPC with `RPC_ACCESS_KEY` as a header (operations.md §10); stagger restarts; a single 429 tick is harmless.
- **Where:** `src/vault.ts:37-53,183-191`; log 2026-10-15, 2026-10-21.

### 13. Dev faucet credits associated wallets
- **Symptom:** freshly associated dev depositor wallets show $1,000 on their Exchange balance; sweeps return more than was sent.
- **Cause:** the dev faucet EOA `0x00e61818…` pays $1,000 on API association or first Exchange deposit (depositors yes, managers no on 2026-10-19).
- **Fix:** expected on dev; do not count it as vault money.
- **Where:** log 2026-10-16, 2026-10-19.

### 14. Python HTTP clients get 403 from the Bokuto RPC
- **Cause:** user-agent filtering. **Fix:** use node/ethers or `cast`. **Where:** log 2026-10-16 gotcha (3).

## C. Trading

### 15. Self-trade prevention is per API account
- **Symptom:** a taker order reports `filled` but no trade exists; vaults never fill each other; a taker buy fills 0.081 of 0.1 with 0.019 dropped.
- **Cause:** STP applies across all wallets of one API ACCOUNT. Default `dc` decrements against any resting order of the same account: another vault's manager, an abandoned loadgen wallet, or the 14 staging-loadgen wallets that share the staging vaultgen account (log 10-26).
- **Fix:** spread managers of vaults on the same markets across accounts (dev: 5 accounts, 3/2/2/2/2). Taker trades send `selfTradePrevention: co`, which cancels the resting same-account order (possibly a sibling vault's quote) and keeps matching; seed-position market orders use the default.
- **Where:** `src/mm.ts:169-174,214-222`; log 2026-10-16 (API Info), 2026-10-21 PM.

### 16. Stale resting orders pull the ladder ("held inside the book")
- **Symptom:** quote lines show `(N held inside the book: bid X / ask Y)` with prices far from `idx`; one side of the ladder sits next to someone else's orders; taker fills print away from index; index-marked PnL skews (±3.5 % on dev, Oct 2026). Before 2026-10-21 every crossing bid was gtx-cancelled → one-sided book, no trades.
- **Cause:** the ladder is centred on index but clamped one tick inside the best OTHER order. From 2026-10-14 a stopped loadgen left ~1,000 orders 3.2–4.2 % below index on dev BTC/ETH/SOL (its keys are not on this box). The public book can also keep orders that already filled until the next book event (A33).
- **Fix:** clear stale orders at the source (restart the owning loadgen with `INITIALIZE_ACCOUNTS=true` where its keys live, or ask the owner); vaultgen cannot cancel other wallets' orders. Judge quoting by `quotes=N`, not by distance to index.
- **Where:** `src/mm.ts:24-27,91-104`; log 2026-10-21 PM; A33 in the reports.

### 17. Taker trades refused on thin books
- **Symptom:** `✗ ETH-USD taker buy 0.068: Unable to execute order. Execution price exceeds 0.26 market order price limit.` (dev 2026-11-17).
- **Cause:** the exchange's market-order price protection on a thin book.
- **Fix:** none needed (the next clip retries); lower `quoteNotionalUsd` or set `TAKER_EVERY_S=0` for that env if it repeats.
- **Where:** `src/mm.ts:193-231`.

### 18. Every restart may open seed positions
- **Symptom:** right after a restart/recreate a vault sends market orders of `quoteNotionalUsd` per market.
- **Cause:** `seeded` is per process; compose defaults `SEED_POSITIONS=2` (the `.env.STRATEGY` value is overridden); markets with no position and a non-zero signal get an order.
- **Fix:** expected. Recreate with `SEED_POSITIONS=0` in the shell if unwanted.
- **Where:** `src/animate.ts:84,143-155`; compose animate `environment:`.

### 19. Stale XAU candles on staging drive gold-trend's signal
- **Symptom:** `XAU-USD SHORT EMA20 3428.70 < EMA50 3752.61 → short` every cycle while the XAU index is ~3862 (identical numbers on 2026-09-22 and 2026-11-17).
- **Cause:** staging `GET /candles?market=XAU-USD&interval=1h` returns old history. **Fix:** accept for a demo, or use `signal: none`; report upstream if it matters.
- **Where:** `src/signals.ts:26-35`; log 2026-09-22.

### 20. A closed RWA session leaves the vault's orders alone
- The daemon skips quoting a market whose `tradingSessionStatus` ≠ `open` but does not cancel its resting orders there; what the exchange does with them at the close is unverified. **Where:** `src/animate.ts:115-123`.

### 21. Number formatting
- Prices and quantities must be 8-decimal strings snapped to tick/step (`"100.3"` → bare HTTP 400); USD amounts go through `toFixed(2)` before `parseUnits` (float residue like `11.2800000000002` is rejected). Order errors live in `e.response.data`, not `e.message`. **Where:** `src/mm.ts:43-50,117-126,286-289`, `src/vault.ts:338-341`, `src/decide.ts:132-137`; commit `17b33a9`.

## D. Churn and vault rules

### 22. PSV withdrawals at a share price below $1 (fixed, deployed)
- **Symptom (2026-10-16/19):** PSV churn withdrawals cancelled by the dispatcher; the depositor silently loses 0.05 shares (gas) and receives nothing.
- **Cause:** a local by-shares withdrawal worth less than its signed floor is cancelled for the $0.05 gas; a $1.00 target with a $1.00 floor fails whenever the price is < $1.
- **Fix:** target ≥ $1.05, floor = max($1, 50 % of target), shares sized at the same-read price and capped at the available shares, skip below $1.05 — in source and in the 2026-10-21 image.
- **Where:** `src/churn.ts:37,144-161`, `src/withdraw-onchain.ts:136-139`; log 2026-10-16 PM.

### 23. Depositors without API credentials never withdraw
- **Symptom:** a wallet only ever joins/tops up; `vault is at its deposit cap and this wallet has no API credentials to withdraw`.
- **Cause:** `decide()` requires API creds on the depositor row although churn withdraws on-chain without them (REST route answered 401, commit `17b33a9`).
- **Fix:** run `associate` with `DEPOSITOR_API_*` set (stamps creds on every pool row), or change `decide.ts` (rebuild).
- **Where:** `src/decide.ts:65-67`, `src/churn.ts:108`.

### 24. A backend stall makes vaults exit-eligible to anyone
- **Symptom:** during a dispatcher stall a depositor can call `exitWallet` (dev donchian, exit age 1 h, exitable 2026-10-26 16:03–19:53 UTC).
- **Cause:** churn queues real withdrawals; an item older than `unappliedAgeS` opens the queue-age exit (by design). donchian strategies use 3600 s.
- **Fix:** during a known stall stop the daemons (or recreate with `CHURN_ENABLED=0`); prefer ≥ 6 h ages for demo vaults.
- **Where:** `src/strategy.ts:162-166`; log 2026-10-27/28.

### 25. PSV fee bounds in `strategy.ts` are older than the deployed PSV
- **Symptom:** provision stops with `the provider refuses this vault configuration: CarryFeeMultiplierOutOfRange(value, max, min)` or `ManagementFeeMultiplierOutOfRange(…)` — nothing sent.
- **Cause:** validation allows carry ≤ 99.999999 % and fee ≤ 1000 %/yr; the 2026-10-20 PSV caps carry at 50 % and the fee at 10 %/yr (log 10-21 bounds sweep).
- **Fix:** keep carry ≤ 50, fee ≤ 10 (current strategies use ≤ 25 / ≤ 3); optionally tighten `PSV_BOUNDS`.
- **Where:** `src/strategy.ts:46-53`, `src/vault.ts:165-170,282-291`.

### 26. Exit vs manager-withdraw multipliers (strategy design)
- With `exitMultiplier > managerWithdrawMultiplier` (ema, rsi, macd, mm, bollinger) a valid manager withdrawal can make the vault exit-eligible (proven on staging 2026-09-21); with `exit < mgrWithdraw` (gold-trend 0.95/1.0) there is a deadlock band and the EAV exit cannot fire while solvent (validator warns). vaultgen never withdraws as manager, so this only matters if someone does. **Where:** `src/strategy.ts:193-217`; log 2026-09-21/22.

### 27. Churn state is saved only when an action succeeded
- Code reading (impact unverified): reschedules of skipped/failed wallets stay in memory unless something succeeded in that tick, so after a restart those wallets are due again at once. **Where:** `src/animate.ts:169-172`.

## E. Ops and tooling

### 28. Staging API secret mix-up (`INVALID_HMAC_SIGNATURE`)
- **Symptom:** every authenticated staging call fails `INVALID_HMAC_SIGNATURE`; `associate` prints `✗` but exits 0 and stamps the wrong pair into the wallet files; MM and details fail.
- **Cause:** `.env.staging` `MANAGER_API_SECRET`/`DEPOSITOR_API_SECRET` held another account's API KEY (36 chars, UUID-shaped); secrets are 32 chars. The staging loadgen's own `.env` `API_SECRET` had the same wrong value.
- **Fix (2026-10-26):** use the 32-char secret paired with the same key in `ikon-loadgen2/docker/staging/markets/.env.ACCOUNTS` (never print it), re-run associate, recreate the daemons. Length-only check (prints a number, not the secret): `awk '/^MANAGER_API_SECRET=/{sub(/^[^=]*=/,""); print length($0)}' docker/staging/.env.staging` → 32.
- **Where:** `src/associate.ts:91-103`; log 2026-10-15, 2026-10-26.

### 29. Restart loop on a vault-less, exited or liquidated manager
- **Symptom:** the container restarts repeatedly; logs repeat `No vault exists for manager …` or `vault is exited — stopping the daemon`.
- **Cause:** animate returns (exit 0) in those states and `restart: unless-stopped` restarts it. **Fix:** `docker stop <c>`; provision first, or retire the dir.
- **Where:** `src/animate.ts:95-110`.

### 30. Never animate a FRESH_WALLETS dir
- `dev/psv-ema-trend` (`FRESH_WALLETS=1`) mints a new manager every process → restart loop with "No vault exists". It is left out of `animate.sh`. **Where:** `docker/dev/animate.sh:12-16`; commit `81e73a6`.

### 31. Raising `DEPOSITOR_POOL_SIZE` after provisioning
- **Symptom:** animate exits: `Depositor pool has 16 of 20 wallets … Set GENERATE_WALLETS=1`. **Cause:** animate and details never generate wallets. **Fix:** run `associate` (or `fund`/provision) with `GENERATE_WALLETS=1` first — associate also stamps creds on the new rows. **Where:** `src/animate.ts:63-65`, `src/wallets.ts:135-138`.

### 32. Vault name over 30 characters
- `VAULT_NAME_PREFIX + " " + display.name` > 30 → provision/details throw before any call. **Where:** `src/strategy.ts:108-114`.

### 33. Every MODE needs every required env var
- `MODE=details` or `list` without `FUNDING_WALLET_KEY` etc. → `FATAL: Missing required env var`. Run through compose so the env files load. **Where:** `src/config.ts:17-58`.

### 34. `docker logs --since` returns nothing for some containers
- On 2026-11-17 `--since 10m` gave 0 lines for vgdev-market-making and vgdev-ema-trend while they logged every 30 s. Use `docker logs --tail N -t <c>` and read the timestamps.

### 35. Retired dirs are not runnable as-is
- `dev/retired-2026-10-20/` has `.env`/`.env.dev` symlinks; the staging and sandbox retired folders do not, so their composes load no env file. Sandbox also changed funding wallet on 2026-10-26. Retired dev PSV composes mount `../../../strategies`, one level too high from there — drop the mount. **Where:** each `retired-*/README.md`.

### 36. Stale docs and example files
- README strategy table and `docker/sandbox/start.sh` comments use old ids (`conservative-income`, `retail-starter`, `market-making-desk` …) — use `MODE=list`. README says depositor withdrawals use REST (they are on-chain). `.env.*.example` files name retired providers (staging `0x85Ea9016…`, sandbox/demo `0x9304FEeC…`) and the old dev adapter `0x4Ef81360…`; examples and `provision.ts:82-83` say PSV is dev-only, but staging's `GET /exchange` lists PSV `0x90ee1F46…` (2026-11-17). Trust `GET /exchange`.

### 37. Type errors are expected
- `npx tsc --noEmit` reports 14 pre-existing errors (vault.ts, withdraw-onchain.ts, withdraw.ts, staging-vault-lab.ts); `tsx` does not type-check, so they do not block runs. Compare the count before and after a change.
