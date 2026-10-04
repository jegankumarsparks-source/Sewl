import { firstSwapMs, LEAD_PROGRAMS } from './sources/helius.js';
import { d, mul, fmt, cmp, floorRaw } from './decimal.js';
import { uuid, nowIso } from './db.js';
import { validateToken } from './validation.js';
import { paperEntry } from './paper.js';

// PAPER ONLY. Momentum trigger from DEX Screener 5m pair data. Candidate coverage is limited to
// promoted/profiled Solana leads (DEX Screener has no "all new pairs" feed): NOT full-market coverage.
const num = (x) => (x == null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));

// Pure trigger check. Any missing input -> { trigger:false, reasons:[...-unknown] } (NULL never passes).
export function evaluateTrigger(pair, cfg, nowMs = Date.now()) {
  const m = cfg.momentum; const reasons = [];
  const surge = num(pair?.priceChange?.m5);
  const v5 = num(pair?.volume?.m5), v1h = num(pair?.volume?.h1);
  const liq = num(pair?.liquidity?.usd);
  const created = num(pair?.pairCreatedAt);
  const ageH = created == null ? null : (nowMs - created) / 3600_000;
  // baseline = average 5m volume over the rest of the last hour: (h1 - m5) / 11
  const base = v5 != null && v1h != null && v1h > v5 ? (v1h - v5) / 11 : null;
  const volX = base != null && base > 0 ? v5 / base : null;
  if (surge == null) reasons.push('price-change-unknown'); else if (surge < Number(m.price_surge_pct)) reasons.push('surge-below-threshold');
  if (volX == null) reasons.push('volume-baseline-unknown'); else if (volX < Number(m.volume_surge_x)) reasons.push('volume-surge-below-threshold');
  if (ageH == null) reasons.push('pool-age-unknown'); else if (ageH > Number(m.pool_age_max_hours)) reasons.push('pool-too-old');
  if (liq == null) reasons.push('liquidity-unknown'); else if (liq < Number(m.min_liquidity_usd)) reasons.push('liquidity-below-min');
  return { trigger: reasons.length === 0, reasons, metrics: { surge_pct: surge, volume_x: volX, pool_age_h: ageH, liquidity_usd: liq } };
}

const withDeadline = (p, ms) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('validation-deadline')), ms); })]).finally(() => clearTimeout(t)); };

// One candidate: trigger -> (<=30s) existing validation gates -> paper entry (origin 'momentum').
export async function processMomentum(db, deps, pair, { nowMs = Date.now() } = {}) {
  const { cfg, jupiter, outbox } = deps; const m = cfg.momentum;
  const mint = pair.baseToken?.address;
  const ev = evaluateTrigger(pair, cfg, nowMs);
  if (!ev.trigger) return { decision: 'NO_TRIGGER', reasons: ev.reasons };
  const cooldownSince = new Date(nowMs - Number(m.cooldown_minutes) * 60_000).toISOString();
  if (db.prepare(`SELECT 1 FROM signals WHERE mint=? AND rule_version='momentum-v1' AND qualified_at>=?`).get(mint, cooldownSince)) return { decision: 'COOLDOWN', reasons: ['recent-momentum-signal'] };
  const detectionMs = nowMs;
  // DEX Screener exposes no candle open time: candle start is the 5m WINDOW BOUND (detection - window), so
  // detection latency here is an UPPER BOUND, labelled as such.
  let candleStartMs = detectionMs - Number(m.window_minutes) * 60_000;
  let candleSource = 'DEXSCREENER_5M_WINDOW_BOUND'; let swapEvidenceId = null;
  // Helius parsed swaps (config-gated, inert without a key): exact on-chain block time of the first swap inside the 5m window.
  if (deps.helius?.enabled) {
    try {
      const winStartSec = Math.floor(candleStartMs / 1000);
      const hs = await deps.helius.swapsSince(mint, winStartSec);
      const first = firstSwapMs(hs.swaps, winStartSec);
      if (first != null) { candleStartMs = first; candleSource = 'HELIUS_FIRST_SWAP_IN_WINDOW'; swapEvidenceId = hs.evidenceId; }
    } catch { /* fall back to the labelled window bound */ }
  }
  const buyId = uuid(); const signalId = uuid(); const reasons = [];
  db.prepare(`INSERT INTO buy_events (id, wallet_address, trade_id, mint, onchain_time, detected_at, latency_ms, eligibility_state, origin, candle_start_ms, detection_ms, candle_time_source)
    VALUES (?,?,?,?,?,?,?,?, 'momentum', ?, ?, ?)`)
    .run(buyId, null, null, mint, null, new Date(detectionMs).toISOString(), detectionMs - candleStartMs, 'TRIGGERED', candleStartMs, detectionMs, candleSource);
  const finish = (decision, rs, extra = {}) => {
    db.prepare(`INSERT INTO signals (id, experiment_id, mint, qualified_at, buy_event_ids_json, rule_version, decision, reason_codes_json, dedupe_key, risk_assessment_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(signalId, 'exp-1', mint, nowIso(), JSON.stringify([buyId]), 'momentum-v1', decision, JSON.stringify(rs), `mom:${mint}:${buyId}`, extra.riskId ?? null);
    db.prepare(`UPDATE buy_events SET eligibility_state=? WHERE id=?`).run(decision, buyId);
    outbox?.enqueue('signal', { mint, decision, reasons: rs, venue: 'MOMENTUM', notional: null, risk: extra.risk ?? null });
    return { decision, reasons: rs, signalId, buyId, metrics: ev.metrics };
  };
  let risk;
  try { risk = await withDeadline((deps.validate ?? validateToken)(db, deps.rpc, deps.dex, jupiter, mint, cfg), Number(m.validation_deadline_seconds) * 1000); }
  catch (e) { return finish('DATA_INCOMPLETE', [String(e.message).slice(0, 60)]); }
  if (risk.result === 'QUALIFIED' && Object.values(risk.checks ?? {}).includes('FAIL')) risk.result = 'REJECTED'; // defense in depth
  if (risk.result !== 'QUALIFIED') return finish(risk.result === 'REJECTED' ? 'REJECTED' : 'DATA_INCOMPLETE', ['risk:' + risk.result, ...(risk.unknown ?? [])], { riskId: risk.id, risk: risk.result });
  const eff = d(cfg.position_budget_usd) - d(cfg.friction.entry_fee_usd);
  let units, qeId;
  try {
    const q = await jupiter.buyQuote(mint, eff.toString());
    qeId = q.evidenceId;
    units = floorRaw((mul(d(q.quote.outAmount), d(1) - d(cfg.friction.entry_haircut))).toString(), risk.decimals ?? 9);
    if (cmp(units, 0n) <= 0) throw new Error('zero units');
  } catch { return finish('DATA_INCOMPLETE', ['entry-quote-unavailable'], { riskId: risk.id, risk: risk.result }); }
  const entry = await paperEntry(db, deps, { signalId: 'pending', mint, entryUnitsRaw: units.toString(), decimals: risk.decimals ?? 9, quoteEvidenceId: qeId, origin: 'momentum' });
  const entryMs = Date.now();
  if (entry.denied) return finish('QUALIFIED_NO_CAPITAL', ['paper-entry-denied:' + entry.denied], { riskId: risk.id, risk: risk.result });
  const out = finish('PAPER_OPEN', reasons, { riskId: risk.id, risk: risk.result });
  db.prepare(`UPDATE paper_positions SET signal_id=? WHERE id=?`).run(signalId, entry.id);
  db.prepare(`UPDATE buy_events SET entry_ms=?, latency_ms=? WHERE id=?`).run(entryMs, entryMs - candleStartMs, buyId);
  return { ...out, positionId: entry.id, entry_ms: entryMs };
}

export async function momentumCycle(db, deps) {
  const { cfg, dex } = deps;
  if (!cfg.momentum?.enabled) return { skipped: 'disabled' };
  const leads = new Set();
  for (const fn of ['latestBoosts', 'latestProfiles']) {
    try { (await dex[fn]()).data?.filter(x => x.chainId === 'solana').forEach(x => leads.add(x.tokenAddress)); } catch { }
  }
  const dexLeads = new Set([...leads].slice(0, Number(cfg.momentum.max_leads_per_cycle)));
  // Extra lead source (config-gated, inert without a Helius key): mints with live Pump.fun / PumpSwap swaps.
  // Same trigger conditions and gates apply to every lead; this only widens what gets looked at.
  const hl = cfg.momentum.helius_leads; let heliusAdded = 0, heliusSeen = 0, heliusErr = null;
  let ranDiscovery = false;
  const state = deps.leadState ??= { cycle: 0 };
  state.cycle++;
  if (hl?.enabled && deps.helius?.enabled && (state.cycle - 1) % Number(hl.every_cycles) === 0) {
    const found = new Map(); let capHit = false; ranDiscovery = true;
    for (const prog of (deps.leadPrograms ?? Object.values(LEAD_PROGRAMS))) {
      try { const r = await deps.helius.activeMints(prog, { limit: Number(hl.per_program_limit) }); for (const [mint, n] of r.mints) found.set(mint, (found.get(mint) ?? 0) + n); }
      catch (e) { heliusErr = String(e.message).slice(0, 40); if (e.message === 'helius-credit-cap') { capHit = true; break; } }
    }
    if (capHit) { state.heliusLeads = []; if (deps.helius.markCapNotified()) deps.onCreditCap?.({ used: deps.helius.creditsUsed(), cap: deps.helius.monthlyCap }); }
    else {
    heliusSeen = found.size;
    state.heliusLeads = [...found.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]).slice(0, Number(hl.max_leads));
    }
  }
  // After the cap is reached no discovery runs; leads fall back to DexScreener only.
  if (!ranDiscovery && deps.helius?.capReached?.()) { state.heliusLeads = []; heliusErr = 'helius-credit-cap'; if (deps.helius.markCapNotified()) deps.onCreditCap?.({ used: deps.helius.creditsUsed(), cap: deps.helius.monthlyCap }); }
  const all = new Set(dexLeads);
  for (const mt of state.heliusLeads ?? []) if (!all.has(mt)) { all.add(mt); heliusAdded++; }
  const mints = [...all];
  if (!mints.length) return { leads: 0, scanned: 0, triggered: 0 };
  let pairs = [];
  try { for (let i = 0; i < mints.length; i += 30) pairs.push(...((await dex.tokensBatch(mints.slice(i, i + 30))).data ?? [])); } catch { return { leads: mints.length, scanned: 0, error: 'pairs-fetch-failed' }; }
  // best (highest-liquidity) solana pair per base token
  const best = new Map();
  for (const p of pairs) if (p.chainId === 'solana' && p.baseToken?.address) {
    const cur = best.get(p.baseToken.address);
    if (!cur || (num(p.liquidity?.usd) ?? 0) > (num(cur.liquidity?.usd) ?? 0)) best.set(p.baseToken.address, p);
  }
  let triggered = 0, opened = 0;
  for (const p of best.values()) {
    if (!evaluateTrigger(p, cfg).trigger) continue;
    triggered++;
    const r = await processMomentum(db, deps, p);
    if (r.decision === 'PAPER_OPEN') opened++;
  }
  return { leads: mints.length, leads_dex: dexLeads.size, leads_helius_new: heliusAdded, helius_seen: heliusSeen, helius_credits: deps.helius?.creditsUsed?.() ?? 0, helius_error: heliusErr, scanned: best.size, triggered, opened };
}

// Weekly-style latency proof from stored fields (NULL rows excluded and counted).
export function latencyStats(db, sinceIso = '1970-01-01') {
  const rows = db.prepare(`SELECT candle_start_ms c, detection_ms dt, entry_ms e FROM buy_events WHERE origin='momentum' AND detected_at>=?`).all(sinceIso);
  const det = rows.filter(r => r.c != null && r.dt != null).map(r => r.dt - r.c);
  const ent = rows.filter(r => r.dt != null && r.e != null).map(r => r.e - r.dt);
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  return { signals: rows.length, detect_avg_ms: avg(det), detect_max_ms: det.length ? Math.max(...det) : null, entry_avg_ms: avg(ent), entry_max_ms: ent.length ? Math.max(...ent) : null, entries_missing: rows.length - ent.length, note: 'candle start is the 5m window bound (upper bound)' };
}
