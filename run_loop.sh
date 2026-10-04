#!/bin/bash
# SEWL worker restart loop. Isolated from the radar. Paper only.
cd /home/sandbox/sewl
while true; do
  node src/main.js >> var/worker.log 2>&1
  echo "worker exited rc=$? at $(date -u +%FT%TZ), restart in 15s" >> var/worker.log
  sleep 15
done
