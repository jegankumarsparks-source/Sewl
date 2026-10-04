import { d, add, sub, mul, div, cmp, min, max, fmt } from './decimal.js';
import { uuid, nowIso } from './db.js';
import { parseSwap } from './parser.js';
import { SOL, USDC } from './sources/jupiter.js';

const lamportsToSol = (raw) => div(d(raw), d(1e9));

// Fetch + parse a wallet's recent history, store trades, price notional USD.
export async function reconstructHistory(db, rpc, coingecko, address, { txCap = 300, parserVersion = 'owner-delta-v1' }) {
  const sigs = [];
  let before = undefined;
  for (let page = 0; page < 5; page++) {
    const { result } = await rpc.getSignaturesForAddress(address, before ? { before } : {});
    if (!result?.length) break;
    sigs.push(...result);
    before = result[result.length - 1].signature;
    if (result.length < 1000 || sigs.length >= txCap) break;
  }
  const kept = sigs.slice(0, txCap);
  const prices = new Map(); // blockTime -> solUsd
  const solUsd = async (bt) => {
    if (!bt) return null;
    if (!prices.has(bt)) { try { prices.set(bt, await coingecko.solUsdAt(bt)); } catch { prices.set(bt, null); } }
    return prices.get(bt);
  };
  let parsed = 0, failed = 0;
  const insTx = db.prepare(`INSERT OR IGNORE INTO transactions
    (signature, slot, block_time, commitment, success, parser_version, parse_state, evidence_id)
    VALUES (?,?,?,?,?,?,?,?)`);
  const insTrade = db.prepare(`INSERT OR IGNORE INTO wallet_trades
    (id, wallet_address, signature, event_index, mint, side, token_amount_raw, quote_mint, quote_amount_raw, notional_usd, venue, classification, evidence_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const s of kept) {
    if (s.err) { failed++; continue; }
    try {
      const { result: tx, evidenceId } = await rpc.getTransaction(s.signature);
      if (!tx) { db.prepare(`INSERT OR IGNORE INTO transactions (signature, parse_state) VALUES (?, 'NULL_RESPONSE')`).run(s.signature); continue; }
      const p = parseSwap(tx, parserVersion);
      if (p.state !== 'OK') { insTx.run(s.signature, s.slot, s.blockTime, 'finalized', 0, parserVersion, p.state, evidenceId); continue; }
      parsed++;
      insTx.run(s.signature, p.slot, p.blockTime, 'finalized', 1, parserVersion, 'OK', evidenceId);
      let idx = 0;
      for (const t of p.trades) {
        if (t.owner !== address) { idx++; continue; } // only the watched owner's own flows
        let notional = null;
        if (t.quoteMint === USDC) notional = fmt(div(d(t.quoteAmountRaw), d(1e6)));
        else if (t.quoteMint === SOL) { const px = await solUsd(p.blockTime); if (px != null) notional = fmt(mul(lamportsToSol(t.quoteAmountRaw), d(px))); }
        const classification = p.venue === 'UNKNOWN' ? 'unsupported-venue' : 'swap-delta';
        insTrade.run(uuid(), address, s.signature, idx, t.mint, t.side, t.tokenAmountRaw, t.quoteMint, t.quoteAmountRaw, notional, p.venue, classification, evidenceId);
        idx++;
      }
    } catch { failed++; }
  }
  db.prepare(`INSERT INTO wallet_cursors (wallet_address, last_signature, last_finalized_slot, last_success_at)
    VALUES (?,?,?,?) ON CONFLICT(wallet_address) DO UPDATE SET last_signature=excluded.last_signature, last_success_at=excluded.last_success_at`)
    .run(address, kept[0]?.signature ?? null, kept[0]?.slot ?? null, nowIso());
  return { fetched: kept.length, parsed, failed };
}

// FIFO round-trip reconstruction + quality score (design doc section 6).
export function evaluateWallet(db, address, cfg) {
  const trades = db.prepare(`SELECT * FROM wallet_trades WHERE wallet_address=? AND classification='swap-delta' ORDER BY rowid`).all(address);
  const priced = trades.filter(t => t.notional_usd != null);
  const perMint = {};
  for (const t of trades) (perMint[t.mint] ??= []).push(t);
  const closed = []; const distinctMints = new Set();
  for (const [mint, arr] of Object.entries(perMint)) {
    distinctMints.add(mint);
    const lots = [];
    for (const t of arr) {
      const amt = d(t.token_amount_raw);
      if (t.side === 'BUY') {
        if (t.notional_usd == null) continue; // unknown basis lot: excluded from scoring
        lots.push({ amt, left: amt, cost: d(t.notional_usd) });
      } else {
        let sell = amt, cost = 0n; const proceeds = t.notional_usd == null ? null : d(t.notional_usd);
        while (sell > 0n && lots.length) {
          const lot = lots[0]; const take = min(sell, lot.left);
          lot.left -= take; sell -= take;
          cost += mul(lot.cost, div(take, lot.amt));
          if (lot.left === 0n) lots.shift();
        }
        if (proceeds == null || sell > 0n) continue; // unpriced/unknown-basis sell: excluded
        closed.push({ mint, costUsd: cost, proceedsUsd: d(proceeds), netUsd: d(proceeds) - cost, ret: cost > 0n ? div(d(proceeds) - cost, cost) : null });
      }
    }
  }
  const closedPriced = closed.filter(c => c.ret != null);
  const n = closedPriced.length;
  const q = cfg.quality;
  const clip = (x) => { const z = d(x); const o = d(1); return cmp(z, 0n) < 0 ? 0n : cmp(z, o) > 0 ? o : z; };
  let winRate = null, wilson = null, median = null, pf = null, topShare = null, score = null;
  let status = 'INSUFFICIENT_DATA'; const reasons = [];
  if (n > 0) {
    const w = closedPriced.filter(c => cmp(c.netUsd, 0n) > 0).length;
    const p = w / n;
    const z = 1.96;
    const center = p + (z * z) / (2 * n);
    const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    const denom = 1 + (z * z) / n;
    wilson = Math.max(0, (center - half) / denom);
    winRate = p;
    const rets = closedPriced.map(c => Number(fmt(c.ret))).sort((a, b) => a - b);
    median = rets[Math.floor(rets.length / 2)];
    const gains = closedPriced.filter(c => cmp(c.netUsd, 0n) > 0).reduce((a, c) => a + c.netUsd, 0n);
    const losses = closedPriced.filter(c => cmp(c.netUsd, 0n) < 0).reduce((a, c) => a - (-c.netUsd), 0n);
    pf = losses > 0n ? Number(fmt(div(gains, losses))) : (cmp(gains, 0n) > 0 ? null : 0); // all-wins: PF undefined, do NOT insert infinity
    if (cmp(gains, 0n) > 0) { const largest = closedPriced.reduce((a, c) => (cmp(c.netUsd, a.netUsd) > 0 ? c : a)).netUsd; topShare = Number(fmt(div(largest, gains))); }
  }
  const parseCoverage = trades.length ? parsedCoverage(db, address) : 0;
  const pricedCoverage = trades.length ? priced.length / trades.length : 0;
  if (n >= q.min_round_trips && distinctMints.size >= q.min_mints && parseCoverage >= Number(q.parse_coverage) && pricedCoverage >= Number(q.priced_coverage)) {
    score = 35 * wilson + 25 * Math.min(1, Math.max(0, (median + 0.10) / 0.40)) + 20 * Math.min(1, Math.max(0, (pf - 1) / 2)) + 10 * Math.min(1, (topShare ?? 1) / 0.80) + 10 * Math.min(parseCoverage, pricedCoverage);
    const pass = score >= Number(q.score_min) && wilson >= Number(q.wilson_min) && median > Number(q.median_min) && pf != null && pf >= Number(q.pf_min);
    status = pass ? 'QUALIFIED' : 'REJECTED';
    if (!pass) reasons.push('score-or-gates-below-threshold');
  } else reasons.push('insufficient-sample-or-coverage');
  const spanDays = trades.length ? 1 : 0; // precise span check left to fuller history; pilot records span caveat
  const id = uuid();
  db.prepare(`INSERT INTO wallet_scores (id, wallet_address, window_start, window_end, closed_round_trips, distinct_mints, parse_coverage, priced_coverage,
    win_rate, wilson_lower, median_return, profit_factor, top_profit_share, score, status, reason_codes_json, rule_version, computed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, address, nowIso(), nowIso(), n, distinctMints.size, String(parseCoverage), String(pricedCoverage),
      winRate, wilson, median, pf, topShare, score, status, JSON.stringify(reasons), 'quality-v1', nowIso());
  db.prepare(`UPDATE wallets SET status=?, last_score_id=? WHERE address=?`).run(status, id, address);
  return { id, n, distinctMints: distinctMints.size, winRate, wilson, median, pf, topShare, score, status, reasons, spanDays };
}
function parsedCoverage(db, address) {
  const r = db.prepare(`SELECT
    SUM(CASE WHEN parse_state='OK' THEN 1 ELSE 0 END)*1.0/COUNT(*) c FROM transactions t
    JOIN wallet_trades w ON w.signature=t.signature WHERE w.wallet_address=?`).get(address);
  return r?.c ?? 0;
}
