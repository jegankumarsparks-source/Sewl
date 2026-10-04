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
