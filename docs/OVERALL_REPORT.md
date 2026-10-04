# SEWL overall report (architecture review)

Prepared 2026-10-04 about 11:40 IST. Paper trading only: no signing key, no real funds, no transaction is ever submitted.
Repo: https://github.com/jegankumarsparks-source/Sewl | Page: https://jegankumarsparks-source.github.io/Sewl/
Scope: everything from the first deploy (09:28 IST) to now. Accuracy over polish; items I could not verify are marked UNVERIFIED.

## 1. Timeline (all times IST, 2026-10-04)

| Time | Event | Commit / branch |
|---|---|---|
| 09:28 | First codebase unpacked, npm install, tests (5/5 after fixing the Node 22 test script), init, worker started under a restart loop | local only |
| 09:48 | Updated codebase received and diffed: only paper.js, tests, README, experiment.json (+package.json) changed; db.js identical (no schema change). 12/12 tests. Hot-swapped with DB + code backup | local |
| 09:50 | Config/DB mismatch found and fixed: experiments row still said $50 / max 10 (paper.js reads max_open from that row). Set to $20 / 12 with 0 positions | local, DB only |
| 10:10 | Repo populated, Pages enabled and built | 3d31fb0 (.gitignore first), 5b24959 (code + page) |
| 10:17 | Phase 0: fresh-clone verify (12/12), removed duplicate `mode_note`, removed unused `const bal` | 391153c on v2-phase0, merged to main |
| 10:21 | Timeout hotfix (AbortSignal on every fetch, stall heartbeat), tests 16/16, hot-swapped | 1bae1b5 on v2-hotfix-timeout |
| 10:23-10:28 | Phase 1 momentum engine, batch endpoint fix, per-cycle stats rows; tests 23/23 | b9ea697, a81bf16, 130e5ab on v2-momentum |
| 10:54 | Hotfix merged to main | 5047b37 |
| 10:55 | Momentum build hot-swapped live (DB backed up, startup row + momentum cycles confirmed) | local deploy of 130e5ab |
| 11:03 | v2-momentum merged to main; DEPLOYMENT.md written | e78d63a, 5cccc32 |
| 11:06 | DEPLOYMENT.md merged | 40e6ff4 |
| 11:35 | This report | branch v2-overall-report (not merged) |

Interleaved "status page update" commits on main are the publisher (one commit per publish).
Branches kept: v2-phase0, v2-hotfix-timeout, v2-momentum, v2-deploy-doc, v2-overall-report.

## 2. Architecture

Single Node.js process (ES modules), one dependency (better-sqlite3), SQLite file `var/sewl.sqlite` (WAL). 1,404 lines in src/ + scripts/.

### Modules
- `src/main.js`: wiring, 6 loops (discovery 15 min, history 5 min, watch 120 s, mark 120 s, outbox flush 30 s, momentum 60 s), daily digest, startup health row, stall heartbeat.
- `src/db.js`: schema (23 tables), non-destructive `migrate()`, single-writer `withTx()` (BEGIN IMMEDIATE), uuid/now helpers.
- `src/rpc.js`: JSON-RPC client with quota (30 calls / 10 s keyless), 15 s timeout, retry on timeout/429/50x, evidence recording.
- `src/sources/dexscreener.js`, `jupiter.js`, `coingecko.js`: read-only HTTP clients with quotas (25/min, 25/min, 5/min), 15 s timeouts, every call stored as a source_observation. Jupiter is quote-only.
- `src/evidence.js`: stores every provider response (hash + file under var/evidence, 90 day retention setting).
- `src/parser.js`: owner-delta swap parser; venue by program id (Raydium AMM/CLMM/CPMM, Orca Whirlpool, Pump.fun). Pump.fun is only DETECTED as a venue; bonding-curve buys are not decoded (INSUFFICIENT DATA).
- `src/detection.js`, `src/wallets.js`: buy detection, wallet history reconstruction, wallet quality scoring (Wilson bound, profit factor, coverage gates).
- `src/validation.js`: token gates (mint/freeze authority null, no Token-2022 extensions, owner concentration, liquidity, full-size sell quote); writes risk_assessments.
- `src/signal.js`: whale signal chain (notional >= $50, pool age <= 6 h, >= 2 clusters in 15 min, risk gates, chase test <= 1.5x, 10 min observation window, entry quote).
- `src/momentum.js` (new): momentum trigger, validation under 30 s deadline, entry via `paperEntry`, cooldown, latency stats.
- `src/paper.js`: paperEntry (atomic capacity + latch check), paperExit, markAndExitCycle (TP/SL/time/rug write-off), double-entry journal, equity valuation.
- `src/telegram.js`: outbox with card templates; 10 s timeout; timeout -> AMBIGUOUS_DELIVERY.
- `scripts/init-db.js` (needs EXIT_POLICY_APPROVED=true in env), `export-web.js` (read-only DB -> data.json), `publish_site.py` (one commit per publish, refuses .env/var/node_modules).
- `index.html` + `data.json`: static status page on Pages.

### Data flow
1. Discovery: DEX Screener boosts/profiles -> pools inside the 60 min early window -> early swaps via RPC -> candidate wallets -> history reconstruction -> scoring -> QUALIFIED wallets.
2. Watch: qualified wallets' new transactions -> buy events -> signal chain (section above) -> paperEntry.
3. Momentum: leads (<= 30 per cycle, one batch call) -> trigger -> validation -> paperEntry with origin `momentum`.
4. Mark cycle (120 s): Jupiter full-size sell quote per open position -> liquidation value -> milestones, TP (gross quote >= 1.5x cost), SL (net <= 50% of cost), 24 h time limit, rug write-off (720 consecutive UNPRICEABLE marks) -> paperExit -> journal -> equity_valuations.
5. Outbox: signal/milestone/exit/digest/complete cards -> Telegram (flush every 30 s).
6. Publisher: export-web.js -> data.json -> one Git Data API commit every 10 min if changed.

### Database (23 tables)
accounts, buy_events, equity_valuations, experiments, health_events, journal_lines, journal_transactions, market_snapshots, milestones, paper_fills, paper_positions, pools, position_marks, risk_assessments, signals, source_observations, telegram_outbox, tokens, transactions, wallet_cursors, wallet_scores, wallet_trades, wallets.
Added by migration: paper_positions.origin; buy_events.origin, candle_start_ms, detection_ms, entry_ms, candle_time_source.
Row counts now: wallets 0, signals 0, paper_positions 0, telegram_outbox 0, journal_transactions 1 (initial capital), accounts 2.

## 3. Live status (11:35 IST)
- Processes: one worker loop (restart loop + node), one publisher loop. Startup health rows for the current build: 1.
- Momentum (since 10:55 swap): 13 cycle rows, about 390 leads / pairs scanned, 0 triggered, 0 opened, 0 momentum signals. Cycles per wall hour are far below 60 because of the host freeze (section 5).
- Live trigger check on real data: 30 pairs -> 0 triggers. Reasons: surge < 100% (23), volume surge < 5x (25), pool > 6 h (11), liquidity < $25k or unknown (18).
- Paper account: cash $500.00, equity $500.00, 0 positions, 0 signals.
- source_observations trend (UTC hour of request): 04h 171, 05h 90, 06h 6 (total 267, all status OK, 0 TIMEOUT). Before the hotfix restart it sat flat at 114 for 29.5 min (latest 04:20:30Z while server time was 04:50:03Z).
- health_events summary: INFO momentum-cycle 13, INFO worker/startup 1, WARN loop-stalled 10 (outbox 5, momentum 3, mark 1, watch 1). ERROR: 0. Every WARN lines up with a resume gap after a host freeze (ages 123-258 s on 30-120 s loops); none was a confirmed hang.
- Page: live, HTTP 200; data.json refreshes at most once per hour when unchanged.

## 4. Test inventory (23 tests, 23 pass, 0 fail; `npm test` = `node --test tests/paper.test.js tests/timeout.test.js tests/momentum.test.js`)

paper.test.js (12): 12 coins x $20 = $240 deployed, $260 cash, 13th denied and slot recycling; journal debits == credits; completion latch blocks a racing entry at equity >= $800; unpriceable holding blocks exact equity and new entries; exit posts realized P&L and restores cash; TP fires at 1.5X gross; rug write-off after N unpriceable cycles; rotation mode x5 (one position, TP, 12 coins then latch, SL, 25% compounding).
timeout.test.js (4): every fetch carries a signal; RPC timeout retried then succeeds; DEX Screener timeout records ERROR TIMEOUT and throws; Telegram timeout -> AMBIGUOUS_DELIVERY.
momentum.test.js (7): all four trigger conditions; missing data never triggers; entry reuses paperEntry with origin tag and balanced journal; 4-slot momentum cap with whale slots and recycling; latency fields stored; failed validation creates no position; migration idempotent.

Coverage notes (gaps): no tests for parser.js (swap parsing), wallets.js (scoring), detection.js, signal.js (whale chain), validation.js (gates), the outbox card templates, publish_site.py, or the stall heartbeat loop. The momentum validation is tested with an injected validator, not the real validateToken against RPC. No integration test runs a full live discovery. Mocked fetch is used for timeouts.

## 5. Known issues and honest caveats

Historical (fixed):
1. `npm test` with a directory argument fails on Node 22 -> script now names the files.
2. First init needs EXIT_POLICY_APPROVED in the process env, `.env` alone is not enough -> documented in DEPLOYMENT.md.
3. Two worker loops ran for about a minute after my first restart (old loop survived the pkill pattern) -> killed both, one loop, verified. No positions existed.
4. DB experiments row ($50 / 10) disagreed with the new config ($20 / 12); paper.js reads max_open from the row -> columns updated with 0 positions.
5. Duplicate `mode_note` and unused `const bal` -> removed (Phase 0).
6. Unbounded fetch could hang a loop silently -> 15 s AbortSignal everywhere + stall heartbeat. The hang was diagnosed from a flat observation count; I could not reproduce it separately from the freeze below.
7. My first momentum draft used the single-token /token-pairs endpoint with a comma list (returned nothing); fixed to the batch /tokens/v1 endpoint and verified on live data.
8. Test run lasted 32 s because the 30 s validation-deadline timer was not cleared; fixed (2 s).

Current (open):
1. HOST FREEZE: /proc/uptime shows about 491,000 s monotonic vs about 939,000 s wall since boot; process start times and mark-loop gaps (4-9 min) agree. The sandbox is suspended when no agent session is active, so the worker only runs while awake. Inference, not proven; frequency unmeasured. The Oracle VM plan was cancelled (no card), so there is no always-on host.
2. Telegram delivery is UNVERIFIED end to end: the outbox has had 0 rows.
3. Momentum candle time is a 5-minute WINDOW BOUND (DEX Screener has no candle open time); latency numbers are upper bounds.
4. Momentum coverage is limited to boosted/profiled Solana leads; no all-new-pairs feed on the free API.
5. Whale discovery has found 0 early pools in the 60 min window and 0 wallets; cause (market vs lead source) UNVERIFIED.
6. Pump.fun bonding-curve buys: INSUFFICIENT DATA (decoder is Phase 3).
7. Keyless public RPC (30 req / 10 s) is the throughput ceiling for discovery and validation.
8. Exits were never exercised on a live position (only in unit tests). Nothing here is evidence of profitability.
9. The SEWL-only GitHub token is in the owner's vault, which has no read action for me; the publisher still uses the shared token. SEWL's alert outbox shares an existing Telegram bot with a paused project (owner decision).
10. The live checkout in /home/sandbox/sewl is a separate working copy from /home/sandbox/sewl_v2 (the git clone); they hold the same main code, but the live one has its own local commits and is not the source of truth.

## 6. Pending items
- Tokens: SEWL-only GitHub token delivery path (provision on the future host, or file attachment); Telegram bot: keep shared for now.
- Hosting: no always-on host without a card (options in the full report). DEPLOYMENT.md is ready.
- 24 h clean-runtime clock for Phase 2: cannot start on a host that freezes.
- Phase 2: multi-key duty plan (scanner / watcher / backfill / reserve), watcher poll 120 s -> 60 s, per-key quota rows in health_events.
- Phase 3: Pump.fun bonding-curve decoder with 2-3 real tx fixtures.
- Phase 4: parsed-trade candle timing (replaces the 5-minute bound).
- Phase 5 (new): premium mobile app + reports archive (branch v2-app).

## 7. Config snapshot (config/experiment.json on main, live)
```json
{
  "name": "SEWL $500 paper", "mode": "concurrent",
  "starting_cash_usd": "500", "target_equity_usd": "800",
  "position_budget_usd": "20", "max_open_positions": 12,
  "exit_policy_approved": true, "exit_policy": { "stop_loss_net": "0.50", "max_hold_hours": 24 },
  "take_profit_multiple": "1.5", "rug_writeoff_unpriceable_cycles": 720,
  "poll_seconds": 120, "mark_seconds": 120, "discovery_cadence_minutes": 15, "outbox_flush_seconds": 30,
  "discovery": { "max_qualified_wallets": 12, "pairs_per_cycle": 10, "early_swap_sample": 200, "early_window_minutes": 60, "new_candidates_per_day": 20, "wallet_history_tx_cap": 300 },
  "quality": { "score_min": "65", "wilson_min": "0.40", "median_min": "0", "pf_min": "1.20", "window_days": 60, "min_span_days": 30, "min_round_trips": 20, "min_mints": 10, "parse_coverage": "0.95", "priced_coverage": "0.90" },
  "signal": { "min_notional_usd": "50", "pool_age_max_hours": 6, "cluster_window_minutes": 15, "cluster_min_wallets": 2, "max_chase_multiple": "1.5", "min_watch_minutes": 10, "max_observed_multiple": "2" },
  "friction": { "entry_fee_usd": "0.25", "entry_haircut": "0.01", "exit_fee_usd": "0.25", "exit_haircut": "0.01" },
  "validation": { "min_liquidity_usd": "25000", "max_impact": "0.02", "max_largest_owner": "0.15", "max_top_owners": "0.50", "market_fresh_seconds": 60, "quote_fresh_seconds": 20 },
  "momentum": { "enabled": true, "cycle_seconds": 60, "window_minutes": 5, "price_surge_pct": 100, "volume_surge_x": 5, "pool_age_max_hours": 6, "min_liquidity_usd": 25000, "max_slots": 4, "validation_deadline_seconds": 30, "cooldown_minutes": 60, "max_leads_per_cycle": 30 },
  "quotas": { "rpc_per_10s": 30, "dexscreener_per_min": 25, "jupiter_per_min": 25, "coingecko_per_min": 5 },
  "allow_scenario_entries": false, "evidence_retention_days": 90
}
```
(The rotation block is present but unused: mode is "concurrent".)
Frozen constants: $500 wallet, $20/coin, 12 max concurrent, $260 reserve, TP 1.5X gross, SL -50%, rug write-off 24 h without a quote, $800 latch is not a promise, paper only, missing data = NULL, no key rotation to evade throttling, no paid resource without written approval.
