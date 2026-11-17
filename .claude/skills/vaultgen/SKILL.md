---
name: vaultgen
description: >-
  Spec and runbook for ikon-vaultgen, the tool that creates and animates the Katana Perps demo vaults (Fixed Income
  and Profit Share vaults) on dev, staging and sandbox. Use it for any work on or with vaultgen: changing its code
  (provisioning, signed vault creation, the animate loop, the market-making ladder, taker trades, depositor churn,
  signals), adding or tuning a strategy, provisioning, renaming or re-creating demo vaults, starting, stopping,
  restarting or recreating the vgdev-*, vgstg-* or vg-* daemons, cancelling a manager's resting orders, moving vaults to
  a new provider or deposit adapter, or debugging a demo vault that does not quote, trade, deposit or churn. Use it even
  when the user only says "the vault bots", "demo vaults", "vaultgen", "vgdev", "the market making strategy" or names a
  strategy such as ema-trend or psv-rsi-pullback.
---

# vaultgen

ikon-vaultgen (this repo) runs the demo vaults people look at on the Katana Perps web app. One strategy JSON
(`strategies/*.json`) describes one vault: its type (FIV or PSV), terms, markets, signal and market-making
parameters. Each deployed vault has its own folder `docker/<env>/<strategy-dir>/` with its own manager and
depositor wallets and one long-running `animate` container that quotes a ladder, takes occasional trades and
churns depositors in and out.

The code is TypeScript run directly by `tsx` (no build step) from `src/index.ts`, which dispatches on `MODE`:
`associate`, `fund`, `provision` (create the vault and seed it), `animate` (the daemon), `details` (rename,
no chain calls) and `list`. Everything is a dry run unless `EXECUTE=1`.

## Ground rules

These environments are shared with other people, and the wallets hold real (test-network) money, so:

- **Secrets.** `docker/<env>/.env.<env>`, `docker/<env>/.env`, every `.env.MANAGER` and `.env.DEPOSITORS` hold
  private keys, API secrets or the RPC access key. Never open, cat, grep or diff them, and never run `docker
  inspect`, `docker exec <c> env` or a full `docker compose config` (they print env values). To check one
  non-secret value use `docker exec <container> printenv VAR_NAME` (e.g. `LOCAL_DEPOSIT_ADAPTER`,
  `VAULT_PROVIDER`, `EXECUTE`). To change one value, edit that single line in place without printing the file
  (back it up first with `cp -p`, keep mode 600). `.env.STRATEGY` and `*.example` files are clean.
- **Ask before acting on shared state**: rebuilding the image, recreating or stopping daemons, provisioning,
  cancelling a manager's orders. Read-only checks (status, logs, `GET /exchange`, dry runs) need no permission.
- **`EXECUTE` comes from the shell.** The `animate` service sets `EXECUTE=${EXECUTE:-0}`, so `docker compose up -d`
  without `EXECUTE=1` in the shell silently recreates a live daemon as a dry run. Env files and the image are fixed
  when a container is created: `docker restart` keeps the old ones (references/operations.md §5).
- **One writer per funding wallet.** Nonce collisions are not retried. Never provision while daemons or other
  tools send from the same funding wallet (dev's funding wallet is shared with the foundry-tests labs).

## Where things are

| Need | Look at |
|---|---|
| What every `src/*.ts` module does, the provisioning flow, the animate loop, FIV vs PSV code paths | `references/architecture.md` |
| Every env var, the env-file precedence, the strategy JSON schema, current per-env addresses | `references/config.md` |
| Status, logs, start/stop/recreate, provision/associate/fund/rename, add a strategy dir, retire a set, image build | `references/operations.md` |
| Something is wrong (37 known pitfalls: symptom → cause → fix → where) | `references/gotchas.md` |
| Count or cancel one manager's resting orders | `scripts/cancel-manager-orders.sh` |

Environments: dev (`vgdev-<dir>`), staging (`vgstg-<dir>`), sandbox (`vg-<dir>`); all run the locally built
image `ikon-vaultgen:local`. Containers are `<prefix>-<dir>-animate-1`.

## Quick recipes

Status of every daemon, and whether one is quoting (a quoting daemon prints one `idx=` line per market each
refresh; use `--tail`, since `--since` has returned nothing for some containers):
```bash
docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep -E '^vg'
docker logs --tail 40 -t vgdev-market-making-animate-1 2>&1 | grep -E 'idx=|depositors=|✗'
```

Pause, resume, apply an env or image change:
```bash
docker stop vgdev-ema-trend-animate-1      # stays down across reboots; its resting orders stay on the book
docker start vgdev-ema-trend-animate-1     # same container, same env (keeps EXECUTE=1)
( cd docker/dev/ema-trend && EXECUTE=1 docker compose -p vgdev-ema-trend up -d --force-recreate --no-deps animate )
```
A (re)start may open seed positions in markets where the vault holds none (`SEED_POSITIONS=2` by default); put
`SEED_POSITIONS=0` in the shell to avoid it.

Check a deployment against the exchange. Run this first whenever deposits, creation or churn start failing:
dev's deposit adapter changed on 2026-11-13 and the dev daemons kept the old one for four days (gotchas #1).
```bash
curl -s https://api-dev.katana-perps-dev.com/v1/exchange | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['bridgeAdapters']['localDepositAdapterV1KatanaContractAddress'], json.dumps(d['vaults'], indent=0))"
docker exec vgdev-ema-trend-animate-1 printenv LOCAL_DEPOSIT_ADAPTER VAULT_PROVIDER
```

Rename a vault (no chain calls), and count or cancel a manager's orders (run from the repo root):
```bash
( cd docker/dev/<dir> && docker compose -p vgdev-<dir> run --rm -e MODE=details -e EXECUTE=1 vaultgen )
.claude/skills/vaultgen/scripts/cancel-manager-orders.sh dev market-making             # count only
EXECUTE=1 .claude/skills/vaultgen/scripts/cancel-manager-orders.sh dev market-making   # cancel (stop the daemon first, or it re-quotes)
```

Ship a code change (ask first; the running image is built from the repo, and anything not rebuilt is not live):
```bash
npx tsc --noEmit 2>&1 | grep -c 'error TS'   # compare with the count before your change (14 pre-existing errors)
docker build -t ikon-vaultgen:local .
# then recreate each daemon with EXECUTE=1 … --force-recreate (above) or: cd docker/<env> && EXECUTE=1 ./animate.sh
```
Before shipping, try the change as a one-tick dry run of one daemon: `cd docker/<env> && ./animate.sh <dir>`
(`ONESHOT=1 EXECUTE=0`, prints the planned quotes and actions, sends nothing). There are no unit tests.

New vault or new strategy dir: references/operations.md §6 and §8. In a new dir, create `.env.MANAGER` and
`.env.DEPOSITORS` as empty files before the first compose run, or docker mounts them as directories (EISDIR).
The seed must be at least $110 (the $100 creation minimum plus the $10 fee), and provisioning refuses unless
`GET /exchange` names the strategy's `VAULT_PROVIDER`.

## How the market-making ladder is placed

People often ask whether the bots follow the index. They do: every refresh `animate` re-reads `indexPrice`
from `GET /markets` and `mm.ts` (`buildSkewedQuotes`) builds the ladder around it.
- Levels: step = index × `priceRangePct` / `ordersPerSide`. Level i sits at index ∓ step × (i + 1) × the side's
  multiplier. Orders are post-only.
- Inventory skew: with inventory ratio r (position against its cap), the side that reduces the position is pulled
  toward the index (× (1 − k·|r|)), the side that adds to it is pushed away (× (1 + k·|r|)). The midpoint equals
  the index only when the vault is flat. The log line shows it: `ETH-USD idx=1788.4 … SHORT → buyOffset x0.73
  sellOffset x1.27`.
- No level is placed through the index. A level that would cross another wallet's resting order is held one tick
  inside it ("held inside the book"), so stale foreign orders pull that whole side away from the index.
- The signal only sets the direction of seed positions and taker trades (`TAKER_EVERY_S`), not the ladder centre.

If quotes look off-centre, compare `idx=` in the log with the exchange's `GET /markets` index: when the exchange's
own index is stale (staging's was frozen until 2026-11-17 15:32 UTC), the bots follow it faithfully.

## Keep this skill current

The reference files are the spec. When you change behaviour, find a pitfall, or move a deployment (new provider,
adapter, funding wallet, image), update the matching file in `references/` in the same change. Date any
time-sensitive statement, and re-verify dated facts (`GET /exchange`, `docker ps`) before acting on them.
