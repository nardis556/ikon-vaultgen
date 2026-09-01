#!/usr/bin/env bash
# Demo runner — one market-making vault on sandbox, end to end.
#
#   ./demo.sh check      # read-only: dry-run every step
#   ./demo.sh associate  # register wallets + attach API credentials (run once, first)
#   ./demo.sh fund       # pre-fund the deterministic pool (idempotent)
#   ./demo.sh provision  # create the vault + seed 10 depositors (skips if it exists)
#   ./demo.sh start      # start churn + inventory-skewed market making
#   ./demo.sh logs       # tail
#   ./demo.sh pull       # fetch the latest published image
#   ./demo.sh stop       # stop the daemon (does not touch on-chain state)
#
# Every action pulls first. compose uses `pull_policy: missing`, which reuses a cached
# image and would silently run yesterday's build — the symptom is a MODE the container
# does not recognise even though the code has it.
#
# fund/provision/start move funds and require EXECUTE=1; check never does.
set -uo pipefail
cd "$(dirname "$0")"
D=market-making-desk
P=vgdemo-$D
cmd="${1:-check}"

[ -f .env.demo ] || { echo "✗ .env.demo missing — copy .env.demo.example, fill FUNDING_WALLET_KEY + POOL_MNEMONIC"; exit 1; }

# Pull, but never fatally: with `pull_policy: missing` a cached image still runs, which is
# the normal case when the GHCR package is private.
pull() {
  ( cd $D && docker compose -p $P pull -q 2>&1 | sed 's/^/  /' ) || {
    echo "  ! pull failed — continuing with the cached image."
    echo "    If this is 'unauthorized'/'403' the GHCR package is private. Either flip it"
    echo "    public briefly, or docker login ghcr.io with a PAT that has read:packages"
    echo "    (a plain 'gh auth token' will NOT work — it lacks read:packages)."
  }
}

confirm() {
  echo "!! $1 — moves funds on sandbox."
  read -r -p "   type 'yes' to continue: " c; [ "$c" = "yes" ] || { echo "aborted"; exit 1; }
}

case "$cmd" in
  pull) pull; docker images ghcr.io/nardis556/ikon-vaultgen --format '  {{.Repository}}:{{.Tag}} {{.ID}} created {{.CreatedSince}}'; exit 0 ;;
  check)
    pull
    echo "═══ dry-run: associate ═══"; ( cd $D && docker compose -p $P run --rm -e EXECUTE=0 associate )
    echo; echo "═══ dry-run: fund ═══";      ( cd $D && docker compose -p $P run --rm -e EXECUTE=0 fund )
    echo; echo "═══ dry-run: provision ═══"; ( cd $D && docker compose -p $P run --rm -e EXECUTE=0 vaultgen )
    echo; echo "═══ dry-run: animate ═══";   ( cd $D && docker compose -p $P run --rm -e EXECUTE=0 -e ONESHOT=1 animate )
    ;;
  associate) confirm "registering wallets and attaching API credentials"; pull
             ( cd $D && docker compose -p $P run --rm -e EXECUTE=1 associate ) ;;
  fund)      confirm "pre-funding the demo pool"; pull; ( cd $D && docker compose -p $P run --rm -e EXECUTE=1 fund ) ;;
  provision) confirm "creating the demo vault"; pull;   ( cd $D && docker compose -p $P run --rm -e EXECUTE=1 vaultgen ) ;;
  start)     confirm "starting live churn + market making"; pull
             # `docker compose up` has no -e flag; EXECUTE is passed through the shell
             # environment, which compose interpolates into the service.
             ( cd $D && EXECUTE=1 docker compose -p $P up -d --no-deps animate )
             docker ps --filter "name=$P" --format '  {{.Names}}\t{{.Status}}' ;;
  logs)      ( cd $D && docker compose -p $P logs -f --tail 60 animate ) ;;
  stop)      ( cd $D && docker compose -p $P down --remove-orphans ); echo "stopped (on-chain state untouched)" ;;
  *) echo "usage: ./demo.sh {check|associate|fund|provision|start|logs|stop|pull}"; exit 1 ;;
esac
