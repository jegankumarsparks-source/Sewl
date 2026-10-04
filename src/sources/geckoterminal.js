// GeckoTerminal public OHLCV (real DEX candles, no key). Free tier ~30 req/min: cached + capped here.
const TF = { '1m': ['minute', 1], '5m': ['minute', 5], '15m': ['minute', 15], '1h': ['hour', 1], '4h': ['hour', 4] };
export const TIMEFRAMES = Object.keys(TF);
export class GeckoTerminal {
  constructor({ fetchImpl = fetch, now = () => Date.now(), maxPerMinute = 20 } = {}) { this.fetch = fetchImpl; this.now = now; this.cache = new Map(); this.calls = []; this.max = maxPerMinute; }
  async ohlcv(pool, tf = '1m', limit = 120) {
    if (!TF[tf]) throw new Error('bad-timeframe');
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pool)) throw new Error('bad-pool');
    const key = `${pool}:${tf}`; const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < 15_000) return { ...hit.v, cached: true };
    const t = this.now(); this.calls = this.calls.filter(x => t - x < 60_000); if (this.calls.length >= this.max) throw new Error('rate-limited'); this.calls.push(t);
    const [unit, agg] = TF[tf];
    const res = await this.fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/${unit}?aggregate=${agg}&limit=${limit}`, { headers: { accept: 'application/json', 'user-agent': 'sewl-app/1' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('geckoterminal ' + res.status);
    const j = await res.json();
    const list = j?.data?.attributes?.ohlcv_list; if (!Array.isArray(list)) throw new Error('geckoterminal-bad-shape');
    const candles = list.map(([time, o, h, l, c, v]) => ({ time, o, h, l, c, v })).sort((a, b) => a.time - b.time);
    const v = { pool, tf, source: 'GECKOTERMINAL', unit: 'USD per token, volume in USD', candles }; this.cache.set(key, { at: this.now(), v }); return { ...v, cached: false };
  }
}
