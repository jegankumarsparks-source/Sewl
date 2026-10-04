import { d, div, mul, fmt, cmp } from './decimal.js';
import { uuid, nowIso } from './db.js';
import { parseSwap } from './parser.js';
import { SOL, USDC } from './sources/jupiter.js';

// Turn a watched wallet's new finalized transaction into provisional buy events.
export async function detectBuys(db, rpc, coingecko, wallet, txResult, signature, cfg) {
  const p = parseSwap(txResult);
  const detectedAt = nowIso();
  const out = [];
  if (p.state !== 'OK') return out;
  const ins = db.prepare(`INSERT OR IGNORE INTO transactions (signature, slot, block_time, commitment, success, parser_version, parse_state, evidence_id)
    VALUES (?,?,?,?,?,?,?,?)`);
  const evId = db.prepare(`SELECT evidence_id FROM transactions WHERE signature=?`).get(signature)?.evidence_id ?? null;
  ins.run(signature, p.slot, p.blockTime, 'finalized', 1, p.parserVersion, 'OK', evId);
  let idx = 0;
  for (const t of p.trades) {
    if (t.owner !== wallet) { idx++; continue; }
    if (t.side !== 'BUY') { idx++; continue; }
    let notional = null;
    if (t.quoteMint === USDC) notional = div(d(t.quoteAmountRaw), d(1e6));
    else if (t.quoteMint === SOL) {
      const px = await coingecko.solUsdAt(p.blockTime ?? Math.floor(Date.now() / 1000)).catch(() => null);
      if (px != null) notional = mul(div(d(t.quoteAmountRaw), d(1e9)), d(px));
    }
    const tradeId = uuid();
    db.prepare(`INSERT OR IGNORE INTO wallet_trades (id, wallet_address, signature, event_index, mint, side, token_amount_raw, quote_mint, quote_amount_raw, notional_usd, venue, classification, evidence_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(tradeId, wallet, signature, idx, t.mint, 'BUY', t.tokenAmountRaw, t.quoteMint, t.quoteAmountRaw, notional == null ? null : fmt(notional), p.venue, p.venue === 'UNKNOWN' ? 'unsupported-venue' : 'swap-delta', evId);
    const id = uuid();
    const latency = p.blockTime ? Date.now() - p.blockTime * 1000 : null;
    db.prepare(`INSERT INTO buy_events (id, wallet_address, trade_id, mint, onchain_time, detected_at, latency_ms, eligibility_state)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, wallet, tradeId, t.mint, p.blockTime ? new Date(p.blockTime * 1000).toISOString() : null, detectedAt, latency, 'PROVISIONAL');
    out.push({ id, wallet, mint: t.mint, notional, quoteMint: t.quoteMint, quoteRaw: t.quoteAmountRaw, blockTime: p.blockTime, venue: p.venue });
    idx++;
  }
  return out;
}
