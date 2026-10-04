// Helius Enhanced Transactions (parsed swaps). Config-gated: inert without HELIUS_API_KEY.
// The API key is sent only in the request URL and is NEVER written to evidence, logs or errors.
import { Quota } from '../rpc.js';
import { recordObservation } from '../evidence.js';

const BASE = 'https://api.helius.xyz';
export class Helius {
  constructor({ db, apiKey = process.env.HELIUS_API_KEY, quota = new Quota(20, 60_000), fetchImpl = fetch } = {}) {
    this.db = db; this.apiKey = apiKey; this.quota = quota; this.fetch = fetchImpl;
  }
  get enabled() { return Boolean(this.apiKey); }
  // Parsed SWAPs touching `mint` since `sinceSec` (unix seconds, block time). Newest first.
  async swapsSince(mint, sinceSec, { limit = 100, timeoutMs = 4000 } = {}) {
    if (!this.enabled) throw new Error('helius-disabled');
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

// Exact on-chain block time (ms) of the earliest parsed swap inside the window, or null if none.
export function firstSwapMs(swaps, windowStartSec) {
  const ts = swaps.filter(s => Number.isFinite(s.timestamp) && s.timestamp >= windowStartSec && !s.transactionError).map(s => s.timestamp);
  return ts.length ? Math.min(...ts) * 1000 : null;
}
