#!/usr/bin/env bash
# Start the activity daemons (depositor churn + inventory-skewed market making)
# for already-provisioned vaults.
#
#   ./animate.sh                     # dry-run all (prints planned quotes/actions, sends nothing)
#   EXECUTE=1 ./animate.sh           # live, detached
#   EXECUTE=1 ./animate.sh market-making-desk
#   ./animate.sh --logs              # tail all daemons
#
# Dry runs are foreground one-shots; live runs are detached with restart:unless-stopped.
set -uo pipefail
cd "$(dirname "$0")"
EXECUTE="${EXECUTE:-0}"
DIRS=(ema-trend rsi-pullback macd-crossover donchian-breakout market-making bollinger-fade)

[ -f .env.staging ] || { echo "✗ .env.staging missing"; exit 1; }

if [ "${1:-}" = "--logs" ]; then
  for d in "${DIRS[@]}"; do
    [ -f "$d/compose.yml" ] || continue
    echo "═══ $d ═══"
    ( cd "$d" && docker compose -p "vgstg-${d}" logs --tail 25 animate 2>/dev/null )
  done
  exit 0
fi

if [ "$#" -gt 0 ]; then
  SELECTED=()
  for want in "$@"; do for d in "${DIRS[@]}"; do [ "$d" = "$want" ] && SELECTED+=("$d"); done; done
  [ "${#SELECTED[@]}" -gt 0 ] || { echo "no match for: $*"; echo "available: ${DIRS[*]}"; exit 1; }
  DIRS=("${SELECTED[@]}")
fi

for d in "${DIRS[@]}"; do
  echo "═══ ${d} ═══"
  # Pull first, non-fatally: `pull_policy: missing` would otherwise reuse a cached image
  # and silently run an older build.
  ( cd "$d" && docker compose -p "vgstg-${d}" pull -q 2>/dev/null ) || echo "  ! pull failed — using cached image"
  if [ "$EXECUTE" = "1" ]; then
    ( cd "$d" && EXECUTE=1 docker compose -p "vgstg-${d}" up -d --no-deps animate ) && echo "  ✓ daemon up (EXECUTE=1)"
  else
    # ONESHOT so a dry run reports one full tick and exits instead of looping forever.
    ( cd "$d" && docker compose -p "vgstg-${d}" run --rm -e ONESHOT=1 -e EXECUTE=0 animate )
  fi
  echo
done
[ "$EXECUTE" = "1" ] && docker ps --filter "name=vgstg-" --format '  {{.Names}}\t{{.Status}}'
exit 0
