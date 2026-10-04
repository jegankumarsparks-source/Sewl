// Static snapshots for the public monitoring copy (GitHub Pages). PAPER ONLY, read-only, NO secrets.
// Public = snapshots only. The live /api/coin and /api/wallet proxies are never public (they spend Helius credits).
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { buildApi } from './app.js';
import { TIMEFRAMES } from './sources/geckoterminal.js';

// Token-shaped strings that must never be published. Mints/addresses (base58) are public data and are NOT matched.
export const SECRET_PATTERNS = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,       // UUID-style API keys (Helius)
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/,                                         // bot-token shape
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/,            // GitHub tokens
  /api[-_]?key\s*[=:]/i, /[?&](api-key|apikey|key|token)=/i, /\bBearer\s+[A-Za-z0-9._-]{12,}/i,
  /BEGIN [A-Z ]*PRIVATE KEY/, /\bsk-[A-Za-z0-9]{20,}/, /\b[0-9a-f]{40,}\b/i,  // long hex
  /x-access-token/i, /Authorization/i,
];
// Row ids (uuid) are public traceability handles, not credentials: values of keys named id / *_id are exempt from the UUID-shape rule only.
// The configured secret VALUES are still checked verbatim, so a real key under an id field is caught by the exact-match pass.
const ID_FIELD = /"[A-Za-z_]*id":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/gi;
export function findSecret(text, extra = []) {
  for (const s of extra) if (s && String(s).length >= 8 && text.includes(String(s))) return 'configured-secret-value';
  text = text.replace(ID_FIELD, '"id":"-"');
  for (const re of SECRET_PATTERNS) { const m = text.match(re); if (m) return String(re); }
  return null;
}

const MONTH_BUDGET = 120_000;       // Helius credits the snapshots may spend per month (of the 800k hard cap)
const COIN_TTL_MS = 90 * 60_000, WALLET_TTL_MS = 6 * 3600_000, MAX_COIN_FETCH = 2, MAX_WALLET_FETCH = 1, MAX_COINS = 6, MAX_WALLETS = 4;

export async function writeSnapshots({ db, cfg, state, chain = null, gecko = null, helius = null, dir = 'site/snap', now = () => Date.now(), sleep = (ms) => new Promise(r => setTimeout(r, ms)), secrets = [], log = () => {} }) {
  mkdirSync(dir, { recursive: true });
  const written = new Set(); const rejected = [];
  const put = (name, obj) => {
    const text = JSON.stringify(obj); const hit = findSecret(text, secrets);
    if (hit) { rejected.push({ name, pattern: hit }); return false; }   // fail closed: never publish a file that looks like it holds a secret
    writeFileSync(path.join(dir, name), text); written.add(name); return true;
  };
  const stamp = new Date(now()).toISOString();
  const api = buildApi(db, cfg);
  const wrap = (k, d) => ({ ...d, snapshot_at: stamp, snapshot_kind: k });
  const cap = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : arr);
  const dash = api.dashboard(); dash.recent_closed = cap(dash.recent_closed, 20); dash.equity_series = cap(dash.equity_series, 120);
  put('dashboard.json', wrap('dashboard', dash));
  const sig = api.signals(); sig.signals = cap(sig.signals, 30); put('signals.json', wrap('signals', sig));
  const mo = api.momentum(); mo.history = cap(mo.history, 30); put('momentum.json', wrap('momentum', mo));
  const wal = api.wallets(); wal.wallets = cap(wal.wallets, 30); put('wallets.json', wrap('wallets', wal));
  const h = api.health(); delete h.outbox; delete h.recent; h.stalls = cap(h.stalls, 10); h.summary = cap(h.summary, 30);
  const hel = helius?.creditsUsed ? { used: helius.creditsUsed(), cap: helius.monthlyCap ?? null } : null;
  put('health.json', wrap('health', { ...h, helius_credits: hel, process_uptime_s: null, note: 'Snapshot of the worker health. Uptime is not shown because the snapshot is a copy.' }));
  const markets = { source: 'worker scan (DEX Screener pairs for the current lead set)', at: state?.lastPairsAt ?? null, coins: cap(state?.lastPairs ?? [], 40) };
  put('markets.json', wrap('markets', markets));

  // ---- entities (pre-rendered drill-downs). Credit-budgeted: positions first, then the most liquid market coins.
  const posMints = (dash.open_positions ?? []).map(p => p.mint);
  const byLiq = [...(state?.lastPairs ?? [])].sort((a, b) => (Number(b.liquidity_usd) || 0) - (Number(a.liquidity_usd) || 0)).map(p => p.mint);
  const coins = [...new Set([...posMints, ...byLiq])].slice(0, MAX_COINS);
  const stFile = path.join(dir, '..', '.snap_state.json'); let st = {}; try { st = JSON.parse(readFileSync(stFile, 'utf8')); } catch { /* first run */ }
  const month = new Date(now()).toISOString().slice(0, 7); if (st.month !== month) st = { month, credits: 0 };
  const age = (f) => (existsSync(f) ? now() - statSync(f).mtimeMs : Infinity);
  const prior = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
  const spend = async (fn) => { const b = helius?.creditsUsed?.() ?? 0; try { return await fn(); } finally { st.credits += Math.max(0, (helius?.creditsUsed?.() ?? 0) - b); } };
  const detail = {}; let cf = 0;
  for (const m of coins) {
    const f = path.join(dir, `coin_${m}.json`); let d = prior(f);
    if (chain && (!d || age(f) >= COIN_TTL_MS) && cf < MAX_COIN_FETCH && st.credits < MONTH_BUDGET) {
      cf++; try { d = await spend(() => chain.coin(m)); d = { ...d, snapshot_at: stamp }; } catch (e) { log('coin-skip', m.slice(0, 6), String(e.message).slice(0, 60)); d = prior(f); }
    }
    if (d) { detail[m] = d; put(`coin_${m}.json`, d); }
  }
  const creators = [...new Set(Object.values(detail).map(d => d.creator?.creator).filter(Boolean))].slice(0, MAX_WALLETS); let wf = 0;
  for (const w of creators) {
    const f = path.join(dir, `wallet_${w}.json`); let d = prior(f);
    if (chain && (!d || age(f) >= WALLET_TTL_MS) && wf < MAX_WALLET_FETCH && st.credits < MONTH_BUDGET) {
      wf++; try { d = await spend(() => chain.wallet(w)); d = { ...d, snapshot_at: stamp }; } catch (e) { log('wallet-skip', String(e.message).slice(0, 60)); d = prior(f); }
    }
    if (d) put(`wallet_${w}.json`, d);
  }
  if (gecko) for (const m of Object.keys(detail)) {   // candles are free (no credits); throttled, 80 candles each
    const pool = detail[m].market?.pair; if (!pool) continue;
    for (const tf of TIMEFRAMES) {
      const name = `ohlcv_${pool}_${tf}.json`;
      try { const r = await gecko.ohlcv(pool, tf); put(name, { ...r, candles: r.candles.slice(-80), snapshot_at: stamp, cached: undefined }); if (!r.cached) await sleep(2100); }
      catch (e) { if (existsSync(path.join(dir, name))) written.add(name); }
    }
  }
  const entities = { coins: Object.keys(detail), wallets: creators.filter(w => written.has(`wallet_${w}.json`)) };
  put('manifest.json', { generated_at: stamp, interval_minutes: 10, entities, files: [...written].sort(), snapshot_helius_credits_this_month: st.credits, snapshot_helius_budget: MONTH_BUDGET,
    note: 'Monitoring copy. Data is a pre-baked snapshot at most ~10 minutes old (coin and wallet details refresh every 90 min / 6 h to save API credits; each file carries its own snapshot_at). PAPER ONLY.' });
  // remove snapshot files that are no longer selected (so Pages never serves stale entities)
  for (const f of readdirSync(dir)) if (f.endsWith('.json') && !written.has(f)) unlinkSync(path.join(dir, f));
  writeFileSync(stFile, JSON.stringify(st));
  return { written: [...written], rejected, entities, credits: st.credits };
}
