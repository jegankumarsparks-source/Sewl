#!/bin/bash
cd /home/sandbox/sewl
while true; do
  sleep 600
  node scripts/export-web.js >> var/publish.log 2>&1 && python3 scripts/publish_site.py >> var/publish.log 2>&1
done
