# TODO (non-blocking)

- Fetch one PumpSwap (PUMP_AMM) SELL transaction fixture when seen in the wild; the current pump_txs.json has a Pump.fun BUY, a Pump.fun SELL and a PumpSwap BUY only. Add a test mirroring the existing independent-delta checks.
- Read the Helius dashboard Usage page and compare with the helius_usage counter (counter starts at 0 on deploy, so it undercounts the few hundred credits spent before it existed).
