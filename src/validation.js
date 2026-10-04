import { d, div, mul, fmt, cmp, usdToRawUnits } from './decimal.js';
import { uuid, nowIso } from './db.js';
import { SOL, USDC } from './sources/jupiter.js';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const POOL_PROGRAMS = new Set(Object.values((await import('./parser.js')).PROGRAM_IDS));

// Minimal mint decoding (base layout). Token-2022: ANY TLV extension => conservative BLOCK.
export function decodeMint(account) {
  const data = Buffer.from(account.data[0], 'base64');
  const mintAuth = data.readUInt32LE(0) === 1 ? data.subarray(4, 36).toString('base64') : null;
  const supply = data.readBigUInt64LE(36).toString();
  const decimals = data.readUInt8(44);
  const freeze = data.readUInt32LE(46) === 1 ? data.subarray(50, 82).toString('base64') : null;
  let extensions = [];
  if (data.length > 82) { // Token-2022: base mint is padded to 165 bytes, accountType byte at 165 (1 = mint), TLV entries from 166
    if (data.length <= 165 || data.readUInt8(165) !== 1) return { ok: false, error: 'token-2022-account-not-mint' };
    for (let off = 166; off + 4 <= data.length;) {
      const type = data.readUInt16LE(off); const len = data.readUInt16LE(off + 2);
      extensions.push({ type, len }); off += 4 + len;
    }
  }
  return { ok: true, mintAuth, supply, decimals, freeze, extensions };
}

// Token-2022 ExtensionType ids verified against the official spl token-2022 interface enum
// (solana-program/token-2022 interface/src/extension/mod.rs, sequential from Uninitialized=0):
// 18 = MetadataPointer, 19 = TokenMetadata. Frozen allowlist: exactly these two. Anything else,
// including unknown or future ids, is rejected.
export const EXTENSION_ALLOWLIST = Object.freeze({ 18: 'metadata_pointer', 19: 'token_metadata' });
export function extensionVerdict(extensions) {
  const blocked = extensions.filter(e => !(e.type in EXTENSION_ALLOWLIST)).map(e => e.type);
  return { pass: blocked.length === 0, blocked };
}

export async function validateToken(db, rpc, dex, jupiter, mint, cfg) {
  const checks = {}; const evidenceIds = []; const unknown = [];
  let result = 'QUALIFIED';
  const set = (k, v, unknownIf = null) => { checks[k] = v; if (v === 'UNKNOWN' && unknownIf) { unknown.push(unknownIf); result = 'DATA_INCOMPLETE'; } if (v === 'FAIL') result = 'REJECTED'; };

  let rpcFailed = false;
  const ai = await rpc.getAccountInfo(mint).catch(() => { rpcFailed = true; return null; });
  if (rpcFailed || !ai?.result) { checks.identity = 'UNKNOWN'; unknown.push('account-info-unavailable'); return finish(db, mint, checks, evidenceIds, unknown, 'DATA_INCOMPLETE'); }
  if (!ai.result.value) { checks.identity = 'FAIL'; return finish(db, mint, checks, evidenceIds, unknown, 'REJECTED'); }
  const prog = ai.result.value.owner; evidenceIds.push(ai.evidenceId);
  if (prog !== TOKEN_PROGRAM && prog !== TOKEN_2022) { checks.identity = 'FAIL'; return finish(db, mint, checks, evidenceIds, unknown, 'REJECTED'); }
  checks.identity = 'PASS';
  const dec = decodeMint(ai.result.value);
  if (!dec.ok) { checks.identity = 'FAIL'; return finish(db, mint, checks, evidenceIds, unknown, 'REJECTED'); }
  checks.mint_authority_null = dec.mintAuth === null ? 'PASS' : 'FAIL';
  checks.freeze_authority_null = dec.freeze === null ? 'PASS' : 'FAIL';
  const ev = extensionVerdict(dec.extensions);
  checks.extensions_allowlist = ev.pass ? 'PASS' : 'FAIL';
  checks.extensions_decoded = dec.extensions.map(e => ({ type: e.type, len: e.len, name: EXTENSION_ALLOWLIST[e.type] ?? null }));
  for (const id of ev.blocked) checks[`extension-type-${id}`] = 'FAIL';
  db.prepare(`INSERT INTO tokens (mint, token_program, decimals, supply_raw, mint_authority, freeze_authority, extensions_json, first_observed_at, last_chain_evidence_id)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(mint) DO UPDATE SET mint_authority=excluded.mint_authority, freeze_authority=excluded.freeze_authority, extensions_json=excluded.extensions_json, last_chain_evidence_id=excluded.last_chain_evidence_id`)
    .run(mint, prog, dec.decimals, dec.supply, dec.mintAuth, dec.freeze, JSON.stringify(dec.extensions), nowIso(), ai.evidenceId);

  const largest = await rpc.getTokenLargestAccounts(mint).catch(() => null);
  if (largest?.result?.value?.length) {
    evidenceIds.push(largest.evidenceId);
    const accts = largest.result.value.slice(0, 20).map(a => a.address);
    const infos = await rpc.getMultipleAccounts(accts).catch(() => null);
    if (infos?.result?.value) {
      evidenceIds.push(infos.evidenceId);
      const byOwner = new Map(); let unclassified = 0n;
      infos.result.value.forEach((v, i) => {
        if (!v) { unclassified += BigInt(largest.result.value[i].amount); return; }
        const od = Buffer.from(v.data[0], 'base64');
        const owner = od.subarray(32, 64).toString('base64');
        const progId = v.owner;
        if (POOL_PROGRAMS.has(progId)) return; // pool-owned account excluded (evidence: program id)
        byOwner.set(owner, (byOwner.get(owner) || 0n) + BigInt(largest.result.value[i].amount));
      });
      const supply = d(dec.supply);
      const ownerAmts = [...byOwner.values()].sort((a, b) => (a < b ? 1 : -1));
      const largestOwner = ownerAmts[0] || 0n;
      const topTotal = ownerAmts.reduce((a, b) => a + b, 0n);
      checks.largest_nonpool_owner_15pct = cmp(div(largestOwner * d(100), supply), mul(d(100), d(cfg.validation.max_largest_owner))) <= 0 ? 'PASS' : 'FAIL';
      checks.top_owners_50pct = cmp(div(topTotal * d(100), supply), mul(d(100), d(cfg.validation.max_top_owners))) <= 0 ? 'PASS' : 'FAIL';
      if (unclassified > 0n) { checks.owner_classification = 'PARTIAL'; unknown.push('largest-accounts-unclassified'); if (result === 'QUALIFIED') result = 'DATA_INCOMPLETE'; }
      else checks.owner_classification = 'PASS';
    } else { checks.owner_classification = 'UNKNOWN'; unknown.push('owner-resolve-failed'); result = 'DATA_INCOMPLETE'; }
  } else { checks.owner_classification = 'UNKNOWN'; unknown.push('largest-accounts-unavailable'); result = 'DATA_INCOMPLETE'; }

  // Market data (Solana pair only, no silent fallback) + freshness derived from the evidence receipt time
  const ageS = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? (Date.now() - t) / 1000 : null; };
  const pairs = await dex.tokenPairs(mint).catch(() => null);
  let liq = null, price = null;
  const p = pairs?.data?.length ? pairs.data.find(x => x.chainId === 'solana') : null;
  if (p) {
    evidenceIds.push(pairs.evidenceId);
    liq = p.liquidity?.usd ?? null; price = p.priceUsd ?? null;
    const mAge = ageS(pairs.receivedAt);
    if (mAge != null && mAge <= Number(cfg.validation.market_fresh_seconds)) checks.market_fresh = 'PASS';
    else { checks.market_fresh = 'UNKNOWN'; unknown.push('market-stale'); if (result === 'QUALIFIED') result = 'DATA_INCOMPLETE'; }
    checks.liquidity = liq != null && Number(liq) >= Number(cfg.validation.min_liquidity_usd) ? 'PASS' : (liq == null ? 'UNKNOWN' : 'FAIL');
    if (checks.liquidity === 'UNKNOWN') { unknown.push('liquidity-missing'); result = 'DATA_INCOMPLETE'; }
  } else if (pairs?.data?.length) { checks.liquidity = 'UNKNOWN'; checks.market_fresh = 'UNKNOWN'; unknown.push('solana-pair-missing'); result = 'DATA_INCOMPLETE'; }
  else { checks.liquidity = 'UNKNOWN'; checks.market_fresh = 'UNKNOWN'; unknown.push('market-data-missing'); result = 'DATA_INCOMPLETE'; }

  // Sellability: price impact on a POSITION-SIZED sell quote is the gate (real exit is ~$20-30).
  // A full-supply route probe is secondary INFO only and never decides the result.
  if (result === 'QUALIFIED' || result === 'DATA_INCOMPLETE') {
    try {
      if (!(price != null && Number(price) > 0)) throw new Error('no-price-for-probe');
      const units = usdToRawUnits(cfg.position_budget_usd, String(price), dec.decimals);
      if (units <= 0n) throw new Error('zero-probe-units');
      const q = await jupiter.sellQuote(mint, units.toString());
      evidenceIds.push(q.evidenceId);
      const qAge = ageS(q.receivedAt);
      const impact = Math.abs(Number(q.quote?.priceImpactPct));
      checks.sell_impact_probe_usd = String(cfg.position_budget_usd);
      if (qAge == null || qAge > Number(cfg.validation.quote_fresh_seconds)) { checks.sellability = 'UNKNOWN'; unknown.push('quote-stale'); if (result === 'QUALIFIED') result = 'DATA_INCOMPLETE'; }
      else if (!Number.isFinite(impact)) { checks.sellability = 'UNKNOWN'; unknown.push('price-impact-missing'); if (result === 'QUALIFIED') result = 'DATA_INCOMPLETE'; }
      else { checks.sell_impact = String(impact); checks.sellability = impact <= Number(cfg.validation.max_impact) ? 'PASS' : 'FAIL'; }
    } catch { checks.sellability = 'UNKNOWN'; unknown.push('sell-quote-unavailable'); if (result === 'QUALIFIED') result = 'DATA_INCOMPLETE'; }
    try { const f = await jupiter.sellQuote(mint, dec.supply); evidenceIds.push(f.evidenceId); checks.full_supply_route_info = 'ROUTE_OK'; }
    catch { checks.full_supply_route_info = 'ROUTE_UNAVAILABLE'; } // informational only: not evidence of unsellability at our size
  }
  // Any definitive FAIL (authority, extension, concentration, liquidity, sellability) rejects the token; direct check assignments above do not set result themselves.
  if (Object.values(checks).includes('FAIL')) result = 'REJECTED';
  return finish(db, mint, checks, evidenceIds, unknown, result, { liquidity: liq, price, decimals: dec.decimals });
}

function finish(db, mint, checks, evidenceIds, unknown, result, extra = {}) {
  const id = uuid();
  db.prepare(`INSERT INTO risk_assessments (id, mint, assessed_at, rule_version, result, checks_json, evidence_ids_json, unknown_fields_json)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, mint, nowIso(), 'risk-v1', result, JSON.stringify(checks), JSON.stringify(evidenceIds), JSON.stringify(unknown));
  return { id, result, checks, unknown, ...extra };
}
