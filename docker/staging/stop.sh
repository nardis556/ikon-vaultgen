#!/usr/bin/env bash
# Stop staging vaultgen containers. Does not touch on-chain state.
set -uo pipefail
cd "$(dirname "$0")"
for d in */; do d="${d%/}"; [ -f "$d/compose.yml" ] || continue
  ( cd "$d" && docker compose -p "vgstg-$d" down --remove-orphans 2>/dev/null ); done
docker ps -a --filter "name=vgstg-" --format '  {{.Names}}\t{{.Status}}'
