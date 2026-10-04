import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { Helius, firstSwapMs } from '../src/sources/helius.js';
import { processMomentum } from '../src/momentum.js';

const cfg = JSON.parse(readFileSync('config/experiment.json', 'utf8'));
const NOW = 1_800_000_000_000;
const KEY = 'test-key-0000-secret';
function freshDb() {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO experiments (id, name, state, starting_cash_usd, target_equity_usd, position_budget_usd, max_open_positions, policy_version, created_at) VALUES ('exp-1','t','PAPER_ACTIVE','500','800','20',12,'v','now')`).run();
  db.prepare(`INSERT INTO accounts (name, balance_usd) VALUES ('cash','500'), ('capital','500')`).run();
  return db;
}
const pair = () => ({ chainId: 'solana', baseToken: { address: 'MOM1' }, priceChange: { m5: 150 }, volume: { m5: 6000, h1: 17000 }, liquidity: { usd: 30000 }, pairCreatedAt: NOW - 2 * 3600_000 });
const jup = { buyQuote: async () => ({ quote: { outAmount: '20000000' }, evidenceId: null }), sellQuote: async () => ({ quote: { outAmount: '1000000' }, evidenceId: null }) };
const validate = async () => ({ id: null, result: 'QUALIFIED', unknown: [], decimals: 6 });

test('inert without a key: disabled, no network call', async () => {
  let called = false; const h = new Helius({ db: openDb(':memory:'), apiKey: '', fetchImpl: async () => { called = true; } });
  assert.equal(h.enabled, false); await assert.rejects(() => h.swapsSince('M', 1), /helius-disabled/); assert.equal(called, false);
});
test('firstSwapMs: earliest successful swap in window, else null', () => {
  assert.equal(firstSwapMs([{ timestamp: 105 }, { timestamp: 103 }, { timestamp: 90 }, { timestamp: 101, transactionError: {} }], 100), 103_000);
  assert.equal(firstSwapMs([], 100), null);
});
test('API key never reaches stored evidence', async () => {
  const db = openDb(':memory:');
  const h = new Helius({ db, apiKey: KEY, fetchImpl: async (url) => { assert.ok(String(url).includes(KEY)); return { ok: true, status: 200, json: async () => [{ signature: 's', timestamp: 5, slot: 1, source: 'PUMP_AMM', type: 'SWAP' }] }; } });
  await h.swapsSince('MINT', 1);
  const rows = JSON.stringify(db.prepare('select * from source_observations').all());
  assert.ok(rows.includes('MINT')); assert.equal(rows.includes(KEY), false);
});
test('momentum: with Helius swaps, candle_start is the exact first swap time and source is labelled', async () => {
  const db = freshDb(); const first = Math.floor((NOW - 200_000) / 1000);
  const helius = { enabled: true, swapsSince: async () => ({ swaps: [{ timestamp: first + 10 }, { timestamp: first }], evidenceId: null }) };
  await processMomentum(db, { cfg, outbox: null, jupiter: jup, validate, helius }, pair(), { nowMs: NOW });
  const b = db.prepare('select candle_start_ms, candle_time_source from buy_events').get();
  assert.equal(b.candle_start_ms, first * 1000); assert.equal(b.candle_time_source, 'HELIUS_FIRST_SWAP_IN_WINDOW');
});
test('momentum: Helius failure falls back to the labelled 5m window bound', async () => {
  const db = freshDb(); const helius = { enabled: true, swapsSince: async () => { throw new Error('helius TIMEOUT'); } };
  await processMomentum(db, { cfg, outbox: null, jupiter: jup, validate, helius }, pair(), { nowMs: NOW });
  const b = db.prepare('select candle_start_ms, candle_time_source from buy_events').get();
  assert.equal(b.candle_start_ms, NOW - 300_000); assert.equal(b.candle_time_source, 'DEXSCREENER_5M_WINDOW_BOUND');
});
test('momentum: Helius disabled behaves exactly as before', async () => {
  const db = freshDb();
  await processMomentum(db, { cfg, outbox: null, jupiter: jup, validate }, pair(), { nowMs: NOW });
  assert.equal(db.prepare('select candle_time_source s from buy_events').get().s, 'DEXSCREENER_5M_WINDOW_BOUND');
});
