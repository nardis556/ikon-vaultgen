# vaultgen configuration

Every knob, where it is set, and which file holds what. Secret values are never shown here — only
variable NAMES. `file:line` refers to `ikon-vaultgen/`.

## Contents
1. Precedence (compose and local runs)
2. Environment variables read by the product code
3. Variables used only by compose, scripts and side tools
4. Files: per-strategy dir and env level
5. Current per-environment values (non-secret)
6. Strategy JSON schema (+ FIV vs PSV, signals, example, current strategies)

## 1. Precedence

**In a container (the normal case)** — compose `env_file` (`docker/<env>/<dir>/compose.yml`):

```yaml
env_file:
  - { path: ../.env.<env>, required: false }   # 1. env-level connection + secrets
  - { path: ../.env,       required: false }   # 2. env-level machine-local overrides
  - .env.STRATEGY                              # 3. per-strategy knobs (required)
environment:                                   # 4. beats every env_file
  - MODE=provision|animate|associate|fund      #    fixed per service
  - EXECUTE=${EXECUTE:-0}                      #    animate service only: from the HOST SHELL
  - SEED_POSITIONS=${SEED_POSITIONS:-2}        #    animate service only: from the HOST SHELL
```

- Later env_file wins; `environment:` beats all env_files; `docker compose run -e K=V` beats
  `environment:`. So for the `animate` service the `EXECUTE` and `SEED_POSITIONS` lines in
  `.env.STRATEGY` are dead — only the shell value counts (`.env.STRATEGY` `SEED_POSITIONS=1` on
  staging/gold-trend is overridden to 2).
- `${…}` interpolation reads the host shell (the strategy dirs have no compose `.env`).
- Env values are fixed when the container is CREATED. `docker start|restart` reuse them; after editing
  any env file, recreate the container (see operations.md).

**Local run** (`npx tsx src/index.ts` from the repo root): `config.ts:14-15` loads repo-root
`.env.STRATEGY` then `.env` without override → real process env > `.env.STRATEGY` > `.env`. Wallet files
then resolve to repo-root `.env.MANAGER` / `.env.DEPOSITORS` (`wallets.ts:23-24`), NOT a strategy dir —
prefer running through compose.

## 2. Environment variables read by the product code (`src/config.ts`)

All `required` vars are evaluated at import, so every MODE (even `list`, `details`) needs them.

| Name | Default | Req | Meaning | Used by |
|---|---|---|---|---|
| `BASE_URL` | – | yes | REST base incl. `/v1` (e.g. `https://api-dev.katana-perps-dev.com/v1`) | all |
| `CHAIN_ID` | – | yes | `737373` (Bokuto) | all |
| `SANDBOX` | `true` | no | SDK `sandbox` flag: selects the sandbox EIP-712 domain version for signed API requests and withdrawals | REST/SDK |
| `RPC_URL` | – | yes | JSON-RPC URL; with a key use the plain keyed host `https://rpc-katana-bokuto.t.conduit.xyz/` | all chain |
| `RPC_ACCESS_KEY` | `""` | no | SECRET. Sent as header `X-AccessKey` (`vault.ts:189`); lifts the public-RPC rate limit | all chain |
| `EXCHANGE_CONTRACT` | – | yes | Exchange address; provision refuses if ≠ `GET /exchange` | all |
| `VAULT_PROVIDER` | – | yes | provider for `VAULT_TYPE`; provision refuses if ≠ `GET /exchange` | all |
| `LOCAL_DEPOSIT_ADAPTER` | – | yes | adapter used for creation + every deposit; also the SDK `bridgeAdapterContractAddress` | provision, animate |
| `QUOTE_TOKEN` | – | yes | vbUSDC `0xc2a4C310F2512A17Ac0047cf871aCAed3E62bB4B` (6 decimals) | all |
| `LZ_ENDPOINT_ID` | `40448` | no | first field of the adapter payload tuple | provision, churn |
| `VAULT_TYPE` | `FIV` | no | `FIV` or `PSV`; must equal the strategy's `vaultType` | all |
| `STRATEGY` | – | yes | strategy `id` (the JSON `id`, not the file name) | all |
| `INSTANCE` | `1` | no | names `out/<strategy>-<instance>.json`, `state/churn-<strategy>-<instance>.json`, and the BIP-44 account when `POOL_MNEMONIC` is set | all |
| `FUNDING_WALLET_KEY` | – | yes | SECRET. Pays every seed, deposit top-up and gas top-up | provision, fund, animate (churn) |
| `POOL_MNEMONIC` | `""` | no | SECRET. Makes manager + pool deterministic (`wallets.ts:39-47`); blank = random | wallet generation |
| `FUND_DEPOSITOR_USD` | `""` | no | `MODE=fund` per-wallet vbUSDC target; blank = `ceil(amountUsdRange.hi × 1.8 + 5)` | fund |
| `MGR_ETH` | `0.004` | no | ETH target for the manager (top-up only if below) | provision, fund |
| `DEP_ETH` | `0.002` | no | ETH target per depositor; churn tops up EVERY acting depositor to it | provision, fund, animate |
| `MANAGER_API_KEY` / `MANAGER_API_SECRET` | `""` | no | SECRET. Account pair for managers; `associate` stamps it into `.env.MANAGER`; used directly only with `FRESH_WALLETS=1` | associate, provision (fresh) |
| `DEPOSITOR_API_KEY` / `DEPOSITOR_API_SECRET` | `""` | no | SECRET. Account pair for the pool (needed for withdrawals to be chosen by `decide`) | associate, provision (fresh) |
| `MODE` | `provision` | no | `associate fund provision animate details list` (compose sets it per service) | – |
| `EXECUTE` | `0` | no | `1` = send; anything else = dry run | all writing modes |
| `SET_DETAILS` | `1` | no | provision calls `setVaultDetails` when the manager has creds | provision |
| `VAULT_NAME_PREFIX` | `""` | no | prepended to `display.name` (`sb` on sandbox); total ≤ 30 chars or the run throws | provision, details |
| `GENERATE_WALLETS` | `1` | no | create missing wallet rows/files (animate and details never generate) | provision, fund, associate |
| `FRESH_WALLETS` | `0` | no | `1` = brand-new random wallets every run, nothing persisted, shared API creds from env | provision |
| `SETTLE_MS` | `15000` | no | wait before each deposit attempt (compose race after creation) | provision, churn |
| `DEPOSITOR_POOL_SIZE` | `0` | no | pool size; `0` = `depositors.count`. Every animated dir uses 16 (10 seeded + 6 join later) | all |
| `CHURN_ENABLED` | `""` | no | `1`/`0` forces churn; blank = strategy `churn.enabled` | animate |
| `MM_ENABLED` | `""` | no | `1`/`0` forces market making; blank = strategy | animate |
| `TIME_SCALE` | `1` | no | multiplies churn intervals (0.01 = a day in ~15 min); interest stays real time | animate |
| `TICK_SECONDS` | `30` | no | daemon loop sleep | animate |
| `SEED_POSITIONS` | `0` (compose: 2) | no | open up to N positions with market orders on the first MM cycle of each process | animate |
| `TAKER_EVERY_S` | `0` | no | one market clip per market toward the signal every N s; 0 = off (dev, staging, sandbox run 180 — taker cycles visible in all three logs; a flat `signal: none` vault sends nothing) | animate |
| `OUT_DIR` | `/app/out` | no | provision summaries | provision |
| `STATE_DIR` | `/app/state` | no | churn schedules | animate |
| `ONESHOT` | – | no | `1` with `EXECUTE≠1`: one tick, then exit (`animate.ts:178`) | animate dry run |

Not read by any code: `PSV_VAULT_PROVIDER` (documentation in `.env.dev`; PSV dirs set `VAULT_PROVIDER`
in their `.env.STRATEGY`), `NODE_ENV` (set by compose).

## 3. Compose, scripts and side tools

| Name | Where | Meaning |
|---|---|---|
| `EXECUTE` (shell) | `start.sh`, `animate.sh`, compose `${EXECUTE:-0}` | `EXECUTE=1 ./start.sh` asks for `yes`, then `run -e EXECUTE=1 vaultgen`; `EXECUTE=1 ./animate.sh` = `up -d animate` live; without it animate.sh runs a one-tick dry run (`ONESHOT=1`) |
| `SEED_POSITIONS` (shell) | compose animate service | default 2 |
| positional args | `start.sh`, `animate.sh` | strategy dir names to limit the run; `animate.sh --logs` tails all |
| `INTERVAL_S` | `run-staging-lab-loop.sh` | lab tick interval (1200) |
| `API_KEY API_SECRET WALLET_PK WALLET EXECUTE` (+ `BASE_URL CHAIN_ID EXCHANGE_CONTRACT SANDBOX`, staging defaults) | `src/associate-one.ts` | associate one wallet; secrets from env only, printed masked |
| `MODE=status\|initiate\|finalize`, `TARGETS` (JSON strategy→exit %), `CANCEL_PENDING=1` | `src/sandbox-set-exit-mult.ts` | 2026-09-17 one-off; reads the CURRENT `docker/sandbox/` env and keys, so it would act on today's sandbox vaults — `status` is read-only |
| `POINTS RESUME RATE_MIN FINALIZE MIN_MINT_ETH WINDOW_MIN DEPOSIT_ADAPTER` | `src/staging-*.ts` | lab knobs; labs also force their own `MGR_ETH`/`DEP_ETH` |

## 4. Files

**Per strategy dir `docker/<env>/<dir>/`**

| File | In git | Holds |
|---|---|---|
| `compose.yml` | yes | services `vaultgen` (provision, `restart: "no"`), `animate` (`restart: unless-stopped`), `associate`, `fund`; image; env_file order; mounts `./.env.MANAGER`, `./.env.DEPOSITORS` → `/app/…`, `./out`, `./state`. Exception: `dev/psv-ema-trend` (FRESH_WALLETS) has no wallet mounts and no associate/fund. |
| `.env.STRATEGY` | yes (allowlisted in `.gitignore`) | no secrets: `STRATEGY VAULT_TYPE INSTANCE [VAULT_PROVIDER] EXECUTE=0 GENERATE_WALLETS FRESH_WALLETS DEPOSITOR_POOL_SIZE SET_DETAILS SETTLE_MS CHURN_ENABLED MM_ENABLED TICK_SECONDS TIME_SCALE SEED_POSITIONS`. PSV dirs set `VAULT_PROVIDER` here; retired dirs append the OLD provider. |
| `.env.MANAGER` | no, mode 600 | SECRET. `MANAGER=address,privateKey,apiKey,apiSecret` |
| `.env.DEPOSITORS` | no, mode 600 | SECRET. `DEPOSITOR001..N=address,privateKey[,apiKey,apiSecret]`; index order ties a wallet to its seeded deposit — never reorder |
| `out/<strategy>-<instance>.json` | no | provision summary: name, manager, provider, exchange, seed, depositors + amounts, verified state (addresses only, no keys) |
| `state/churn-<strategy>-<instance>.json` | no | per-wallet next-action time + last 500 actions |

**Env level `docker/<env>/`**

| File | In git | Holds (names only) |
|---|---|---|
| `.env.<env>.example` | yes | template; secrets blank; provider/adapter addresses in it are STALE (section 5) |
| `.env.<env>` | no, 600 | SECRET. `BASE_URL CHAIN_ID SANDBOX RPC_URL EXCHANGE_CONTRACT VAULT_PROVIDER [VAULT_TYPE] [VAULT_NAME_PREFIX] LOCAL_DEPOSIT_ADAPTER QUOTE_TOKEN LZ_ENDPOINT_ID FUNDING_WALLET_KEY POOL_MNEMONIC MGR_ETH DEP_ETH MANAGER_API_KEY MANAGER_API_SECRET DEPOSITOR_API_KEY DEPOSITOR_API_SECRET RPC_ACCESS_KEY TAKER_EVERY_S` |
| `.env` | no, 600 | SECRET. Machine-local overrides read after `.env.<env>`: the keyed `RPC_URL` (plain host) + `RPC_ACCESS_KEY` (log 2026-10-15), corrected values |
| `.env.<env>.bak-YYYY-MM-DD` | no | SECRET backups made before edits — never open |
| `start.sh animate.sh stop.sh` (`demo.sh` for demo envs) | yes | runners (operations.md) |
| `retired-<date>/` | yes (READMEs, composes, `.env.STRATEGY`) | old sets with their keys (keys gitignored) |
| `sandbox/.exit-mult-upgrade-state.json` | yes | addresses + tx hashes of the 09-17 exit-multiplier upgrades |

`.dockerignore` excludes `docker/`, `.env*` (except `*.example`), `*.md`, `out`, `state`, `.git`, `.github`
— keys reach a container only through `env_file` and the two bind mounts.

## 5. Current per-environment values (non-secret)

Live sets as recorded in each dir's `out/*.json` (2026-10-21 dev, 2026-10-26 staging/sandbox). `GET
{BASE_URL}/exchange` is the authority; re-read it before provisioning.

| | dev | staging | sandbox |
|---|---|---|---|
| `BASE_URL` | `https://api-dev.katana-perps-dev.com/v1` | `https://api-staging.katana-perps-dev.com/v1` | `https://api-perps-sandbox.katana.network/v1` |
| Exchange | `0x18F7966C93C5b5d24Dbc7a1425FCe6cf5ebAa5e0` | `0x4C234fCeA3f8c4C8a7D962a6d8f2214f6ab1D5c4` | `0x92d3072dDe1aD3e9B7895500F504aA5e664E71d3` |
| Provider of the live vaults | FIV `0xC1e94AD07E6056AD594935fB069CA0bd35fB6E22`; PSV `0x7C7309595d98f04339c87e4aA09CBaF490FA7142` (both 2026-10-20, signed creation) | FIV `0x6B1cd16C903Eb613E5de94e3cD3E119c01C391d1` (2026-10-26) | FIV `0x8E670De99eE17bf877923A234E9A12d1e918fb7A` (2026-10-26) |
| `GET /exchange` names (read 2026-11-17 18:40 UTC) | FIV `0x63DA1779B6d134BBACe70102A5Ec90cf71Ce59cE`, PSV `0x9332996882329FDc17d3DC68821e9ef840350ae2` (2026-11-14 release) — NOT the live set's providers | FIV `0x6B1cd16C…` (= live set); PSV `0x90ee1F4678A66a1953969eD86cf6e57D0AEB098d` (new — staging now has a PSV) | FIV `0x8E670De9…` (= live set); PSV `0x0` |
| `isAddManagedAccountEnabled()` (2026-11-17) | `0x63DA…` true, `0x9332…` false, `0xC1e9…` false, `0x7C73…` true | `0x6B1c…` true, `0x90ee…` true | `0x8E67…` true |
| Local deposit adapter (`GET /exchange` → `bridgeAdapters.localDepositAdapterV1KatanaContractAddress`) | `0x8d74c0A36B460457cf29cb93d9a3FB02Faf5b71d` since 2026-11-13 22:18 UTC; the dev daemons' env was switched to it on 2026-11-17 (gotchas.md #1); the example still has the old `0x4Ef81360dE00B9f1f32847404C0D036FC6860F92` | `0xE827DABDE1A661AaE17bD4c18f9afA9bbb1aAfB8` (= example) | `0x65b9a7F10C0C984dB118435FA974eA80a5896ee7` (= example) |
| Fees (`GET /exchange` `vaults.*`, all envs) | creation min 100, creation fee 10, deposit fee 0.05, deposit min 1, withdrawal min 1, withdrawal fee 0 | same | same |
| Old providers (retired dirs) | FIV `0x46b4C417…`, PSV `0xC2AbBCB4…` | `0x85Ea9016acdEc997338F92B3E1256E9ae4aC9411` | `0x9304FEeCa70694B5d9BeFEB5577EF6182f158CeB` |
| Funding wallet | Test Wallet 2 `0x2d9a1d2c74b20a1be24ffc4e680a716fcc068f8f` — SHARED with the foundry-tests labs (log 10-21, 11-17) | dedicated `0x42936143CDaF2088184957e606A060A07f2a16Cb` (log 10-16) | dedicated `0x5C0971891EAebA32Ceb4AD32E73eeb912EC6BA8d` since 2026-10-26 (before: loadgen-shared `0x1A73f787…`) |
| `INSTANCE` | `dev` | `staging-2` | `sandbox-2` |
| Wallet derivation | random per dir (log 10-21; mnemonic use unverified) | deterministic `POOL_MNEMONIC` (log 10-26) | random, no mnemonic (log 10-26) |
| API accounts | managers spread over the 5 dev accounts (3/2/2/2/2), depositors on dev key #1 (log 10-21) | one staging account for managers + depositors; 14 staging-loadgen wallets share it (log 10-26) | the sandbox loadgen's init account (log 10-15) |
| Name prefix | none | none | `sb` |
| Strategy dirs (animated) | 6 FIV + 5 PSV (`psv-ema-trend` is FRESH_WALLETS, provision-only) | 7 FIV incl. `gold-trend` (XAU-USD) | 6 FIV |
| Compose project prefix | `vgdev-` | `vgstg-` | `vg-` |

Demo envs: `docker/demo/` (sandbox API, prefix `vgdemo-`) and `docker/demo-staging/` (staging API, prefix
`vgdemostg-`), one `market-making` dir each, `INSTANCE=demo`, `TIME_SCALE=0.01`, GHCR image; no
`.env.demo*` and no wallet files on this box (never provisioned here); their examples name the retired
providers.

## 6. Strategy JSON schema (`strategies/*.json`, type at `strategy.ts:56-88`)

| Field | Meaning | Validation (`validateStrategy`) |
|---|---|---|
| `id` | strategy id = `STRATEGY` | required |
| `vaultType` | `"FIV"` (default) or `"PSV"` | must equal env `VAULT_TYPE` |
| `profile` | free label (`over-collateralized`, `profit-share`, …) | – |
| `display.name` | on-exchange name (prefix prepended) | required, ≤ 30 chars |
| `display.description` | vault description | required, ≤ 2000 chars |
| `display.x`, `display._x_note` | X-link placeholder (manual OAuth, never automated) | unused |
| `vault.*` | on-chain economics, FIV or PSV block below | each inside its on-chain bound |
| `seed.managerSeedUsd` | manager's creation deposit, gross (the $10 creation fee comes out of it) | ≥ 110; provision re-checks vs live fees |
| `depositors.count` | depositors seeded at provision | 1..100 (deposit queue cap) |
| `depositors.amountUsdRange` | `[lo, hi]` USD: seeded deposit sizes (deterministic per id), churn join sizes, per-wallet target band | `lo > 0.05`; `hi × count ≤ maximumNetDeposits` (warn > 90 %) |
| `churn.enabled` | depositor activity on/off | – |
| `churn.intervalHoursRange` | `[lo, hi]` hours between one wallet's actions | `0 < lo ≤ hi` |
| `churn.depositPctOfBalanceRange` / `withdrawPctOfBalanceRange` | top-up / withdrawal size as % of the wallet's balance | – |
| `churn.depositWeight` / `withdrawWeight` | base weights; scaled by vault fill (neutral at 50 %) | sum > 0 |
| `marketMaking.enabled` | ladder on/off | – |
| `marketMaking.markets` | e.g. `["BTC-USD","ETH-USD","SOL-USD"]`; unlisted markets are skipped | non-empty |
| `marketMaking.ordersPerSide` | levels per side | ≥ 1 |
| `marketMaking.priceRangePct` | ladder depth as a fraction of index (0.004 = 0.4 %) | (0, 0.5) |
| `marketMaking.skewStrength` | `k` of the inventory skew | [0, 1]; warns > 0.9 |
| `marketMaking.maxPositionUsd` | inventory scale for `r` and the taker cap | > 0; warns > 6 × seed |
| `marketMaking.refreshSeconds` | requote cadence | – |
| `marketMaking.quoteNotionalUsd` | base level size; seed and taker clip size | – |
| `signal` | trading rule, kinds below | – |

FIV `vault` block (`FIV_BOUNDS`, `strategy.ts:34-42`): `interestApyPct` [0, 1000], `maximumNetDeposits`
[100, 1e12] USD, `exitMultiplier` [0.50, 2.00] (anyone may exit when EAV < mult × owed),
`managerWithdrawMultiplier` [0.50, 9.99] (manager may withdraw while EAV ≥ mult × owed), `unappliedAgeS`
[3600, 2,419,200] (queue-age exit trigger), `withdrawalLimitPctDepositors` [10, 100],
`withdrawalLimitPctVault` [0, 100]. Warnings: `managerWithdrawMultiplier > exitMultiplier` = deadlock
band; `exitMultiplier ≤ 1` = EAV exit can never fire while solvent.

PSV `vault` block (`PSV_BOUNDS`, `:46-53`): `carryFeePct` [0, 99.999999] (the 2026-10-20 PSV accepts ≤ 50;
newer PSVs unverified), `managementFeePct` [0, 1000] %/yr (2026-10-20 PSV ≤ 10), plus `maximumNetDeposits`, `unappliedAgeS`,
`withdrawalLimitPctDepositors`, `withdrawalLimitPctVault` as FIV. No interest, no multipliers.

Signals (`signals.ts:18-24`, `kind` + fields): `ema-cross` (`interval fast slow`; long if fast EMA > slow),
`macd` (`interval fast slow signal`; sign of the histogram), `rsi` (`interval period low high`; long below
`low`, short above `high`, else flat), `donchian` (`interval period atrPeriod atrMult`; break of the
channel by `atrMult × ATR`), `bollinger` (`interval period stddev`; fade the bands), `none` (pure market
making). `interval` is a `GET /candles` interval (`5m`, `15m`, `1h`). Fewer than 20 candles → bias 0.

Example — `strategies/01-ema-trend.json` (description shortened here):

```json
{
  "id": "ema-trend",
  "display": { "name": "EMA 50/200 Trend", "description": "we quote both sides of eth and the 50/200 ema cross …", "x": null },
  "profile": "over-collateralized",
  "vault": { "interestApyPct": 4.5, "maximumNetDeposits": 1500, "exitMultiplier": 1.95, "managerWithdrawMultiplier": 1,
             "unappliedAgeS": 86400, "withdrawalLimitPctDepositors": 100, "withdrawalLimitPctVault": 50 },
  "seed": { "managerSeedUsd": 1000 },
  "depositors": { "count": 10, "amountUsdRange": [20, 40] },
  "churn": { "enabled": true, "intervalHoursRange": [36, 72], "depositPctOfBalanceRange": [3, 10],
             "withdrawPctOfBalanceRange": [2, 8], "depositWeight": 60, "withdrawWeight": 40 },
  "marketMaking": { "enabled": true, "markets": ["ETH-USD"], "ordersPerSide": 3, "priceRangePct": 0.004,
                    "skewStrength": 0.5, "maxPositionUsd": 3000, "refreshSeconds": 45, "quoteNotionalUsd": 120 },
  "signal": { "kind": "ema-cross", "interval": "15m", "fast": 50, "slow": 200 }
}
```

PSV differences — `strategies/09-psv-rsi-pullback.json`: `"vaultType": "PSV"`, `"profile": "profit-share"`,
`"vault": { "carryFeePct": 15, "managementFeePct": 1.5, "maximumNetDeposits": 2500, "unappliedAgeS": 43200,
"withdrawalLimitPctDepositors": 75, "withdrawalLimitPctVault": 35 }`.

Current strategies (`MODE=list`):

| File | id | Economics | Seed | Deps | Markets | Signal |
|---|---|---|---|---|---|---|
| 01 | ema-trend | 4.5 %, exit 1.95, mgr 1.0 | 1000 | 10×[20,40] | ETH | ema-cross 15m 50/200 |
| 02 | rsi-pullback | 9 %, 1.5, 1.0 | 600 | 10×[45,75] | ETH | rsi 5m p2 10/90 |
| 03 | macd-crossover | 12 %, 1.25, 1.0 | 500 | 10×[80,120] | ETH, SOL | macd 15m 12/26/9 |
| 04 | donchian-breakout | 45 %, 0.6, 0.55, age 3600 s | 150 | 10×[150,260] | BTC, ETH, SOL | donchian 15m 20/14/0.25 |
| 05 | market-making | 18 %, 1.1, 1.0 | 800 | 10×[60,100] | BTC, ETH, SOL | none |
| 06 | bollinger-fade | 7 %, 1.8, 1.0 | 300 | 10×[10,25] | SOL | bollinger 5m 20/2 |
| 07 | gold-trend | 3.5 %, 0.95, 1.0 (deadlock-band warning by design) | 1000 | 10×[20,40] | XAU (staging only) | ema-cross 1h 20/50 |
| 08–13 | psv-ema-trend, psv-rsi-pullback, psv-macd-crossover, psv-donchian-breakout, psv-market-making, psv-bollinger-fade | carry/mgmt 15/2, 15/1.5, 20/2, 25/3, 20/2, 10/1 | as the FIV twin | as twin | as twin | as twin |
