import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY, name, state, starting_cash_usd TEXT, target_equity_usd TEXT,
  position_budget_usd TEXT, max_open_positions INTEGER, policy_version, created_at,
  completed_at NULL, completion_valuation_id NULL, pause_reason NULL
);
CREATE TABLE IF NOT EXISTS source_observations (
  id TEXT PRIMARY KEY, provider, method, subject_key, requested_at, received_at,
  source_time NULL, slot INTEGER NULL, commitment NULL, http_status INTEGER NULL,
  payload_hash, payload_path, quality_state, error_code NULL
);
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY, discovered_at, discovery_evidence_id,
  discovery_method, cluster_id NULL, status DEFAULT 'DISCOVERED', last_score_id NULL
);
CREATE TABLE IF NOT EXISTS wallet_cursors (
  wallet_address TEXT PRIMARY KEY REFERENCES wallets(address),
  last_signature NULL, last_finalized_slot INTEGER NULL, last_success_at NULL,
  gap_state DEFAULT 'OK', backfill_before NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  signature TEXT PRIMARY KEY, slot INTEGER, block_time NULL, commitment,
  success INTEGER, parser_version, parse_state, evidence_id
);
CREATE TABLE IF NOT EXISTS wallet_trades (
  id TEXT PRIMARY KEY, wallet_address, signature, event_index INTEGER,
  mint, side, token_amount_raw TEXT, decimals INTEGER NULL, quote_mint,
  quote_amount_raw TEXT, notional_usd TEXT NULL, fee_usd TEXT NULL, venue,
  classification, evidence_id,
  UNIQUE(wallet_address, signature, event_index)
);
CREATE TABLE IF NOT EXISTS wallet_scores (
  id TEXT PRIMARY KEY, wallet_address, window_start, window_end,
  closed_round_trips INTEGER, distinct_mints INTEGER, parse_coverage TEXT,
  priced_coverage TEXT, win_rate TEXT NULL, wilson_lower TEXT NULL,
  median_return TEXT NULL, profit_factor TEXT NULL, top_profit_share TEXT NULL,
  score TEXT NULL, status, reason_codes_json, rule_version, computed_at
);
CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY, token_program, decimals INTEGER, supply_raw TEXT,
  mint_authority NULL, freeze_authority NULL, extensions_json, creation_time NULL,
  first_observed_at, last_chain_evidence_id
);
CREATE TABLE IF NOT EXISTS pools (
  address TEXT PRIMARY KEY, venue, base_mint, quote_mint, created_at NULL,
  creation_evidence_id NULL, classification_state
);
CREATE TABLE IF NOT EXISTS market_snapshots (
  id TEXT PRIMARY KEY, mint, pool_address NULL, observed_at, source_time NULL,
  price_usd TEXT NULL, liquidity_usd TEXT NULL, volume_5m_usd TEXT NULL,
  volume_1h_usd TEXT NULL, market_cap_usd TEXT NULL, fdv_usd TEXT NULL,
  evidence_id NULL, freshness_state
);
CREATE TABLE IF NOT EXISTS risk_assessments (
  id TEXT PRIMARY KEY, mint, assessed_at, rule_version, result,
  checks_json, evidence_ids_json, unknown_fields_json
);
CREATE TABLE IF NOT EXISTS buy_events (
  id TEXT PRIMARY KEY, wallet_address, trade_id, mint, onchain_time NULL,
  detected_at, latency_ms INTEGER NULL, eligibility_state
);
CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY, experiment_id, mint, qualified_at NULL,
  buy_event_ids_json, wallet_score_ids_json, risk_assessment_id NULL,
  snapshot_id NULL, rule_version, decision, reason_codes_json,
  dedupe_key UNIQUE
);
CREATE TABLE IF NOT EXISTS paper_positions (
  id TEXT PRIMARY KEY, experiment_id, signal_id, mint, entry_at,
  entry_units_raw TEXT, remaining_units_raw TEXT, decimals INTEGER,
  entry_total_usd TEXT, entry_unit_cost_usd TEXT, state DEFAULT 'OPEN',
  exit_policy_version, closed_at NULL
);
CREATE TABLE IF NOT EXISTS paper_fills (
  id TEXT PRIMARY KEY, position_id, side, at, units_raw TEXT,
  gross_usd TEXT, estimated_cost_usd TEXT, net_cash_delta_usd TEXT,
  fill_method, quote_evidence_id NULL, idempotency_key UNIQUE
);
CREATE TABLE IF NOT EXISTS journal_transactions (
  id TEXT PRIMARY KEY, experiment_id, event_type, reference_id, posted_at,
  idempotency_key UNIQUE
);
CREATE TABLE IF NOT EXISTS journal_lines (
  transaction_id, line_no INTEGER, account, debit_usd TEXT, credit_usd TEXT,
  PRIMARY KEY(transaction_id, line_no)
);
CREATE TABLE IF NOT EXISTS accounts (
  name TEXT PRIMARY KEY, balance_usd TEXT NOT NULL DEFAULT '0'
);
CREATE TABLE IF NOT EXISTS position_marks (
  id TEXT PRIMARY KEY, position_id, marked_at, units_raw TEXT,
  liquidation_value_usd TEXT NULL, indicative_value_usd TEXT NULL,
  net_multiple TEXT NULL, valuation_state, quote_evidence_id NULL, snapshot_id NULL
);
CREATE TABLE IF NOT EXISTS equity_valuations (
  id TEXT PRIMARY KEY, experiment_id, at, cash_usd TEXT,
  open_value_usd TEXT NULL, equity_usd TEXT NULL,
  unrealized_pnl_usd TEXT NULL, realized_pnl_usd TEXT,
  complete_data INTEGER, mark_ids_json
);
CREATE TABLE IF NOT EXISTS milestones (
  position_id, multiple INTEGER, first_observed_at, mark_id,
  PRIMARY KEY(position_id, multiple)
);
CREATE TABLE IF NOT EXISTS telegram_outbox (
  id TEXT PRIMARY KEY, experiment_id NULL, event_key UNIQUE, destination_ref,
  template_version, payload_json, state DEFAULT 'PENDING', attempts INTEGER DEFAULT 0,
  next_attempt_at NULL, telegram_message_id NULL, last_error NULL
);
CREATE TABLE IF NOT EXISTS health_events (
  id TEXT PRIMARY KEY, component, at, severity, code, detail_json
);
CREATE INDEX IF NOT EXISTS idx_trades_wallet_time ON wallet_trades(wallet_address);
CREATE INDEX IF NOT EXISTS idx_marks_pos ON position_marks(position_id);
CREATE INDEX IF NOT EXISTS idx_outbox_state ON telegram_outbox(state, next_attempt_at);
CREATE TABLE IF NOT EXISTS helius_usage (
  month TEXT PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 0, cap_notified INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, title TEXT NOT NULL, body_md TEXT NOT NULL,
  created_at TEXT NOT NULL, period TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_open_mint ON paper_positions(experiment_id, mint) WHERE state='OPEN';
`;

// Non-destructive, idempotent column additions (existing DBs keep all rows).
function addColumn(db, table, col, ddl) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
export function migrate(db) {
  addColumn(db, 'paper_positions', 'origin', `TEXT DEFAULT 'whale'`);
  addColumn(db, 'buy_events', 'origin', `TEXT DEFAULT 'whale'`);
  addColumn(db, 'buy_events', 'candle_start_ms', 'INTEGER NULL');
  addColumn(db, 'buy_events', 'detection_ms', 'INTEGER NULL');
  addColumn(db, 'buy_events', 'entry_ms', 'INTEGER NULL');
  addColumn(db, 'buy_events', 'candle_time_source', 'TEXT NULL');
}

let writer = Promise.resolve();
export function openDb(file = 'var/sewl.sqlite') {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
// Single-writer: serialize all mutating work behind one promise chain and use
// BEGIN IMMEDIATE so the capacity/latch check and the entry commit are atomic.
export function withTx(db, fn) {
  const run = writer.then(() => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  });
  writer = run.catch(() => {});
  return run;
}
export const nowIso = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();
