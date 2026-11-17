#!/usr/bin/env bash
# Count — or with EXECUTE=1 cancel — the resting orders of one vaultgen strategy's vault manager.
#
#   cancel-manager-orders.sh <dev|staging|sandbox> <strategy-dir>             # dry run: prints the count
#   EXECUTE=1 cancel-manager-orders.sh <dev|staging|sandbox> <strategy-dir>   # cancels them
#
# It runs the bundled cancel-manager-orders.ts as a one-off container of that strategy's compose (`animate` service), so the
# manager key and API credentials come from the same files the daemon uses; nothing secret is printed. The running daemon is
# NOT stopped: if it is still up it re-quotes on its next tick — stop it first (`docker stop <container>`) when the goal is
# an empty book. Example: docker stop vgdev-market-making-animate-1 && EXECUTE=1 ./cancel-manager-orders.sh dev market-making
set -euo pipefail
ENV="${1:?usage: cancel-manager-orders.sh <dev|staging|sandbox> <strategy-dir>}"
DIR="${2:?usage: cancel-manager-orders.sh <dev|staging|sandbox> <strategy-dir>}"
case "$ENV" in
  dev) PREFIX=vgdev ;;
  staging) PREFIX=vgstg ;;
  sandbox) PREFIX=vg ;;
  *) echo "env must be dev, staging or sandbox"; exit 1 ;;
esac
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"   # this file lives in <repo>/.claude/skills/vaultgen/scripts
STRAT="$REPO/docker/$ENV/$DIR"
[ -f "$STRAT/compose.yml" ] || { echo "no compose.yml in $STRAT"; exit 1; }
cd "$STRAT"
docker compose -p "$PREFIX-$DIR" run --rm --no-deps \
  -e EXECUTE="${EXECUTE:-0}" -e NPM_CONFIG_UPDATE_NOTIFIER=false \
  -v "$HERE/cancel-manager-orders.ts:/app/src/cancel-manager-orders.ts:ro" \
  animate npx tsx src/cancel-manager-orders.ts 2>&1 | grep -v -i -E "secret|private|api[_-]?key"
