import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Outbox } from '../src/telegram.js';
const M = '7U62Lm4CKa25eRdBdYv3QeTJjJirxTVGJpA3ePkkpump';
const n = (db) => db.prepare(`SELECT COUNT(*) c FROM telegram_outbox`).get().c;
test('DATA_INCOMPLETE / REJECTED / no-capital signals never reach the Telegram outbox', () => {
  const db = openDb(':memory:'), o = new Outbox(db);
  for (const decision of ['DATA_INCOMPLETE', 'REJECTED', 'QUALIFIED_NO_CAPITAL']) o.enqueue('signal', { mint: M, decision, reasons: ['sell-quote-unavailable'], name: 'X' });
  assert.equal(n(db), 0);
  o.enqueue('signal', { mint: M, decision: 'PAPER_OPEN', reasons: [] }); assert.equal(n(db), 0, 'no coin name -> not posted');
});
test('PAPER_OPEN card: name, copyable CA, 3 links, time, no n/a, no invented wallet', () => {
  const db = openDb(':memory:'), o = new Outbox(db);
  o.enqueue('signal', { mint: M, decision: 'PAPER_OPEN', name: 'Coin <A>', symbol: 'CA', notional: '20', entry_at: '2026-10-04T08:00:00Z' });
  assert.equal(n(db), 1);
  const t = o.card('signal', JSON.parse(db.prepare(`SELECT payload_json p FROM telegram_outbox`).get().p));
  assert.match(t, new RegExp(`<code>${M}</code>`)); assert.match(t, /gmgn\.ai\/sol\/token\//); assert.match(t, /web3\.binance\.com/); assert.match(t, /dexscreener\.com\/solana\//);
  assert.match(t, /Coin &lt;A&gt;/); assert.ok(!/n\/a|undefined|null/i.test(t)); assert.match(t, /no single wallet/);
  assert.ok(!/Wallet:|SOL spent/.test(t));
});
