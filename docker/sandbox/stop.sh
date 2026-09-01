#!/usr/bin/env bash
# Stop the animate daemons and clean up containers.
# Does NOT touch vaults or funds on-chain — containers only.
set -uo pipefail
cd "$(dirname "$0")"
for d in */; do
  d="${d%/}"
  [ -f "$d/compose.yml" ] || continue
  ( cd "$d" && docker compose -p "vg-${d}" down --remove-orphans 2>/dev/null )
done
echo "remaining vg-* containers:"
docker ps -a --filter "name=vg-" --format '  {{.Names}}\t{{.Status}}' || true
