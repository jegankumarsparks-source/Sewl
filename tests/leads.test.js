import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { Helius, mintsFromTxs, WSOL } from '../src/sources/helius.js';
import { momentumCycle } from '../src/momentum.js';

const cfg = JSON.parse(readFileSync('config/experiment.json', 'utf8'));
const fx = JSON.parse(readFileSync(new URL('./fixtures/lead_txs.json', import.meta.url))).data;
const KEY = 'test-key-0000-secret';

test('mintsFromTxs: real txs -> distinct non-SOL mints, counts equal an independent recount', () => {
  const got = mintsFromTxs(fx); const want = new Map();
  for (const t of fx) { const s = new Set(); for (const b of [...t.meta.preTokenBalances, ...t.meta.postTokenBalances]) if (b.mint !== WSOL) s.add(b.mint); for (const m of s) want.set(m, (want.get(m) ?? 0) + 1); }
  assert.ok(got.size > 3); assert.deepEqual([...got].sort(), [...want].sort()); assert.equal(got.has(WSOL), false);
});
test('failed txs are ignored', () => { const t = JSON.parse(JSON.stringify(fx[0])); t.meta.err = { x: 1 }; assert.equal(mintsFromTxs([t]).size, 0); });

test('activeMints: counts credits per call, records evidence without the key, inert without a key', async () => {
  const db = openDb(':memory:'); let n = 0;
  const h = new Helius({ db, apiKey: KEY, fetchImpl: async (url, o) => { n++; assert.ok(String(url).includes(KEY)); return { ok: true, status: 200, json: async () => ({ result: { data: fx } }) }; } });
  const r = await h.activeMints('PROG', { limit: 100 }); assert.ok(r.mints.size > 3); assert.equal(h.credits, 10);
  assert.equal(JSON.stringify(db.prepare('select * from source_observations').all()).includes(KEY), false);
  const off = new Helius({ db, apiKey: '', fetchImpl: async () => { n++; } }); await assert.rejects(() => off.activeMints('P'), /helius-disabled/); assert.equal(n, 1);
});

const mkPair = (mint, over = {}) => ({ chainId: 'solana', baseToken: { address: mint }, priceChange: { m5: 10 }, volume: { m5: 100, h1: 1200 }, liquidity: { usd: 30000 }, pairCreatedAt: Date.now() - 3600_000, ...over });
function world({ withKey, dexLeads = 30, heliusMints = 40, trigger = false }) {
  const asked = [];
  const dexIds = Array.from({ length: dexLeads }, (_, i) => 'DEX' + i);
  const hMints = new Map(Array.from({ length: heliusMints }, (_, i) => ['HEL' + i, 50 - i]));
  const dex = { latestBoosts: async () => ({ data: dexIds.map(a => ({ chainId: 'solana', tokenAddress: a })) }), latestProfiles: async () => ({ data: [] }),
    tokensBatch: async (ms) => { asked.push(...ms); return { data: ms.map(m => mkPair(m, trigger && m === 'HEL3' ? { priceChange: { m5: 500 }, volume: { m5: 90000, h1: 100000 } } : {})) }; } };
  let calls = 0;
  const helius = { enabled: withKey, credits: 0, activeMints: async () => { calls++; helius.credits += 10; return { mints: hMints }; } };
  const deps = { cfg, dex, helius, leadPrograms: ['P1'], jupiter: {}, outbox: null, validate: async () => ({ id: null, result: 'REJECTED', unknown: [], decimals: 6 }) };
  return { deps, asked, calls: () => calls };
}
test('coverage: with a key, leads/cycle rises above the 30 DEX leads; same cap rules apply', async () => {
  const w = world({ withKey: true }); const r = await momentumCycle(openDb(':memory:'), w.deps);
  assert.equal(r.leads_dex, 30); assert.equal(r.leads_helius_new, 40); assert.equal(r.leads, 70); assert.equal(r.helius_credits, 10); assert.equal(w.asked.length, 70);
});
test('inert without a key: exactly the old behaviour (30 leads, no helius call)', async () => {
  const w = world({ withKey: false }); const r = await momentumCycle(openDb(':memory:'), w.deps);
  assert.equal(r.leads, 30); assert.equal(r.leads_helius_new, 0); assert.equal(w.calls(), 0);
});
test('helius discovery runs every N cycles; cached leads persist between runs', async () => {
  const w = world({ withKey: true }); const db = openDb(':memory:');
  const rs = []; for (let i = 0; i < 4; i++) rs.push(await momentumCycle(db, w.deps));
  assert.equal(w.calls(), 2); assert.deepEqual(rs.map(r => r.leads), [70, 70, 70, 70]);
});
test('max_leads caps helius leads', async () => {
  const w = world({ withKey: true, heliusMints: 100 }); const r = await momentumCycle(openDb(':memory:'), w.deps); assert.equal(r.leads_helius_new, 60);
});
test('new leads pass the SAME trigger: a helius lead that does not trigger opens nothing; a surging one is evaluated by the same gates', async () => {
  const db1 = openDb(':memory:'); const quiet = await momentumCycle(db1, world({ withKey: true }).deps); assert.equal(quiet.triggered, 0);
  const db2 = openDb(':memory:'); const w = world({ withKey: true, trigger: true }); const r = await momentumCycle(db2, w.deps);
  assert.equal(r.triggered, 1); assert.equal(r.opened, 0); // validate mock REJECTS: gates still decide
  assert.equal(db2.prepare(`select decision from signals`).get().decision, 'REJECTED');
});
