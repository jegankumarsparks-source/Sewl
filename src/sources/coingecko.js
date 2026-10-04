import { Quota } from '../rpc.js';
import { recordObservation } from '../evidence.js';

// Free historical SOL/USD for pricing SOL-quoted trades. Aggressively cached; rate limited.
export class CoinGecko {
  constructor({ db, quota = new Quota(5, 60_000) }) { this.db = db; this.quota = quota; this.cache = new Map(); }
  async solUsdRange(fromUnix, toUnix) {
    const key = `${Math.floor(fromUnix / 3600)}-${Math.floor(toUnix / 3600)}`;
    if (this.cache.has(key)) return this.cache.get(key);
    await this.quota.take();
    const requestedAt = new Date().toISOString();
    const url = `https://api.coingecko.com/api/v3/coins/solana/market_chart/range?vs_currency=usd&from=${fromUnix}&to=${toUnix}`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const j = await res.json().catch(() => null);
    recordObservation(this.db, { provider: 'coingecko', method: 'market_chart/range', subject: key, requestedAt, body: j, httpStatus: res.status, status: res.ok && j?.prices ? 'OK' : 'ERROR' });
    if (!res.ok || !j?.prices) throw new Error('coingecko ' + res.status);
    this.cache.set(key, j.prices);
    return j.prices;
  }
  async solUsdAt(unix) {
    const prices = await this.solUsdRange(unix - 7200, unix + 7200);
    let best = null, bd = Infinity;
    for (const [t, p] of prices) { const dd = Math.abs(t / 1000 - unix); if (dd < bd) { bd = dd; best = p; } }
    return best; // null if range empty
  }
}
