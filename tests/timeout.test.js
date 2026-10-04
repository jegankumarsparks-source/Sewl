import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Rpc, Quota } from '../src/rpc.js';
import { Dexscreener } from '../src/sources/dexscreener.js';
import { Jupiter } from '../src/sources/jupiter.js';
import { Outbox } from '../src/telegram.js';

const realFetch = globalThis.fetch;
const timeoutErr = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });
const obs = (db) => db.prepare(`SELECT status, error_code FROM source_observations`).all();

test('every outbound fetch carries an AbortSignal timeout', async () => {
  const db = openDb(':memory:'); const seen = [];
  globalThis.fetch = async (url, opts) => { seen.push(!!opts?.signal); return { ok: true, status: 200, json: async () => ({ result: 1, data: [] }) }; };
  try {
    await new Rpc({ endpoint: 'http://x', quota: new Quota(100, 1000), db }).call('getHealth');
    await new Dexscreener({ db }).get('/x');
    await new Jupiter({ db }).quote({ inputMint: 'a', outputMint: 'b', amountRaw: '1' });
    assert.deepEqual(seen, [true, true, true]);
  } finally { globalThis.fetch = realFetch; }
});

test('rpc: timeout is retried then succeeds', async () => {
  const db = openDb(':memory:'); let n = 0;
  globalThis.fetch = async () => { if (++n === 1) throw timeoutErr(); return { ok: true, status: 200, json: async () => ({ result: 'ok' }) }; };
  try {
    const r = await new Rpc({ endpoint: 'http://x', quota: new Quota(100, 1000), db }).call('getHealth');
    assert.equal(r.result, 'ok'); assert.equal(n, 2);
  } finally { globalThis.fetch = realFetch; }
});

test('dexscreener timeout: records ERROR TIMEOUT observation and throws', async () => {
  const db = openDb(':memory:');
  globalThis.fetch = async () => { throw timeoutErr(); };
  try {
    await assert.rejects(() => new Dexscreener({ db }).get('/x'), /TIMEOUT/);
    const rows = db.prepare(`SELECT quality_state, error_code FROM source_observations`).all();
    assert.equal(rows.length, 1); assert.equal(rows[0].error_code, 'TIMEOUT');
  } finally { globalThis.fetch = realFetch; }
});

test('telegram timeout: AMBIGUOUS_DELIVERY, never SENT', async () => {
  const db = openDb(':memory:'); const ob = new Outbox(db);
  ob.enqueue('digest', { cash: '500', realized: '0', equity: '500', open: 0, state: 'PAPER_ACTIVE', at: 'x' });
  globalThis.fetch = async () => { throw timeoutErr(); };
  try {
    await ob.flush('tok', 'chat');
    assert.equal(db.prepare(`SELECT state FROM telegram_outbox`).get().state, 'AMBIGUOUS_DELIVERY');
  } finally { globalThis.fetch = realFetch; }
});
