#!/usr/bin/env bash
# Provision demo vaults on sandbox — one compose project per strategy.
#
#   ./start.sh                       # dry-run every strategy (safe; sends nothing)
#   ./start.sh conservative-income   # dry-run just this one
#   EXECUTE=1 ./start.sh             # actually provision all of them
#   EXECUTE=1 ./start.sh retail-starter
#
# Projects are named vg-<strategy> so they never collide with the loadgen's sbx-*
# projects on a shared host.
set -uo pipefail
cd "$(dirname "$0")"
PREFIX=vg
EXECUTE="${EXECUTE:-0}"
DIRS=(conservative-income delta-neutral-basis balanced-growth high-yield-aggressive market-making-desk retail-starter)

[ -f .env.sandbox ] || { echo "✗ .env.sandbox missing — copy .env.sandbox.example and fill in FUNDING_WALLET_KEY"; exit 1; }

if [ "$#" -gt 0 ]; then
  SELECTED=()
  for want in "$@"; do for d in "${DIRS[@]}"; do [ "$d" = "$want" ] && SELECTED+=("$d"); done; done
  [ "${#SELECTED[@]}" -gt 0 ] || { echo "no match for: $*"; echo "available: ${DIRS[*]}"; exit 1; }
  DIRS=("${SELECTED[@]}")
fi

if [ "$EXECUTE" = "1" ]; then
  echo "!! EXECUTE=1 — this CREATES VAULTS and MOVES FUNDS on sandbox."
  echo "   strategies: ${DIRS[*]}"
  read -r -p "   type 'yes' to continue: " confirm
  [ "$confirm" = "yes" ] || { echo "aborted"; exit 1; }
fi

ok=0; fail=0
for d in "${DIRS[@]}"; do
  echo "═══ ${d} ═══"
  # Foreground to completion: provisioning is a job and its exit code is the result.
  if ( cd "$d" && docker compose -p "vg-${d}" run --rm -e EXECUTE="$EXECUTE" vaultgen ); then
    echo "  ✓ ${d}"; ok=$((ok+1))
  else
    echo "  ✗ ${d}"; fail=$((fail+1))
  fi
  echo
done
echo "ok=${ok} failed=${fail}"
[ "$fail" -eq 0 ]
