import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { evaluateTrigger, processMomentum, latencyStats } from '../src/momentum.js';
import { paperEntry, paperExit, realizedPnl } from '../src/paper.js';

const cfg = JSON.parse(readFileSync('config/experiment.json', 'utf8'));
const NOW = 1_800_000_000_000;
function freshDb() {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO experiments (id, name, state, starting_cash_usd, target_equity_usd, position_budget_usd, max_open_positions, policy_version, created_at)
    VALUES ('exp-1','t','PAPER_ACTIVE','500','800','20',12,'v','now')`).run();
  db.prepare(`INSERT INTO accounts (name, balance_usd) VALUES ('cash','500'), ('capital','500')`).run();
  return db;
}
const pair = (over = {}) => ({ chainId: 'solana', baseToken: { address: 'MOM1' }, priceChange: { m5: 150 }, volume: { m5: 6000, h1: 6000 + 11 * 1000 },
  liquidity: { usd: 30000 }, pairCreatedAt: NOW - 2 * 3600_000, ...over });
const okValidate = async () => ({ id: null, result: 'QUALIFIED', unknown: [], decimals: 6 });
const jup = { buyQuote: async () => ({ quote: { outAmount: '20000000' }, evidenceId: null }), sellQuote: async () => ({ quote: { outAmount: '1000000' }, evidenceId: null }) };
const mkDeps = (over = {}) => ({ cfg, outbox: null, jupiter: jup, validate: okValidate, ...over });

test('trigger: passes only when ALL four conditions hold', () => {
  assert.equal(evaluateTrigger(pair(), cfg, NOW).trigger, true);
  assert.ok(evaluateTrigger(pair({ priceChange: { m5: 99 } }), cfg, NOW).reasons.includes('surge-below-threshold'));
  assert.ok(evaluateTrigger(pair({ volume: { m5: 4900, h1: 4900 + 11000 } }), cfg, NOW).reasons.includes('volume-surge-below-threshold'));
  assert.ok(evaluateTrigger(pair({ pairCreatedAt: NOW - 7 * 3600_000 }), cfg, NOW).reasons.includes('pool-too-old'));
  assert.ok(evaluateTrigger(pair({ liquidity: { usd: 24999 } }), cfg, NOW).reasons.includes('liquidity-below-min'));
});

test('trigger: missing data is NULL -> never passes', () => {
  assert.ok(evaluateTrigger(pair({ priceChange: {} }), cfg, NOW).reasons.includes('price-change-unknown'));
  assert.ok(evaluateTrigger(pair({ volume: { m5: 5000 } }), cfg, NOW).reasons.includes('volume-baseline-unknown'));
  assert.ok(evaluateTrigger(pair({ pairCreatedAt: undefined }), cfg, NOW).reasons.includes('pool-age-unknown'));
  assert.ok(evaluateTrigger(pair({ liquidity: {} }), cfg, NOW).reasons.includes('liquidity-unknown'));
});

test('momentum entry reuses paperEntry: origin tagged, $20, journal balances', async () => {
  const db = freshDb();
  const r = await processMomentum(db, mkDeps(), pair(), { nowMs: NOW });
  assert.equal(r.decision, 'PAPER_OPEN');
  const pos = db.prepare(`SELECT * FROM paper_positions`).get();
  assert.equal(pos.origin, 'momentum'); assert.equal(pos.entry_total_usd, '20');
  assert.equal(db.prepare(`SELECT balance_usd FROM accounts WHERE name='cash'`).get().balance_usd, '480');
  const bad = db.prepare(`SELECT t.id FROM journal_transactions t JOIN journal_lines l ON l.transaction_id=t.id GROUP BY t.id HAVING SUM(CAST(l.debit_usd AS REAL)) != SUM(CAST(l.credit_usd AS REAL))`).all();
  assert.equal(bad.length, 0);
  await paperExit(db, mkDeps(), pos.id, 'TAKE_PROFIT', '29.5', null);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM journal_transactions WHERE id NOT IN (SELECT transaction_id FROM journal_lines)`).get().c, 0);
});

test('max 4 momentum slots; whale entries still use the other slots', async () => {
  const db = freshDb(); const deps = mkDeps();
  for (let i = 0; i < 4; i++) {
    const e = await paperEntry(db, deps, { signalId: 's' + i, mint: 'M' + i, entryUnitsRaw: '1000', decimals: 6, quoteEvidenceId: null, origin: 'momentum' });
    assert.ok(!e.denied);
  }
  const fifth = await paperEntry(db, deps, { signalId: 's5', mint: 'M5', entryUnitsRaw: '1000', decimals: 6, quoteEvidenceId: null, origin: 'momentum' });
  assert.equal(fifth.denied, 'momentum-slot-cap');
  const whale = await paperEntry(db, deps, { signalId: 's6', mint: 'W1', entryUnitsRaw: '1000', decimals: 6, quoteEvidenceId: null });
  assert.ok(!whale.denied);
  const first = db.prepare(`SELECT id FROM paper_positions WHERE mint='M0'`).get().id;
  await paperExit(db, deps, first, 'STOP_LOSS', '8', null);
  const again = await paperEntry(db, deps, { signalId: 's7', mint: 'M7', entryUnitsRaw: '1000', decimals: 6, quoteEvidenceId: null, origin: 'momentum' });
  assert.ok(!again.denied); // slot recycled
});

test('latency fields stored for every momentum signal (candle, detection, entry)', async () => {
  const db = freshDb();
  await processMomentum(db, mkDeps(), pair(), { nowMs: NOW });
  const b = db.prepare(`SELECT * FROM buy_events WHERE origin='momentum'`).get();
  assert.equal(b.candle_start_ms, NOW - 300_000); assert.equal(b.detection_ms, NOW);
  assert.ok(b.entry_ms > 0); assert.equal(b.candle_time_source, 'DEXSCREENER_5M_WINDOW_BOUND');
  const s = latencyStats(db);
  assert.equal(s.signals, 1); assert.equal(s.detect_avg_ms, 300_000); assert.equal(s.entries_missing, 0);
});

test('failed validation: no position, signal kept with reason, rejected/incomplete', async () => {
  const db = freshDb();
  const r = await processMomentum(db, mkDeps({ validate: async () => ({ id: null, result: 'REJECTED', unknown: [] }) }), pair(), { nowMs: NOW });
  assert.equal(r.decision, 'REJECTED');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM paper_positions`).get().c, 0);
});

test('migration is idempotent on an existing DB', () => {
  const db = openDb(':memory:');
  assert.ok(db.prepare(`PRAGMA table_info(paper_positions)`).all().some(c => c.name === 'origin'));
  assert.doesNotThrow(() => import('../src/db.js').then(m => m.migrate(db)));
});
