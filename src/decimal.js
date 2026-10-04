// Fixed-point decimal (6dp) on BigInt. Never use binary floats for money.
const S = 1000000n;
export function d(x) {
  if (typeof x === 'bigint') return x;
  if (typeof x === 'number') { if (!isFinite(x)) throw new Error('bad number'); return BigInt(Math.round(x * 1e6)); }
  const s = String(x).trim();
  if (!/^[+-]?(\d+(\.\d{1,6})?|\.\d{1,6})$/.test(s)) throw new Error('bad decimal: ' + s);
  const neg = s.startsWith('-'); const t = neg ? s.slice(1) : s;
  const [i, f = ''] = t.split('.');
  let v = BigInt(i) * S + BigInt((f + '000000').slice(0, 6));
  return neg ? -v : v;
}
export const add = (a, b) => a + b;
export const sub = (a, b) => a - b;
export const mul = (a, b) => (a * b) / S;
export const div = (a, b) => (b === 0n ? null : (a * S) / b);
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const min = (a, b) => (a < b ? a : b);
export const max = (a, b) => (a > b ? a : b);
export const fmt = (a) => {
  const neg = a < 0n; const v = neg ? -a : a;
  const i = v / S; const f = (v % S).toString().padStart(6, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + i.toString() + (f ? '.' + f : '');
};
// Round a raw token amount DOWN to whole token units.
export const floorRaw = (raw, decimals) => { const r = BigInt(raw); const m = 10n ** BigInt(decimals); return r - (r % m); };
export const rawToUsdText = (raw, decimals, priceUsd) =>
  fmt(mul(div(d(raw), d(10).pow(d(decimals))), d(priceUsd)));
// Raw token units worth `usd` at a price quoted with ANY number of decimals (DexScreener quotes pump coins at 7+ dp).
// Exact BigInt math, floored. Exponent notation or non-positive prices throw, so callers stay fail-closed.
export function usdToRawUnits(usd, priceText, decimals) {
  const m = /^(\d+)(?:\.(\d{1,30}))?$/.exec(String(priceText).trim());
  if (!m) throw new Error('bad price: ' + priceText);
  const frac = m[2] ?? '';
  const P = BigInt(m[1] + frac);
  if (P <= 0n) throw new Error('non-positive price');
  return (d(usd) * 10n ** BigInt(decimals + frac.length)) / (P * S);
}
