# SEWL deployment guide (always-on host)

PAPER TRADING ONLY. No signing key, no real funds, nothing here submits a transaction.

## Why a dedicated host
A worker only counts as "24x7" if the machine keeps running. On a sandbox or laptop that sleeps, timers pause and the stall heartbeat logs `loop-stalled`. Use a small always-on VM.

## Target: Oracle Cloud Always Free
- Shape: VM.Standard.A1.Flex (Ampere ARM), 1 OCPU / 6 GB is plenty. Image: Ubuntu 22.04.
- Free-tier rules: stay inside the Always Free limits shown in the console. Do not upgrade the account to paid and do not add paid resources without the owner's written approval.
- Network: SSH (22) from your IP only. The worker makes outbound calls only, no inbound port is needed. Do not open the dashboard port to the internet.

## 1. Base setup
```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install git curl build-essential python3 sqlite3
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs
sudo useradd -m -s /bin/bash sewl
```

## 2. Code
```bash
sudo -iu sewl
git clone https://github.com/jegankumarsparks-source/Sewl.git ~/sewl && cd ~/sewl
git checkout main
npm install
npm test          # expect: tests 23, pass 23, fail 0
```

## 3. Secrets (.env, never in git)
```bash
cp .env.example .env && chmod 600 .env
nano .env         # set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; Helius keys only when the key plan is approved
```
- `.env` is git-ignored. Never paste keys into chat, issues or commits.
- `EXIT_POLICY_APPROVED=true` must be present in the process environment when running `npm run init` (the systemd unit below sets it).

## 4. Initialise the database once
```bash
EXIT_POLICY_APPROVED=true npm run init
```
To move an existing paper run, stop the old worker, copy `var/sewl.sqlite` (use `sqlite3 var/sewl.sqlite ".backup /path/out.sqlite"`) to the new host's `var/`, then start. Schema migrations are non-destructive and run on start.

## 5. systemd service (auto-restart)
`/etc/systemd/system/sewl.service`:
```ini
[Unit]
Description=SEWL paper-trading worker (PAPER ONLY)
After=network-online.target
Wants=network-online.target

[Service]
User=sewl
WorkingDirectory=/home/sewl/sewl
EnvironmentFile=/home/sewl/sewl/.env
Environment=EXIT_POLICY_APPROVED=true
ExecStart=/usr/bin/node src/main.js
Restart=always
RestartSec=15
StandardOutput=append:/home/sewl/sewl/var/worker.log
StandardError=append:/home/sewl/sewl/var/worker.log

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sewl
systemctl status sewl --no-pager
```
Optional status page publisher (one commit per publish) as a second unit running `scripts/publish_site.py` every 10 minutes with `GITHUB_TOKEN`-style access kept in a root-only file, never in the repo.

## 6. Log rotation
`/etc/logrotate.d/sewl`:
```
/home/sewl/sewl/var/worker.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  copytruncate
}
```
Evidence files under `var/evidence/` are kept for `evidence_retention_days` (90). Check disk with `df -h` weekly.

## 7. How a boot is confirmed
Every start writes one `health_events` row: component `worker`, code `startup`, detail `{version, keyless, mode, pid}`.
```bash
sqlite3 var/sewl.sqlite "SELECT at, detail_json FROM health_events WHERE code='startup' ORDER BY at DESC LIMIT 5;"
```
- One new row per restart. Several rows in a short time = crash loop, read `var/worker.log`.
- `loop-stalled` rows mean a loop did not finish within 3x its interval (a hang, or the host paused).
- `momentum-cycle` rows (about one per minute) show leads / scanned / triggered / opened. `scanned > 0` is healthy; `triggered = 0` is often legitimate.

## 8. Backups
Daily: `sqlite3 var/sewl.sqlite ".backup /home/sewl/backups/sewl-$(date +%F).sqlite"` via cron, keep 14 days.

## 9. Update procedure
```bash
cd ~/sewl && git pull && npm install && npm test
sudo systemctl restart sewl     # watch for a new 'startup' row and a 'momentum-cycle' row within ~60 s
```

## 10. Safety checklist
- [ ] `.env` mode 600, not in git (`git ls-files | grep -c '^.env$'` prints 0)
- [ ] `npm test` 23/23 on the new host
- [ ] Only ONE worker per database (never run two against the same file)
- [ ] No paid resources created without the owner's written approval
- [ ] Still paper only: no signing key anywhere on the host
