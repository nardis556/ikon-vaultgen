#!/usr/bin/env bash
# Detached driver for the staging vault lab: one tick every INTERVAL_S (default 1200 s), serialized
# with flock so a manual `npx tsx src/staging-lab.ts` never overlaps a loop tick. The lab itself
# decides MINT / REUSE+battery / FINALIZE=exit per tick. Start detached:
#   setsid nohup ./run-staging-lab-loop.sh > /dev/null 2>&1 < /dev/null &
# Stop: pkill -f run-staging-lab-loop.sh   Log: foundry-tests/ops/logs/staging-lab-loop.log
set -u
cd "$(dirname "$0")"
INTERVAL_S=${INTERVAL_S:-1200}
LOCK=/tmp/staging-lab.lock
LOOPLOG=/home/user/code/kperps-test/foundry-tests/ops/logs/staging-lab-loop.log
mkdir -p "$(dirname "$LOOPLOG")"
echo "[$(date -u +%FT%TZ)] loop started pid $$ interval ${INTERVAL_S}s" >> "$LOOPLOG"
while true; do
  {
    echo "[$(date -u +%FT%TZ)] tick start"
    flock -w 2400 "$LOCK" npx tsx src/staging-lab.ts 2>&1 | grep -v ExperimentalWarning | sed -E 's/0x[0-9a-fA-F]{64}/0x<64hex>/g'
    echo "[$(date -u +%FT%TZ)] tick end (exit ${PIPESTATUS[0]})"
  } >> "$LOOPLOG" 2>&1
  sleep "$INTERVAL_S"
done
