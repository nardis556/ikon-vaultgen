#!/usr/bin/env bash
# Provision the vault set on DEV (test-dev) — one compose project per strategy.
#
#   ./start.sh                  # dry-run everything (reads only)
#   EXECUTE=1 ./start.sh        # provision all
#   EXECUTE=1 ./start.sh psv-ema-trend
#
# Dev is the only environment with the Profit-Share provider deployed, so the PSV
# strategy (psv-ema-trend, VAULT_TYPE=PSV) is included here. Projects are prefixed
# vgdev- so they never collide with staging (vgstg-), sandbox (vg-) or demo (vgdemo-).
set -uo pipefail
cd "$(dirname "$0")"
PREFIX=vgdev
EXECUTE="${EXECUTE:-0}"
DIRS=(ema-trend rsi-pullback macd-crossover donchian-breakout market-making bollinger-fade psv-ema-trend psv-rsi-pullback psv-macd-crossover psv-donchian-breakout psv-market-making psv-bollinger-fade)
[ -f .env ] || [ -f .env.dev ] || { echo "✗ no .env or .env.dev (copy .env.dev.example and fill FUNDING_WALLET_KEY + API keys)"; exit 1; }
if [ "$#" -gt 0 ]; then
  SEL=(); for w in "$@"; do for d in "${DIRS[@]}"; do [ "$d" = "$w" ] && SEL+=("$d"); done; done
  [ "${#SEL[@]}" -gt 0 ] || { echo "no match: $*"; echo "available: ${DIRS[*]}"; exit 1; }
  DIRS=("${SEL[@]}")
fi
if [ "$EXECUTE" = "1" ]; then
  echo "!! EXECUTE=1 — creates vaults and moves funds on DEV."
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
