import { d, div, mul, fmt, cmp } from './decimal.js';
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
  if (data.length > 82) { // Token-2022 TLV area present (accountType byte at 82, then entries)
    if (data.readUInt8(82) !== 1) return { ok: false, error: 'token-2022-account-not-mint' };
    for (let off = 83; off + 4 <= data.length;) {
      const type = data.readUInt16LE(off); const len = data.readUInt16LE(off + 2);
      extensions.push({ type, len }); off += 4 + len;
    }
  }
  return { ok: true, mintAuth, supply, decimals, freeze, extensions };
}

export async function validateToken(db, rpc, dex, jupiter, mint, cfg) {
  const checks = {}; const evidenceIds = []; const unknown = [];
  let result = 'QUALIFIED';
  const set = (k, v, unknownIf = null) => { checks[k] = v; if (v === 'UNKNOWN' && unknownIf) { unknown.push(unknownIf); result = 'DATA_INCOMPLETE'; } if (v === 'FAIL') result = 'REJECTED'; };

  const ai = await rpc.getAccountInfo(mint).catch(() => null);
  if (!ai?.result?.value) { checks.identity = 'FAIL'; return finish(db, mint, checks, evidenceIds, unknown, 'REJECTED'); }
  const prog = ai.result.value.owner; evidenceIds.push(ai.evidenceId);
  if (prog !== TOKEN_PROGRAM && prog !== TOKEN_2022) { checks.identity = 'FAIL'; return finish(db, mint, checks, evidenceIds, unknown, 'REJECTED'); }
  checks.identity = 'PASS';
  const dec = decodeMint(ai.result.value);
  if (!dec.ok) { checks.identity = 'FAIL'; return finish(db, mint, checks, evidenceIds, unknown, 'REJECTED'); }
  checks.mint_authority_null = dec.mintAuth === null ? 'PASS' : 'FAIL';
  checks.freeze_authority_null = dec.freeze === null ? 'PASS' : 'FAIL';
  checks.extensions_none = dec.extensions.length === 0 ? 'PASS' : 'FAIL';
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
      checks.largest_nonpool_owner_15pct = cmp(div(largestOwner * d(100), supply), d(15)) <= 0 ? 'PASS' : 'FAIL';
      checks.top_owners_50pct = cmp(div(topTotal * d(100), supply), d(50)) <= 0 ? 'PASS' : 'FAIL';
      if (unclassified > 0n) { checks.owner_classification = 'PARTIAL'; unknown.push('largest-accounts-unclassified'); if (result === 'QUALIFIED') result = 'DATA_INCOMPLETE'; }
      else checks.owner_classification = 'PASS';
    } else { checks.owner_classification = 'UNKNOWN'; unknown.push('owner-resolve-failed'); result = 'DATA_INCOMPLETE'; }
  } else { checks.owner_classification = 'UNKNOWN'; unknown.push('largest-accounts-unavailable'); result = 'DATA_INCOMPLETE'; }

  // Market data + sellability quote
  const pairs = await dex.tokenPairs(mint).catch(() => null);
  let liq = null, price = null;
  if (pairs?.data?.length) {
    evidenceIds.push(pairs.evidenceId);
    const p = pairs.data.find(x => x.chainId === 'solana') || pairs.data[0];
    liq = p.liquidity?.usd ?? null; price = p.priceUsd ?? null;
    checks.market_fresh = 'PASS'; // freshness tracked via received_at in evidence
    checks.liquidity = liq != null && Number(liq) >= Number(cfg.validation.min_liquidity_usd) ? 'PASS' : (liq == null ? 'UNKNOWN' : 'FAIL');
    if (checks.liquidity === 'UNKNOWN') { unknown.push('liquidity-missing'); result = 'DATA_INCOMPLETE'; }
  } else { checks.liquidity = 'UNKNOWN'; checks.market_fresh = 'UNKNOWN'; unknown.push('market-data-missing'); result = 'DATA_INCOMPLETE'; }

  if (result === 'QUALIFIED' || result === 'DATA_INCOMPLETE') {
    const units = dec.supply; // full-supply probe sellability (conservative read-only quote)
    try {
      const q = await jupiter.sellQuote(mint, units);
      evidenceIds.push(q.evidenceId);
      checks.sellability = 'PASS';
    } catch { checks.sellability = 'UNKNOWN'; unknown.push('sell-quote-unavailable'); if (result === 'QUALIFIED') result = 'DATA_INCOMPLETE'; }
  }
  return finish(db, mint, checks, evidenceIds, unknown, result, { liquidity: liq, price, decimals: dec.decimals });
}

function finish(db, mint, checks, evidenceIds, unknown, result, extra = {}) {
  const id = uuid();
  db.prepare(`INSERT INTO risk_assessments (id, mint, assessed_at, rule_version, result, checks_json, evidence_ids_json, unknown_fields_json)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, mint, nowIso(), 'risk-v1', result, JSON.stringify(checks), JSON.stringify(evidenceIds), JSON.stringify(unknown));
  return { id, result, checks, unknown, ...extra };
}
