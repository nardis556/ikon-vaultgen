#!/usr/bin/env bash
# Demo runner — one market-making vault on sandbox, end to end.
#
#   ./demo.sh check      # read-only: does the vault exist yet? dry-run every step
#   ./demo.sh fund       # pre-fund the deterministic pool (idempotent)
#   ./demo.sh provision  # create the vault + seed 10 depositors (skips if it exists)
#   ./demo.sh start      # start churn + inventory-skewed market making
#   ./demo.sh logs       # tail
#   ./demo.sh stop       # stop the daemon (does not touch on-chain state)
#
# fund/provision/start move funds and require EXECUTE=1; check never does.
set -uo pipefail
cd "$(dirname "$0")"
D=market-making-desk
P=vgdemo-$D
cmd="${1:-check}"

[ -f .env.demo ] || { echo "✗ .env.demo missing — copy .env.demo.example, fill FUNDING_WALLET_KEY + POOL_MNEMONIC"; exit 1; }

confirm() {
  echo "!! $1 — moves funds on sandbox."
  read -r -p "   type 'yes' to continue: " c; [ "$c" = "yes" ] || { echo "aborted"; exit 1; }
}

case "$cmd" in
  check)
    echo "═══ dry-run: fund ═══";      ( cd $D && docker compose -p $P run --rm -e EXECUTE=0 fund )
    echo; echo "═══ dry-run: provision ═══"; ( cd $D && docker compose -p $P run --rm -e EXECUTE=0 vaultgen )
    echo; echo "═══ dry-run: animate ═══";   ( cd $D && docker compose -p $P run --rm -e EXECUTE=0 -e ONESHOT=1 animate )
    ;;
  fund)      confirm "pre-funding the demo pool"; ( cd $D && docker compose -p $P run --rm -e EXECUTE=1 fund ) ;;
  provision) confirm "creating the demo vault";   ( cd $D && docker compose -p $P run --rm -e EXECUTE=1 vaultgen ) ;;
  start)     confirm "starting live churn + market making"
             # `docker compose up` has no -e flag; EXECUTE is passed through the shell
             # environment, which compose interpolates into the service.
             ( cd $D && EXECUTE=1 docker compose -p $P up -d --no-deps animate )
             docker ps --filter "name=$P" --format '  {{.Names}}\t{{.Status}}' ;;
  logs)      ( cd $D && docker compose -p $P logs -f --tail 60 animate ) ;;
  stop)      ( cd $D && docker compose -p $P down --remove-orphans ); echo "stopped (on-chain state untouched)" ;;
  *) echo "usage: ./demo.sh {check|fund|provision|start|logs|stop}"; exit 1 ;;
esac
