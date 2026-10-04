import { readFileSync } from 'node:fs';
import { openDb, nowIso } from '../src/db.js';
import { d, fmt } from '../src/decimal.js';
import { USDC } from '../src/sources/jupiter.js';

const cfg = JSON.parse(readFileSync('config/experiment.json', 'utf8'));
const db = openDb('var/sewl.sqlite');

if (!cfg.exit_policy_approved || process.env.EXIT_POLICY_APPROVED !== 'true') {
  console.error('Exit policy not approved. Set EXIT_POLICY_APPROVED=true in .env after reviewing config/experiment.json');
  process.exit(1);
}
const txId = crypto.randomUUID();
db.exec('BEGIN IMMEDIATE');
try {
  db.prepare(`INSERT INTO accounts (name, balance_usd) VALUES ('cash','0'), ('capital','0') ON CONFLICT(name) DO NOTHING`).run();
  const existing = db.prepare(`SELECT id FROM experiments WHERE id='exp-1'`).get();
  if (!existing) {
    db.prepare(`INSERT INTO experiments (id, name, state, starting_cash_usd, target_equity_usd, position_budget_usd, max_open_positions, policy_version, created_at)
      VALUES ('exp-1', ?, 'PAPER_ACTIVE', ?, ?, ?, ?, 'policy-v1', ?)`)
      .run(cfg.name, cfg.starting_cash_usd, cfg.target_equity_usd, cfg.position_budget_usd, cfg.max_open_positions, nowIso());
    db.prepare(`INSERT INTO journal_transactions (id, experiment_id, event_type, reference_id, posted_at, idempotency_key) VALUES (?,?,?,?,?,?)`)
      .run(txId, 'exp-1', 'SEED', 'exp-1', nowIso(), crypto.randomUUID());
    db.prepare(`INSERT INTO journal_lines (transaction_id, line_no, account, debit_usd, credit_usd) VALUES (?,0,'cash',?,'0')`).run(txId, cfg.starting_cash_usd);
    db.prepare(`INSERT INTO journal_lines (transaction_id, line_no, account, debit_usd, credit_usd) VALUES (?,1,'capital','0',?)`).run(txId, cfg.starting_cash_usd);
    db.prepare(`UPDATE accounts SET balance_usd=? WHERE name='cash'`).run(cfg.starting_cash_usd);
    db.prepare(`UPDATE accounts SET balance_usd=? WHERE name='capital'`).run(cfg.starting_cash_usd);
  }
  db.exec('COMMIT');
  console.log('DB initialized. experiment exp-1 state=' + db.prepare(`SELECT state FROM experiments WHERE id='exp-1'`).get().state + ' cash=$' + db.prepare(`SELECT balance_usd FROM accounts WHERE name='cash'`).get().balance_usd);
} catch (e) { db.exec('ROLLBACK'); console.error(e); process.exit(1); }
