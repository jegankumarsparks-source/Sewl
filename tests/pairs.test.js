import test from 'node:test';
import assert from 'node:assert/strict';
import { pairCreatedMs } from '../src/pairs.js';
test('reads the real DexScreener field pairCreatedAt (regression: discovery skipped every pool)', () => {
  assert.equal(pairCreatedMs({ pairCreatedAt: 1791100000000 }), 1791100000000);
  assert.equal(pairCreatedMs({ pairCreatedAtMs: 5 }), 5);
  assert.equal(pairCreatedMs({}), null); assert.equal(pairCreatedMs({ pairCreatedAt: 'x' }), null); assert.equal(pairCreatedMs(null), null);
});
