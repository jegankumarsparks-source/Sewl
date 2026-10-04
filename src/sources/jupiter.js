import { Quota } from '../rpc.js';
import { recordObservation } from '../evidence.js';

const BASE = 'https://api.jup.ag/swap/v2';
export const SOL = 'So11111111111111111111111111111111111111112';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export class Jupiter {
  constructor({ db, quota = new Quota(25, 60_000) }) { this.db = db; this.quota = quota; }
  async quote({ inputMint, outputMint, amountRaw, slippageBps = 300 }) {
    await this.quota.take();
    const requestedAt = new Date().toISOString();
    const path = `/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}`;
    const res = await fetch(BASE + path, { headers: { accept: 'application/json' } });
    const j = await res.json().catch(() => null);
    const evidenceId = recordObservation(this.db, { provider: BASE, method: 'GET ' + path, subject: `${inputMint}->${outputMint}:${amountRaw}`, requestedAt, body: j, httpStatus: res.status, status: res.ok ? 'OK' : 'ERROR' });
    if (!res.ok) throw new Error('jupiter ' + res.status);
    return { quote: j, evidenceId, requestedAt };
  }
  // Read-only buy quote (USDC -> mint). Quote-only: never builds/submits a transaction.
  buyQuote(mint, usdcRaw) { return this.quote({ inputMint: USDC, outputMint: mint, amountRaw: usdcRaw }); }
  // Read-only full-size sell quote (mint -> USDC). A quote is NOT proof a real sell will settle.
  sellQuote(mint, unitsRaw) { return this.quote({ inputMint: mint, outputMint: USDC, amountRaw: unitsRaw }); }
  spotSellQuote(mint, unitsRaw) { return this.quote({ inputMint: mint, outputMint: USDC, amountRaw: unitsRaw, slippageBps: 0 }); }
}
