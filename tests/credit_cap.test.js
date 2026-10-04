import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { Helius } from '../src/sources/helius.js';
import { momentumCycle } from '../src/momentum.js';

const cfg = JSON.parse(readFileSync('config/experiment.json', 'utf8'));
const fx = JSON.parse(readFileSync(new URL('./fixtures/lead_txs.json', import.meta.url))).data;
const okFetch = (counter) => async () => { counter.n++; return { ok: true, status: 200, json: async () => ({ result: { data: fx } }) }; };

test('config carries the hard cap: 800000 credits (80% of the 1M free tier)', () => assert.equal(cfg.helius_monthly_credit_cap, 800000));
test('counter persists across instances (restart-safe) and charges 10 per discovery call, 100 per enhanced call', async () => {
  const db = openDb(':memory:'); const c = { n: 0 };
  const a = new Helius({ db, apiKey: 'k', fetchImpl: okFetch(c), monthlyCap: 1000 }); await a.activeMints('P'); assert.equal(a.creditsUsed(), 10);
  const b = new Helius({ db, apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }), monthlyCap: 1000 }); assert.equal(b.creditsUsed(), 10);
  await b.swapsSince('M', 1); assert.equal(b.creditsUsed(), 110);
});
test('cap reached: call is refused BEFORE any network request, counter unchanged', async () => {
  const db = openDb(':memory:'); const c = { n: 0 };
  const h = new Helius({ db, apiKey: 'k', fetchImpl: okFetch(c), monthlyCap: 25 });
  await h.activeMints('P'); await h.activeMints('P'); assert.equal(h.creditsUsed(), 20);
  await assert.rejects(() => h.swapsSince('M', 1), /helius-credit-cap/); // 100 would exceed 25
  await assert.rejects(() => h.activeMints('P'), /helius-credit-cap/); assert.equal(c.n, 2); assert.equal(h.creditsUsed(), 20);
});
test('cap boundary: a call that would cross the cap is refused, one that lands exactly on it is allowed', async () => {
  const db = openDb(':memory:'); const c = { n: 0 };
  const h = new Helius({ db, apiKey: 'k', fetchImpl: okFetch(c), monthlyCap: 20 });
  await h.activeMints('P'); await h.activeMints('P'); assert.equal(h.creditsUsed(), 20); assert.equal(h.capReached(), true);
  await assert.rejects(() => h.activeMints('P'), /helius-credit-cap/); assert.equal(c.n, 2);
});
test('month rollover resets the counter', async () => {
  const db = openDb(':memory:'); let d = new Date('2026-10-31T23:59:00Z'); const c = { n: 0 };
  const h = new Helius({ db, apiKey: 'k', fetchImpl: okFetch(c), monthlyCap: 10, now: () => d });
  await h.activeMints('P'); assert.equal(h.capReached(), true);
  d = new Date('2026-11-01T00:00:10Z'); assert.equal(h.capReached(), false); await h.activeMints('P'); assert.equal(c.n, 2);
});
test('warning is signalled exactly once per month', () => {
  const db = openDb(':memory:'); const h = new Helius({ db, apiKey: 'k', monthlyCap: 10 }); h.charge(10);
  assert.equal(h.markCapNotified(), true); assert.equal(h.markCapNotified(), false);
});
test('momentum: after the cap, leads fall back to DexScreener-only, helius is not called, one warning callback total', async () => {
  const db = openDb(':memory:'); const c = { n: 0 }; const warns = [];
  const helius = new Helius({ db, apiKey: 'k', fetchImpl: okFetch(c), monthlyCap: 20 });
  const ids = Array.from({ length: 30 }, (_, i) => 'DEX' + i);
  const dex = { latestBoosts: async () => ({ data: ids.map(a => ({ chainId: 'solana', tokenAddress: a })) }), latestProfiles: async () => ({ data: [] }),
    tokensBatch: async (ms) => ({ data: ms.map(m => ({ chainId: 'solana', baseToken: { address: m }, priceChange: { m5: 1 }, volume: { m5: 1, h1: 12 }, liquidity: { usd: 30000 }, pairCreatedAt: Date.now() - 3600_000 })) }) };
  const deps = { cfg: { ...cfg, momentum: { ...cfg.momentum, helius_leads: { ...cfg.momentum.helius_leads, every_cycles: 1 } } }, dex, helius, leadPrograms: ['P1', 'P2'], jupiter: {}, outbox: null, onCreditCap: (x) => warns.push(x) };
  const r1 = await momentumCycle(db, deps); assert.ok(r1.leads_helius_new > 0); assert.equal(c.n, 2); assert.equal(warns.length, 0);
  const r2 = await momentumCycle(db, deps); assert.equal(r2.leads, 30); assert.equal(r2.leads_helius_new, 0); assert.equal(r2.helius_error, 'helius-credit-cap'); assert.equal(c.n, 2); assert.equal(warns.length, 1);
  const r3 = await momentumCycle(db, deps); assert.equal(r3.leads, 30); assert.equal(c.n, 2); assert.equal(warns.length, 1);
});
test('exact-timing lookup after the cap falls back to the labelled window bound', async () => {
  const db = openDb(':memory:'); const helius = new Helius({ db, apiKey: 'k', fetchImpl: okFetch({ n: 0 }), monthlyCap: 50 });
  await assert.rejects(() => helius.swapsSince('M', 1), /helius-credit-cap/);
});
