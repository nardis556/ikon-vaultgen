# ikon-vaultgen

Provisions **demo fixed-income vaults** on sandbox — strategy-driven, each with its own name,
description, on-chain economics and depositors — then keeps them **alive**: depositors join, top up
and withdraw on multi-day schedules, and managers quote an inventory-skewed two-sided book.

Built for showing the vault product to market makers on a call, so it has to look like production
rather than a test fixture.

Shaped deliberately like `ikon-loadgen2` — one image, a directory per deployment, layered `.env`,
`start.sh` / `stop.sh`, `vg-*` compose project prefixes — so operational habits carry over.

## Layout

```
strategies/            one JSON per strategy — the single source of truth for a vault
src/                   provisioner + daemon
docker/sandbox/
  .env.sandbox         shared connection + funding key      (gitignored)
  <strategy>/
    compose.yml        two services: vaultgen (one-shot), animate (daemon)
    .env.STRATEGY      strategy selection + run knobs       (committed — no secrets)
    .env.MANAGER       manager key + API creds              (gitignored, generated)
    .env.DEPOSITORS    random depositor pool                (gitignored, generated)
    out/  state/       run summaries, churn schedules
  start.sh  animate.sh  stop.sh
```

## Why the strategy is one file

A vault's **identity** (the name and description a market maker reads) and its **economics** (exit
threshold, collateralization, interest) have to agree. Splitting them across env files is how you
end up demoing a vault called "Conservative Income" whose parameters say otherwise. Each
`strategies/*.json` holds both, plus the two activity behaviours.

`src/strategy.ts` validates every number against bounds **enforced on-chain**. This matters more
than it looks: a bad config does not produce a clean error. `addManagedAccount` reverts *inside* the
compose call, the adapter re-credits the seed to the manager's exchange balance, and you get a
`ComposeFailed` event instead of a vault. Validating up front turns that into a startup error naming
the field. It also warns on things that are legal but bad to demo — the **deadlock band**
(`managerWithdrawMultiplier > exitMultiplier`, where neither exit nor manager-withdraw is possible)
and **exit reachability** (an over-collateralized vault can never hit the EAV exit trigger while
solvent — correct for that mandate, but you want to know before someone asks on a call).

## Two deployments

| | `docker/sandbox/` | `docker/demo/` |
|---|---|---|
| strategies | all six | market-making-desk only |
| instance | `1` | `demo` (separate wallets) |
| time scale | `1` (real 24-48h cadence) | `0.01` (a day per ~15 min) |
| purpose | the full product surface | one vault to show on a call |

They share the chain and the funding wallet but nothing else, so rehearsing or resetting the demo
never disturbs the sandbox set.

## Wallets: deterministic and pre-funded

Set `POOL_MNEMONIC` and every strategy's manager + depositor pool is derived, not random — the same
addresses come back across re-runs, rebuilds, or a lost `.env.DEPOSITORS`. Each strategy+instance
gets its own BIP-44 account index, so no two strategies ever derive the same wallet.

`MODE=fund` then pre-funds the whole pool in one pass, so demo-day has no funding transactions
mid-flow and the addresses are simply *already funded*. It is idempotent — only tops up wallets
below target. Provisioning still funds just-in-time if you skip it.

> **Back up `POOL_MNEMONIC`.** Lose it and the demo wallets, and anything in them, are gone.

Note the loadgen's 40 sandbox accounts are **not** usable here: they hold $0 on-chain (their capital
lives in exchange balances for trading), and vault deposits require on-chain vbUSDC.

## Run it

```bash
# demo — one market-making vault, end to end
cd docker/demo
cp .env.demo.example .env.demo           # FUNDING_WALLET_KEY, POOL_MNEMONIC, API creds
./demo.sh check                          # dry-run every stage
./demo.sh associate                      # register wallets + attach creds (once, first)
./demo.sh fund                           # pre-fund the pool (idempotent)
./demo.sh provision                      # create vault + seed 10 depositors
./demo.sh start                          # churn + skewed market making
./demo.sh logs

# full six-strategy set
cd docker/sandbox
cp .env.sandbox.example .env.sandbox     # fill in FUNDING_WALLET_KEY

./start.sh                               # dry-run all six (reads only, sends nothing)
EXECUTE=1 ./start.sh                     # provision all six (prompts to confirm)
EXECUTE=1 ./start.sh retail-starter      # just one

./animate.sh                             # dry-run the daemons: prints planned quotes + churn
EXECUTE=1 ./animate.sh                   # start them detached
./animate.sh --logs                      # tail
./stop.sh                                # stop daemons (does not touch on-chain state)
```

The dry run performs every check — provider/exchange drift against `GET /exchange`, strategy bounds,
funding budget — and prints the exact plan. Get a clean dry run before `EXECUTE=1`.

Re-running a strategy **resumes the same vault**. Provisioning checks `loadVaultSummary` first: if a
vault already exists it skips creation and only seeds depositors that are not already in. This is
not cosmetic — a second `addManagedAccount` for the same manager reverts `Duplicate` *inside* the
compose call, which does not throw. The adapter would re-credit the seed to the manager's exchange
balance and emit `ComposeFailed`, so a naive re-run silently costs another seed and creates nothing.
Bump `INSTANCE` to deliberately create a second vault.

## Strategies

Manager seeds are capped at **$1,000** (floor is $110 = creationMinimum + creationFee); depositors
supply the rest. `ratio` is manager first-loss buffer ÷ depositor principal — it is what makes each
`profile` mean something.

| strategy | profile | seed | 10 deposits | ratio | maxNet | exit | interest | MM | churn |
|---|---|---|---|---|---|---|---|---|---|
| conservative-income | over-collateralized | $1000 | ~$300 | 3.30x | $1500 | 1.95x | 4.5% | – | 36-72h |
| delta-neutral-basis | equal | $600 | ~$600 | 0.98x | $2500 | 1.50x | 9% | ETH | 24-48h |
| balanced-growth | moderate | $500 | ~$1000 | 0.49x | $4000 | 1.25x | 12% | ETH, SOL | 24-48h |
| high-yield-aggressive | low-requirement | $150 | ~$2050 | 0.07x | $6000 | 0.60x | 45% | BTC, ETH, SOL | 18-36h |
| market-making-desk | equal | $800 | ~$800 | 0.99x | $3000 | 1.10x | 18% | BTC, ETH, SOL | 24-48h |
| retail-starter | low-barrier | $300 | ~$175 | 1.66x | $1000 | 1.80x | 7% | – | 24-48h |

Provisioning all six + the demo costs ≈ **$10,262 vbUSDC**. Pre-funding every pool to churn-ready
levels is ≈ $25,991 — most of the funding wallet, so pre-fund the demo (~$4,155) and let the rest
fund just-in-time unless you need them all standing by. `maxNet` is sized ~3-4x initial deposits so
vault fill starts near 20-30% and the churn logic has somewhere to grow into.

**Reading the exit threshold**: `exitWallet` fires when `EAV < exitMultiplier × totalOwed`. A *high*
multiplier (1.95x) lets depositors force an exit while the vault is still solvent — depositor-
protective. A *low* one (0.60x) means the vault must be deeply underwater first — manager-permissive.
Separately, `profile` describes the manager's first-loss buffer relative to depositor principal.

## Depositor churn

Each wallet in the pool gets its own next-action time drawn from the strategy's
`intervalHoursRange` (default 24-48h), so activity is **staggered rather than synchronised**.
Schedules persist to `state/`, so a container restart does not re-roll everyone and produce a burst
of simultaneous activity — which is exactly the tell we are avoiding.

The pool is intentionally **larger** than the initial depositor count (`DEPOSITOR_POOL_SIZE`,
default count + 6). Provisioning seeds the first N; churn draws from the whole pool, so wallets that
were never in the original cohort **join later**. A depositor list that only ever contains the same
ten addresses looks synthetic; one that gains and loses depositors over days does not.

`TIME_SCALE` compresses the clock for demos — `0.001` replays a 24h schedule in ~86 seconds. It
scales the *schedule* only; interest still accrues in real time.

### How the deposit-vs-withdraw choice is made

Not a coin flip. `src/decide.ts` establishes **feasibility first** and only ever chooses among
actions that can actually succeed, so a scheduled slot is never wasted on an impossible pick. Then
it biases on two signals:

- **Vault fill** (`netDeposits / maximumNetDeposits`) — near the cap the vault leans toward
  withdrawals, near empty toward deposits, so it oscillates in a healthy band instead of pinning at
  its ceiling and stalling. Neutral at half full, where the configured weights apply unchanged.
- **Wallet drift** — each wallet has a deterministic target size. Above it the wallet leans toward
  withdrawing, below it toward depositing, so no wallet drifts monotonically to zero or the cap.

Sizes are clamped to what is possible **up front** (`headroom`, `quantityAvailableToWithdraw`)
rather than picked and then rejected.

When nothing is possible it distinguishes **transient** blocks (an exhausted withdrawal-limit
window, momentarily no headroom) from **structural** ones (no API credentials). Transient blocks
retry at 1/8 the normal interval; burning a full 24-48h slot on a limit window that reopens in an
hour would leave the wallet visibly idle for days.

Constraints respected: the $1 withdrawal minimum, `quantityAvailableToWithdraw` (authoritative — it
already nets `lockedQuantity` **and** both limit windows, so never compute it from `owed`), and
`maximumNetDeposits` headroom. A wallet with no vault balance can only join.

**Deposits need no API credentials** (pure on-chain approve + deposit). **Withdrawals do** — put
them in `.env.DEPOSITORS` fields 3 and 4 for any wallet that should be able to withdraw. Without
them that wallet deposits only, and says so.

## Market making, and what "smart" means here

The loadgen quotes a **symmetric** ladder around index and merely *gates* a side once position gets
large. That bounds inventory but never actively unwinds it — the book stops growing on one side and
sits there.

This quotes **asymmetrically**. With inventory ratio `r = net / maxPosition` in [-1, 1]:

```
reducing side  (sell when long, buy when short)   offset × (1 − k|r|)   → pulled TOWARD index
adding   side  (buy  when long, sell when short)  offset × (1 + k|r|)   → pushed AWAY from index
```

so the side that flattens the book is closer to index and likelier to fill, while the side that
would add to it retreats. `k = skewStrength`. Measured on ETH at index 2444.30, `k=0.8`:

| inventory | nearest bid | nearest ask |
|---|---|---|
| flat | −3.30 | +3.30 |
| half long | −4.60 | **+2.00** |
| at limit long | −5.90 | **+0.70** |
| half short | **−2.00** | +4.60 |

The book walks itself back to flat instead of accumulating. Size is skewed mildly too — the adding
side quotes smaller — so an adverse far-side fill moves inventory less than the near-side fill that
corrects it.

Quotes are **post-only** (`gtx`). A maker that crosses is not earning spread, it is paying it;
without `gtx` an aggressively skewed near-side quote would sometimes take. At `skewStrength > 0.9`
the validator warns, because at full skew the reducing side quotes essentially at index and stops
being market making.

Market making needs manager API credentials; without them the daemon says so and runs churn only.

## API credentials

An API key identifies an **account**, not a wallet. Any number of wallets associate into one
account and each keeps its own balances and positions — so **one key covers every manager and a
second covers every depositor pool**, across all strategies. No key per wallet, no key per strategy.

`MODE=associate` (`./demo.sh associate`) registers each wallet with the exchange and stamps the
credentials into `.env.MANAGER` / `.env.DEPOSITORS` fields 3 and 4. Run it once per deployment
before funding. A wallet must be associated before the exchange will surface a balance for it, so
an on-chain deposit made beforehand reads as "not credited".

Who needs credentials:

| | needs API creds | why |
|---|---|---|
| manager | yes | `setVaultDetails`, and market-making orders |
| depositor deposit | **no** | pure on-chain approve + deposit |
| depositor withdrawal | yes | authenticated REST |

Without manager credentials the daemon runs churn only and says so. Without depositor credentials
a wallet deposits but never withdraws, and logs the reason rather than failing silently.

## Name, description, and X

`name` (≤30 chars) and `description` (≤2000 chars) go through the authenticated `setVaultDetails`
endpoint, EIP-712 signed by the manager. Fully automated.

⚠️ **These are not plain client methods.** They live under an internal namespace keyed by
`Symbol.for('@katanaPerps/internal')` (exported as `INTERNAL_SYMBOL`) — calling
`client.auth.setVaultDetails(...)` silently yields `undefined`. Same for
`withdrawFromManagedAccountByQuantity`. See `src/withdraw.ts`.

**X/Twitter linking cannot be automated.** The flow is `getXChallenge({wallet, manager})` → the
manager authorizes **on X** → `setVaultXConnection({manager, code})`. That middle step is a real
OAuth click-through, so a human does it once per vault. `display.x` is a placeholder for whoever
performs it.

## Deploying (GitHub Actions)

This is its **own repository** (`nardis556/ikon-vaultgen`), same as `ikon-loadgen2`. That matters:
GitHub only reads `.github/workflows` at a repository root, so a workflow sitting in a subdirectory
of another repo never runs.

`.github/workflows/docker-publish.yml` builds and pushes `ghcr.io/nardis556/ikon-vaultgen` on every
push to `main`, on `v*` tags, and on manual dispatch. GHCR authenticates with the built-in
`GITHUB_TOKEN` — **no secrets to configure**, and no npm token either.

That last point took a change to be true. `@katanaperps/katana-perps-sdk` is public, but
`@katanaperps/katana-perps-contracts-niseko-ma` is **not** (404 anonymously), so depending on it
would have forced registry credentials into CI and the image build. Its only use here was one
adapter call, now made with a minimal ABI in `src/vault.ts` whose calldata is byte-identical
(selector `0x5d303519`, checked against that package's own typechain ABI). Re-adding it means adding
an `NPM_TOKEN` secret and an `.npmrc` to the build.

The workflow is step-for-step identical to `ikon-loadgen2`'s. Credentials are kept out of the image
by **`.dockerignore`**, not by a CI check: it excludes `docker/` wholesale — the funding key, the
pool mnemonic, and every manager and depositor private key — plus `.env*`, so none of it is ever
uploaded to the builder. (An earlier filename-based CI guard was removed: it added nothing over
`.dockerignore` and false-positived on the seven committed `.env.STRATEGY` knob files, which are
credential-free by design.)

Verified locally before shipping: `npm install --omit=dev` from the public registry with no auth
(84 packages), `docker build` clean, the built image runs `MODE=list` correctly, and it contains no
`.env*` files. 412 MB.

### Keeping the image current

Compose uses `pull_policy: missing`, which reuses a cached image and will happily run yesterday's
build. The symptom is confusing: the container rejects a `MODE` the source clearly supports, e.g.

```
FATAL: Unknown MODE "associate" (provision | fund | animate | list)
```

That error text is from the OLD build — CI had already published the new one. Every runner script
(`demo.sh`, `start.sh`, `animate.sh`) now pulls first, non-fatally, so a private-package pull
failure still falls back to the cached image. To force it: `./demo.sh pull`.

### First push

The remote does not exist yet. Create it, then:

```bash
cd ikon-vaultgen
git push -u origin main          # triggers the first build
```

The GHCR package defaults to **private**, so hosts need `docker login ghcr.io` with a PAT carrying
`read:packages` (a plain `gh auth token` will not work), or flip the package public once.

## Security

Every file that can hold a key is gitignored by default; only `.env.STRATEGY` and `*.example` are
committed, and `.env.STRATEGY` is credential-free by design (which is why API creds live in
`.env.MANAGER` / `.env.DEPOSITORS` rather than there).

This is deliberate: `ikon-loadgen2` **tracks its `.env.ACCOUNTS` in git** — 40 accounts' private
keys and API secrets are in that history, across `sandbox/` and `staging/`, plus
`staging/markets/funding-wallet.txt`. Worth a separate cleanup (`git rm --cached` plus rotation,
since history retains them). Do not copy that pattern here.

## Known limits

- The **manager's** market-making PnL moves EAV; depositor `owed` moves with configured interest.
  If a demo needs a specific headline APY, set `interestApyPct` — it is not derived from trading.
- Churn queues **real** withdrawals. If the withdrawal dispatcher stalls longer than
  `vault.unappliedAgeS`, the queue-age trigger makes the vault exit-eligible to any depositor. That
  is correct protocol behaviour, just not something to leave stalled mid-demo.
- Sandbox lists 7 markets; MM configs reference BTC/ETH/SOL. A missing market is skipped with a warning.
