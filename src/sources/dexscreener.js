import { Quota } from '../rpc.js';
import { recordObservation } from '../evidence.js';

const BASE = 'https://api.dexscreener.com';
export class Dexscreener {
  constructor({ db, quota = new Quota(25, 60_000) }) { this.db = db; this.quota = quota; }
  async get(path) {
    await this.quota.take();
    const requestedAt = new Date().toISOString();
    let res, j;
    try {
      res = await fetch(BASE + path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      j = await res.json().catch((e) => { if (e.name === 'TimeoutError' || e.name === 'AbortError') throw e; return null; });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        recordObservation(this.db, { provider: BASE, method: 'GET ' + path, requestedAt, status: 'ERROR', error: 'TIMEOUT' });
        throw new Error('dexscreener TIMEOUT');
      }
      throw e;
    }
    const evidenceId = recordObservation(this.db, { provider: BASE, method: 'GET ' + path, requestedAt, body: j, httpStatus: res.status, status: res.ok ? 'OK' : 'ERROR' });
    if (!res.ok) throw new Error('dexscreener ' + res.status);
    return { data: j, evidenceId };
  }
  tokenPairs(mints) { return this.get(`/token-pairs/v1/solana/${Array.isArray(mints) ? mints.slice(0, 30).join(',') : mints}`); }
  // batch: up to 30 token addresses in one call (the token-pairs endpoint takes ONE token)
  tokensBatch(mints) { return this.get(`/tokens/v1/solana/${mints.slice(0, 30).join(',')}`); }
  pair(pairAddress) { return this.get(`/latest/dex/pairs/solana/${pairAddress}`); }
  // Promotional leads only - NOT quality evidence.
  latestBoosts() { return this.get('/token-boosts/latest/v1'); }
  latestProfiles() { return this.get('/token-profiles/latest/v1'); }
}
