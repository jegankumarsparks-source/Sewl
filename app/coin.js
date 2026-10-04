'use strict';
// SEWL app P0: coin drill-down, wallet profile, markets, gestures. Read-only. Data is escaped; every number carries its source in a tooltip.
const fnum = (n, d = 2) => (n == null || n === '' || isNaN(n) ? 'n/a' : Number(n) >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : Number(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : Number(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : Number(n).toFixed(d));
const price = (p) => { if (p == null) return 'n/a'; const n = Number(p); return '$' + (n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(4) : n.toPrecision(3)); };
const pct = (v) => (v == null ? '<span class="sub">n/a</span>' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%</span>`);
const tago = (sec) => (sec == null ? 'unknown' : ago(new Date(sec * 1000).toISOString()));
const tick = () => { try { navigator.vibrate && navigator.vibrate(8); } catch (_) {} };
const tip = (s) => `title="${esc(s)}"`;
const solscan = (k, a) => `https://solscan.io/${k}/${encodeURIComponent(a)}`;
const TFS = ['1m', '5m', '15m', '1h', '4h'];
let coinTimer = null;

function sheet(html) {
  closeSheet(); const d = document.createElement('div'); d.id = 'sheet'; d.className = 'sheet';
  d.innerHTML = `<div class="sh-bg"></div><div class="sh-body"><div class="grab"></div>${html}</div>`; document.body.appendChild(d);
  requestAnimationFrame(() => d.classList.add('open')); d.querySelector('.sh-bg').onclick = closeSheet; tick();
}
function closeSheet() { const d = $('#sheet'); if (d) d.remove(); }

function candles(canvas, data) {
  const dpr = devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight; canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  if (!data.length) { g.fillStyle = '#6b7280'; g.fillText('No candles returned', 12, 24); return; }
  const vh = H * 0.22, ph = H - vh - 8, n = data.length, cw = W / n;
  const hi = Math.max(...data.map((c) => c.h)), lo = Math.min(...data.map((c) => c.l)), sp = hi - lo || hi || 1, vmax = Math.max(...data.map((c) => c.v)) || 1;
  const y = (p) => 4 + (hi - p) / sp * ph;
  data.forEach((c, i) => {
    const up = c.c >= c.o, col = up ? '#2ee59d' : '#ff5c6c', x = i * cw + cw / 2; g.strokeStyle = col; g.fillStyle = col; g.globalAlpha = 1;
    g.beginPath(); g.moveTo(x, y(c.h)); g.lineTo(x, y(c.l)); g.stroke();
    const t = y(Math.max(c.o, c.c)), b = y(Math.min(c.o, c.c)); g.fillRect(x - cw * 0.33, t, cw * 0.66, Math.max(1, b - t));
    g.globalAlpha = 0.35; const bh = c.v / vmax * vh; g.fillRect(x - cw * 0.33, H - bh, cw * 0.66, bh); g.globalAlpha = 1;
  });
}

function donut(holders, creator) {
  const R = 70, r1 = 44, cx = 90, cy = 90; let a0 = -Math.PI / 2; const top = holders.slice(0, 20); const tot = top.reduce((a, h) => a + h.pct_supply, 0);
  const arc = (r0, r, s, e, col, attr) => { const f = (rr, a) => [cx + rr * Math.cos(a), cy + rr * Math.sin(a)]; const [x1, y1] = f(r, s), [x2, y2] = f(r, e), [x3, y3] = f(r0, e), [x4, y4] = f(r0, s), L = e - s > Math.PI ? 1 : 0;
    return `<path d="M${x1} ${y1}A${r} ${r} 0 ${L} 1 ${x2} ${y2}L${x3} ${y3}A${r0} ${r0} 0 ${L} 0 ${x4} ${y4}Z" fill="${col}" ${attr}/>`; };
  let out = '', i = 0; const pal = ['#22d3ee', '#a78bfa', '#f472b6', '#fbbf24', '#34d399', '#60a5fa'];
  for (const h of top) { const span = h.pct_supply / 100 * 2 * Math.PI; if (span <= 0.002) continue; const isC = creator && h.owner === creator;
    out += arc(r1 + 2, R, a0, a0 + span - 0.01, isC ? '#ff5c6c' : pal[i % pal.length], `data-owner="${esc(h.owner ?? '')}" class="slice" ${tip(`rank ${i + 1}: ${h.pct_supply}% of supply (RPC getTokenLargestAccounts)`)}`); a0 += span; i++; }
  const creatorPct = creator ? top.filter((h) => h.owner === creator).reduce((a, h) => a + h.pct_supply, 0) : 0;
  const inner = `<circle cx="${cx}" cy="${cy}" r="${r1}" fill="#0c0f14"/><text x="${cx}" y="${cy - 2}" text-anchor="middle" fill="#e8eefc" font-size="15" font-weight="700">${tot.toFixed(1)}%</text><text x="${cx}" y="${cy + 14}" text-anchor="middle" fill="#8a93a6" font-size="9">top ${top.length} hold</text>`;
  return { svg: `<svg viewBox="0 0 180 180" class="donut">${out}${inner}</svg>`, creatorPct };
}

const CV = {
  async markets() {
    const d = await get('markets');
    return `<div class="sub">${esc(d.source)} | scan ${d.at ? ago(d.at) : 'not yet'}</div>` + (d.coins.map((c) => `<div class="row coinrow" data-m="${esc(c.mint)}"><div><b>${esc(c.symbol ?? '?')}</b> <span class="sub">${esc(c.name ?? '')}</span><div class="mono sub">${esc(short(c.mint))}${c.from_helius ? ' | via Helius' : ''}</div></div><div style="text-align:right"><div ${tip('DEX Screener priceUsd')}>${price(c.price_usd)}</div><div>${pct(c.change_5m)} <span class="sub">5m</span></div></div></div>`).join('') || '<div class="empty">No scan yet. The list fills after the next worker cycle.</div>');
  },
  async coin(mint) {
    const d = await get('coin/' + mint); const m = d.market, a = d.audit; const cr = d.creator?.creator ?? null;
    const buys = d.trades.filter((t) => t.side === 'BUY').reduce((s, t) => s + t.sol, 0), sells = d.trades.filter((t) => t.side === 'SELL').reduce((s, t) => s + t.sol, 0), tot = buys + sells;
    const ageMin = m?.pool_created_ms ? Math.round((Date.now() - m.pool_created_ms) / 60000) : null;
    const exts = a?.ok ? (a.extensions.length ? a.extensions.map((e) => `<div class="row"><span>${esc(e.meaning)}</span>${badge(e.allowed ? 'allowed' : 'REJECTED', e.allowed ? 'ok' : 'bad')}</div>`).join('') : '<div class="sub">Classic SPL token, no extensions.</div>') : '';
    const dn = d.holders ? donut(d.holders, cr) : null;
    const tl = [d.creator?.created_at && ['Creation (first on-chain tx)', d.creator.created_at], m?.pool_created_ms && ['Pool created (DEX Screener)', Math.floor(m.pool_created_ms / 1000)], d.trades.length && ['Oldest swap shown', d.trades[d.trades.length - 1].time], d.trades.length && ['Latest swap', d.trades[0].time]].filter(Boolean).sort((x, y) => x[1] - y[1]);
    return `<a class="link" href="#/signals">&larr; Back</a>
    <div class="coinhead"><div><h1>${esc(d.symbol ?? '?')} <span class="sub">${esc(d.name ?? '')}</span></h1><div class="mono sub">${esc(d.mint)} <a class="link" href="${solscan('token', d.mint)}" target="_blank" rel="noopener noreferrer">Solscan</a></div></div>
      <div style="text-align:right"><div class="kpi" id="px" ${tip('DEX Screener priceUsd, refreshes every 15s')}>${price(m?.price_usd)}</div><div>${pct(m?.change_5m)} 5m ${pct(m?.change_1h)} 1h ${pct(m?.change_24h)} 24h</div></div></div>
    ${banner}
    <div class="card noswipe"><div class="chips" id="tfs">${TFS.map((t, i) => `<button class="chip ${i === 1 ? 'on' : ''}" data-tf="${t}">${t}</button>`).join('')}</div>
      <canvas id="cv" class="cv"></canvas><div class="sub" id="cvnote">Real OHLCV from GeckoTerminal. No 5-second candles exist in any free source; the smallest timeframe is 1m.</div></div>
    <div class="grid"><div class="card"><div class="lbl">Liquidity</div><div class="kpi sm" ${tip('DEX Screener liquidity.usd, current value only (no history)')}>$${fnum(m?.liquidity_usd)}</div></div>
      <div class="card"><div class="lbl">Market cap</div><div class="kpi sm">$${fnum(m?.market_cap_usd)}</div></div>
      <div class="card"><div class="lbl">Vol 1h</div><div class="kpi sm">$${fnum(m?.volume_1h_usd)}</div></div>
      <div class="card"><div class="lbl">Pool age</div><div class="kpi sm">${ageMin == null ? 'n/a' : ageMin < 120 ? ageMin + ' min' : (ageMin / 60).toFixed(1) + ' h'}</div><div class="sub">${esc(m?.dex ?? '')}</div></div></div>
    <div class="card"><h2>Buy / sell pressure</h2><div class="pres" style="${tot ? '' : 'background:#2a2f3a'}"><i style="width:${tot ? buys / tot * 100 : 0}%"></i></div>
      <div class="sub">${d.trades.length ? '' : 'No swaps could be parsed from this coin\'s latest 100 on-chain transactions (venue may be unsupported); showing DEX Screener counts only. '}Last ${d.trades.length} swaps (on-chain, SOL-quoted): buys ${buys.toFixed(2)} SOL | sells ${sells.toFixed(2)} SOL.${m?.txns_h1 ? ` DEX Screener 1h: ${m.txns_h1.buys} buys / ${m.txns_h1.sells} sells.` : ''}</div></div>
    <div class="card"><h2>Contract audit</h2>${a?.ok ? `<div class="row"><span>Mint authority</span>${badge(a.mint_authority_revoked ? 'revoked' : 'ACTIVE', a.mint_authority_revoked ? 'ok' : 'bad')}</div><div class="row"><span>Freeze authority</span>${badge(a.freeze_authority_revoked ? 'revoked' : 'ACTIVE', a.freeze_authority_revoked ? 'ok' : 'bad')}</div>${exts}` : '<div class="sub">Mint account could not be read (UNVERIFIED).</div>'}
      <div class="row"><span>Liquidity</span><span>$${fnum(m?.liquidity_usd)}</span></div><div class="row"><span>Pool age</span><span>${ageMin == null ? 'UNVERIFIED' : ageMin + ' min'}</span></div><div class="sub">${esc(d.liquidity_note)}</div></div>
    <div class="card"><h2>Top 20 holders</h2>${dn ? `<div class="dwrap">${dn.svg}<div class="sub">Tap a slice to open that wallet. Red = the creator wallet${dn.creatorPct ? ` (${dn.creatorPct.toFixed(1)}% of supply)` : ' (not among the top 20, or unknown)'}. The largest account is often the pool or curve; this is NOT classified by the app (UNVERIFIED).</div></div>` : '<div class="sub">Holder data unavailable.</div>'}</div>
    <div class="card"><h2>Creator</h2>${cr ? `<div class="row"><span class="mono">${esc(short(cr))}</span><a class="link" href="#/wallet/${esc(cr)}">Open wallet</a></div><div class="sub">${esc(d.creator.source)}</div><button class="btn" id="crBtn">Load creator's other coins</button><div id="crOut"></div>` : '<div class="sub">Creator not determined.</div>'}</div>
    <div class="card"><h2>Event timeline</h2>${tl.map((e) => `<div class="tl"><i></i><div><b>${esc(e[0])}</b><div class="sub">${tago(e[1])} | ${new Date(e[1] * 1000).toISOString().slice(11, 19)}Z</div></div></div>`).join('') || '<div class="sub">No events.</div>'}<div class="sub">Our own signal/entry events appear here when the app is deployed on the live worker database (none for this coin otherwise).</div></div>
    <div class="card"><h2>Trade tape</h2><div class="sub">${esc(d.trades_note)}</div>${d.trades.slice(0, 25).map((t) => `<div class="row"><span>${badge(t.side, t.side === 'BUY' ? 'ok' : 'bad')} ${t.sol.toFixed(3)} SOL</span><span class="sub">${tago(t.time)}</span><a class="link mono" href="#/wallet/${esc(t.wallet ?? t.owner ?? '')}">${esc(short(t.wallet ?? t.owner ?? '', 4))}</a></div>`).join('')}</div>
    <div class="sub" style="padding:8px">${d.cached ? 'cached' : 'fresh'} read | RPC credits are quota-capped.</div>`;
  }
};

async function drawCoin(mint, d) {
  const cv = $('#cv'); if (!cv) return; let tf = '5m';
  const pool = (await get('coin/' + mint)).market?.pair;
  const load = async () => { try { const r = await get(`ohlcv/${pool}?tf=${tf}`); candles(cv, r.candles.slice(-80)); } catch (e) { $('#cvnote').textContent = 'Candles unavailable: ' + e.message; } };
  document.querySelectorAll('#tfs .chip').forEach((b) => (b.onclick = () => { tf = b.dataset.tf; document.querySelectorAll('#tfs .chip').forEach((x) => x.classList.toggle('on', x === b)); tick(); load(); }));
  if (pool) { tf = '5m'; load(); }
  document.querySelectorAll('.slice').forEach((s) => (s.onclick = () => { if (s.dataset.owner) { tick(); location.hash = '#/wallet/' + s.dataset.owner; } }));
  const cb = $('#crBtn'); if (cb) cb.onclick = async () => { cb.disabled = true; $('#crOut').innerHTML = '<div class="skel"></div>'; try { const w = await get('wallet/' + d.creator.creator); const c = w.created_coins; const dead = c.filter((x) => x.status === 'DEAD_OR_RUGGED_HEURISTIC').length;
    $('#crOut').innerHTML = `<div class="row"><span>Coins created (latest 100 txs)</span><b>${c.length}</b></div><div class="row"><span ${tip('Heuristic: liquidity < $1000 or no pair. Not proof of a rug.')}>Dead/rugged-looking (HEURISTIC)</span><b>${dead}</b></div>` + c.map((x) => `<a class="row coinrow" href="#/coin/${esc(x.mint)}" style="text-decoration:none;color:inherit"><span>${esc(x.symbol ?? short(x.mint))}</span>${badge(x.status.replace(/_/g, ' '), x.status === 'ACTIVE' ? 'ok' : 'warn')}</a>`).join('') + `<div class="sub">${esc(w.created_note)}</div>`; } catch (e) { $('#crOut').textContent = 'Could not load: ' + e.message; } };
}

CV.wallet = async function (addr) {
  const w = await get('wallet/' + addr), p = w.pnl, tags = [];
  const created = w.created_coins.length; const dead = w.created_coins.filter((c) => c.status === 'DEAD_OR_RUGGED_HEURISTIC').length;
  if (created >= 3 && dead / created >= 0.6) tags.push(['Serial rugger?', 'bad', `${dead} of ${created} created coins look dead (heuristic)`]);
  else if (created) tags.push(['Dev-adjacent', 'warn', `created ${created} coin(s) in the fetched window`]);
  if ((w.sol_balance ?? 0) >= 1000) tags.push(['Whale', 'ok', `${w.sol_balance} SOL balance`]);
  const hit = (n) => (p.coins_with_realized_sells ? Math.round(n / p.coins_with_realized_sells * 100) : 0);
  return `<a class="link" href="#/wallets">&larr; Back</a><h1>Wallet</h1><div class="mono sub">${esc(addr)} <a class="link" href="${solscan('account', addr)}" target="_blank" rel="noopener noreferrer">Solscan</a></div>${banner}
  <div class="grid"><div class="card"><div class="lbl">SOL balance</div><div class="kpi sm">${w.sol_balance == null ? 'n/a' : w.sol_balance.toFixed(3)}</div></div>
    <div class="card"><div class="lbl">Last active</div><div class="kpi sm" style="font-size:15px">${tago(w.last_active)}</div></div>
    <div class="card"><div class="lbl">Realized P&amp;L (EST)</div><div class="kpi sm ${!p.coins_with_realized_sells ? '' : p.realized_pnl_sol >= 0 ? 'pos' : 'neg'}">${p.coins_with_realized_sells ? p.realized_pnl_sol + ' SOL' : 'n/a'}</div><div class="sub">${p.coins_with_realized_sells} coin(s) with a matched sell</div></div>
    <div class="card"><div class="lbl">Coins traded</div><div class="kpi sm">${p.coins_traded}</div></div></div>
  <div class="card"><h2>Tags</h2>${tags.map((t) => `<span class="badge ${t[1]}" ${tip(t[2])}>${esc(t[0])}</span> `).join('') || '<div class="sub">No tag applies on the data available. Sniper / Insider / Diamond Hands need first-block and hold-time data (UNVERIFIED, P1).</div>'}</div>
  <div class="card"><h2>Hit rate (ESTIMATED)</h2><div class="hr"><span>1.5x</span><div class="bar"><i style="width:${hit(p.hit_1_5x)}%"></i></div><b>${p.hit_1_5x}/${p.coins_with_realized_sells}</b></div><div class="hr"><span>2x</span><div class="bar"><i style="width:${hit(p.hit_2x)}%"></i></div><b>${p.hit_2x}/${p.coins_with_realized_sells}</b></div><div class="sub">${esc(p.label)} ${p.coins_history_incomplete} coin(s) skipped as NULL: sold with the buy outside the fetched window.</div></div>
  <div class="card"><h2>Holdings</h2><div class="sub">${esc(w.holdings_note)}</div>${w.holdings.slice(0, 25).map((h) => `<a class="row coinrow" href="#/coin/${esc(h.mint)}" style="text-decoration:none;color:inherit"><span>${esc(h.symbol ?? short(h.mint))}</span><span>${h.est_value_usd == null ? '<span class="sub">unpriced</span>' : '~$' + fnum(h.est_value_usd)}</span></a>`).join('') || '<div class="empty">No token holdings.</div>'}</div>
  <div class="card"><h2>Coin history (ESTIMATED)</h2><div class="sub">Window: latest ${w.history_window.txs} txs. ${esc(w.history_window.note)}</div>${w.coins.slice(0, 40).map((c) => `<a class="row coinrow" href="#/coin/${esc(c.mint)}" style="text-decoration:none;color:inherit"><span class="mono">${esc(short(c.mint, 4))}</span><span>${c.realized_multiple == null ? '<span class="sub">NULL (incomplete)</span>' : c.realized_multiple + 'x'}</span><span class="sub">${tago(c.last_trade)}</span></a>`).join('')}</div>
  <div class="card"><h2>Coins created</h2>${w.created_coins.map((c) => `<a class="row coinrow" href="#/coin/${esc(c.mint)}" style="text-decoration:none;color:inherit"><span>${esc(c.symbol ?? short(c.mint))}</span>${badge(c.status.replace(/_/g, ' '), c.status === 'ACTIVE' ? 'ok' : 'warn')}</a>`).join('') || '<div class="sub">None in the fetched window.</div>'}<div class="sub">${esc(w.created_note)}</div></div>`;
};

// ---- gestures: swipe between tabs, pull-to-refresh, long-press preview
const TABS = ['', 'signals', 'wallets', 'activity', 'health'];
function gestures() {
  let sx = 0, sy = 0, st = 0, pulled = 0, lp = null, moved = false; const view = document.body;
  addEventListener('touchstart', (e) => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); pulled = 0; moved = false;
    const row = e.target.closest('.coinrow[data-m]'); if (row) lp = setTimeout(() => { if (!moved) previewCoin(row.dataset.m); lp = null; }, 450); }, { passive: true });
  addEventListener('touchmove', (e) => { const t = e.touches[0]; if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) { moved = true; clearTimeout(lp); }
    if (scrollY <= 0 && t.clientY - sy > 0 && Math.abs(t.clientX - sx) < 40) { pulled = t.clientY - sy; document.body.style.setProperty('--pull', Math.min(pulled, 110) / 110); } }, { passive: true });
  addEventListener('touchend', (e) => { clearTimeout(lp); const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy; document.body.style.setProperty('--pull', 0);
    if (pulled > 90) { scanPulse(); render(); return; }
    if (e.target.closest('.noswipe, canvas, input')) return;
    if (Math.abs(dx) > 90 && Math.abs(dy) < 50 && Date.now() - st < 600) { const cur = (location.hash.replace(/^#\/?/, '').split('/')[0]) || ''; const i = TABS.indexOf(cur); if (i < 0) return; const n = TABS[Math.max(0, Math.min(TABS.length - 1, i + (dx < 0 ? 1 : -1)))]; if (n !== cur) { tick(); location.hash = '#/' + n; } } }, { passive: true });
}
function scanPulse() { const h = $('#hb'); if (h) { h.classList.add('scan'); setTimeout(() => h.classList.remove('scan'), 1200); } tick(); }
async function previewCoin(mint) {
  tick(); sheet('<div class="skel"></div>');
  try { const d = await get('coin/' + mint); const m = d.market; $('#sheet .sh-body').innerHTML = `<div class="grab"></div><h2>${esc(d.symbol ?? '?')} <span class="sub">${esc(d.name ?? '')}</span></h2><div class="kpi">${price(m?.price_usd)}</div><div>${pct(m?.change_5m)} 5m ${pct(m?.change_1h)} 1h</div><div class="row"><span>Liquidity</span><span>$${fnum(m?.liquidity_usd)}</span></div><div class="row"><span>Mint authority</span><span>${d.audit?.ok ? (d.audit.mint_authority_revoked ? 'revoked' : 'ACTIVE') : 'UNVERIFIED'}</span></div><a class="btn" href="#/coin/${esc(mint)}" onclick="closeSheet()">Open full page</a>`; } catch (e) { $('#sheet .sh-body').innerHTML = '<div class="grab"></div><div class="sub">Preview failed: ' + esc(e.message) + '</div>'; }
}
document.addEventListener('click', (e) => { const r = e.target.closest('.coinrow[data-m]'); if (r && !e.target.closest('a')) { tick(); location.hash = '#/coin/' + r.dataset.m; } });
gestures();
