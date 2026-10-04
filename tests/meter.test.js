import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Rpc, Quota } from '../src/rpc.js';
import { Helius } from '../src/sources/helius.js';
import { withSource } from '../src/meter.js';
const mk = (cap) => { const db = openDb(':memory:'); const h = new Helius({ db, apiKey: 'k', monthlyCap: cap }); const rpc = new Rpc({ endpoint: 'http://x.invalid/?api-key=k', quota: new Quota(1000, 1000), db, record: false }); rpc.meter = h; return { db, h, rpc }; };
test('every RPC call is counted per source (1 credit default, 10 for token-largest-accounts)', async () => {
  const real = globalThis.fetch; globalThis.fetch = async () => ({ status: 200, json: async () => ({ result: 1 }) });
  try {
    const { db, h, rpc } = mk(null);
    await withSource('whale-history', () => rpc.call('getTransaction', ['s']));
    await withSource('momentum', async () => { await rpc.call('getAccountInfo', ['a']); await rpc.call('getTokenLargestAccounts', ['m']); });
    const rows = Object.fromEntries(db.prepare(`SELECT source, credits FROM helius_usage_source`).all().map(r => [r.source, r.credits]));
    assert.deepEqual(rows, { 'whale-history': 1, momentum: 11 }); assert.equal(h.creditsUsed(), 12);
  } finally { globalThis.fetch = real; }
});
test('the cap now also blocks RPC calls (no fetch made past the cap; callers fail closed)', async () => {
  const real = globalThis.fetch; let fetched = 0; globalThis.fetch = async () => { fetched++; return { status: 200, json: async () => ({ result: 1 }) }; };
  try {
    const { rpc } = mk(5);
    await assert.rejects(() => withSource('momentum', () => rpc.call('getTokenLargestAccounts', ['m'])), /helius-credit-cap/);
    assert.equal(fetched, 0);
  } finally { globalThis.fetch = real; }
});
