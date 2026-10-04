import { recordObservation } from './evidence.js';

export class Quota {
  constructor(perInterval, intervalMs) { this.cap = perInterval; this.ms = intervalMs; this.used = 0; this.window = Date.now(); }
  async take() {
    const t = Date.now();
    if (t - this.window >= this.ms) { this.window = t; this.used = 0; }
    if (this.used >= this.cap) { await new Promise(r => setTimeout(r, this.ms - (t - this.window) + 25)); return this.take(); }
    this.used++;
  }
  utilization() { return this.used / this.cap; }
}

export class Rpc {
  constructor({ endpoint, quota, db, record = true }) {
    this.endpoint = endpoint; this.quota = quota; this.db = db; this.record = record;
    this.id = 0;
  }
  async call(method, params = [], { subject = null, evidence = true, retries = 3 } = {}) {
    await this.quota.take();
    const requestedAt = new Date().toISOString();
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(this.endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
          signal: AbortSignal.timeout(15000)
        });
        const j = await res.json();
        let evidenceId = null;
        if (this.record && evidence) {
          evidenceId = recordObservation(this.db, {
            provider: this.endpoint, method, subject,
            requestedAt, body: j, httpStatus: res.status,
            status: j.error ? 'ERROR' : 'OK', error: j.error ? String(j.error.code ?? j.error) : null
          });
        }
        if (j.error) { lastErr = new Error(method + ' RPC error: ' + JSON.stringify(j.error)); if (res.status >= 500 && attempt < retries) { await sleep(500 * (attempt + 1)); continue; } throw lastErr; }
        return { result: j.result, evidenceId };
      } catch (e) {
        lastErr = e;
        if ((e.name === 'TimeoutError' || e.name === 'AbortError' || /429|50[023]/i.test(String(e))) && attempt < retries) { await sleep(800 * (attempt + 1)); continue; }
        if (this.record && evidence) recordObservation(this.db, { provider: this.endpoint, method, subject, requestedAt, status: 'ERROR', error: (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'TIMEOUT' : String(e).slice(0, 200) });
        throw e;
      }
    }
    throw lastErr;
  }
  getSignaturesForAddress(addr, opts = {}) { return this.call('getSignaturesForAddress', [addr, { limit: 1000, ...opts }], { subject: addr }); }
  getTransaction(sig, commitment = 'finalized') { return this.call('getTransaction', [sig, { encoding: 'jsonParsed', commitment, maxSupportedTransactionVersion: 0 }], { subject: sig }); }
  getAccountInfo(addr) { return this.call('getAccountInfo', [addr, { encoding: 'base64' }], { subject: addr }); }
  getTokenLargestAccounts(mint) { return this.call('getTokenLargestAccounts', [mint, { commitment: 'finalized' }], { subject: mint }); }
  getTokenSupply(mint) { return this.call('getTokenSupply', [mint, { commitment: 'finalized' }], { subject: mint }); }
  getMultipleAccounts(addrs) { return this.call('getMultipleAccounts', [addrs, { encoding: 'base64' }], { subject: addrs.join(',').slice(0, 80) }); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
