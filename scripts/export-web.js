// Read-only export of SEWL state to site/data.json for the static page. PAPER ONLY. No secrets, no chat/bot info.
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
const db = new Database('var/sewl.sqlite', { readonly: true });
const q = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const exp = one(`SELECT * FROM experiments WHERE id='exp-1'`);
const acc = Object.fromEntries(q(`SELECT name, balance_usd FROM accounts`).map(r => [r.name, r.balance_usd]));
const val = one(`SELECT at, cash_usd, open_value_usd, equity_usd, unrealized_pnl_usd, realized_pnl_usd, complete_data FROM equity_valuations ORDER BY at DESC LIMIT 1`);
const target = exp?.target_equity_usd ?? '800';
const equity = val && val.complete_data ? val.equity_usd : (q(`SELECT 1 FROM paper_positions WHERE state='OPEN' LIMIT 1`).length ? null : acc.cash ?? null);
const out = {
  generated_at: new Date().toISOString(),
  banner: 'PAPER TRADING ONLY. No real funds, no signing key. $800 is a target latch, not a promise. Research pilot; results are NOT proof of profitability.',
  experiment: exp ? { name: exp.name, state: exp.state, starting_cash_usd: exp.starting_cash_usd, target_equity_usd: target, position_budget_usd: exp.position_budget_usd, max_open_positions: exp.max_open_positions, created_at: exp.created_at, completed_at: exp.completed_at, pause_reason: exp.pause_reason } : null,
  account: { cash_usd: acc.cash ?? null, equity_usd: equity, equity_note: equity == null ? 'NOT EXACT: open positions without a fresh priced mark (DATA INCOMPLETE)' : 'cash + fresh liquidation marks', last_valuation_at: val?.at ?? null, unrealized_pnl_usd: val?.unrealized_pnl_usd ?? null, realized_pnl_usd: val?.realized_pnl_usd ?? null },
  counts: {
    wallets_by_status: q(`SELECT status, COUNT(*) n FROM wallets GROUP BY status`),
    buy_events: one(`SELECT COUNT(*) n FROM buy_events`).n,
    signals_by_decision: q(`SELECT decision, COUNT(*) n FROM signals GROUP BY decision`),
    positions_by_state: q(`SELECT state, COUNT(*) n FROM paper_positions GROUP BY state`),
    outbox_by_state: q(`SELECT state, COUNT(*) n FROM telegram_outbox GROUP BY state`),
    source_observations: one(`SELECT COUNT(*) n FROM source_observations`).n,
    last_observation_at: one(`SELECT MAX(received_at) t FROM source_observations`).t,
  },
  positions: q(`SELECT id, mint, entry_at, entry_total_usd, state, closed_at FROM paper_positions ORDER BY entry_at DESC LIMIT 25`),
  recent_signals: q(`SELECT id, mint, qualified_at, decision, reason_codes_json FROM signals ORDER BY qualified_at DESC LIMIT 15`),
  milestones: q(`SELECT position_id, multiple, first_observed_at FROM milestones ORDER BY first_observed_at DESC LIMIT 15`),
  health: q(`SELECT component, at, severity, code FROM health_events ORDER BY at DESC LIMIT 12`),
  limits: ['Not real-time: 120 s polling means 1-3 min delay.', 'Free RPC can throttle; unsupported venues (Pump.fun bonding curve, Orca) are INSUFFICIENT DATA.', 'Zero signals is a legitimate outcome.', 'Missing data stays NULL, never zero.'],
};
mkdirSync('site', { recursive: true });
writeFileSync('site/data.json', JSON.stringify(out));
console.log('exported', out.generated_at, 'state=' + (out.experiment?.state ?? 'n/a'));
