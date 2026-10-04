import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeMint } from '../src/validation.js';

test('real Token-2022 mint with extensions decodes (accountType at byte 165)', () => {
  const f = JSON.parse(readFileSync(new URL('./fixtures/token2022_mint.json', import.meta.url)));
  const d = decodeMint(f.account);
  assert.equal(d.ok, true);
  assert.equal(d.decimals, 6);
  assert.ok(d.extensions.length > 0);
});

import { extensionVerdict, EXTENSION_ALLOWLIST, validateToken } from '../src/validation.js';
import { openDb } from '../src/db.js';

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TOKENKEG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const cfgV = JSON.parse(readFileSync('config/experiment.json', 'utf8'));

function mintAccount(owner, extTypes) {
  const base = Buffer.alloc(82); base.writeUInt8(6, 44); base.writeUInt8(1, 45);
  let data = base;
  if (extTypes) {
    const pad = Buffer.alloc(165 - 82);
    const tlv = Buffer.concat(extTypes.map(t => { const h = Buffer.alloc(4); h.writeUInt16LE(t, 0); h.writeUInt16LE(2, 2); return Buffer.concat([h, Buffer.alloc(2)]); }));
    data = Buffer.concat([base, pad, Buffer.from([1]), tlv]);
  }
  return { owner, data: [data.toString('base64'), 'base64'] };
}
async function run(owner, extTypes) {
  const db = openDb(':memory:');
  const rpc = { getAccountInfo: async () => ({ result: { value: mintAccount(owner, extTypes) }, evidenceId: 'ev1' }), getTokenLargestAccounts: async () => { throw new Error('x'); } };
  const dex = { tokenPairs: async () => null }; const jup = { sellQuote: async () => { throw new Error('x'); } };
  const r = await validateToken(db, rpc, dex, jup, 'M'.repeat(44), cfgV);
  return JSON.parse(db.prepare('select checks_json from risk_assessments').get().checks_json) && { r, checks: JSON.parse(db.prepare('select checks_json from risk_assessments').get().checks_json) };
}

test('allowlist is exactly metadata_pointer(18) and token_metadata(19)', () => {
  assert.deepEqual(Object.keys(EXTENSION_ALLOWLIST).sort(), ['18', '19']);
  assert.equal(extensionVerdict([{ type: 18 }, { type: 19 }]).pass, true);
});
test('mint with only metadata extensions passes the extension gate and records the decoded list', async () => {
  const { checks } = await run(TOKEN_2022, [18, 19]);
  assert.equal(checks.identity, 'PASS'); assert.equal(checks.extensions_allowlist, 'PASS');
  assert.deepEqual(checks.extensions_decoded.map(e => e.type), [18, 19]);
});
test('transfer-fee (1) is rejected with extension-type-1', async () => {
  const { r, checks } = await run(TOKEN_2022, [18, 1]);
  assert.equal(checks.extensions_allowlist, 'FAIL'); assert.equal(checks['extension-type-1'], 'FAIL');
  assert.equal(r.result, 'REJECTED');
});
test('unknown extension id is rejected, never passed', async () => {
  const { r, checks } = await run(TOKEN_2022, [9999]);
  assert.equal(checks['extension-type-9999'], 'FAIL'); assert.equal(r.result, 'REJECTED');
});
test('legacy Tokenkeg mint unchanged: no extensions, gate passes', async () => {
  const { checks } = await run(TOKENKEG, null);
  assert.equal(checks.identity, 'PASS'); assert.equal(checks.extensions_allowlist, 'PASS');
  assert.deepEqual(checks.extensions_decoded, []);
});

test('active mint authority now yields REJECTED (previously a direct FAIL left result QUALIFIED/DATA_INCOMPLETE)', async () => {
  const db = openDb(':memory:');
  const acct = mintAccount(TOKENKEG, null); const b = Buffer.from(acct.data[0], 'base64'); b.writeUInt32LE(1, 0); acct.data[0] = b.toString('base64');
  const rpc = { getAccountInfo: async () => ({ result: { value: acct }, evidenceId: 'e' }), getTokenLargestAccounts: async () => { throw new Error('x'); } };
  const r = await validateToken(db, rpc, { tokenPairs: async () => null }, { sellQuote: async () => { throw new Error('x'); } }, 'M'.repeat(44), cfgV);
  assert.equal(r.checks.mint_authority_null, 'FAIL'); assert.equal(r.result, 'REJECTED');
});
