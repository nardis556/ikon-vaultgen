#!/usr/bin/env bash
# Start the activity daemons (depositor churn + inventory-skewed market making)
# for already-provisioned DEV vaults.
#
#   ./animate.sh                     # dry-run all (prints planned quotes/actions, sends nothing)
#   EXECUTE=1 ./animate.sh           # live, detached
#   EXECUTE=1 ./animate.sh psv-ema-trend
#   ./animate.sh --logs              # tail all daemons
set -uo pipefail
cd "$(dirname "$0")"
EXECUTE="${EXECUTE:-0}"
# psv-ema-trend is intentionally NOT here: it is FRESH_WALLETS=1 (provision-only, one throwaway vault
# per run). Animating it would mint a vault-less fresh manager each start and restart-loop. To animate
# a PERSISTENT PSV vault, set FRESH_WALLETS=0 + restore the wallet mounts in its compose.yml, then add it.
# gold-trend is omitted on dev: it trades XAU-USD only, which dev does not list.
DIRS=(ema-trend rsi-pullback macd-crossover donchian-breakout market-making bollinger-fade psv-rsi-pullback psv-macd-crossover psv-donchian-breakout psv-market-making psv-bollinger-fade)

[ -f .env ] || [ -f .env.dev ] || { echo "✗ no .env or .env.dev"; exit 1; }

if [ "${1:-}" = "--logs" ]; then
  for d in "${DIRS[@]}"; do
    [ -f "$d/compose.yml" ] || continue
    echo "═══ $d ═══"
    ( cd "$d" && docker compose -p "vgdev-${d}" logs --tail 25 animate 2>/dev/null )
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
  # The dev composes run the locally built ikon-vaultgen:local (nothing to pull); pull registry images only.
  if grep -q 'image: ghcr' "$d/compose.yml"; then
    ( cd "$d" && docker compose -p "vgdev-${d}" pull -q 2>/dev/null ) || echo "  ! pull failed — using cached image"
  fi
  if [ "$EXECUTE" = "1" ]; then
    ( cd "$d" && EXECUTE=1 docker compose -p "vgdev-${d}" up -d --no-deps animate ) && echo "  ✓ daemon up (EXECUTE=1)"
  else
    ( cd "$d" && docker compose -p "vgdev-${d}" run --rm -e ONESHOT=1 -e EXECUTE=0 animate )
  fi
  echo
done
[ "$EXECUTE" = "1" ] && docker ps --filter "name=vgdev-" --format '  {{.Names}}\t{{.Status}}'
exit 0
