// Frozen real mainnet Pump.fun / PumpSwap transactions. Expected values are computed from the raw
// pre/post balances in the test itself (independent of the parser), then compared with parseSwap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSwap, PROGRAM_IDS } from '../src/parser.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/pump_txs.json', import.meta.url)));
const SOL = 'So11111111111111111111111111111111111111112';
function truth(tx) { // payer = fee payer (accountKeys[0]); returns raw on-chain deltas for that wallet
  const m = tx.meta, payer = tx.transaction.message.accountKeys[0].pubkey;
  const bal = (a) => Object.fromEntries((a ?? []).map(b => [b.owner + '|' + b.mint, BigInt(b.uiTokenAmount.amount)]));
  const pre = bal(m.preTokenBalances), post = bal(m.postTokenBalances);
  const tok = {};
  for (const k of new Set([...Object.keys(pre), ...Object.keys(post)])) if (k.startsWith(payer + '|')) { const x = (post[k] ?? 0n) - (pre[k] ?? 0n); if (x !== 0n) tok[k.split('|')[1]] = x; }
  const native = BigInt(m.postBalances[0]) - BigInt(m.preBalances[0]);
  return { payer, tok, sol: native + (tok[SOL] ?? 0n) };
}
const parsed = (name) => { const t = fx.txs[name].tx; const p = parseSwap(t); const tr = truth(t); return { p, tr, mine: p.trades.filter(x => x.owner === tr.payer) }; };

test('fixtures are finalized, successful mainnet transactions with a block time', () => {
  for (const [n, x] of Object.entries(fx.txs)) { assert.equal(x.tx.meta.err, null, n); assert.ok(x.tx.blockTime > 1.7e9, n); assert.ok(x.signature.length >= 86, n); }
});
test('program ids: Pump.fun curve and PumpSwap AMM are both recognised venues', () => {
  assert.equal(PROGRAM_IDS.PUMP_FUN, '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  assert.equal(PROGRAM_IDS.PUMP_AMM, 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
  assert.equal(parsed('pumpfun_buy').p.venue, 'PUMP_FUN'); assert.equal(parsed('pumpfun_sell').p.venue, 'PUMP_FUN'); assert.equal(parsed('pumpamm_buy').p.venue, 'PUMP_AMM');
});
test('Pump.fun BUY: token amount and SOL paid equal the raw on-chain deltas', () => {
  const { mine, tr } = parsed('pumpfun_buy'); assert.equal(mine.length, 1); const t = mine[0];
  const [mint, delta] = Object.entries(tr.tok).find(([m, v]) => m !== SOL && v > 0n);
  assert.equal(t.side, 'BUY'); assert.equal(t.mint, mint); assert.equal(t.tokenAmountRaw, delta.toString());
  assert.equal(t.quoteMint, SOL); assert.equal(t.quoteAmountRaw, (-tr.sol).toString());
});
test('Pump.fun SELL: token sold and SOL received equal the raw on-chain deltas', () => {
  const { mine, tr } = parsed('pumpfun_sell'); assert.equal(mine.length, 1); const t = mine[0];
  const [mint, delta] = Object.entries(tr.tok).find(([m, v]) => m !== SOL && v < 0n);
  assert.equal(t.side, 'SELL'); assert.equal(t.mint, mint); assert.equal(t.tokenAmountRaw, (-delta).toString());
  assert.equal(t.quoteMint, SOL); assert.equal(t.quoteAmountRaw, tr.sol.toString());
});
test('PumpSwap BUY paid in wrapped SOL: quote counts the wSOL spent, not just native fees (regression)', () => {
  const { mine, tr } = parsed('pumpamm_buy'); assert.equal(mine.length, 1); const t = mine[0];
  assert.ok(tr.tok[SOL] < 0n, 'fixture pays with wSOL');
  assert.equal(t.quoteMint, SOL); assert.equal(t.quoteAmountRaw, (-tr.sol).toString());
  const nativeOnly = -(BigInt(fx.txs.pumpamm_buy.tx.meta.postBalances[0]) - BigInt(fx.txs.pumpamm_buy.tx.meta.preBalances[0]));
  assert.ok(BigInt(t.quoteAmountRaw) > nativeOnly, 'old native-only parse understated the spend');
});
test('wrapped SOL is never reported as a traded token', () => {
  for (const n of Object.keys(fx.txs)) assert.equal(parsed(n).p.trades.some(x => x.mint === SOL), false, n);
});
