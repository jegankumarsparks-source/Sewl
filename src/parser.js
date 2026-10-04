// Owner-level swap detection via pre/post balance deltas (jsonParsed).
// Heuristic parser: unknown flows are NOT forced into swaps.
export const PROGRAM_IDS = {
  RAYDIUM_AMM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUQo2mHUpZWMkjyGPdQ',
  RAYDIUM_CPMM: 'CPMMoo8L3F4NbTegBCKVNubggq1KL5sz6V4EVRFQh5ej',
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  PUMP_FUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
};
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export function parseSwap(tx, parserVersion = 'owner-delta-v1') {
  if (!tx || !tx.meta) return { state: 'NO_META', trades: [] };
  if (tx.meta.err) return { state: 'FAILED', trades: [] };
  const msg = tx.transaction.message;
  const keys = msg.accountKeys.map(k => (typeof k === 'string' ? k : k.pubkey));
  const meta = tx.meta;
  const preN = {}, postN = {};
  keys.forEach((k, i) => { preN[k] = BigInt(meta.preBalances?.[i] ?? 0); postN[k] = BigInt(meta.postBalances?.[i] ?? 0); });
  const preT = {}, postT = {};
  const add = (m, e) => {
    const amt = e.uiTokenAmount?.amount; if (!amt) return;
    const owner = e.owner || keys[e.accountIndex];
    const key = owner + '|' + e.mint;
    m[key] = (m[key] || 0n) + BigInt(amt);
  };
  (meta.preTokenBalances || []).forEach(e => add(preT, e));
  (meta.postTokenBalances || []).forEach(e => add(postT, e));
  const progs = new Set();
  (msg.instructions || []).forEach(i => i.programId && progs.add(i.programId));
  (meta.innerInstructions || []).forEach(ii => (ii.instructions || []).forEach(i => i.programId && progs.add(i.programId)));
  let venue = 'UNKNOWN';
  for (const [name, id] of Object.entries(PROGRAM_IDS)) if (progs.has(id)) { venue = name; break; }
  const owners = new Set();
  for (const k of [...Object.keys(preT), ...Object.keys(postT)]) owners.add(k.split('|')[0]);
  const trades = [];
  for (const owner of owners) {
    const native = (postN[owner] || 0n) - (preN[owner] || 0n);
    const mints = new Set();
    for (const k of [...Object.keys(preT), ...Object.keys(postT)]) if (k.startsWith(owner + '|')) mints.add(k.split('|')[1]);
    const usdcOut = (preT[owner + '|' + USDC] || 0n) - (postT[owner + '|' + USDC] || 0n);
    const usdcIn = (postT[owner + '|' + USDC] || 0n) - (preT[owner + '|' + USDC] || 0n);
    for (const mint of mints) {
      if (mint === USDC) continue;
      const delta = (postT[owner + '|' + mint] || 0n) - (preT[owner + '|' + mint] || 0n);
      if (delta > 0n) {
        let quoteMint = null, quoteRaw = 0n;
        if (native < 0n) { quoteMint = SOL; quoteRaw = -native; }
        else if (usdcOut > 0n) { quoteMint = USDC; quoteRaw = usdcOut; }
        else continue; // transfer/inflow without identifiable payment - NOT a buy
        trades.push({ owner, mint, side: 'BUY', tokenAmountRaw: delta.toString(), quoteMint, quoteAmountRaw: quoteRaw.toString() });
      } else if (delta < 0n) {
        let quoteMint = null, quoteRaw = 0n;
        if (native > 0n) { quoteMint = SOL; quoteRaw = native; }
        else if (usdcIn > 0n) { quoteMint = USDC; quoteRaw = usdcIn; }
        else continue;
        trades.push({ owner, mint, side: 'SELL', tokenAmountRaw: (-delta).toString(), quoteMint, quoteAmountRaw: quoteRaw.toString() });
      }
    }
  }
  return { state: 'OK', slot: tx.slot, blockTime: tx.blockTime, venue, trades, parserVersion };
}
