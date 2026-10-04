import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { startApp } from '../src/app.js';
import { fifoPnl, walletTrades, creatorOf, createdMints, Chain, validAddress, auditMint, walletStats, walletTags, copyImpact } from '../src/chain.js';
import { GeckoTerminal } from '../src/sources/geckoterminal.js';

const pump = JSON.parse(readFileSync(new URL('./fixtures/pump_txs.json', import.meta.url))).txs;
const SOL = 'So11111111111111111111111111111111111111112';

test('fifoPnl: realized P&L and multiples match hand-computed values', () => {
  const t = [{ mint: 'A', side: 'BUY', token_raw: '100', sol: 1, time: 1 }, { mint: 'A', side: 'SELL', token_raw: '50', sol: 1.2, time: 2 },
    { mint: 'B', side: 'BUY', token_raw: '100', sol: 2, time: 3 }, { mint: 'B', side: 'SELL', token_raw: '100', sol: 3.2, time: 4 }, { mint: 'C', side: 'BUY', token_raw: '10', sol: 1, time: 5 }, { mint: 'C', side: 'SELL', token_raw: '10', sol: 0.4, time: 6 }];
  const r = fifoPnl(t); const by = Object.fromEntries(r.coins.map(c => [c.mint, c]));
  assert.equal(by.A.realized_multiple, 2.4); assert.equal(by.A.realized_pnl_sol, 0.7); assert.equal(by.A.open_cost_sol, 0.5);
  assert.equal(by.B.realized_multiple, 1.6); assert.equal(by.C.realized_multiple, 0.4);
  assert.deepEqual([r.summary.hit_1_5x, r.summary.hit_2x, r.summary.coins_with_realized_sells], [2, 1, 3]);
  assert.equal(r.summary.realized_pnl_sol, +(0.7 + 1.2 - 0.6).toFixed(6));
});
test('fifoPnl: a sell with no buy in the fetched history is NULL, never invented', () => {
  const r = fifoPnl([{ mint: 'X', side: 'SELL', token_raw: '100', sol: 5, time: 1 }]); const c = r.coins[0];
  assert.equal(c.realized_multiple, null); assert.equal(c.realized_pnl_sol, null); assert.equal(c.history_incomplete, true); assert.equal(r.summary.coins_history_incomplete, 1);
});
test('walletTrades on a real fixture: payer BUY equals the raw on-chain deltas', () => {
  const tx = pump.pumpfun_buy.tx; const payer = tx.transaction.message.accountKeys[0].pubkey; const { trades } = walletTrades([tx], payer);
  assert.equal(trades.length, 1); assert.equal(trades[0].side, 'BUY'); assert.equal(trades[0].venue, 'PUMP_FUN'); assert.ok(trades[0].sol > 0.3 && trades[0].time === tx.blockTime);
});
test('creatorOf / createdMints read the create transaction', () => {
  const tx = { blockTime: 100, transaction: { signatures: ['S'], message: { accountKeys: [{ pubkey: 'CREATOR' }], instructions: [{ programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' }] } }, meta: { err: null, logMessages: ['Program log: Instruction: CreateV2'], postTokenBalances: [{ mint: 'NEWMINT' }] } };
  assert.deepEqual([creatorOf([tx]).creator, creatorOf([tx]).created_at, creatorOf([tx]).is_create], ['CREATOR', 100, true]);
  assert.deepEqual(createdMints([tx], 'CREATOR').map(x => x.mint), ['NEWMINT']); assert.deepEqual(createdMints([tx], 'SOMEONE'), []);
  assert.equal(creatorOf([]), null);
});
test('address validation', () => { assert.equal(validAddress('3ZtY5iuH7BottzL249JoiQYqdSE9mFLikFYieNAHpump'), true); for (const b of ['', 'x', '../etc', 'a b', null]) assert.equal(validAddress(b), false); });

test('Chain.coin: caches, rate-limits, returns labelled real fields only', async () => {
  let rpcCalls = 0; const h = { rpc: async (m, p) => { rpcCalls++; if (m === 'getAsset') return { content: { metadata: { name: 'N', symbol: 'S' } }, token_info: { supply: 1000, decimals: 6, token_program: 'T' } };
    if (m === 'getTransactionsForAddress') return { data: [] }; if (m === 'getTokenLargestAccounts') return { value: [{ address: 'TA', amount: '500' }] }; if (m === 'getMultipleAccounts') return { value: [{ data: { parsed: { info: { owner: 'OWN' } } } }] }; throw new Error('x'); } };
  const dex = { tokensBatch: async () => ({ data: [{ chainId: 'solana', priceUsd: '1', liquidity: { usd: 10 }, pairAddress: 'P', baseToken: {} }] }) };
  const c = new Chain({ helius: h, dex, maxPerMinute: 3 }); const M = '3ZtY5iuH7BottzL249JoiQYqdSE9mFLikFYieNAHpump';
  const a = await c.coin(M); assert.equal(a.name, 'N'); assert.equal(a.holders[0].pct_supply, 50); assert.equal(a.market.source, 'DEXSCREENER'); assert.equal(a.creator, null);
  const n = rpcCalls; const b = await c.coin(M); assert.equal(b.cached, true); assert.equal(rpcCalls, n);
  await assert.rejects(() => c.coin('Vote111111111111111111111111111111111111111'), /rate-limited/); // 3 fetch groups already used this minute
  await assert.rejects(() => c.coin('bad'), /bad-address/);
});

test('GeckoTerminal: real candle shape parsed, sorted, cached; bad input rejected', async () => {
  let n = 0; const g = new GeckoTerminal({ fetchImpl: async () => { n++; return { ok: true, json: async () => ({ data: { attributes: { ohlcv_list: [[120, 2, 3, 1, 2.5, 10], [60, 1, 2, 0.5, 2, 5]] } } }) }; } });
  const r = await g.ohlcv('3Czf9zzuDHbYkziB7Wh65HG2Vg27nK7FZTdYpTGRdN2K', '1m'); assert.deepEqual(r.candles.map(c => c.time), [60, 120]); assert.equal(r.candles[1].c, 2.5);
  await g.ohlcv('3Czf9zzuDHbYkziB7Wh65HG2Vg27nK7FZTdYpTGRdN2K', '1m'); assert.equal(n, 1);
  await assert.rejects(() => g.ohlcv('3Czf9zzuDHbYkziB7Wh65HG2Vg27nK7FZTdYpTGRdN2K', '5s'), /bad-timeframe/); await assert.rejects(() => g.ohlcv('x', '1m'), /bad-pool/);
});

const cfg = { ...JSON.parse(readFileSync('config/experiment.json', 'utf8')), app: { enabled: true, host: '127.0.0.1', port: 0 } };
const listen = (s) => new Promise((r) => s.listening ? r(s.address().port) : s.on('listening', () => r(s.address().port)));
test('app routes: markets from worker state, coin/wallet 503 without chain, 400 on bad address, still GET-only', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'sewl-')), 't.sqlite'); openDb(file);
  const state = { lastPairs: [{ mint: 'M', symbol: 'S' }], lastPairsAt: 'now' };
  const srv = startApp(cfg, { file, state, chain: null, gecko: null }); const base = `http://127.0.0.1:${await listen(srv)}`;
  try {
    assert.equal((await (await fetch(base + '/api/markets')).json()).coins[0].symbol, 'S');
    assert.equal((await fetch(base + '/api/coin/3ZtY5iuH7BottzL249JoiQYqdSE9mFLikFYieNAHpump')).status, 503);
    assert.equal((await fetch(base + '/api/ohlcv/x')).status, 503);
    assert.equal((await fetch(base + '/api/coin/x', { method: 'POST' })).status, 405);
  } finally { srv.close(); }
  const chain = { coin: async (m) => { if (m === 'bad') throw new Error('bad-address'); return { mint: m }; }, wallet: async () => { throw new Error('rate-limited'); } };
  const srv2 = startApp(cfg, { file, state, chain, gecko: null }); const b2 = `http://127.0.0.1:${await listen(srv2)}`;
  try { assert.equal((await fetch(b2 + '/api/coin/bad')).status, 400); assert.equal((await fetch(b2 + '/api/coin/abc')).status, 200); assert.equal((await fetch(b2 + '/api/wallet/abc')).status, 429); } finally { srv2.close(); }
});

test('auditMint on the real Token-2022 mint: authorities revoked, extensions named, unknown ids flagged unsafe', () => {
  const f = JSON.parse(readFileSync(new URL('./fixtures/token2022_mint.json', import.meta.url))); const a = auditMint(f.account);
  assert.equal(a.ok, true); assert.equal(a.token_2022, true); assert.ok(a.extensions.length >= 1);
  assert.ok(a.extensions.every(e => e.allowed === (e.type === 18 || e.type === 19)));
  assert.equal(auditMint(null), null);
});

test('walletStats: win rate, median hold, curve and first-seen match hand-computed values; unmatched sells excluded', () => {
  const coins = [{ mint: 'A', realized_multiple: 2, realized_pnl_sol: 1, first_buy: 100, last_sell: 200 }, { mint: 'B', realized_multiple: 0.5, realized_pnl_sol: -0.4, first_buy: 150, last_sell: 450 },
    { mint: 'C', realized_multiple: 1.2, realized_pnl_sol: 0.2, first_buy: 0, last_sell: 1000 }, { mint: 'D', realized_multiple: null, realized_pnl_sol: null, first_buy: null, last_sell: 900 }];
  const s = walletStats(coins, { oldest: 77 });
  assert.equal(s.win_rate, 0.667); assert.equal(s.sample, 3); assert.equal(s.median_hold_s, 300); assert.equal(s.first_seen, 77); assert.equal(s.mints_traded, 4);
  assert.deepEqual(s.curve.map(p => p.cum_pnl_sol), [1, 0.6, 0.8]); assert.equal(walletStats([]).win_rate, null);
});
test('walletTags: each tag flips on its own condition; Sniper/Insider are never produced', () => {
  const base = { hold_sample: 3, median_hold_s: 1000 };
  assert.deepEqual(walletTags(base, {}), []);
  assert.equal(walletTags({ hold_sample: 3, median_hold_s: 90000 }, {})[0].tag, 'Diamond hands');
  assert.equal(walletTags({ hold_sample: 3, median_hold_s: 60 }, {})[0].tag, 'Flipper');
  assert.equal(walletTags({ hold_sample: 2, median_hold_s: 60 }, {}).length, 0);
  assert.equal(walletTags(base, { solBalance: 2000 })[0].tag, 'Whale');
  const dead = (n) => Array.from({ length: n }, () => ({ status: 'DEAD_OR_RUGGED_HEURISTIC' }));
  assert.equal(walletTags(base, { created: dead(3) })[0].tag, 'Serial rugger?'); assert.equal(walletTags(base, { created: dead(2) })[0].tag, 'Dev-adjacent');
  for (const x of [walletTags({ hold_sample: 9, median_hold_s: 1 }, { solBalance: 1e6, created: dead(9) })]) assert.ok(!x.some(t => /Sniper|Insider/.test(t.tag)));
});
test('copyImpact: constant-product math; NULL when liquidity unknown', () => {
  assert.equal(copyImpact(1000, 20).est_impact_pct, +(20 / 520 * 100).toFixed(2)); assert.equal(copyImpact(null), null); assert.equal(copyImpact(0), null);
  assert.ok(copyImpact(100000, 20).est_impact_pct < copyImpact(1000, 20).est_impact_pct);
});
test('signals API exposes the real risk-assessment checks for the gate checklist', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'sewl-')), 't.sqlite'); const db = openDb(file);
  db.prepare(`INSERT INTO risk_assessments (id, mint, assessed_at, rule_version, result, checks_json) VALUES ('ra1','M','2026-10-04T00:00:00Z','v','REJECTED','{"identity":"FAIL"}')`).run();
  db.prepare(`INSERT INTO signals (id, experiment_id, mint, qualified_at, buy_event_ids_json, rule_version, decision, reason_codes_json, dedupe_key, risk_assessment_id) VALUES ('s1','exp-1','M','2026-10-04T00:00:00Z','[]','momentum-v1','REJECTED','["risk:REJECTED"]','d1','ra1')`).run();
  db.close(); const srv = startApp(cfg, { file }); const base = `http://127.0.0.1:${await listen(srv)}`;
  try { const j = await (await fetch(base + '/api/signals')).json(); assert.deepEqual(j.signals[0].checks, { identity: 'FAIL' }); assert.equal(j.signals[0].checks_json, undefined); } finally { srv.close(); }
});
