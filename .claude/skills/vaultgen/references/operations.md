# Operating vaultgen

How to run, inspect, change and retire the demo vault daemons. Paths are relative to `ikon-vaultgen/`
unless absolute. `<p>` = compose project prefix, `<dir>` = strategy dir name.

## Contents
1. Ground rules for agents
2. Environments and containers
3. Image: local build vs GHCR, and what is actually running
4. Status, logs, "is it quoting?"
5. Start / stop / restart / recreate
6. Provision, associate, fund, rename (non-interactive)
7. Cancel a manager's resting orders
8. Add a new strategy dir
9. Retire a set and re-create it on a new provider
10. RPC access key (header mode)
11. Demo envs, staging labs

## 1. Ground rules for agents

- Never print the contents of `.env`, `.env.<env>`, `.env.<env>.bak-*`, `.env.MANAGER`, `.env.DEPOSITORS`
  (no `cat`, no plain `grep`), and never run `docker inspect` (prints env). If you must confirm a
  non-secret value, print only a count for the expected value, e.g.
  `grep -c '^LOCAL_DEPOSIT_ADAPTER=0x8d74c0A3' docker/dev/.env.dev`.
- Everything is dry-run until `EXECUTE=1`. A dry run is cheap and does every read and check — run it
  first, then the live command.
- One writer per funding wallet. Provisioning while daemons churn on the same funding wallet collides on
  nonces (`rpcRetry` does not retry nonce errors) — see gotchas.md.
- Ask the user before rebuilding the image or recreating daemons (the last instruction in the log,
  2026-10-26, was "do NOT redeploy vaultgen for now"), before stopping another env's daemons, and before
  touching staging (the user stopped/started envs by hand on 2026-11-16/17).
- Read-only checks that are always safe: `docker ps`, `docker logs`, `curl $BASE_URL/exchange`,
  `cast call` / `cast balance` against `https://rpc-bokuto.katanarpc.com/`, a script's dry run.

## 2. Environments and containers

| Env | Dir | Project prefix | Containers (one per strategy) | Image | Runners |
|---|---|---|---|---|---|
| dev | `docker/dev/` | `vgdev-` | 11: `ema-trend rsi-pullback macd-crossover donchian-breakout market-making bollinger-fade psv-rsi-pullback psv-macd-crossover psv-donchian-breakout psv-market-making psv-bollinger-fade` (`psv-ema-trend` = FRESH_WALLETS, provision-only, never animated) | `ikon-vaultgen:local` | `start.sh animate.sh stop.sh` |
| staging | `docker/staging/` | `vgstg-` | 7: the six FIV + `gold-trend` (XAU-USD; dev lists no XAU) | `ikon-vaultgen:local` | same |
| sandbox | `docker/sandbox/` | `vg-` | 6 FIV, names prefixed `sb` | `ikon-vaultgen:local` | same |
| demo | `docker/demo/` | `vgdemo-` | `market-making` only; not set up on this box | GHCR `:latest` | `demo.sh` |
| demo-staging | `docker/demo-staging/` | `vgdemostg-` | `market-making` only; not set up | GHCR `:latest` | `demo.sh` |

- Daemon container name: `<p><dir>-animate-1` (e.g. `vgdev-market-making-animate-1`, `vg-ema-trend-animate-1`).
  One-off `run --rm` containers: `<p><dir>-<service>-run-<id>`, removed on exit.
- Other containers on the host: `stg-markets-loadgen-1` (ikon-loadgen2 staging market maker, stopped since
  2026-11-16) — not vaultgen, but it shares the staging vaultgen API account (gotchas.md, self-trade).
- `retired-<date>/` folders hold previous sets: `dev/retired-2026-10-20/` (pre-10-20 FIV `0x46b4C417…`,
  PSV `0xC2AbBCB4…`), `staging/retired-2026-10-26/` (`0x85Ea9016…`), `sandbox/retired-2026-10-26/`
  (`0x9304FEeC…`). Each has a README (section 9) and keeps its keys; nothing there runs.
- Live vault managers: read `docker/<env>/<dir>/out/*.json` (`manager`, `provider`, `name`).

## 3. Image: local build vs GHCR, and what is actually running

- Local: `cd ikon-vaultgen && docker build -t ikon-vaultgen:local .` (Dockerfile: `node:22-alpine`,
  `npm install --omit=dev`, copies `src/` and `strategies/`, `CMD npx tsx src/index.ts`). New strategy
  JSON or code needs a rebuild (or a read-only mount of `../../../strategies:/app/strategies:ro`, as the
  retired dev PSV composes do).
- A rebuild changes NOTHING that is running: containers keep the image they were created from until
  recreated (section 5). `docker ps` shows a raw image id instead of `ikon-vaultgen:local` for containers
  whose image the tag no longer points to (docker behaviour).
- GHCR: `.github/workflows/docker-publish.yml` builds `ghcr.io/nardis556/ikon-vaultgen` on push to
  `main`/`master`, `v*` tags or manual dispatch (tags `latest`, `sha-<short>`, branch, semver; amd64 +
  arm64; auth = `GITHUB_TOKEN`). The package is private by default: hosts need `docker login ghcr.io` with
  a PAT that has `read:packages`. The local copy of `:latest` here is from 2026-10-14 — older than signed
  creation, so it cannot create vaults on the 2026-10-20+ providers. Whether CI published `97d646c`
  (pushed 2026-10-27) is unverified.
- Running now (verified 2026-11-17): every vgdev/vgstg/vg container runs `ikon-vaultgen:local` built
  2026-10-21 14:31 CDT = HEAD minus `src/vault.ts:371-378` (deposit re-send guard). Re-verify:

```bash
d=$(mktemp -d); docker cp vgdev-ema-trend-animate-1:/app/src - | tar -x -C "$d"
diff -r "$d/src" src && echo "container runs HEAD src"
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedAt}}' | grep vaultgen
```

## 4. Status, logs, "is it quoting?"

```bash
docker ps -a --filter name=vgdev- --format '{{.Names}} {{.Image}} {{.Status}}'      # vgstg- / vg-
docker logs --tail 60 -t vgdev-market-making-animate-1 2>&1 | sed -E 's/0x[0-9a-fA-F]{64}/0x<64hex>/g'
./animate.sh --logs        # in docker/<env>/: last 25 lines of every daemon
```

- Use `--tail N -t`. `docker logs --since 10m` returned 0 lines for `vgdev-market-making` and
  `vgdev-ema-trend` on 2026-11-17 while they were logging (other containers were fine).
- A healthy MM daemon prints every `refreshSeconds` (30–60 s):
  `[<UTC>] depositors=16 owed=$1474.06 pending=$0.00` (PSV: `value=$… price=$…`), then per market
  `ETH-USD idx=1802.4 net=0.113 r=0.051 LONG → buyOffset x1.04 sellOffset x0.96 quotes=12`.
  `quotes=0`, repeated `! buy 1801.2: <reason>` lines, or no market lines = not quoting.
- `(N held inside the book: bid X / ask Y)` = levels clamped one tick inside other resting orders.
- `✓ took sell 0.0039 BTC-USD at market (…)` = taker trade (`TAKER_EVERY_S`). `✗ … taker …: Execution price
  exceeds 0.26 market order price limit` = thin book refused the market order.
- Churn: `✓ DEPOSITOR007 JOIN|top-up — …`, `✓ … withdraw enqueued — …`, `✗ … top-up` after
  `! attempt N did not settle (compose race)` (deposit not applied — see gotchas "adapter switch").
- After a (re)start the header shows `mode : LIVE`; `DRY-RUN — nothing will be sent` means `EXECUTE` was not
  1 when the container was created. Find it: `docker logs --tail 5000 <c> 2>&1 | grep 'mode  ' | tail -1`.
- `! market making needs manager API credentials … Disabling MM.` = no creds in `.env.MANAGER`.
- `XAU-USD session closed — not quoting, reopens ~22:01Z` = RWA session gating (normal).
- `No vault exists for manager …` / `vault is exited|liquidated — stopping the daemon` = the process
  exits; `restart: unless-stopped` restarts it in a loop.
- Open-order count without changing anything: `../scripts/cancel-manager-orders.sh <env> <dir>` (dry run;
  path relative to this file).
- Funding wallet balance (public RPC, read-only):
  `cast balance <addr> --ether --rpc-url https://rpc-bokuto.katanarpc.com/` and
  `cast call 0xc2a4C310F2512A17Ac0047cf871aCAed3E62bB4B "balanceOf(address)(uint256)" <addr> --rpc-url …` (6 dp).
- Provider state: `curl -s -A ikon-vaultgen $BASE_URL/exchange | jq '.vaults, .bridgeAdapters'` and
  `cast call <provider> "isAddManagedAccountEnabled()(bool)" --rpc-url …`.

## 5. Start / stop / restart / recreate

| Goal | Command | Notes |
|---|---|---|
| Pause one daemon | `docker stop <c>` | `unless-stopped` keeps it down across reboots |
| Resume it | `docker start <c>` | same container: same env (incl. `EXECUTE=1`), same image |
| Restart | `docker restart <c>` | same env/image; process restarts → may open seed positions again |
| (Re)create one from compose | `cd docker/<env>/<dir> && EXECUTE=1 docker compose -p <p><dir> up -d --no-deps animate` | picks up current image + env files; WITHOUT `EXECUTE=1` in the shell it recreates the daemon as a DRY-RUN |
| Force pick-up of a rebuilt image or edited env files | add `--force-recreate` | env files are read only at container creation |
| All daemons of an env | `cd docker/<env> && EXECUTE=1 ./animate.sh [dirs…]` | `up -d --no-deps animate` per dir; staging/sandbox print a harmless "pull failed" for the local image |
| Stop and REMOVE all of an env | `cd docker/<env> && ./stop.sh` | `compose down --remove-orphans` per dir; next start recreates (current image + env) |
| Dry-run preview of a daemon | `cd docker/<env> && ./animate.sh <dir>` | one tick (`ONESHOT=1 EXECUTE=0`), prints planned quotes |

On-chain state is never touched by stop/start; a stopped daemon leaves its resting orders on the book
(cancel them, section 7).

## 6. Provision, associate, fund, rename (non-interactive)

Run inside the strategy dir; drop `-e EXECUTE=1` for the dry run. `start.sh` wraps the provision command
for many dirs but prompts for `yes` on stdin (`echo yes | EXECUTE=1 ./start.sh <dir>` when headless).

```bash
cd docker/<env>/<dir>
docker compose -p <p><dir> run --rm -e EXECUTE=1 associate   # mint wallets if missing, associate, stamp API creds
docker compose -p <p><dir> run --rm -e EXECUTE=1 fund        # optional pre-fund (idempotent)
docker compose -p <p><dir> run --rm -e EXECUTE=1 vaultgen    # MODE=provision: create + name + seed + verify
docker compose -p <p><dir> run --rm -e MODE=details -e EXECUTE=1 vaultgen   # rename only, no chain calls
docker compose -p <p><dir> run --rm -e MODE=list vaultgen    # list strategies in the image
```

- `associate` exits 0 even when wallets fail — read its `✗` lines; it writes the credentials into the
  wallet files regardless. It uses `MANAGER_API_*` / `DEPOSITOR_API_*` from the env files; to put one
  manager in a different API account, export that pair in the shell and pass `-e MANAGER_API_KEY -e
  MANAGER_API_SECRET` (names only, so the secret is not on the command line; docker convention is to take
  the value from the shell — confirm with the dry run, which prints the key's last 6 chars) for that run.
- Provision success: `✓ vault LIVE`, `✓ details set`, 10 × `✓ DEPOSITORnnn …`, `conservation : ✓ exact`,
  summary `out/<strategy>-<instance>.json` (`depositorsCredited`, `conserved`).
- Re-running provision on a live vault skips creation and only seeds missing depositors — never use it to
  rename (use `MODE=details`).
- Rename: name = `VAULT_NAME_PREFIX` + space + `display.name` (≤ 30 chars), description = strategy JSON.
  The image bakes `strategies/`; to push edited text without a rebuild add
  `-v "$PWD/../../../strategies:/app/strategies:ro"` to the `run`.
- Provisioning refuses when `GET /exchange` names a different provider than `VAULT_PROVIDER` — true for
  every live dev dir since 2026-11-14 (gotchas.md).

## 7. Cancel a manager's resting orders

The skill ships `scripts/cancel-manager-orders.sh` + `.ts` (run the strategy's own image with the same
env and mounted `.env.MANAGER`; prints counts and the manager address only):

```bash
S=ikon-vaultgen/.claude/skills/vaultgen/scripts   # from kperps-test/
$S/cancel-manager-orders.sh dev market-making                    # dry run: open-order count
docker stop vgdev-market-making-animate-1                        # else it re-quotes within refreshSeconds
EXECUTE=1 $S/cancel-manager-orders.sh dev market-making          # cancel all, prints "open orders N → 0"
```

`cancelOrders` without a market cancels every order of that wallet. The daemon itself only cancels per
market inside each requote and never on shutdown.

## 8. Add a new strategy dir

1. Write `strategies/NN-<id>.json` (schema in config.md; PSV: `"vaultType": "PSV"`). Rebuild the image or
   mount `strategies/` read-only (section 3).
2. `mkdir docker/<env>/<dir>`; copy `compose.yml` and `.env.STRATEGY` from a sibling of the same type;
   set `STRATEGY=<id>`, `VAULT_TYPE`, `INSTANCE` (the env's value), PSV: `VAULT_PROVIDER=<psv provider>`.
3. Create the wallet files as FILES before any compose run (otherwise docker creates root-owned
   directories → EISDIR): `touch .env.MANAGER .env.DEPOSITORS && chmod 600 .env.MANAGER .env.DEPOSITORS
   && mkdir -p out state`.
4. Add `<dir>` to `DIRS=(…)` in `docker/<env>/start.sh` and `animate.sh` (`stop.sh` walks every dir).
5. Dry run: `cd docker/<env> && ./start.sh <dir>`; fix every error, read the warnings.
6. Section 6: associate → (fund) → provision → details if needed; then `EXECUTE=1 ./animate.sh <dir>` and
   check the logs (section 4).

## 9. Retire a set and re-create it on a new provider

Pattern used on 2026-10-21 (dev) and 2026-10-26 (staging, sandbox):

1. Read the new addresses: `curl -s -A ikon-vaultgen $BASE_URL/exchange | jq '.exchangeContractAddress,
   .vaults, .bridgeAdapters'`; confirm `isAddManagedAccountEnabled()` is true and (for signed creation)
   that the provider answers `eip712Domain()`.
2. Stop the daemons (`./stop.sh` or `docker stop …`) and cancel every manager's orders (section 7, per
   dir); note any open positions (they stay with the old vaults).
3. `mkdir docker/<env>/retired-$(date +%F)`; `mv` the strategy dirs into it with plain `mv` (keys, `out/`,
   `state/` must move too). Append `VAULT_PROVIDER=<old provider>` to each moved FIV `.env.STRATEGY`.
   For dev also `ln -s ../.env .env; ln -s ../.env.dev .env.dev` inside the retired folder so its
   composes still find the env files (staging/sandbox retired folders lack these links — and sandbox
   now has a different funding wallet).
4. Write `retired-<date>/README.md`: why (which provider `GET /exchange` names since when), old
   provider(s), old manager addresses, keys/state/funds untouched and how to restart one, positions left,
   "daemons stopped and N resting orders cancelled on <date>".
5. Back up and edit the env file without printing it: `cp .env.<env> .env.<env>.bak-$(date +%F)`, then
   `sed -i 's|^VAULT_PROVIDER=.*|VAULT_PROVIDER=<new FIV>|' .env.<env>` (and `LOCAL_DEPOSIT_ADAPTER` if it
   changed; `TAKER_EVERY_S=180`); check `docker/<env>/.env` does not override them (`grep -c '^VAULT_PROVIDER='
   .env`). PSV dirs: set `VAULT_PROVIDER` in their `.env.STRATEGY`.
6. Fresh dirs: copy `compose.yml` + `.env.STRATEGY` from the retired dir, drop the appended pin, bump
   `INSTANCE` when `POOL_MNEMONIC` is set (`staging` → `staging-2`, else the same addresses come back),
   section 8 step 3 (touch files). Point compose `image:` at `ikon-vaultgen:local` if it named GHCR.
7. Check the funding wallet covers seeds + deposits + gas (dry run prints `have`/`need`); top it up.
8. Associate → fund (sequentially, or a bulk pre-fund) → provision. Parallel provisions are safe only when
   every wallet is pre-funded (then no funding-wallet tx is sent). → details → `EXECUTE=1 ./animate.sh`.
9. Verify: each `out/*.json` shows the new provider, `depositorsCredited` 10/10, `conserved: true`; logs
   quote. Update the project log.

## 10. RPC access key (header mode)

- The public `https://rpc-bokuto.katanarpc.com/` rate-limits bursts with JSON-RPC `-32017` inside HTTP 200
  (log 2026-10-15: 121 of 400 burst calls answered without a key, 400/400 with the `X-AccessKey` header).
  18 daemons × 16 wallet reads per tick need the keyed Conduit RPC.
- Put `RPC_URL=https://rpc-katana-bokuto.t.conduit.xyz/` and `RPC_ACCESS_KEY=<key>` in
  `docker/<env>/.env` (mode 600; it overrides `.env.<env>`). vaultgen sends the key as the `X-AccessKey`
  header (`src/vault.ts:183-191`), so it never appears in a URL — ethers quotes request URLs in error
  messages, which end up in `docker logs`. Never put the key in the URL path for vaultgen.
- Containers read it only at creation → recreate after changing it. Check presence without printing:
  `docker exec <c> sh -c 'test -n "$RPC_ACCESS_KEY" && echo set || echo unset'`.
- Not covered by the header: `src/sandbox-set-exit-mult.ts` (plain provider) and the staging labs (they
  parse only `.env.staging`).

## 11. Demo envs, staging labs

- Demo: `cd docker/demo && cp .env.demo.example .env.demo` (fill secrets; update `VAULT_PROVIDER`, the
  example names the retired sandbox provider), then `./demo.sh check | associate | fund | provision |
  start | logs | pull | stop`. Each live command asks for `yes`; `start` passes `EXECUTE=1`. Same for
  `docker/demo-staging` (`.env.demo-staging`). Their composes use GHCR `:latest` — use an image with
  signed creation (≥ `97d646c`, or switch to `ikon-vaultgen:local`).
- Staging labs (`src/staging-*.ts`) are throwaway test harnesses that share the staging funding wallet;
  serialise them with `flock /tmp/staging-lab.lock` and do not run them while provisioning staging.
  `run-staging-lab-loop.sh` drives `staging-lab.ts` every `INTERVAL_S` (log
  `foundry-tests/ops/logs/staging-lab-loop.log`; stop with `pkill -f run-staging-lab-loop.sh` from a command
  line that does not itself contain that string).
