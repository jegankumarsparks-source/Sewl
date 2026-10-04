// DexScreener quotes pool creation time as `pairCreatedAt` (ms). Older code read a field that never exists (`pairCreatedAtMs`).
export function pairCreatedMs(p) {
  const v = Number(p?.pairCreatedAt ?? p?.pairCreatedAtMs);
  return Number.isFinite(v) && v > 0 ? v : null;
}
