import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { paperEntry, paperExit, conservativeEquity, getExperiment, markAndExitCycle, realizedPnl } from '../src/paper.js';
import { d, fmt } from '../src/decimal.js';

const cfg = JSON.parse((await import('node:fs')).readFileSync('config/experiment.json', 'utf8'));
// config now: $500 cash, $20 per coin, max 12 open (= $240 max deployed, $260 reserve)

function freshDb() {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO experiments (id, name, state, starting_cash_usd, target_equity_usd, position_budget_usd, max_open_positions, policy_version, created_at)
    VALUES ('exp-1','t','PAPER_ACTIVE','500','800','20',12,'v','now')`).run();
  db.prepare(`INSERT INTO accounts (name, balance_usd) VALUES ('cash','500'), ('capital','500')`).run();
  return db;
}
const deps = { cfg, outbox: null };
const jup = (outAmount) => ({ cfg, outbox: null, jupiter: { sellQuote: async () => ({ quote: { outAmount }, evidenceId: null }) } });
const jupFail = (extra = {}) => ({ ...deps, ...extra, jupiter: { sellQuote: async () => { throw new Error('no route'); } } });

test('12 coins x $20 = $240 deployed, cash $260 reserve, 13th denied', async () => {
  const db = freshDb();
  for (let i = 0; i < 12; i++) {
    const r = await paperEntry(db, deps, { signalId: 's' + i, mint: 'mint' + i, entryUnitsRaw: '1000', decimals: 6, quoteEvidenceId: null });
    assert.ok(!r.denied, 'entry ' + i + ' denied: ' + r.denied);
  }
  assert.equal(db.prepare(`SELECT balance_usd FROM accounts WHERE name='cash'`).get().balance_usd, '260');
  const denied = await paperEntry(db, deps, { signalId: 'sX', mint: 'mintX', entryUnitsRaw: '1000', decimals: 6, quoteEvidenceId: null });
  assert.equal(denied.denied, 'no-capacity');
  // sold position frees a slot and redeploys $20
  const first = db.prepare(`SELECT id FROM paper_positions WHERE mint='mint0'`).get().id;
  await paperExit(db, deps, first, 'TAKE_PROFIT', '30', null);
  const again = await paperEntry(db, deps, { signalId: 'sY', mint: 'mintY', entryUnitsRaw: '1000', decimals: 6, quoteEvidenceId: null });
  assert.ok(!again.denied);
});

test('journal balances: debits == credits on every transaction', async () => {
  const db = freshDb();
  await paperEntry(db, deps, { signalId: 's1', mint: 'A', entryUnitsRaw: '100', decimals: 2, quoteEvidenceId: null });
  await paperExit(db, deps, db.prepare(`SELECT id FROM paper_positions`).get().id, 'STOP_LOSS', '10', null);
  const bad = db.prepare(`SELECT jt.id FROM journal_transactions jt WHERE
    (SELECT SUM(CAST(debit_usd AS REAL)) FROM journal_lines WHERE transaction_id=jt.id) !=
    (SELECT SUM(CAST(credit_usd AS REAL)) FROM journal_lines WHERE transaction_id=jt.id)`).all();
  assert.equal(bad.length, 0);
});

test('completion latch blocks racing entry once equity >= $800', async () => {
  const db = freshDb();
  const r = await paperEntry(db, deps, { signalId: 's1', mint: 'A', entryUnitsRaw: '100', decimals: 2, quoteEvidenceId: null });
  db.prepare(`INSERT INTO position_marks (id, position_id, marked_at, units_raw, liquidation_value_usd, net_multiple, valuation_state)
    VALUES ('m1',?, 'now', '100', '500', '25', 'PRICED')`).run(r.id);
  const e = conservativeEquity(db);
  assert.equal(fmt(e.equity), '980'); // 480 cash + 500 mark
  const denied = await paperEntry(db, deps, { signalId: 's2', mint: 'B', entryUnitsRaw: '100', decimals: 2, quoteEvidenceId: null });
  assert.match(denied.denied, /complete|latched/);
  assert.equal(getExperiment(db).state, 'EXPERIMENT_COMPLETE');
  db.prepare(`INSERT INTO position_marks (id, position_id, marked_at, units_raw, liquidation_value_usd, net_multiple, valuation_state)
    VALUES ('m2',?, 'now', '100', '5', '0.25', 'PRICED')`).run(r.id);
  const denied2 = await paperEntry(db, deps, { signalId: 's3', mint: 'C', entryUnitsRaw: '100', decimals: 2, quoteEvidenceId: null });
  assert.equal(denied2.denied, 'experiment-complete');
});

test('unpriceable holding blocks exact equity and new entries', async () => {
  const db = freshDb();
  const r = await paperEntry(db, deps, { signalId: 's1', mint: 'A', entryUnitsRaw: '100', decimals: 2, quoteEvidenceId: null });
  db.prepare(`INSERT INTO position_marks (id, position_id, marked_at, units_raw, valuation_state) VALUES ('m1',?,'now','100','UNPRICEABLE')`).run(r.id);
  const e = conservativeEquity(db);
  assert.equal(e.equity, null);
  const denied = await paperEntry(db, deps, { signalId: 's2', mint: 'B', entryUnitsRaw: '100', decimals: 2, quoteEvidenceId: null });
  assert.equal(denied.denied, 'unpriceable-holdings');
});

test('exit posts realized P&L and restores cash', async () => {
  const db = freshDb();
  const r = await paperEntry(db, deps, { signalId: 's1', mint: 'A', entryUnitsRaw: '100', decimals: 2, quoteEvidenceId: null });
  const x = await paperExit(db, deps, r.id, 'TAKE_PROFIT', '30', null);
  assert.equal(x.pnl, '10'); // 30 - 20
  assert.equal(db.prepare(`SELECT balance_usd FROM accounts WHERE name='cash'`).get().balance_usd, '510');
  assert.equal((realizedPnl(db) / 1000000n).toString(), '10');
});

test('concurrent: take profit fires at 1.5X gross ($30 quote on $20 entry)', async () => {
  const db = freshDb();
  const r = await paperEntry(db, deps, { signalId: 's1', mint: 'T', entryUnitsRaw: '100', decimals: 2, quoteEvidenceId: null });
  await markAndExitCycle(db, jup('30000000')); // gross $30 = 1.5x -> TP; net = 30*0.99-0.25 = 29.45
  const pos = db.prepare(`SELECT * FROM paper_positions WHERE id=?`).get(r.id);
  assert.equal(pos.state, 'CLOSED');
  const fill = db.prepare(`SELECT * FROM paper_fills WHERE position_id=? AND side='SELL'`).get(r.id);
  assert.ok(Math.abs(Number(fill.gross_usd) - 29.45) < 0.001);
  assert.equal(Number(fmt(realizedPnl(db))), 9.45); // 29.45 - 20
});

test('rug: unpriceable for N consecutive cycles => write off at 0', async () => {
  const db = freshDb();
  const cfg2 = { ...cfg, rug_writeoff_unpriceable_cycles: 2 };
  const d2 = jupFail({ cfg: cfg2 });
  const r = await paperEntry(db, d2, { signalId: 's1', mint: 'RUG', entryUnitsRaw: '100', decimals: 2, quoteEvidenceId: null });
  await markAndExitCycle(db, d2); // consec 1
  assert.equal(db.prepare(`SELECT state FROM paper_positions WHERE id=?`).get(r.id).state, 'OPEN');
  await markAndExitCycle(db, d2); // consec 2 -> write-off
  const pos = db.prepare(`SELECT * FROM paper_positions WHERE id=?`).get(r.id);
  assert.equal(pos.state, 'CLOSED');
  const fill = db.prepare(`SELECT * FROM paper_fills WHERE position_id=? AND side='SELL'`).get(r.id);
  assert.equal(fill.gross_usd, '0');
  assert.equal(fmt(realizedPnl(db)), '-20');
});

// ---------- ROTATION MODE: 1 position at a time, max 12 coins, TP 1.5X, SL 50% ----------
const rotCfg = { ...cfg, mode: 'rotation' };
const rotDeps = { cfg: rotCfg, outbox: null };
const mockJup = (outAmount) => ({ cfg: rotCfg, outbox: null, jupiter: { sellQuote: async () => ({ quote: { outAmount }, evidenceId: null }) } });

test('rotation: one open position at a time', async () => {
  const db = freshDb();
  const a = await paperEntry(db, rotDeps, { signalId: 's1', mint: 'A', entryUnitsRaw: '100', decimals: 2, quoteEvidenceId: null });
  assert.ok(!a.denied);
  const b = await paperEntry(db, rotDeps, { signalId: 's2', mint: 'B', entryUnitsRaw: '100', decimals: 2, quoteEvidenceId: null });
  assert.equal(b.denied, 'no-capacity');
  await paperExit(db, rotDeps, a.id, 'STOP_LOSS', '10', null);
  const c = await paperEntry(db, rotDeps, { signalId: 's3', mint: 'B', entryUnitsRaw: '100', decimals: 2, quoteEvidenceId: null });
  assert.ok(!c.denied);
});

test('rotation: take profit at 1.5X gross exits', async () => {
  const db = freshDb();
  const a = await paperEntry(db, rotDeps, { signalId: 's1', mint: 'A', entryUnitsRaw: '100', decimals: 2, quoteEvidenceId: null });
  await markAndExitCycle(db, mockJup('30000000')); // gross 30 = 1.5x20 -> TP (net 29.45)
  const pos = db.prepare(`SELECT * FROM paper_positions WHERE id=?`).get(a.id);
  assert.equal(pos.state, 'CLOSED');
  const fill = db.prepare(`SELECT * FROM paper_fills WHERE position_id=? AND side='SELL'`).get(a.id);
  assert.ok(Math.abs(Number(fill.gross_usd) - 29.45) < 0.001);
});

test('rotation: 12th coin allowed, 13th denied, then latches EXPERIMENT_COMPLETE', async () => {
  const db = freshDb();
  for (let i = 0; i < 12; i++) {
    const r = await paperEntry(db, rotDeps, { signalId: 's' + i, mint: 'm' + i, entryUnitsRaw: '100', decimals: 2, quoteEvidenceId: null });
    assert.ok(!r.denied, 'entry ' + i);
    await paperExit(db, rotDeps, r.id, 'STOP_LOSS', '10', null);
  }
  const denied = await paperEntry(db, rotDeps, { signalId: 'x', mint: 'mx', entryUnitsRaw: '100', decimals: 2, quoteEvidenceId: null });
  assert.equal(denied.denied, 'rotation-complete');
  await markAndExitCycle(db, mockJup('100'));
  assert.equal(getExperiment(db).state, 'EXPERIMENT_COMPLETE');
  assert.equal(db.prepare(`SELECT pause_reason FROM experiments WHERE id='exp-1'`).get().pause_reason, 'rotation-complete');
});

test('rotation: stop loss at 50% of cost exits', async () => {
  const db = freshDb();
  const a = await paperEntry(db, rotDeps, { signalId: 's1', mint: 'A', entryUnitsRaw: '100', decimals: 2, quoteEvidenceId: null });
  await markAndExitCycle(db, mockJup('10000000')); // $10 gross -> net 9.65 <= $10 (50% of 20): STOP_LOSS
  assert.equal(db.prepare(`SELECT state FROM paper_positions WHERE id=?`).get(a.id).state, 'CLOSED');
});

test('rotation: compounding option bets 25% of cash', async () => {
  const db = freshDb();
  const c2 = { ...rotCfg, rotation: { ...rotCfg.rotation, position_pct_of_cash: '0.25' } };
  const d2 = { cfg: c2, outbox: null };
  const r = await paperEntry(db, d2, { signalId: 's1', mint: 'A', entryUnitsRaw: '100', decimals: 2, quoteEvidenceId: null });
  assert.ok(!r.denied);
  assert.equal(db.prepare(`SELECT entry_total_usd FROM paper_positions WHERE id=?`).get(r.id).entry_total_usd, '125');
});
