# SEWL - Solana Early Wallet Lab (project package)

PAPER TRADING ONLY. No real money, no signing key, no transactions are ever sent.
Results are not proof of profit. A $500 paper wallet, $20 per coin, up to 12 open positions.

## What is in this folder
- src/        the worker (scanner, risk gates, paper ledger, Telegram outbox, app server)
- app/        the mobile-style dashboard app (plain HTML/JS/CSS, no build step)
- config/     settings (frozen paper rules: $500 wallet, $20/coin, take-profit 1.5x, stop-loss -50%)
- scripts/    helper scripts (database init, web export, Pages publisher)
- tests/      the automated tests (122 tests)
- docs/       the overall report and to-do notes
- var/sewl.sqlite   a snapshot of the live database (positions, signals, evidence index)
- var/evidence/     the raw saved API responses; each file's SHA-256 matches the database
- .env        the keys (Helius API key, Telegram bot token and chat id). Keep this file private.
- DEPLOYMENT.md   more detail on running it permanently

## Requirements
- Node.js 20 or newer (https://nodejs.org)
- A C/C++ build toolchain only if npm cannot download a prebuilt better-sqlite3 (usually not needed)
- Internet access (the worker reads public Solana data)

## Install
    cd SEWL_project
    npm install

## Start the worker (runs forever; stop with Ctrl+C)
    npm start

It scans new Solana coins every 60 seconds, checks them against the risk gates, and keeps a paper
ledger. It sends Telegram messages through the bot in .env. A paper entry card is sent only when a
real paper entry is opened.

To run it again if it stops, use:  bash run_loop.sh   (restarts the worker automatically)

## View the app
With the worker running, open this in a browser:  http://127.0.0.1:8787
On a phone on the same network, set the environment variable SEWL_APP_HOST=0.0.0.0 before
starting, then open http://<your computer's IP>:8787 . The app is read-only.

A public snapshot copy (no live data, updated about every 10 minutes) was published at:
https://jegankumarsparks-source.github.io/Sewl/app/

## Run the tests
    node --test tests/*.test.js

## Start fresh (optional)
Delete var/sewl.sqlite and var/evidence, then run:  npm run init

## Important notes
- The .env file contains live keys. Do not post this package publicly. Anyone with the
  Helius key can use its free credits; anyone with the Telegram bot token can send messages as the bot.
- The Helius key is on a free plan with a hard cap of 800,000 credits per month enforced in the code.
- Without the host awake the worker does not run. Expect gaps if you run it on a laptop that sleeps.
- Numbers shown as UNVERIFIED or estimated are labelled in the app and reports.
- Source code: https://github.com/jegankumarsparks-source/Sewl
