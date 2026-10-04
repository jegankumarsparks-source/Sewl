# Solana Early Wallet Lab (SEWL)

**PAPER TRADING ONLY — உண்மைப் பணம் இல்லை. No signing key, no real funds, no transactions submitted.**
A $500 → $800 evidence-first research pilot that watches high-quality early wallets and mirrors their
buys in a paper ledger. $800 is a *completion latch*, **not a promise or a prediction**.

---

## ⚠️ நேர்மையான உண்மைகள் (Honest limitations — read first)

1. **"Whale buy பண்ற நேரத்துல அதே நேரத்துல" முடியாது.** Free RPC keyless-இல் நாங்கள் *poll* செய்கிறோம்:
   ஒவ்வொரு 120 நொடிக்கு ஒருமுறை wallet signatures பார்க்கிறோம். Real delay = poll interval + RPC latency,
   பொதுவாக **1–3 நிமிடங்கள்**. இதுவே keyless-இல் சாத்தியமான அதிகபட்சம். Delay ஒவ்வொரு signal-இலும்
   `buy_events.latency_ms` ஆக evidence-ஆக record ஆகும் — மறைக்கப்படாது.
2. **$800 guarantee இல்லை.** இது monitoring latch மட்டுமே. Zero signals கூட legitimate outcome.
3. **நான் உங்களுக்காக server ஓட்ட முடியாது.** Code + deploy guide தருகிறேன்; நீங்கள் host செய்ய வேண்டும்.
4. **Free RPC மட்டுப்படுத்தப்படும் / block செய்யப்படலாம்.** Public endpoint production-க்கு அல்ல (Solana docs).
   Optional: free Helius key (1M credits/மாதம்).
5. Parser heuristic ஆகும் (owner-balance-delta): unknown flows swaps ஆக force செய்யப்படாது;
   unsupported venues (Pump.fun bonding curve, Orca) → `INSUFFICIENT DATA`, silent inference இல்லை.
6. Token-2022 extensions ஏதேனும் இருந்தால் conservative-ஆக **BLOCK** (future finer decoding).
7. Largest-accounts வெறும் 20 token accounts மட்டுமே; owner aggregation சிறிய wallets-இல் incomplete ஆகலாம்.

## Quickstart (உங்கள் PC-இல்)

```bash
# 1. Node.js 20+ தேவை: https://nodejs.org
git clone <this repo> && cd solana-early-wallet-lab
npm install               # better-sqlite3 (native module; build tools தேவைப்பட்டால்: visual studio build tools / xcode CLT)
cp .env.example .env      # Telegram token/chat id ஐ நிரப்பவும் (விரும்பினால் Helius key)
npm run init              # DB + $500 paper cash seed (exit policy ஐ config-இல் review செய்து EXIT_POLICY_APPROVED=true வைக்கவும்)
npm start                 # நிரந்தர worker: discovery + watch + marks + telegram outbox
```

Cron-style (free hosting-இல் அல்லது ஒவ்வொரு நிமிடமும்):
```bash
node src/main.js once     # ஒரு முழு cycle (discover+history+watch+mark+flush)
```

## எப்படி வேலை செய்கிறது

```
DEX Screener leads (promotional only - not quality evidence)
  → new pool transactions → early-window swap owners = candidate wallets
  → wallet history reconstruction (FIFO round trips, SOL/USD via CoinGecko historical)
  → quality score: 35·Wilson + 25·median + 20·profit factor + 10·concentration + 10·coverage
     (gates: score≥65, Wilson≥0.40, median>0, PF≥1.20, ≥20 round trips, ≥10 mints)
  → qualified wallets polled every 120s (getSignaturesForAddress cursor)
  → new finalized BUY: notional≥$50, pool age≤6h, ≥2 clusters in 15 min,
     risk gates (null authorities, no extensions, liquidity≥$25k, sell quote, concentration),
     chase ≤1.5x whale price, no 2x pump in 10-min window
  → paper entry: $50 ($0.25 fee reserve + 1% haircut), max 10 positions, Jupiter read-only quote
  → marks every 120s (full-size sell quote), 2X/3X/5X/10X milestones,
     auto-exit at ≤50% of cost or 24h (configurable, approval required)
  → equity ≥$800 → EXPERIMENT COMPLETE (atomic latch; never reopens)
  → Telegram cards: signal / milestone / exit / daily digest / completion
```

## Telegram setup

1. @BotFather → `/newbot` → token-ஐ `.env`-இல் `TELEGRAM_BOT_TOKEN`
2. Bot-ஐ துவங்கி உங்கள் chat id-ஐ பெறவும் (userinfobot) → `TELEGRAM_CHAT_ID`
3. வெறும் outgoing மட்டுமே; webhook இல்லை. 429-இல் backoff; delivery ambiguous என்றால் `AMBIGUOUS_DELIVERY`.

## Free hosting வழிகள் (24/7 செய்ய)

| Option | குறிப்பு |
|---|---|
| நீங்கள் PC / Raspberry Pi | `npm start` — free-ஆக நேரடியாக |
| Render / Railway / Fly.io free tier | மாறக்கூடியது; free always-on உத்தரவாதமில்லை — limitation என report செய்யவும், கட்டணம் கொடுக்க வேண்டாம் என்றால் |
| GitHub Actions cron (5-min) | `node src/main.js once` ஒவ்வொரு run-இலும்; artifacts-இல் `var/sewl.sqlite` persist செய்யவும்; 120s poll சாத்தியமில்லை — delay அதிகமாகும் |

## Tests

```bash
npm test   # accounting invariants: 10x$50 never overspends, journal balances,
           # $800 latch blocks racing entry, unpriceable blocks equity, exit P&L
```

## முக்கிய files

| File | பணி |
|---|---|
| `src/rpc.js` | Solana JSON-RPC + quota token bucket + evidence |
| `src/parser.js` | owner-level swap detection (pre/post balance deltas) |
| `src/wallets.js` | history reconstruction, FIFO round trips, quality score |
| `src/detection.js` | watched-wallet new-buy detection (proof: on-chain time vs detected time) |
| `src/validation.js` | mint decode, authorities, extensions, largest accounts, liquidity, sell quote |
| `src/signal.js` | full gate chain → signal → paper entry decision with reason codes |
| `src/paper.js` | double-entry journal, capacity+completion latch (atomic), marks, exits |
| `src/telegram.js` | durable outbox, cards, rate limit, ambiguous delivery |
| `var/sewl.sqlite` | durable state (never commit) |

## Compliance / safety

- No real transactions: Jupiter is used **quote-only** (`/swap/v2/order` without taker, never submitted).
- No other project's files, credentials, or databases are touched. Fresh repo, fresh DB, fresh bot.
- Evidence retention: raw responses hashed + stored under `var/evidence/` (90 days proposal).
- Every decision carries reason codes; missing data is `NULL` + reason, **never zero or pass**.

## Status

Design + working pilot code. **Not battle-tested.** Run `npm test`, then paper-run for days/weeks.
A zero-signal outcome is legitimate and will be reported honestly.

## Rotation mode (1 position at a time) — optional

Set `"mode": "rotation"` in `config/experiment.json`:

```json
"rotation": {
  "max_positions": 1,            // only 1 open position at a time
  "max_total_entries": 12,       // experiment ends after 12 coins
  "take_profit_multiple": "1.5", // exit when net value >= 1.5x cost
  "stop_loss_net": "0.50",       // exit when net value <= 50% of cost
  "max_hold_hours": 24,
  "position_pct_of_cash": null   // null = flat $50; "0.25" = compound (25% of current cash)
}
```

Honest math for $500 -> $800 with rotation mode:
- Flat $50: each win +$25, each loss -$25. Reaching +$300 needs 12/12 wins - unrealistic.
- Compounding 25% of cash: 3 straight wins take equity to ~$703; 4 wins / 1 loss also nears $800.
- With a 45-55% realistic win rate after quality gates, expect roughly break-even to +$100-150;
  the $800 latch is a stretch goal, not a plan. Treat the 12-coin rotation as a measured sample.

## உன் strategy (default config) — $20 x 12 coins

```
mode: "concurrent" (default now)
position_budget_usd: 20        -> 1 coin = $20
max_open_positions: 12         -> 12 coins concurrent = $240 max deployed
                                 remaining $260 stays as unused reserve
take_profit_multiple: "1.5"    -> gross sell quote >= $30 (1.5x) => TAKE_PROFIT exit
                                 (TP checks the GROSS quote; friction 1% + $0.25 is
                                  deducted from proceeds. Net at exactly 1.5x = $29.45.)
stop_loss_net: "0.50"          -> net value <= $10 (50% of $20) => STOP_LOSS exit
rug_writeoff_unpriceable_cycles: 720
                                 -> no sell quote for 720 consecutive mark cycles
                                    (720 x 120s = 24h) since last priced mark
                                    => RUG_WRITE_OFF at $0 (approved evidence policy)
Exit proceeds recycle: a closed slot's $20 is immediately reusable by the next signal.
Math note: $240 deployed, all 12 hit 1.5x once = +$120 => equity $620. Reaching $800
needs recycled wins (e.g. ~+300 net across successive rounds). $800 is a latch, not a plan.
```
