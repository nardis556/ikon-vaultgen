#!/usr/bin/env bash
# Provision the vault set on STAGING — one compose project per strategy.
#
#   ./start.sh                  # dry-run everything (reads only)
#   EXECUTE=1 ./start.sh        # provision all
#   EXECUTE=1 ./start.sh ema-trend
#
# Projects are prefixed vgstg- so they never collide with the sandbox (vg-) or
# demo (vgdemo-) sets, or with the loadgen's own stg-* projects.
set -uo pipefail
cd "$(dirname "$0")"
PREFIX=vgstg
EXECUTE="${EXECUTE:-0}"
DIRS=(ema-trend rsi-pullback macd-crossover donchian-breakout market-making bollinger-fade)
[ -f .env.staging ] || { echo "✗ .env.staging missing"; exit 1; }
if [ "$#" -gt 0 ]; then
  SEL=(); for w in "$@"; do for d in "${DIRS[@]}"; do [ "$d" = "$w" ] && SEL+=("$d"); done; done
  [ "${#SEL[@]}" -gt 0 ] || { echo "no match: $*"; echo "available: ${DIRS[*]}"; exit 1; }
  DIRS=("${SEL[@]}")
fi
if [ "$EXECUTE" = "1" ]; then
  echo "!! EXECUTE=1 — creates vaults and moves funds on STAGING."
  read -r -p "   type 'yes': " c; [ "$c" = "yes" ] || { echo aborted; exit 1; }
fi
ok=0; fail=0
for d in "${DIRS[@]}"; do
  echo "═══ $d ═══"
  if ( cd "$d" && docker compose -p "$PREFIX-$d" run --rm -e EXECUTE="$EXECUTE" vaultgen ); then
    echo "  ✓ $d"; ok=$((ok+1)); else echo "  ✗ $d"; fail=$((fail+1)); fi
  echo
done
echo "ok=$ok failed=$fail"
[ "$fail" -eq 0 ]
