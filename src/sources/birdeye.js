import { Quota } from '../rpc.js';
import { recordObservation } from '../evidence.js';
const BASE = 'https://public-api.birdeye.so/defi';
// DexScreener-compatible adapter on Birdeye token_overview. Missing field = null = fail-closed.
export class Birdeye {
  constructor({ db, key = process.env.BIRDEYE_API_KEY, quota = new Quota(20, 60_000), perCycle = 15 }) {
    if (!key) throw new Error('BIRDEYE_API_KEY missing');
    this.db = db; this.key = key; this.quota = quota; this.perCycle = perCycle;
    db.exec(`CREATE TABLE IF NOT EXISTS birdeye_cache (mint TEXT PRIMARY KEY, created_ms INTEGER, fetched_at TEXT)`);
    this.cache = new Map();
  }
  async get(path, subject) {
    await this.quota.take();
    const requestedAt = new Date().toISOString();
    const res = await fetch(BASE + path, { headers: { 'X-API-KEY': this.key, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    const j = await res.json().catch(() => null);
    recordObservation(this.db, { provider: 'birdeye', method: 'GET ' + path.split('?')[0], subject, requestedAt, body: j, httpStatus: res.status, status: res.ok && j?.success ? 'OK' : 'ERROR' });
    if (!res.ok || !j?.success) throw new Error('birdeye ' + res.status);
    return { data: j.data, evidenceId: null };
  }
  async overview(mint) { return this.get(`/token_overview?address=${mint}`, mint); }
  async createdMs(mint) {
    if (this.cache.has(mint)) return this.cache.get(mint);
    const row = this.db.prepare(`SELECT created_ms FROM birdeye_cache WHERE mint=?`).get(mint);
    if (row) { this.cache.set(mint, row.created_ms); return row.created_ms; }
    let created = null;
    try { const r = await this.get(`/token_creation_info?address=${mint}`, mint); created = r.data?.blockUnixTime ? r.data.blockUnixTime * 1000 : null; } catch {}
    this.cache.set(mint, created);
    this.db.prepare(`INSERT OR REPLACE INTO birdeye_cache (mint, created_ms, fetched_at) VALUES (?,?,?)`).run(mint, created, new Date().toISOString());
    return created;
  }
  mapPair(mint, d, createdMs) {
    const num = (x) => (x == null || isNaN(Number(x)) ? null : Number(x));
    return { chainId: 'solana', dexId: 'birdeye', baseToken: { address: mint }, priceUsd: d.price != null ? String(d.price) : null,
      liquidity: { usd: num(d.liquidity) },
      priceChange: { m5: num(d.priceChange5mPercent), h1: num(d.priceChange1hPercent) },
      volume: { m5: num(d.v5mUSD), h1: num(d.v1hUSD) },
      pairCreatedAt: createdMs, txns: { m5: { buys: num(d.buy5m), sells: num(d.sell5m) } } };
  }
  async tokensBatch(mints) {
    const out = [];
    for (const mint of (mints ?? []).slice(0, this.perCycle)) {
      try { const o = await this.overview(mint); out.push(this.mapPair(mint, o.data, await this.createdMs(mint))); } catch {}
    }
    return { data: out };
  }
  async tokenPairs(mint) {
    const o = await this.overview(mint);
    return { data: [this.mapPair(mint, o.data, await this.createdMs(mint))] };
  }
  async trending() {
    const r = await this.get(`/token_trending?sort_by=rank&sort_type=asc`, 'trending');
    return { data: (r.data?.tokens ?? []).filter(t => t?.address).slice(0, 30).map(t => ({ chainId: 'solana', tokenAddress: t.address })) };
  }
  latestBoosts() { return this.trending(); }
  latestProfiles() { return this.trending(); }
}
