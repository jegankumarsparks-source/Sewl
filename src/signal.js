import { pairCreatedMs as pairCreatedMsOf } from './pairs.js';
import { d, div, mul, cmp, fmt, floorRaw } from './decimal.js';
import { uuid, nowIso } from './db.js';
import { validateToken } from './validation.js';
import { paperEntry } from './paper.js';
import { USDC } from './sources/jupiter.js';

// Full gate chain for a provisional buy event -> signal -> optional paper entry.
// Pre-entry observation window gate. Returns null to proceed, or { decision, reasons }.
// Unknown observed price is DATA_INCOMPLETE (never a silent skip); a >=2x run above the window low is REJECTED.
export function pumpWindowGate(db, mint, curUnitUsd, cfg, nowMs = Date.now()) {
  const winMs = Number(cfg.signal.min_watch_minutes) * 60_000;
  const hasObsWindow = db.prepare(`SELECT COUNT(*) c FROM market_snapshots WHERE mint=? AND observed_at<=?`).get(mint, new Date(nowMs - winMs).toISOString()).c > 0;
  if (!hasObsWindow) return { decision: 'WATCH_ONLY', reasons: ['observation-window-too-short'] };
  const lo = db.prepare(`SELECT MIN(CAST(price_usd AS REAL)) lo FROM market_snapshots WHERE mint=? AND observed_at>=? AND price_usd IS NOT NULL AND CAST(price_usd AS REAL) > 0`).get(mint, new Date(nowMs - winMs).toISOString()).lo;
  if (lo == null || !(lo > 0)) return { decision: 'DATA_INCOMPLETE', reasons: ['observed-price-unknown'] };
  if (cmp(div(curUnitUsd, d(String(lo))), d(cfg.signal.max_observed_multiple)) >= 0) return { decision: 'REJECTED', reasons: ['pump-above-2x-in-window'] };
  return null;
}

export async function processBuy(db, deps, buy) {
  const { cfg, dex, jupiter, rpc, outbox } = deps;
  const reasons = [];
  const pass = (c, code) => { if (!c) reasons.push(code); return c; };

  // 1. decoded finalized buy with evidence-backed notional >= $50
  if (!pass(buy.notional != null, 'notional-unknown')) return decide(db, deps, buy, 'REJECTED', reasons);
  if (!pass(cmp(buy.notional, d(cfg.signal.min_notional_usd)) >= 0, 'notional-below-' + cfg.signal.min_notional_usd)) return decide(db, deps, buy, 'REJECTED', reasons);
  if (!pass(buy.venue !== 'UNKNOWN', 'unsupported-venue')) return decide(db, deps, buy, 'REJECTED', reasons);

  // 2. pool age <= 6h (pool age is not mint age; unknown -> incomplete)
  const pairs = await dex.tokenPairs(buy.mint).catch(() => null);
  let pairCreatedMs = null;
  if (pairs?.data?.length) {
    const p = pairs.data.find(x => x.chainId === 'solana');
    if (!p) { reasons.push('solana-pair-missing'); return decide(db, deps, buy, 'DATA_INCOMPLETE', reasons); }
    pairCreatedMs = pairCreatedMsOf(p);
    db.prepare(`INSERT INTO market_snapshots (id, mint, pool_address, observed_at, price_usd, liquidity_usd, market_cap_usd, fdv_usd, evidence_id, freshness_state)
      VALUES (?,?,?,?,?,?,?,?,?, 'FRESH')`)
      .run(uuid(), buy.mint, p.pairAddress ?? null, nowIso(), p.priceUsd ?? null, p.liquidity?.usd != null ? String(p.liquidity.usd) : null, p.marketCap ?? null, p.fdv ?? null, pairs.evidenceId);
  }
  const ageH = pairCreatedMs ? (Date.now() - pairCreatedMs) / 3600_000 : null;
  if (!pass(ageH != null, 'pool-age-unknown')) return decide(db, deps, buy, 'DATA_INCOMPLETE', reasons);
  if (!pass(ageH <= Number(cfg.signal.pool_age_max_hours), 'pool-too-old')) return decide(db, deps, buy, 'REJECTED', reasons);

  // 3. >=2 qualified wallet clusters within 15 min
  const since = new Date(Date.now() - Number(cfg.signal.cluster_window_minutes) * 60_000).toISOString();
  const clusterWallets = db.prepare(`SELECT DISTINCT w.cluster_id FROM buy_events b JOIN wallets w ON w.address=b.wallet_address
    WHERE b.mint=? AND b.detected_at>=? AND w.status='QUALIFIED'`).all(buy.mint, since).map(r => r.cluster_id ?? 'solo:' + buy.wallet);
  const distinctClusters = new Set([...clusterWallets, 'solo:' + buy.wallet]).size;
  const soloWatch = distinctClusters < Number(cfg.signal.cluster_min_wallets);
  if (!pass(!soloWatch, 'single-cluster-watch-only')) {
    db.prepare(`UPDATE buy_events SET eligibility_state='WATCH_ONLY' WHERE id=?`).run(buy.id);
    return decide(db, deps, buy, 'WATCH_ONLY', reasons);
  }

  // 4. token validation risk gates
  const risk = await validateToken(db, rpc, dex, jupiter, buy.mint, cfg);
  if (risk.result === 'QUALIFIED' && Object.values(risk.checks ?? {}).includes('FAIL')) risk.result = 'REJECTED'; // defense in depth
  if (!pass(risk.result === 'QUALIFIED', 'risk:' + risk.result)) return decide(db, deps, buy, risk.result === 'REJECTED' ? 'REJECTED' : 'DATA_INCOMPLETE', [...reasons, ...risk.unknown]);

  // 5. chase test: current quote <= 1.5x the whale's execution price
  const spot = d(risk.price ?? '0');
  let whaleUnitUsd = null;
  try {
    const trade = db.prepare(`SELECT * FROM wallet_trades WHERE id=(SELECT trade_id FROM buy_events WHERE id=?)`).get(buy.id);
    const token = db.prepare(`SELECT decimals FROM tokens WHERE mint=?`).get(buy.mint);
    const dec = token?.decimals ?? 9;
    whaleUnitUsd = div(buy.notional, div(d(trade.token_amount_raw), d(10).pow(d(dec))));
  } catch { }
  const curUnitUsd = spot;
  if (!pass(whaleUnitUsd != null && curUnitUsd > 0n, 'price-comparison-unknown')) return decide(db, deps, buy, 'DATA_INCOMPLETE', reasons);
  if (!pass(cmp(div(curUnitUsd, whaleUnitUsd), d(cfg.signal.max_chase_multiple)) <= 0, 'chase-limit-exceeded')) return decide(db, deps, buy, 'REJECTED', reasons);

  // 6. 10-minute pre-entry observation window: current < 2x lowest credible observation
  const pw = pumpWindowGate(db, buy.mint, curUnitUsd, cfg);
  if (pw) { reasons.push(...pw.reasons); return decide(db, deps, buy, pw.decision, reasons); }

  // 7. paper entry via fresh read-only Jupiter quote ($49.75 effective, 1% haircut, round down)
  const budget = d(cfg.position_budget_usd);
  const eff = budget - d(cfg.friction.entry_fee_usd);
  let entryUnits = null, qeId = null;
  try {
    const q = await jupiter.buyQuote(buy.mint, (eff).toString());
    qeId = q.evidenceId;
    entryUnits = floorRaw((mul(d(q.quote.outAmount), d(1) - d(cfg.friction.entry_haircut))).toString(), risk.decimals ?? 9);
    if (cmp(entryUnits, 0n) <= 0) throw new Error('zero units');
  } catch {
    if (!cfg.allow_scenario_entries) { reasons.push('entry-quote-unavailable'); return decide(db, deps, buy, 'DATA_INCOMPLETE', reasons); }
  }
  const signalId = uuid();
  db.prepare(`INSERT INTO signals (id, experiment_id, mint, qualified_at, buy_event_ids_json, risk_assessment_id, snapshot_id, rule_version, decision, reason_codes_json, dedupe_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(signalId, 'exp-1', buy.mint, nowIso(), JSON.stringify([buy.id]), risk.id, null, 'signal-v1', entryUnits != null ? 'PAPER_OPEN' : 'QUALIFIED_NO_CAPITAL', JSON.stringify(reasons), `sig:${buy.mint}:${buy.id}`);
  let entry = null;
  if (entryUnits != null) {
    entry = await paperEntry(db, deps, { signalId, mint: buy.mint, entryUnitsRaw: entryUnits.toString(), decimals: risk.decimals ?? 9, quoteEvidenceId: qeId });
    if (entry.denied) {
      db.prepare(`UPDATE signals SET decision=? WHERE id=?`).run('QUALIFIED_NO_CAPITAL', signalId);
      reasons.push('paper-entry-denied:' + entry.denied);
    } else {
      db.prepare(`UPDATE buy_events SET eligibility_state='PAPER_OPEN' WHERE id=?`).run(buy.id);
    }
  }
  outbox?.enqueue('signal', { mint: buy.mint, score: null, risk: risk.result, notional: fmt(buy.notional), venue: buy.venue, decision: entry?.denied ? 'QUALIFIED_NO_CAPITAL' : 'PAPER_OPEN', reasons });
  return { decision: entry?.denied ?? 'PAPER_OPEN', reasons, signalId };
}

function decide(db, deps, buy, decision, reasons) {
  const id = uuid();
  db.prepare(`INSERT OR IGNORE INTO signals (id, experiment_id, mint, qualified_at, buy_event_ids_json, rule_version, decision, reason_codes_json, dedupe_key)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, 'exp-1', buy.mint, nowIso(), JSON.stringify([buy.id]), 'signal-v1', decision, JSON.stringify(reasons), `sig:${buy.mint}:${buy.id}`);
  deps.outbox?.enqueue('signal', { mint: buy.mint, decision, reasons });
  return { decision, reasons, signalId: id };
}
