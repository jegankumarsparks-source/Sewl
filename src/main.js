import { momentumCycle } from './momentum.js';
import { startApp } from './app.js';
import { readFileSync, existsSync } from 'node:fs';
import { openDb, withTx, nowIso, uuid } from './db.js';
import { Rpc, Quota } from './rpc.js';
import { Dexscreener } from './sources/dexscreener.js';
import { Jupiter } from './sources/jupiter.js';
import { CoinGecko } from './sources/coingecko.js';
import { Outbox } from './telegram.js';
import { reconstructHistory, evaluateWallet } from './wallets.js';
import { detectBuys } from './detection.js';
import { processBuy } from './signal.js';
import { markAndExitCycle, getExperiment } from './paper.js';

const cfg = JSON.parse(readFileSync('config/experiment.json', 'utf8'));
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}
const db = openDb('var/sewl.sqlite');
const outbox = new Outbox(db);
const keyless = !process.env.HELIUS_API_KEY;
const endpoint = keyless ? 'https://api.mainnet.solana.com'
  : `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const rpc = new Rpc({ endpoint, quota: new Quota(keyless ? 30 : 50, 10_000), db });
const dex = new Dexscreener({ db });
const jupiter = new Jupiter({ db });
const coingecko = new CoinGecko({ db });
const deps = { cfg, rpc, dex, jupiter, coingecko, outbox };

function health(component, severity, code, detail) {
  db.prepare(`INSERT INTO health_events (id, component, at, severity, code, detail_json) VALUES (?,?,?,?,?,?)`)
    .run(uuid(), component, nowIso(), severity, code, JSON.stringify(detail).slice(0, 500));
}

async function discoverCycle() {
  const q = db.prepare(`SELECT COUNT(*) c FROM wallets WHERE status='QUALIFIED'`).get().c;
  if (q >= cfg.discovery.max_qualified_wallets) return { skipped: 'enough-qualified' };
  // Promotional leads only; retained failures and flat tokens matter (survivorship control).
  const leads = new Set();
  for (const fn of ['latestBoosts', 'latestProfiles']) {
    try { (await dex[fn]()).data?.filter(x => x.chainId === 'solana').forEach(x => leads.add(x.tokenAddress)); }
    catch (e) { health('discovery', 'WARN', fn + '-failed', { e: String(e) }); }
  }
  const candidates = new Map(); // wallet -> firstSeenMint
  let sampled = 0;
  for (const mint of [...leads].slice(0, cfg.discovery.pairs_per_cycle * 3)) {
    if (sampled >= cfg.discovery.pairs_per_cycle) break;
    let pairs;
    try { pairs = (await dex.tokenPairs(mint)).data; } catch { continue; }
    const p = (pairs ?? []).find(x => x.chainId === 'solana');
    if (!p?.pairAddress) continue;
    const ageMin = p.pairCreatedAtMs ? (Date.now() - p.pairCreatedAtMs) / 60_000 : null;
    if (ageMin == null || ageMin > cfg.discovery.early_window_minutes) continue;
    sampled++;
    try {
      const { result: sigs } = await rpc.getSignaturesForAddress(p.pairAddress, { limit: cfg.discovery.early_swap_sample });
      for (const s of (sigs ?? []).slice(0, cfg.discovery.early_swap_sample)) {
        if (s.err) continue;
        try {
          const { result: tx } = await rpc.getTransaction(s.signature);
          if (!tx) continue;
          const { parseSwap } = await import('./parser.js');
          const parsed = parseSwap(tx);
          for (const t of parsed.trades.slice(0, 2)) if (!candidates.has(t.owner)) candidates.set(t.owner, t.mint);
        } catch { }
      }
    } catch (e) { health('discovery', 'WARN', 'pool-tx-failed', { e: String(e).slice(0, 120) }); }
  }
  let newWallets = 0;
  for (const [addr] of candidates) {
    if (newWallets >= cfg.discovery.new_candidates_per_day) break;
    if (db.prepare(`SELECT 1 FROM wallets WHERE address=?`).get(addr)) continue;
    db.prepare(`INSERT INTO wallets (address, discovered_at, discovery_method, status) VALUES (?,?,'prospective-cohort', 'HISTORY_PENDING')`).run(addr, nowIso());
    newWallets++;
  }
  return { leads: leads.size, sampledPools: sampled, newWallets };
}

async function historyCycle() {
  const pending = db.prepare(`SELECT address FROM wallets WHERE status IN ('HISTORY_PENDING','DISCOVERED') LIMIT 3`).all();
  for (const { address } of pending) {
    try {
      await reconstructHistory(db, rpc, coingecko, address, { txCap: cfg.discovery.wallet_history_tx_cap });
      const r = evaluateWallet(db, address, cfg);
      health('quality', 'INFO', 'wallet-evaluated', { address: address.slice(0, 8), status: r.status, score: r.score });
    } catch (e) { health('history', 'ERROR', 'reconstruct-failed', { address: address.slice(0, 8), e: String(e).slice(0, 150) }); }
  }
}

async function watchCycle() {
  const wallets = db.prepare(`SELECT address FROM wallets WHERE status='QUALIFIED' LIMIT 12`).all();
  for (const { address } of wallets) {
    let before;
    const cur = db.prepare(`SELECT last_signature s FROM wallet_cursors WHERE wallet_address=?`).get(address);
    if (cur?.s) before = cur.s;
    let sigs;
    try { sigs = (await rpc.getSignaturesForAddress(address, before ? { before, limit: 20 } : { limit: 20 })).result ?? []; }
    catch (e) { health('watch', 'WARN', 'sig-fetch-failed', { e: String(e).slice(0, 120) }); continue; }
    for (const s of sigs.slice(0, 5)) {
      if (s.err) continue;
      try {
        const { result: tx } = await rpc.getTransaction(s.signature);
        if (!tx) { db.prepare(`INSERT OR IGNORE INTO transactions (signature, parse_state) VALUES (?, 'NULL_RESPONSE')`).run(s.signature); continue; }
        const buys = await detectBuys(db, rpc, coingecko, address, tx, s.signature, cfg);
        for (const b of buys) await processBuy(db, deps, b);
      } catch (e) { health('watch', 'ERROR', 'tx-process-failed', { e: String(e).slice(0, 150) }); }
    }
    if (sigs.length) db.prepare(`INSERT INTO wallet_cursors (wallet_address, last_signature, last_success_at) VALUES (?,?,?)
      ON CONFLICT(wallet_address) DO UPDATE SET last_signature=excluded.last_signature, last_success_at=excluded.last_success_at`)
      .run(address, sigs[0].signature, nowIso());
  }
}

async function markCycle() {
  await markAndExitCycle(db, deps);
}

async function digestCycle() {
  const exp = getExperiment(db);
  const e = await markCycle();
  const open = db.prepare(`SELECT COUNT(*) c FROM paper_positions WHERE state='OPEN'`).get().c;
  const realizedRow = db.prepare(`SELECT
    COALESCE((SELECT balance_usd FROM accounts WHERE name='realized_gain'),'0') g,
    COALESCE((SELECT balance_usd FROM accounts WHERE name='realized_loss'),'0') l`).get();
  const realized = (Number(realizedRow.g) - Number(realizedRow.l)).toFixed(6);
  outbox.enqueue('digest', { cash: (Number(e.cash) / 1e6).toFixed(2), realized, equity: e.equity == null ? null : (Number(e.equity) / 1e6).toFixed(2), open, state: exp.state, at: nowIso() });
}

const mode = process.argv[2] ?? 'run';
if (mode === 'discover') { console.log(await discoverCycle()); process.exit(0); }
if (mode === 'watch') { await watchCycle(); console.log('watch cycle done'); process.exit(0); }
if (mode === 'mark') { await markCycle(); console.log('mark cycle done'); process.exit(0); }
if (mode === 'flush') { console.log(await outbox.flush(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID)); process.exit(0); }
if (mode === 'once') { console.log(await discoverCycle()); await historyCycle(); await watchCycle(); await digestCycle(); console.log(await outbox.flush(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID)); process.exit(0); }

health('worker', 'INFO', 'startup', { version: JSON.parse(readFileSync('package.json', 'utf8')).version + '+momentum-v1', keyless, mode: process.argv[2] ?? 'run', pid: process.pid });
console.log('SEWL worker starting. mode=run keyless=' + keyless);
console.log('PAPER TRADING ONLY. $' + cfg.starting_cash_usd + ' -> target $' + cfg.target_equity_usd + ' (latch, not a promise).');
let stopped = false;
const lastDone = new Map(); const loopEvery = new Map(); const stallWarned = new Map();
async function loop(name, seconds, fn) {
  loopEvery.set(name, seconds); lastDone.set(name, Date.now());
  while (!stopped) {
    try { await fn(); lastDone.set(name, Date.now()); } catch (e) { health(name, 'ERROR', 'cycle-crash', { e: String(e).slice(0, 200) }); }
    await new Promise(r => setTimeout(r, seconds * 1000));
  }
}
loop('momentum', cfg.momentum?.cycle_seconds ?? 60, async () => { if (!cfg.momentum?.enabled) return; const r = await momentumCycle(db, deps); health('momentum', 'INFO', 'momentum-cycle', r); });
try { const srv = startApp(cfg); if (srv) health('worker', 'INFO', 'app-listening', { host: process.env.SEWL_APP_HOST ?? cfg.app.host, port: process.env.SEWL_APP_PORT ?? cfg.app.port }); } catch (e) { health('worker', 'WARN', 'app-start-failed', { e: String(e).slice(0, 150) }); }
loop('discovery', cfg.discovery_cadence_minutes * 60, discoverCycle);
loop('history', 300, historyCycle);
loop('watch', cfg.poll_seconds, watchCycle);
loop('mark', cfg.mark_seconds, markCycle);
loop('outbox', cfg.outbox_flush_seconds, () => outbox.flush(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID));
setInterval(() => { // stall heartbeat: catches hangs, not just crashes
  for (const [name, every] of loopEvery) {
    const age = Date.now() - lastDone.get(name);
    if (age > 3 * every * 1000 && Date.now() - (stallWarned.get(name) ?? 0) > 3 * every * 1000) {
      stallWarned.set(name, Date.now());
      try { health(name, 'WARN', 'loop-stalled', { last_done_age_s: Math.round(age / 1000), interval_s: every }); } catch {}
    }
  }
}, 60_000).unref();
setInterval(digestCycle, 24 * 3600 * 1000).unref();
process.on('SIGINT', () => { stopped = true; console.log('stopping gracefully'); setTimeout(() => process.exit(0), 500); });
