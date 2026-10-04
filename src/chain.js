// Read-only on-chain data service for the app: coins, wallets, creators. REAL on-chain data only.
// Anything estimated is labelled as such; anything not derivable is null. No signing, no writes to chain.
import { parseSwap, PROGRAM_IDS } from './parser.js';

const SOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const HIST = { encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 1, commitment: 'confirmed' };
const lam = (x) => Number(x) / 1e9;
const isMint = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
export const validAddress = isMint;
import { decodeMint, EXTENSION_ALLOWLIST } from './validation.js';
// ids sequential from the official spl token-2022 ExtensionType enum (checked against mod.rs); plain-words meaning
const EXT_WORDS = ['uninitialized', 'transfer fee: a cut of every transfer can be taken', 'transfer fee amount (account side)', 'mint close authority: the mint can be closed', 'confidential transfers (hidden amounts)', 'confidential transfer account', 'default account state: new accounts may start frozen', 'immutable owner', 'memo required on transfer', 'non-transferable: cannot be moved', 'interest-bearing: displayed balance drifts', 'CPI guard', 'permanent delegate: someone can move or burn ANY holder tokens', 'non-transferable account', 'transfer hook: custom program runs on every transfer', 'transfer hook account', 'confidential transfer fee config', 'confidential transfer fee amount', 'metadata pointer (harmless)', 'token metadata (harmless)', 'group pointer', 'token group', 'group member pointer', 'token group member', 'confidential mint/burn', 'scaled UI amount: displayed balance is scaled', 'pausable: transfers can be paused', 'pausable account', 'permissioned burn'];
export function auditMint(acct) {
  if (!acct) return null; const d = decodeMint(acct); if (!d.ok) return { ok: false, error: d.error };
  return { ok: true, mint_authority: d.mintAuth, freeze_authority: d.freeze, mint_authority_revoked: d.mintAuth == null, freeze_authority_revoked: d.freeze == null,
    extensions: d.extensions.map(e => ({ type: e.type, meaning: EXT_WORDS[e.type] ?? 'unknown extension (treated as unsafe)', allowed: e.type in EXTENSION_ALLOWLIST })), token_2022: d.extensions.length > 0 || null, source: 'ON-CHAIN: mint account via RPC' };
}

// Trades of ONE wallet from raw txs (owner-delta parser). Only SOL-quoted trades are used for P&L; the rest are counted, not guessed.
export function walletTrades(txs, wallet) {
  const out = []; let skippedNonSol = 0, parsed = 0;
  for (const tx of txs) {
    if (!tx?.meta || tx.meta.err) continue;
    const p = parseSwap(tx); parsed++;
    for (const t of p.trades) if (t.owner === wallet) {
      if (t.quoteMint !== SOL) { skippedNonSol++; continue; }
      out.push({ signature: tx.transaction.signatures?.[0] ?? null, time: tx.blockTime ?? null, slot: tx.slot ?? null, venue: p.venue, mint: t.mint, side: t.side, token_raw: t.tokenAmountRaw, sol: lam(t.quoteAmountRaw) });
    }
  }
  return { trades: out.sort((a, b) => (a.time ?? 0) - (b.time ?? 0)), skippedNonSol, parsed };
}

// Per-mint FIFO realized P&L in SOL (fees excluded). realized_multiple = proceeds / cost of the SOLD part. ESTIMATED: partial history, no fees, no priced remainder.
export function fifoPnl(trades) {
  const by = new Map();
  for (const t of trades) { if (!by.has(t.mint)) by.set(t.mint, []); by.get(t.mint).push(t); }
  const coins = [];
  for (const [mint, ts] of by) {
    const lots = []; let realizedCost = 0, proceeds = 0, bought = 0, sold = 0, buys = 0, sells = 0, firstBuy = null, lastSell = null, lastTrade = null, soldUnmatched = 0n;
    for (const t of ts) {
      lastTrade = t.time;
      const amt = BigInt(t.token_raw);
      if (t.side === 'BUY') { buys++; bought += t.sol; lots.push({ amt, cost: t.sol, left: amt }); if (firstBuy == null) firstBuy = t.time; }
      else {
        sells++; sold += t.sol; proceeds += t.sol; lastSell = t.time; let need = amt;
        for (const l of lots) { if (need <= 0n) break; if (l.left <= 0n) continue; const take = l.left < need ? l.left : need; realizedCost += l.cost * Number(take) / Number(l.amt); l.left -= take; need -= take; }
        if (need > 0n) soldUnmatched += need; // sold tokens whose buy is outside the fetched history
      }
    }
    const heldRaw = lots.reduce((a, l) => a + l.left, 0n);
    const matched = soldUnmatched === 0n;
    coins.push({ mint, buys, sells, bought_sol: +bought.toFixed(6), sold_sol: +sold.toFixed(6), realized_cost_sol: +realizedCost.toFixed(6),
      realized_pnl_sol: matched && sells ? +(proceeds - realizedCost).toFixed(6) : null,
      realized_multiple: matched && sells && realizedCost > 0 ? +(proceeds / realizedCost).toFixed(3) : null,
      open_cost_sol: +lots.reduce((a, l) => a + (l.amt > 0n ? l.cost * Number(l.left) / Number(l.amt) : 0), 0).toFixed(6),
      held_raw_from_history: heldRaw.toString(), first_buy: firstBuy, last_sell: lastSell, last_trade: lastTrade, history_incomplete: !matched });
  }
  const done = coins.filter(c => c.realized_multiple != null);
  return { coins: coins.sort((a, b) => (b.last_trade ?? 0) - (a.last_trade ?? 0)),
    summary: { coins_traded: coins.length, coins_with_realized_sells: done.length, hit_1_5x: done.filter(c => c.realized_multiple >= 1.5).length, hit_2x: done.filter(c => c.realized_multiple >= 2).length,
      realized_pnl_sol: +done.reduce((a, c) => a + c.realized_pnl_sol, 0).toFixed(6), coins_history_incomplete: coins.filter(c => c.history_incomplete).length,
      label: 'ESTIMATED: SOL-quoted swaps in the fetched history only, FIFO, fees excluded, 1.5x/2x = realized proceeds / cost of the sold part.' } };
}

export function creatorOf(txAsc) { const t = txAsc?.[0]; if (!t) return null; return { creator: t.transaction.message.accountKeys[0]?.pubkey ?? null, created_at: t.blockTime ?? null, signature: t.transaction.signatures?.[0] ?? null,
  is_create: (t.meta?.logMessages ?? []).some(l => /Instruction: Create/.test(l)) }; }

// Mints created by a wallet within its fetched history (pump.fun Create / CreateV2 logs, mint = first non-wSOL mint in the creator's token balances of that tx).
export function createdMints(txs, wallet) {
  const out = [];
  for (const t of txs) {
    if (!t?.meta || t.meta.err) continue;
    if (t.transaction.message.accountKeys[0]?.pubkey !== wallet) continue;
    const prog = (t.transaction.message.instructions ?? []).some(i => i.programId === PROGRAM_IDS.PUMP_FUN);
    if (!prog || !(t.meta.logMessages ?? []).some(l => /Instruction: Create(V2)?$/.test(l))) continue;
    const mint = (t.meta.postTokenBalances ?? []).find(b => b.mint !== SOL)?.mint ?? null;
    if (mint) out.push({ mint, created_at: t.blockTime ?? null, signature: t.transaction.signatures?.[0] ?? null });
  }
  return out;
}

export class Chain {
  constructor({ helius, dex, now = () => Date.now(), maxPerMinute = 30 }) { this.h = helius; this.dex = dex; this.now = now; this.cache = new Map(); this.calls = []; this.maxPerMinute = maxPerMinute; }
  async cached(key, ttlMs, fn) {
    const hit = this.cache.get(key); if (hit && this.now() - hit.at < ttlMs) return { ...hit.v, cached: true };
    const t = this.now(); this.calls = this.calls.filter(x => t - x < 60_000);
    if (this.calls.length >= this.maxPerMinute) throw new Error('rate-limited');
    this.calls.push(t);
    const v = await fn(); this.cache.set(key, { at: this.now(), v }); return { ...v, cached: false };
  }
  hist(addr, limit = 100, sortOrder = 'desc') { return this.h.rpc('getTransactionsForAddress', [addr, { ...HIST, limit, sortOrder }]).then(r => r.data ?? []); }

  async coin(mint) {
    if (!isMint(mint)) throw new Error('bad-address');
    return this.cached('coin:' + mint, 20_000, async () => {
      const [pairsRes, asset, txs, first, largest, acct] = await Promise.all([
        this.dex.tokensBatch([mint]).catch(() => null),
        this.cached('asset:' + mint, 3600_000, async () => ({ a: await this.h.rpc('getAsset', { id: mint }).catch(() => null) })),
        this.hist(mint, 100, 'desc').catch(() => []),
        this.cached('create:' + mint, 86_400_000, async () => ({ c: creatorOf(await this.hist(mint, 1, 'asc').catch(() => [])) })),
        this.h.rpc('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]).catch(() => null),
        this.h.rpc('getAccountInfo', [mint, { encoding: 'base64' }], { cost: 1 }).catch(() => null),
      ]);
      const pairs = (pairsRes?.data ?? []).filter(p => p.chainId === 'solana'); const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null;
      const a = asset.a; const supplyRaw = a?.token_info?.supply ?? null; const dec = a?.token_info?.decimals ?? null;
      const trades = []; for (const tx of txs) { if (!tx?.meta || tx.meta.err) continue; const p = parseSwap(tx); for (const t of p.trades) if (t.mint === mint && t.quoteMint === SOL && p.venue !== 'UNKNOWN') trades.push({ time: tx.blockTime, signature: tx.transaction.signatures?.[0], wallet: t.owner, side: t.side, token_raw: t.tokenAmountRaw, sol: lam(t.quoteAmountRaw), venue: p.venue }); }
      let holders = null;
      if (largest?.value?.length && supplyRaw) {
        const top = largest.value.slice(0, 20); const infos = await this.h.rpc('getMultipleAccounts', [top.map(x => x.address), { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => null);
        holders = top.map((x, i) => { const info = infos?.value?.[i]?.data?.parsed?.info; return { token_account: x.address, owner: info?.owner ?? null, amount_raw: x.amount, pct_supply: +(Number(x.amount) / Number(supplyRaw) * 100).toFixed(3) }; });
      }
      return { mint, name: a?.content?.metadata?.name ?? best?.baseToken?.name ?? null, symbol: a?.content?.metadata?.symbol ?? best?.baseToken?.symbol ?? null, image: a?.content?.links?.image ?? null,
        decimals: dec, supply_raw: supplyRaw == null ? null : String(supplyRaw), token_program: a?.token_info?.token_program ?? null,
        market: best ? { source: 'DEXSCREENER', price_usd: best.priceUsd ?? null, change_5m: best.priceChange?.m5 ?? null, change_1h: best.priceChange?.h1 ?? null, change_6h: best.priceChange?.h6 ?? null, change_24h: best.priceChange?.h24 ?? null,
          volume_24h_usd: best.volume?.h24 ?? null, volume_1h_usd: best.volume?.h1 ?? null, liquidity_usd: best.liquidity?.usd ?? null, market_cap_usd: best.marketCap ?? null, fdv_usd: best.fdv ?? null, pair: best.pairAddress ?? null, dex: best.dexId ?? null, pool_created_ms: best.pairCreatedAt ?? null, txns_h1: best.txns?.h1 ?? null } : null,
        audit: auditMint(acct?.value), liquidity_note: 'Pool age and liquidity from DEX Screener. Sell-quote health is not re-checked in the app; see the signal gate checklist.',
        creator: first.c ? { ...first.c, source: 'ON-CHAIN: fee payer of the earliest transaction touching the mint' } : null,
        trades: trades.sort((a, b) => b.time - a.time).slice(0, 60), trades_note: 'Latest swaps touching this mint (SOL-quoted, supported venues), parsed from raw on-chain transactions.', holders, holders_note: holders ? 'Top token accounts from RPC; owner = wallet owning the account. Pool/curve accounts are included.' : null };
    });
  }

  async wallet(addr) {
    if (!isMint(addr)) throw new Error('bad-address');
    return this.cached('wallet:' + addr, 60_000, async () => {
      const [txs, bal, held] = await Promise.all([this.hist(addr, 100, 'desc'), this.h.rpc('getBalance', [addr]).catch(() => null),
        Promise.all(TOKEN_PROGRAMS.map(p => this.h.rpc('getTokenAccountsByOwner', [addr, { programId: p }, { encoding: 'jsonParsed' }]).catch(() => null)))]);
      const { trades, skippedNonSol, parsed } = walletTrades(txs, addr); const pnl = fifoPnl(trades);
      const holdings = held.flatMap(r => r?.value ?? []).map(x => { const i = x.account.data.parsed.info; return { mint: i.mint, amount: i.tokenAmount.uiAmountString, amount_raw: i.tokenAmount.amount, decimals: i.tokenAmount.decimals }; }).filter(h => h.amount_raw !== '0');
      const priced = new Map();
      for (let i = 0; i < Math.min(holdings.length, 60); i += 30) { const r = await this.dex.tokensBatch(holdings.slice(i, i + 30).map(h => h.mint)).catch(() => null); for (const p of r?.data ?? []) if (p.chainId === 'solana' && !priced.has(p.baseToken?.address)) priced.set(p.baseToken.address, p); }
      const hold = holdings.map(h => { const p = priced.get(h.mint); return { ...h, symbol: p?.baseToken?.symbol ?? null, price_usd: p?.priceUsd ?? null, est_value_usd: p?.priceUsd ? +(Number(h.amount) * Number(p.priceUsd)).toFixed(2) : null }; }).sort((a, b) => (b.est_value_usd ?? -1) - (a.est_value_usd ?? -1));
      const times = txs.map(t => t.blockTime).filter(Boolean);
      const created0 = createdMints(txs, addr); const cp = new Map();
      if (created0.length) { const r = await this.dex.tokensBatch(created0.slice(0, 30).map(c => c.mint)).catch(() => null); for (const p of r?.data ?? []) if (p.chainId === 'solana' && !cp.has(p.baseToken?.address)) cp.set(p.baseToken.address, p); }
      const created = created0.map(c => { const p = cp.get(c.mint); const liq = p?.liquidity?.usd ?? null; return { ...c, symbol: p?.baseToken?.symbol ?? null, liquidity_usd: liq, market_cap_usd: p?.marketCap ?? null, status: p == null ? 'NO_PAIR_FOUND' : liq != null && liq < 1000 ? 'DEAD_OR_RUGGED_HEURISTIC' : 'ACTIVE', status_note: 'HEURISTIC from DEX Screener liquidity (<$1000 or no pair); not proof of a rug.' }; });
      return { wallet: addr, sol_balance: bal?.value == null ? null : lam(bal.value), last_active: times.length ? Math.max(...times) : null, history_window: { txs: txs.length, oldest: times.length ? Math.min(...times) : null, newest: times.length ? Math.max(...times) : null, note: 'Most recent 100 transactions only; older activity is not included.' },
        holdings: hold, holdings_note: 'Token balances from RPC. Values are ESTIMATES at the DEX Screener price; unpriced coins show null.',
        coins: pnl.coins.slice(0, 80), pnl: pnl.summary, skipped_non_sol_trades: skippedNonSol, txs_parsed: parsed, created_coins: created, created_note: 'Pump.fun coins this wallet created within its latest 100 transactions only.' };
    });
  }
}
