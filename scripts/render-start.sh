#!/bin/bash
set -e
mkdir -p var
echo "[render] restoring state..."
curl -sL "https://raw.githubusercontent.com/jegankumarsparks-source/Sewl/main/var/sewl.sqlite" -o var/sewl.sqlite || true
if [ ! -s var/sewl.sqlite ]; then echo "[render] fresh start"; fi
EXIT_POLICY_APPROVED=true node scripts/init-db.js || true
echo "[render] starting SEWL worker + app on port ${PORT:-10000}"
node src/main.js
