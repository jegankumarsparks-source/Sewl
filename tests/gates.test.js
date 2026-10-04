// Each risk check, alone, flips the final result away from QUALIFIED (audit standard).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateToken } from '../src/validation.js';
import { openDb } from '../src/db.js';

const cfg = JSON.parse(readFileSync('config/experiment.json', 'utf8'));
const KEG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SUPPLY = 1_000_000_000_000n;

const okQuote = (imp = '-0.001', at = new Date().toISOString()) => ({ evidenceId: 'q', quote: { priceImpactPct: imp }, receivedAt: at });
const pairRes = (over = {}, at = new Date().toISOString()) => async () => ({ data: [{ chainId: 'solana', liquidity: { usd: 50000 }, priceUsd: '0.01', ...over }], evidenceId: 'd', receivedAt: at });
function mint({ owner = KEG, mintAuth = false, freeze = false, ext = null } = {}) {
  const b = Buffer.alloc(82); if (mintAuth) b.writeUInt32LE(1, 0); b.writeBigUInt64LE(SUPPLY, 36); b.writeUInt8(6, 44); b.writeUInt8(1, 45); if (freeze) b.writeUInt32LE(1, 46);
  let data = b;
  if (ext) { const h = Buffer.alloc(4); h.writeUInt16LE(ext, 0); h.writeUInt16LE(2, 2); data = Buffer.concat([b, Buffer.alloc(83), Buffer.from([1]), h, Buffer.alloc(2)]); }
  return { owner: ext ? T22 : owner, data: [data.toString('base64'), 'base64'] };
}
const tokAcct = (n) => { const b = Buffer.alloc(165); b.fill(n, 32, 64); return { owner: KEG, data: [b.toString('base64'), 'base64'] }; };
// amounts as percent of supply, one distinct owner each
function world(o = {}) {
  const pct = o.pct ?? [5, 5, 5, 5, 5];
  const rpc = {
    getAccountInfo: o.acct ?? (async () => ({ result: { value: o.mint ?? mint() }, evidenceId: 'a' })),
    getTokenLargestAccounts: o.largest ?? (async () => ({ result: { value: pct.map((p, i) => ({ address: 'A' + i, amount: String(SUPPLY * BigInt(p) / 100n) })) }, evidenceId: 'l' })),
    getMultipleAccounts: o.multi ?? (async () => ({ result: { value: pct.map((_, i) => tokAcct(i + 1)) }, evidenceId: 'm' })),
  };
  const dex = { tokenPairs: o.dex ?? (async () => ({ data: [{ chainId: 'solana', liquidity: { usd: 50000 }, priceUsd: '0.01' }], evidenceId: 'd', receivedAt: new Date().toISOString() })) };
  const jup = { sellQuote: o.sell ?? (async () => okQuote()) };
  return { rpc, dex, jup };
}
async function run(o) { const w = world(o); return validateToken(openDb(':memory:'), w.rpc, w.dex, w.jup, 'M'.repeat(44), cfg); }

test('baseline: all gates pass -> QUALIFIED', async () => { const r = await run({}); assert.equal(r.result, 'QUALIFIED', JSON.stringify(r.checks)); });
test('mint authority alone fails -> REJECTED', async () => { const r = await run({ mint: mint({ mintAuth: true }) }); assert.equal(r.checks.mint_authority_null, 'FAIL'); assert.equal(r.result, 'REJECTED'); });
test('freeze authority alone fails -> REJECTED', async () => { const r = await run({ mint: mint({ freeze: true }) }); assert.equal(r.checks.freeze_authority_null, 'FAIL'); assert.equal(r.result, 'REJECTED'); });
test('largest owner > 15% alone fails -> REJECTED', async () => { const r = await run({ pct: [16, 5, 5, 5, 5] }); assert.equal(r.checks.largest_nonpool_owner_15pct, 'FAIL'); assert.equal(r.checks.top_owners_50pct, 'PASS'); assert.equal(r.result, 'REJECTED'); });
test('top owners > 50% alone fails -> REJECTED', async () => { const r = await run({ pct: [10, 10, 10, 10, 11] }); assert.equal(r.checks.largest_nonpool_owner_15pct, 'PASS'); assert.equal(r.checks.top_owners_50pct, 'FAIL'); assert.equal(r.result, 'REJECTED'); });
test('owner thresholds come from config (tightened config flips result)', async () => {
  const w = world({}); const c2 = JSON.parse(JSON.stringify(cfg)); c2.validation.max_largest_owner = '0.04';
  const r = await validateToken(openDb(':memory:'), w.rpc, w.dex, w.jup, 'M'.repeat(44), c2); assert.equal(r.result, 'REJECTED');
});
test('liquidity below minimum alone fails -> REJECTED', async () => { const r = await run({ dex: pairRes({ liquidity: { usd: 100 } }) }); assert.equal(r.checks.liquidity, 'FAIL'); assert.equal(r.result, 'REJECTED'); });
test('liquidity missing -> DATA_INCOMPLETE (not QUALIFIED)', async () => { const r = await run({ dex: pairRes({ liquidity: undefined }) }); assert.equal(r.result, 'DATA_INCOMPLETE'); });
test('market data unavailable -> DATA_INCOMPLETE', async () => { const r = await run({ dex: async () => { throw new Error('x'); } }); assert.equal(r.result, 'DATA_INCOMPLETE'); });
test('sell quote unavailable -> DATA_INCOMPLETE', async () => { const r = await run({ sell: async () => { throw new Error('x'); } }); assert.equal(r.checks.sellability, 'UNKNOWN'); assert.equal(r.result, 'DATA_INCOMPLETE'); });
test('largest accounts unavailable -> DATA_INCOMPLETE', async () => { const r = await run({ largest: async () => { throw new Error('x'); } }); assert.equal(r.result, 'DATA_INCOMPLETE'); });
test('unclassified largest account -> DATA_INCOMPLETE', async () => { const r = await run({ multi: async () => ({ result: { value: [null, tokAcct(2), tokAcct(3), tokAcct(4), tokAcct(5)] }, evidenceId: 'm' }) }); assert.equal(r.checks.owner_classification, 'PARTIAL'); assert.equal(r.result, 'DATA_INCOMPLETE'); });
test('wrong token program -> REJECTED identity FAIL', async () => { const r = await run({ mint: { ...mint(), owner: '11111111111111111111111111111111' } }); assert.equal(r.checks.identity, 'FAIL'); assert.equal(r.result, 'REJECTED'); });
test('mint account does not exist -> REJECTED', async () => { const r = await run({ acct: async () => ({ result: { value: null }, evidenceId: 'a' }) }); assert.equal(r.result, 'REJECTED'); });
test('RPC failure on account info -> DATA_INCOMPLETE, not a false REJECTED', async () => { const r = await run({ acct: async () => { throw new Error('rpc down'); } }); assert.equal(r.result, 'DATA_INCOMPLETE'); });
test('transfer-fee extension alone -> REJECTED with extension-type-1', async () => { const r = await run({ mint: mint({ ext: 1 }) }); assert.equal(r.checks['extension-type-1'], 'FAIL'); assert.equal(r.result, 'REJECTED'); });
test('metadata-pointer extension alone -> QUALIFIED', async () => { const r = await run({ mint: mint({ ext: 18 }) }); assert.equal(r.result, 'QUALIFIED', JSON.stringify(r.checks)); });

// ---- decisions A/B/D ----
test('B: stale market evidence (older than market_fresh_seconds) -> DATA_INCOMPLETE market-stale', async () => { const r = await run({ dex: pairRes({}, new Date(Date.now() - 120_000).toISOString()) }); assert.equal(r.checks.market_fresh, 'UNKNOWN'); assert.ok(r.unknown.includes('market-stale')); assert.equal(r.result, 'DATA_INCOMPLETE'); });
test('B: market evidence with no receipt time is never auto-PASS', async () => { const r = await run({ dex: async () => ({ data: [{ chainId: 'solana', liquidity: { usd: 50000 }, priceUsd: '0.01' }], evidenceId: 'd' }) }); assert.equal(r.checks.market_fresh, 'UNKNOWN'); assert.equal(r.result, 'DATA_INCOMPLETE'); });
test('D: no solana pair -> DATA_INCOMPLETE solana-pair-missing, no silent fallback', async () => { const r = await run({ dex: async () => ({ data: [{ chainId: 'ethereum', liquidity: { usd: 50000 }, priceUsd: '0.01' }], evidenceId: 'd', receivedAt: new Date().toISOString() }) }); assert.ok(r.unknown.includes('solana-pair-missing')); assert.equal(r.result, 'DATA_INCOMPLETE'); });
test('A: price impact above max_impact on the $20 quote alone -> REJECTED', async () => { const r = await run({ sell: async () => okQuote('-0.03') }); assert.equal(r.checks.sellability, 'FAIL'); assert.equal(r.result, 'REJECTED'); });
test('A: impact within max_impact -> QUALIFIED', async () => { const r = await run({ sell: async () => okQuote('-0.019') }); assert.equal(r.checks.sellability, 'PASS'); assert.equal(r.result, 'QUALIFIED'); });
test('A: stale quote (>quote_fresh_seconds) -> DATA_INCOMPLETE quote-stale, never auto-PASS', async () => { const r = await run({ sell: async () => okQuote('-0.001', new Date(Date.now() - 60_000).toISOString()) }); assert.equal(r.checks.sellability, 'UNKNOWN'); assert.ok(r.unknown.includes('quote-stale')); assert.equal(r.result, 'DATA_INCOMPLETE'); });
test('A: missing price impact field -> DATA_INCOMPLETE', async () => { const r = await run({ sell: async () => ({ evidenceId: 'q', quote: {}, receivedAt: new Date().toISOString() }) }); assert.equal(r.result, 'DATA_INCOMPLETE'); });
test('A: probe is position-sized ($20 / price, in raw units) and full-supply route failure is INFO only', async () => {
  const calls = []; const r = await run({ sell: async (m, u) => { calls.push(u); if (u === SUPPLY.toString()) throw new Error('no route'); return okQuote(); } });
  assert.equal(calls[0], '2000000000'); // $20 at $0.01 = 2000 tokens * 1e6 raw
  assert.equal(r.checks.full_supply_route_info, 'ROUTE_UNAVAILABLE'); assert.equal(r.result, 'QUALIFIED');
});

// ---- C: pre-entry observation window gate ----
import { pumpWindowGate } from '../src/signal.js';
import { d } from '../src/decimal.js';
function snaps(rows) {
  const db = openDb(':memory:');
  for (const [minAgo, price] of rows) db.prepare(`INSERT INTO market_snapshots (id, mint, pool_address, observed_at, price_usd, liquidity_usd, market_cap_usd, fdv_usd, evidence_id, freshness_state) VALUES (?,?,?,?,?,?,?,?,?, 'FRESH')`).run('s' + Math.random(), 'MINT', null, new Date(Date.now() - minAgo * 60_000).toISOString(), price, null, null, null, 'e');
  return db;
}
test('C: no observation older than the window -> WATCH_ONLY', () => { const g = pumpWindowGate(snaps([[1, '0.01']]), 'MINT', d('0.01'), cfg); assert.equal(g.decision, 'WATCH_ONLY'); });
test('C: no observed price in the window -> DATA_INCOMPLETE observed-price-unknown (was a silent skip)', () => { const g = pumpWindowGate(snaps([[30, '0.01'], [1, null]]), 'MINT', d('0.05'), cfg); assert.equal(g.decision, 'DATA_INCOMPLETE'); assert.deepEqual(g.reasons, ['observed-price-unknown']); });
test('C: zero observed price -> DATA_INCOMPLETE, no divide by zero', () => { const g = pumpWindowGate(snaps([[30, '0.01'], [1, '0']]), 'MINT', d('0.05'), cfg); assert.equal(g.decision, 'DATA_INCOMPLETE'); });
test('C: observed price and 2x breach -> REJECTED', () => { const g = pumpWindowGate(snaps([[30, '0.01'], [5, '0.01']]), 'MINT', d('0.025'), cfg); assert.equal(g.decision, 'REJECTED'); assert.deepEqual(g.reasons, ['pump-above-2x-in-window']); });
test('C: clean window -> proceeds (null)', () => { assert.equal(pumpWindowGate(snaps([[30, '0.01'], [5, '0.01']]), 'MINT', d('0.012'), cfg), null); });
