import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { writeSnapshots, findSecret, SECRET_PATTERNS } from '../src/snapshot.js';

const cfg = JSON.parse(readFileSync('config/experiment.json', 'utf8'));
const M1 = '3ZtY5iuH7BottzL249JoiQYqdSE9mFLikFYieNAHpump', M2 = 'GDeKVeV3cs6UCTRDmHqZHugBmUbLLRW7hi9P91XXeLNT', CR = '3vGozu5qAHvo3FTyBdaSdPGoJVhD6r2PXPcLefWC4Koh', POOL = '3Czf9zzuDHbYkziB7Wh65HG2Vg27nK7FZTdYpTGRdN2K';
function env() {
  const d = mkdtempSync(path.join(tmpdir(), 'snap-')); const db = openDb(path.join(d, 't.sqlite'));
  db.prepare(`INSERT INTO experiments (id, name, state, starting_cash_usd, target_equity_usd, position_budget_usd, max_open_positions, policy_version, created_at) VALUES ('exp-1','t','PAPER_RUNNING','500','800','20','12','v','2026-10-04T00:00:00Z')`).run();
  db.prepare(`INSERT INTO accounts (name, balance_usd) VALUES ('cash','500')`).run();
  db.prepare(`INSERT INTO health_events (id, component, at, severity, code, detail_json) VALUES ('h1','worker','2026-10-04T00:00:00Z','INFO','startup','{"version":"x"}')`).run();
  const calls = { coin: 0, wallet: 0, ohlcv: 0 }; let credits = 0;
  const helius = { creditsUsed: () => credits, monthlyCap: 800000 };
  const chain = { coin: async (m) => { calls.coin++; credits += 41; return { mint: m, symbol: 'T', market: { pair: POOL, liquidity_usd: 1 }, creator: { creator: CR }, trades: [], holders: [] }; }, wallet: async (w) => { calls.wallet++; credits += 31; return { wallet: w, pnl: {}, holdings: [], coins: [], created_coins: [] }; } };
  const gecko = { ohlcv: async (p, tf) => { calls.ohlcv++; return { pool: p, tf, candles: [{ time: 1, o: 1, h: 2, l: 1, c: 2, v: 3 }], cached: true }; } };
  const state = { lastPairsAt: 'x', lastPairs: [{ mint: M1, liquidity_usd: 100 }, { mint: M2, liquidity_usd: 50 }] };
  return { db, dir: path.join(d, 'site', 'snap'), calls, helius, chain, gecko, state, d };
}
const run = (e, extra = {}) => writeSnapshots({ db: e.db, cfg, state: e.state, chain: e.chain, gecko: e.gecko, helius: e.helius, dir: e.dir, sleep: async () => {}, ...extra });

test('snapshots: pages, manifest, pre-rendered coins/wallet/candles; credit use is bounded and TTL-cached', async () => {
  const e = env(); const r = await run(e);
  for (const f of ['dashboard.json', 'signals.json', 'momentum.json', 'wallets.json', 'health.json', 'markets.json', 'manifest.json', `coin_${M1}.json`, `coin_${M2}.json`, `wallet_${CR}.json`, `ohlcv_${POOL}_5m.json`]) assert.ok(existsSync(path.join(e.dir, f)), f);
  assert.equal(r.rejected.length, 0); assert.ok(e.calls.coin <= 2 && e.calls.wallet <= 1);
  const man = JSON.parse(readFileSync(path.join(e.dir, 'manifest.json'))); assert.deepEqual(man.entities.coins.sort(), [M1, M2].sort()); assert.equal(man.snapshot_helius_budget, 120000);
  const before = { ...e.calls }; await run(e); assert.equal(e.calls.coin, before.coin); assert.equal(e.calls.wallet, before.wallet); // fresh files are reused, no credits
  const old = new Date(Date.now() - 100 * 60_000); utimesSync(path.join(e.dir, `coin_${M1}.json`), old, old); await run(e); assert.equal(e.calls.coin, before.coin + 1); // stale (>90 min) coin refreshes
});
test('snapshots: NO secret-shaped string in any file, and no public live-proxy data path exists', async () => {
  const e = env(); await run(e, { secrets: ['SUPERSECRETVALUE123'] });
  for (const f of readdirSync(e.dir)) { const t = readFileSync(path.join(e.dir, f), 'utf8'); assert.equal(findSecret(t), null, f); assert.ok(!/api-key|helius-rpc\.com|SUPERSECRETVALUE123/i.test(t), f); }
});
test('snapshots: a file that holds a secret-shaped string is REJECTED (fail closed) and a planted configured value is caught', async () => {
  const e = env(); e.chain.coin = async (m) => ({ mint: m, symbol: 'T', market: { pair: POOL }, creator: null, note: 'https://x/?api-key=0123abcd-0123-4abc-8abc-0123456789ab' });
  const r = await run(e); assert.ok(r.rejected.some(x => x.name.startsWith('coin_'))); assert.ok(!readdirSync(e.dir).some(f => f.startsWith('coin_')));
  const e2 = env(); e2.chain.coin = async (m) => ({ mint: m, symbol: 'MYPLANTEDSECRETVALUE', market: { pair: POOL }, creator: null });
  const r2 = await run(e2, { secrets: ['MYPLANTEDSECRETVALUE'] }); assert.ok(r2.rejected.some(x => x.pattern === 'configured-secret-value'));
  assert.ok(SECRET_PATTERNS.length >= 8);
});
test('snapshots: monthly credit budget stops chain reads; stale entity files are removed', async () => {
  const e = env(); await run(e); writeFileSync(path.join(e.dir, 'coin_STALEMINT1111111111111111111111111.json'), '{}');
  writeFileSync(path.join(e.dir, '..', '.snap_state.json'), JSON.stringify({ month: new Date().toISOString().slice(0, 7), credits: 120000 }));
  const old = new Date(Date.now() - 200 * 60_000); utimesSync(path.join(e.dir, `coin_${M1}.json`), old, old);
  const c0 = e.calls.coin; await run(e); assert.equal(e.calls.coin, c0, 'over budget: no chain call');
  assert.ok(!existsSync(path.join(e.dir, 'coin_STALEMINT1111111111111111111111111.json')));
  assert.ok(existsSync(path.join(e.dir, `coin_${M1}.json`)), 'last good snapshot is kept, not blanked');
});

test('secret scan: uuid row ids pass, the same shape under any other field fails, configured value fails anywhere', () => {
  assert.equal(findSecret('{"id":"0123abcd-0123-4abc-8abc-0123456789ab","signal_id":"0123abcd-0123-4abc-8abc-0123456789ab"}'), null);
  assert.ok(findSecret('{"note":"0123abcd-0123-4abc-8abc-0123456789ab"}'));
  assert.ok(findSecret('{"id":"0123abcd-0123-4abc-8abc-0123456789ab"}', ['0123abcd-0123-4abc-8abc-0123456789ab']));
  assert.ok(findSecret('{"u":"https://x?api-key=abc"}')); assert.ok(findSecret('ghp_' + 'a'.repeat(30)));
});
