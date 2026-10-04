// Helius Enhanced Transactions (parsed swaps). Config-gated: inert without HELIUS_API_KEY.
// The API key is sent only in the request URL and is NEVER written to evidence, logs or errors.
import { Quota } from '../rpc.js';
import { recordObservation } from '../evidence.js';

const BASE = 'https://api.helius.xyz';
export class Helius {
  constructor({ db, apiKey = process.env.HELIUS_API_KEY, quota = new Quota(20, 60_000), fetchImpl = fetch, monthlyCap = null, now = () => new Date() } = {}) {
    this.monthlyCap = monthlyCap; this.now = now; this.db = db; this.apiKey = apiKey; this.quota = quota; this.fetch = fetchImpl;
  }
  get enabled() { return Boolean(this.apiKey); }
  // Persistent monthly credit counter (UTC month). Charged when a request is made, so failed calls still count (conservative).
  monthKey() { return this.now().toISOString().slice(0, 7); }
  creditsUsed() { return this.db.prepare('SELECT credits FROM helius_usage WHERE month=?').get(this.monthKey())?.credits ?? 0; }
  capReached() { return this.monthlyCap != null && this.creditsUsed() >= Number(this.monthlyCap); }
  charge(n) { this.db.prepare('INSERT INTO helius_usage (month, credits) VALUES (?,?) ON CONFLICT(month) DO UPDATE SET credits = credits + excluded.credits').run(this.monthKey(), n); this.credits = (this.credits ?? 0) + n; }
  // True exactly once per month, the first time the cap blocks a call (drives the single warning card).
  markCapNotified() { const r = this.db.prepare('UPDATE helius_usage SET cap_notified=1 WHERE month=? AND cap_notified=0').run(this.monthKey()); return r.changes > 0; }
  guard(cost) { if (this.capReached() || (this.monthlyCap != null && this.creditsUsed() + cost > Number(this.monthlyCap))) throw new Error('helius-credit-cap'); this.charge(cost); }
  // Parsed SWAPs touching `mint` since `sinceSec` (unix seconds, block time). Newest first.
  async swapsSince(mint, sinceSec, { limit = 100, timeoutMs = 4000 } = {}) {
    if (!this.enabled) throw new Error('helius-disabled');
    this.guard(100); // Enhanced Transactions API = 100 credits per request
    await this.quota.take();
    const requestedAt = new Date().toISOString();
    const redacted = `/v0/addresses/${mint}/transactions?type=SWAP&gte-time=${sinceSec}&commitment=confirmed&limit=${limit}`;
    let res, j;
    try {
      res = await this.fetch(`${BASE}${redacted}&api-key=${encodeURIComponent(this.apiKey)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      j = await res.json().catch(() => null);
    } catch (e) {
      recordObservation(this.db, { provider: BASE, method: 'GET ' + redacted, subject: mint, requestedAt, status: 'ERROR', error: (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'TIMEOUT' : 'FETCH_FAILED' });
      throw new Error('helius ' + ((e.name === 'TimeoutError' || e.name === 'AbortError') ? 'TIMEOUT' : 'FETCH_FAILED'));
    }
    const evidenceId = recordObservation(this.db, { provider: BASE, method: 'GET ' + redacted, subject: mint, requestedAt, body: Array.isArray(j) ? j.map(x => ({ signature: x.signature, timestamp: x.timestamp, slot: x.slot, source: x.source, type: x.type })) : j, httpStatus: res.status, status: res.ok ? 'OK' : 'ERROR' });
    if (!res.ok || !Array.isArray(j)) throw new Error('helius ' + res.status);
    return { swaps: j, evidenceId, receivedAt: new Date().toISOString() };
  }
}

// Lead discovery: distinct non-SOL mints touched by the latest successful txs of a program (Pump.fun curve, PumpSwap AMM).
// JSON-RPC getTransactionsForAddress, 10 credits per 100 full transactions (Helius billing docs), counted per call in `credits`.
export const WSOL = 'So11111111111111111111111111111111111111112';
export const LEAD_PROGRAMS = { PUMP_FUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', PUMP_AMM: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' };
export function mintsFromTxs(txs) {
  const c = new Map();
  for (const t of txs) {
    if (!t?.meta || t.meta.err) continue;
    const ms = new Set([...(t.meta.preTokenBalances ?? []), ...(t.meta.postTokenBalances ?? [])].map(b => b.mint).filter(m => m && m !== WSOL));
    for (const m of ms) c.set(m, (c.get(m) ?? 0) + 1);
  }
  return c;
}
Helius.prototype.activeMints = async function (program, { limit = 100, timeoutMs = 8000 } = {}) {
  if (!this.enabled) throw new Error('helius-disabled');
  this.guard(Math.max(10, Math.ceil(limit / 100) * 10)); // getTransactionsForAddress = 10 credits per 100 full txs
  await this.quota.take();
  const requestedAt = new Date().toISOString();
  const method = `POST getTransactionsForAddress ${program} limit=${limit}`;
  let res, j;
  try {
    res = await this.fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(this.apiKey)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransactionsForAddress', params: [program, { transactionDetails: 'full', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, limit, commitment: 'confirmed', sortOrder: 'desc' }] }) });
    j = await res.json().catch(() => null);
  } catch (e) {
    const code = (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'TIMEOUT' : 'FETCH_FAILED';
    recordObservation(this.db, { provider: 'helius-rpc', method, subject: program, requestedAt, status: 'ERROR', error: code });
    throw new Error('helius ' + code);
  }
  const data = j?.result?.data;
  const evidenceId = recordObservation(this.db, { provider: 'helius-rpc', method, subject: program, requestedAt, body: Array.isArray(data) ? { txs: data.length, newest_blockTime: data[0]?.blockTime ?? null } : { error: j?.error?.message ?? null }, httpStatus: res.status, status: res.ok && Array.isArray(data) ? 'OK' : 'ERROR' });
  if (!res.ok || !Array.isArray(data)) throw new Error('helius-rpc ' + res.status);
  return { mints: mintsFromTxs(data), txs: data.length, evidenceId, receivedAt: new Date().toISOString() };
};

// Exact on-chain block time (ms) of the earliest parsed swap inside the window, or null if none.
export function firstSwapMs(swaps, windowStartSec) {
  const ts = swaps.filter(s => Number.isFinite(s.timestamp) && s.timestamp >= windowStartSec && !s.transactionError).map(s => s.timestamp);
  return ts.length ? Math.min(...ts) * 1000 : null;
}

// Generic guarded read-only JSON-RPC (Helius). Cost is charged against the monthly cap BEFORE the call.
// Costs are conservative estimates from the Helius billing page (standard RPC 1, DAS and history 10); UNVERIFIED per method until the dashboard Usage page is read.
export const RPC_COST = { getAsset: 10, getTokenLargestAccounts: 10, getTokenAccountsByOwner: 10, getMultipleAccounts: 1, getBalance: 1, getTransactionsForAddress: 10 };
Helius.prototype.rpc = async function (method, params, { timeoutMs = 8000, cost = RPC_COST[method] ?? 10 } = {}) {
  if (!this.enabled) throw new Error('helius-disabled');
  this.guard(cost);
  await this.quota.take();
  const requestedAt = new Date().toISOString();
  let res, j;
  try {
    res = await this.fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(this.apiKey)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    j = await res.json().catch(() => null);
  } catch (e) { throw new Error('helius ' + ((e.name === 'TimeoutError' || e.name === 'AbortError') ? 'TIMEOUT' : 'FETCH_FAILED')); }
  if (!res.ok || j?.error || j?.result === undefined) throw new Error('helius-rpc ' + (j?.error?.message ?? res.status).toString().slice(0, 80));
  recordObservation(this.db, { provider: 'helius-rpc', method: `POST ${method}`, subject: String(Array.isArray(params) ? params[0] : params?.id ?? '').slice(0, 60), requestedAt, body: { ok: true }, httpStatus: res.status, status: 'OK' });
  return j.result;
};
