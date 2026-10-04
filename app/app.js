'use strict';
// SEWL app (read-only). All data is escaped before it touches innerHTML. No keys, no write calls.
const $ = (s) => document.querySelector(s);
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => (n == null ? 'n/a' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const short = (s, n = 6) => (s && s.length > 2 * n + 3 ? s.slice(0, n) + '...' + s.slice(-n) : s ?? '');
const ago = (iso) => { if (!iso) return 'never'; const s = Math.max(0, (Date.now() - new Date(iso)) / 1000); return s < 90 ? Math.round(s) + 's ago' : s < 5400 ? Math.round(s / 60) + 'm ago' : s < 172800 ? (s / 3600).toFixed(1) + 'h ago' : Math.round(s / 86400) + 'd ago'; };
const ms = (v) => (v == null ? 'n/a' : v < 1000 ? v + ' ms' : (v / 1000).toFixed(1) + ' s');
const ico = {
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  sig: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  rad: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 12l6-6"/>',
  wal: '<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M16 12.5h2M3 10h18"/>',
  evi: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  hea: '<path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 0 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1z"/>',
  rep: '<path d="M4 4h16v16H4zM8 9h8M8 13h8M8 17h5"/>',
  mor: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>'
};
const ROUTES = [['', 'Dashboard', 'home'], ['signals', 'Signals', 'sig'], ['wallets', 'Wallets', 'wal'], ['activity', 'Activity', 'evi'], ['health', 'Health', 'hea']];
const TAB = ['', 'signals', 'wallets', 'activity', 'health'];
const svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ico[k]}</svg>`;

const PARENT = { coin: 'signals', wallet: 'wallets', momentum: 'activity', evidence: 'activity', reports: 'activity', journal: 'activity', lab: 'activity', alerts: 'activity' };
function nav(cur) {
  const on = PARENT[cur] ?? cur;
  $('#side').innerHTML = '<div class="brand">SE<b>WL</b> <span class="badge mute">PAPER</span></div>' + ROUTES.map(([p, l, i]) => `<a href="#/${p}" class="${on === p ? 'on' : ''}">${svg(i)}${l}</a>`).join('');
  $('#tabs').innerHTML = ROUTES.map(([p, l, i]) => `<a href="#/${p}" class="${on === p ? 'on' : ''}">${svg(i)}${l}</a>`).join('');
}
// STATIC = public monitoring copy (GitHub Pages): reads pre-baked snapshot JSONs, never a live API.
const STATIC_MODE = /\.github\.io$/.test(location.hostname) || new URLSearchParams(location.search).has('static');
const snapName = (p) => { const [path, q] = p.split('?'); const s = path.split('/'); if (s[0] === 'ohlcv') return `ohlcv_${s[1]}_${new URLSearchParams(q).get('tf') ?? '5m'}.json`; return s.length === 2 ? `${s[0]}_${s[1]}.json` : `${s[0]}.json`; };
async function get(p) {
  if (STATIC_MODE) {
    if (['evidence', 'reports'].includes(p.split('/')[0])) throw new Error('not in the public snapshot (full version only)');
    const r = await fetch('snap/' + snapName(p), { cache: 'no-store' }); if (!r.ok) throw new Error('not in current snapshot'); const d = await r.json(); if (d.snapshot_at) window.SNAP_AT = d.snapshot_at; return d;
  }
  const r = await fetch('/api/' + p, { cache: 'no-store' }); if (!r.ok) throw new Error(p + ' ' + r.status); return r.json();
}
const badge = (t, k = '') => `<span class="badge ${k}">${esc(t)}</span>`;
const decisionKind = (d) => (d === 'PAPER_OPEN' ? 'ok' : d === 'REJECTED' ? 'bad' : d === 'WATCH_ONLY' || d === 'DATA_INCOMPLETE' || d === 'QUALIFIED_NO_CAPITAL' ? 'warn' : 'mute');

function ring(p, label) {
  const R = 54, C = 2 * Math.PI * R, v = p == null ? 0 : p;
  return `<svg class="ring" viewBox="0 0 132 132"><circle class="t" cx="66" cy="66" r="${R}" fill="none" stroke-width="10"/><circle class="p" cx="66" cy="66" r="${R}" fill="none" stroke-width="10" transform="rotate(-90 66 66)" stroke-dasharray="${C}" stroke-dashoffset="${C}" data-to="${C * (1 - v)}"/><text x="66" y="68" text-anchor="middle">${p == null ? 'n/a' : Math.round(v * 100) + '%'}</text><text class="s" x="66" y="86" text-anchor="middle">${esc(label)}</text></svg>`;
}
function spark(series) {
  const pts = series.filter((s) => s.equity_usd != null);
  if (pts.length < 2) return '<div class="empty">Not enough valuation points yet.</div>';
  const w = 300, h = 64, lo = Math.min(...pts.map((p) => p.equity_usd)), hi = Math.max(...pts.map((p) => p.equity_usd)), span = hi - lo || 1;
  const xy = pts.map((p, i) => [(i / (pts.length - 1)) * w, h - 6 - ((p.equity_usd - lo) / span) * (h - 12)]);
  const d = xy.map((c, i) => (i ? 'L' : 'M') + c[0].toFixed(1) + ' ' + c[1].toFixed(1)).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22d3ee" stop-opacity=".35"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/></linearGradient></defs><path class="a" d="${d} L${w} ${h} L0 ${h}Z"/><path class="l" d="${d}"/></svg>`;
}
const head = (t, s) => `<h1>${esc(t)}</h1><div class="sub">${esc(s)}</div>`;
const banner = '<div class="banner">PAPER TRADING ONLY. No real funds, no signing key, read-only app. Results are not proof of profitability.</div>';

const V = {
  async '' () {
    const d = await get('dashboard');
    const pnl = d.pnl_vs_start_usd;
    const pos = d.open_positions.map((p) => {
      const m = p.last_multiple == null ? null : Number(p.last_multiple), cost = Number(p.entry_total_usd);
      const pct = m == null ? 0 : Math.max(0, Math.min(1.8, m)) / 1.8 * 100;
      return `<div class="row" style="flex-direction:column;align-items:stretch;gap:8px"><div class="row" style="padding:0;border:0"><span class="mono">${esc(short(p.mint))}</span><span>${badge(p.origin ?? 'whale', p.origin === 'momentum' ? '' : 'mute')}</span></div>
      <div class="bar"><i style="width:${pct}%"></i><span class="mk" style="left:${0.5 / 1.8 * 100}%" title="SL"></span><span class="mk tp" style="left:${1.5 / 1.8 * 100}%" title="TP"></span></div>
      <div class="sub">entry ${usd(cost)} | SL ${usd(p.sl_value_usd)} (-50%) | TP gross ${usd(p.tp_gross_value_usd)} (1.5X) | mark ${m == null ? 'n/a (no priced mark)' : m.toFixed(2) + 'x'} ${p.last_mark_at ? '(' + ago(p.last_mark_at) + ')' : ''}</div></div>`;
    }).join('');
    $('#view').innerHTML = head('Dashboard', 'Paper account, updated ' + ago(d.valuation_at)) + banner + `
    <div class="card"><div class="ringwrap">${ring(d.progress, 'to $' + d.target_usd + ' latch')}<div><div class="lbl">Equity</div><div class="kpi">${usd(d.equity_usd)}</div>
      <div class="sub ${pnl == null ? '' : pnl >= 0 ? 'pos' : 'neg'}">${pnl == null ? esc(d.equity_note) : (pnl >= 0 ? '+' : '') + usd(pnl) + ' vs start'}</div><div style="margin-top:8px">${badge(d.state ?? 'n/a', d.state === 'PAPER_ACTIVE' ? 'ok' : 'warn')}</div></div></div></div>
    <div class="grid"><div class="card"><div class="lbl">Cash</div><div class="kpi sm">${usd(d.cash_usd)}</div></div>
      <div class="card"><div class="lbl">Deployed</div><div class="kpi sm">${usd(d.split.deployed_now_usd)}</div></div>
      <div class="card"><div class="lbl">Realized P&amp;L</div><div class="kpi sm">${usd(d.realized_pnl_usd)}</div></div>
      <div class="card"><div class="lbl">Reserve (untouched)</div><div class="kpi sm">${usd(d.split.reserve_usd)}</div><div class="sub">max deployed ${usd(d.split.max_deployed_usd)}</div></div></div>
    <div class="card" style="margin-top:12px"><h2>Equity</h2>${spark(d.equity_series)}</div>
    <div class="card"><h2>Open positions (${d.open_positions.length})</h2>${pos || '<div class="empty">No open positions.</div>'}</div>
    <div class="card"><h2>Recently closed</h2>${d.recent_closed.map((p) => `<div class="row"><span class="mono">${esc(short(p.mint))}</span><span class="sub">${ago(p.closed_at)}</span></div>`).join('') || '<div class="empty">None yet.</div>'}</div>`;
    requestAnimationFrame(() => document.querySelectorAll('.ring .p').forEach((c) => { c.style.strokeDashoffset = c.dataset.to; }));
    try { $('#view').insertAdjacentHTML('beforeend', await P2.dashExtra()); } catch (_) {}
  },
  async signalsList() {
    const d = await get('signals'); const hid = JSON.parse(localStorage.getItem('sewl_hidden') || '[]'), watch = JSON.parse(localStorage.getItem('sewl_watch') || '[]');
    const seen = Number(localStorage.getItem('sewl_seen') || 0); const ap = P2.alertPrefs(), qn = P2.quietNow(ap); const fresh = d.signals.filter((s) => Date.parse(s.qualified_at) > seen && s.decision === 'PAPER_OPEN' && (s.origin === 'whale' ? ap.whale : ap.momentum));
    if (d.signals[0]) localStorage.setItem('sewl_seen', String(Math.max(seen, Date.parse(d.signals[0].qualified_at) || 0)));
    if (fresh.length && !qn && 'Notification' in window && Notification.permission === 'granted') new Notification('SEWL (paper)', { body: fresh.length + ' new paper entry signal(s)' });
    const alertBar = !fresh.length || qn ? '' : ap.collapse ? `<div class="card alert">${fresh.length} new paper entr${fresh.length === 1 ? 'y' : 'ies'} since your last visit</div>` : `<div class="card alert">New paper entry since your last visit: ${fresh.map((s) => esc(short(s.mint, 4))).join(', ')}</div>`;
    const cards = d.signals.filter((s) => !hid.includes(s.id)).map((s) => {
      const lat = s.origin === 'momentum' ? `<div class="sub">latency (upper bound): detect ${ms(s.detection_ms != null && s.candle_start_ms != null ? s.detection_ms - s.candle_start_ms : null)} | entry ${ms(s.latency_ms)}</div>` : '';
      const ck = s.checks ? Object.entries(s.checks).filter(([k]) => k !== 'extensions_decoded').map(([k, v]) => `<div class="row" style="padding:6px 0"><span class="sub">${esc(k.replace(/_/g, ' '))}</span>${badge(v, v === 'PASS' || v === 'ROUTE_OK' ? 'ok' : v === 'FAIL' ? 'bad' : 'warn')}</div>`).join('') : '<div class="sub">No risk assessment stored for this signal (not evaluated).</div>';
      return `<div class="swipe" data-id="${esc(s.id)}"><div class="swhint l">watch</div><div class="swhint r">hide</div><div class="card sigcard" ${tip('signal row id ' + s.id)}><div class="row" style="padding:0;border:0"><a class="mono link" href="#/coin/${esc(s.mint)}">${esc(short(s.mint))}</a><span>${badge(s.origin, s.origin === 'momentum' ? 'warn' : 'mute')} ${badge(s.decision, decisionKind(s.decision))}${watch.includes(s.id) ? ' ' + badge('watching', 'ok') : ''}</span></div>
      <div class="sub">${esc(s.qualified_at)} (${ago(s.qualified_at)}) | rule ${esc(s.rule_version)}</div>${lat}
      <div style="margin-top:8px">${s.reasons.map((r) => badge(r, 'mute')).join(' ') || '<span class="sub">no reason codes</span>'}</div>
      <details class="gate"><summary>Gate checklist</summary>${ck}</details>
      <button class="chip rp" data-replay="${esc(s.id)}">&#9654; Replay</button></div></div>`;
    }).join('');
    $('#view').innerHTML = head('Signals', 'Whale and momentum decisions, newest first') + banner + alertBar + (cards || '<div class="card empty">No signals yet. Zero signals is a legitimate outcome, not proof the system is idle or broken.</div>') + (hid.length ? '<button class="chip" id="unhide">Show ' + hid.length + ' hidden</button>' : '') + `<div class="sub" style="padding:8px">Swipe a card right to watch, left to hide (saved on this device only). ${('Notification' in window) ? '<a class="link" href="#" id="enNotif">Enable in-app alerts</a>' : ''} Alerts fire only while the app is open; true background push needs a push service that this read-only app does not have.</div>`;
    window.__bindSig = () => {
    const find = (id) => d.signals.find((x) => x.id === id);
    document.querySelectorAll('.rp').forEach((b) => (b.onclick = () => { const s = find(b.dataset.replay); replay(s); }));
    const un = $('#unhide'); if (un) un.onclick = () => { localStorage.removeItem('sewl_hidden'); V.signals(); };
    const en = $('#enNotif'); if (en) en.onclick = (e) => { e.preventDefault(); Notification.requestPermission().then(() => V.signals()); };
    document.querySelectorAll('.swipe').forEach((el) => { let x0 = 0, dx = 0; const c = el.querySelector('.sigcard');
      el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; dx = 0; }, { passive: true });
      el.addEventListener('touchmove', (e) => { dx = e.touches[0].clientX - x0; if (Math.abs(dx) > 12) c.style.transform = `translateX(${dx}px)`; }, { passive: true });
      el.addEventListener('touchend', () => { c.style.transform = ''; const id = el.dataset.id; if (dx > 90) { const w = new Set(JSON.parse(localStorage.getItem('sewl_watch') || '[]')); w.has(id) ? w.delete(id) : w.add(id); localStorage.setItem('sewl_watch', JSON.stringify([...w])); tick(); V.signals(); } else if (dx < -90) { const h = JSON.parse(localStorage.getItem('sewl_hidden') || '[]'); h.push(id); localStorage.setItem('sewl_hidden', JSON.stringify(h)); tick(); V.signals(); } }); });
  
    };
    window.__bindSig();
  },
  async momentum() {
    const d = await get('momentum'); const l = d.last_1h, l24 = d.last_24h, t = d.trigger;
    $('#view').innerHTML = head('Momentum radar', 'Last cycle ' + ago(d.last_at)) + banner + `
    <div class="grid"><div class="card"><div class="lbl">Cycles 1h</div><div class="kpi sm">${l.cycles}</div><div class="sub">expected ${d.expected_cycles_per_hour}</div></div>
      <div class="card"><div class="lbl">Scanned 1h</div><div class="kpi sm">${l.scanned}</div></div>
      <div class="card"><div class="lbl">Triggered 1h</div><div class="kpi sm">${l.triggered}</div></div>
      <div class="card"><div class="lbl">Opened 1h</div><div class="kpi sm">${l.opened}</div></div></div>
    <div class="card" style="margin-top:12px"><h2>24h</h2><div class="sub">${l24.cycles} cycles | ${l24.leads} leads | ${l24.scanned} scanned | ${l24.triggered} triggered | ${l24.opened} opened</div>
      ${l.cycles < d.expected_cycles_per_hour * 0.5 ? '<div style="margin-top:8px">' + badge('fewer cycles than expected: host paused or worker stopped', 'warn') + '</div>' : ''}</div>
    <div class="card"><h2>Trigger (all must hold)</h2><div class="sub">surge 5m &ge; +${esc(t.price_surge_pct)}% | volume &ge; ${esc(t.volume_surge_x)}x baseline | pool age &le; ${esc(t.pool_age_max_hours)}h | liquidity &ge; $${esc(t.min_liquidity_usd)} | max ${esc(t.max_slots)} momentum slots | validation deadline ${esc(t.validation_deadline_seconds)}s</div></div>
    <div class="card"><h2>Latency</h2><div class="sub">signals ${d.latency.signals} | detect avg ${ms(d.latency.detect_avg_ms)} max ${ms(d.latency.detect_max_ms)} | entry avg ${ms(d.latency.entry_avg_ms)} max ${ms(d.latency.entry_max_ms)}<br>${esc(d.latency.note)}</div></div>
    <div class="card"><h2>Trigger history</h2>${d.history.map((h) => `<div class="row"><span class="mono">${esc(short(h.mint))}</span><span>${badge(h.decision, decisionKind(h.decision))}</span><span class="sub">${ago(h.qualified_at)}</span></div>`).join('') || '<div class="empty">No triggers yet.</div>'}</div>
    <div class="card"><h2>Coverage note</h2><div class="sub">${esc(d.coverage_note)}</div></div>`;
  },
  async walletsList() {
    const d = await get('wallets'), g = d.gates;
    $('#view').innerHTML = head('Wallets', 'Quality leaderboard') + banner + `<div class="card"><h2>Gates</h2><div class="sub">score &ge; ${esc(g.score_min)} | Wilson &ge; ${esc(g.wilson_min)} | profit factor &ge; ${esc(g.pf_min)} | &ge; ${esc(g.min_round_trips)} round trips | &ge; ${esc(g.min_mints)} mints | parse coverage &ge; ${esc(g.parse_coverage)} | priced coverage &ge; ${esc(g.priced_coverage)}</div></div>`
      + (d.wallets.map((w) => `<div class="card"><div class="row" style="padding:0;border:0"><span class="mono">${esc(short(w.address))}</span>${badge(w.status, w.status === 'QUALIFIED' ? 'ok' : 'mute')}</div>
      <div class="sub">score ${esc(w.score ?? 'n/a')} | Wilson ${esc(w.wilson_lower ?? 'n/a')} | PF ${esc(w.profit_factor ?? 'n/a')} | trips ${esc(w.closed_round_trips ?? 'n/a')} | mints ${esc(w.distinct_mints ?? 'n/a')} | parse ${esc(w.parse_coverage ?? 'n/a')} | priced ${esc(w.priced_coverage ?? 'n/a')}</div>
      <div style="margin-top:8px">${w.reasons.map((r) => badge(r, 'mute')).join(' ')}</div></div>`).join('') || '<div class="card empty">No wallets discovered yet (no early pools found in the 60-minute window so far). Missing data stays NULL, never zero.</div>');
  },
  async evidence(id) {
    if (id) return P2.evidenceVerify(id);
    const d = await get('evidence');
    $('#view').innerHTML = head('Evidence', d.total + ' source observations (latest 100 shown)') + banner + d.observations.map((o) => `<div class="card"><div class="row" style="padding:0;border:0"><a class="mono link" href="#/evidence/${esc(o.id)}">${esc(o.method)} &#128274;</a>${badge(o.error_code ?? o.quality_state ?? 'n/a', o.quality_state === 'OK' ? 'ok' : 'bad')}</div>
      <div class="sub">${esc(o.provider)} | HTTP ${esc(o.http_status ?? 'n/a')} | latency ${ms(o.latency_ms)} | ${esc(o.requested_at)}</div><div class="mono">hash ${esc(o.hash ?? 'n/a')}${o.subject_key ? ' | ' + esc(short(o.subject_key, 10)) : ''}</div></div>`).join('');
  },
  async health() {
    const d = await get('health'), st = d.last_startup;
    $('#view').innerHTML = head('Health', 'Worker and loops') + banner + P2.cockpit(d) + `
    <div class="grid"><div class="card"><div class="lbl">Process uptime</div><div class="kpi sm">${d.process_uptime_s == null ? 'n/a (snapshot)' : d.process_uptime_s >= 3600 ? (d.process_uptime_s / 3600).toFixed(1) + ' h' : Math.round(d.process_uptime_s / 60) + ' min'}</div></div>
      <div class="card"><div class="lbl">Startups logged</div><div class="kpi sm">${d.startups}</div></div>
      <div class="card"><div class="lbl">Last startup</div><div class="kpi sm" style="font-size:15px">${st ? ago(st.at) : 'none'}</div><div class="sub">${st ? esc(st.detail?.version ?? '') : ''}</div></div>
      <div class="card"><div class="lbl">Outbox</div><div class="sub">${d.outbox.map((o) => esc(o.state) + ' ' + o.n).join(' | ') || 'empty (no alert ever queued)'}</div></div></div>
    <div class="card" style="margin-top:12px"><h2>Event summary</h2>${d.summary.map((s) => `<div class="row"><span>${badge(s.severity, s.severity === 'INFO' ? 'mute' : s.severity === 'WARN' ? 'warn' : 'bad')} <span class="mono">${esc(s.code)}</span></span><span class="sub">${s.n}x, last ${ago(s.last_at)}</span></div>`).join('') || '<div class="empty">No events.</div>'}</div>
    <div class="card"><h2>Stall heartbeat</h2><div class="sub">${esc(d.stall_note)}</div>${d.stalls.map((s) => `<div class="row"><span class="mono">${esc(s.component)}</span><span class="sub">age ${esc(s.detail?.last_done_age_s ?? '?')}s of ${esc(s.detail?.interval_s ?? '?')}s interval | ${ago(s.at)}</span></div>`).join('')}</div>
    <div class="card"><h2>API key quota</h2><div class="sub">${esc(d.key_quota.note)}</div></div>`;
  },
  async signals() {
    const mk = await CV.markets(); await V.signalsList(); const cur = $('#view').innerHTML; const i = cur.indexOf('</div>', cur.indexOf('class="banner"')) + 6;
    $('#view').innerHTML = cur.slice(0, i) + `<div class="card"><h2>Markets</h2><div class="sub">Tap a coin for details. Long-press for a quick preview.</div>${mk}</div><h2 style="margin:16px 4px 8px">Decisions</h2>` + cur.slice(i); window.__bindSig && window.__bindSig();
  },
  async wallets() {
    await V.walletsList(); const cur = $('#view').innerHTML; const i = cur.indexOf('</div>', cur.indexOf('class="banner"')) + 6;
    $('#view').innerHTML = cur.slice(0, i) + `<form class="card" id="wf"><input id="wi" class="inp" placeholder="Paste any Solana wallet address" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="btn" type="submit">Open wallet</button><div class="sub">Real on-chain data. Each lookup spends Helius credits from the capped monthly budget; results are cached.</div></form>` + cur.slice(i);
    $('#wf').onsubmit = (e) => { e.preventDefault(); const v = $('#wi').value.trim(); if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) location.hash = '#/wallet/' + v; else $('#wi').classList.add('bad'); };
  },
  async activity() {
    const wk = await P2.weekly().catch(() => '');
    $('#view').innerHTML = head('Activity', 'Journal, narrative, lab and the scan loop') + banner + wk + `<div class="card"><a class="row" href="#/journal" style="text-decoration:none;color:inherit"><span>Decision journal</span><span>&rsaquo;</span></a><a class="row" href="#/alerts" style="text-decoration:none;color:inherit"><span>Alert settings</span><span>&rsaquo;</span></a><a class="row" href="#/lab" style="text-decoration:none;color:inherit"><span>Strategy lab (what-if)</span><span>&rsaquo;</span></a><a class="row" href="#/momentum" style="text-decoration:none;color:inherit"><span>Momentum scan stats</span><span>&rsaquo;</span></a>${STATIC_MODE ? '' : '<a class="row" href="#/reports" style="text-decoration:none;color:inherit"><span>Reports</span><span>&rsaquo;</span></a><a class="row" href="#/evidence" style="text-decoration:none;color:inherit"><span>Evidence log (hash verify)</span><span>&rsaquo;</span></a>'}</div>`;
  },
  async journal() { return P2.journal(); },
  async alerts() { return P2.alerts(); },
  async lab() { return P2.lab(); },
  async coin(mint) { const html = await CV.coin(mint); $('#view').innerHTML = html; drawCoin(mint, await get('coin/' + mint)); clearInterval(coinTimer); coinTimer = setInterval(async () => { try { const d = await get('coin/' + mint); const el = $('#px'); if (!el) return clearInterval(coinTimer); const old = el.textContent; el.textContent = price(d.market?.price_usd); if (el.textContent !== old) { el.classList.remove('up', 'dn'); void el.offsetWidth; el.classList.add(Number(d.market?.price_usd) >= 0 ? 'up' : 'dn'); } } catch (_) {} }, 15000); },
  async wallet(addr) { $('#view').innerHTML = await CV.wallet(addr); },
  async reports(id) {
    if (id) {
      const r = await get('reports/' + id);
      $('#view').innerHTML = `<a class="link" href="#/reports">&larr; All reports</a>` + head(r.title, r.kind + ' | ' + r.created_at) + `<div class="card md">${md(r.body_md)}</div>`;
      return;
    }
    const d = await get('reports');
    $('#view').innerHTML = head('Reports', 'Every report sent to the owner, kept forever') + (d.reports.map((r) => `<a href="#/reports/${r.id}" style="text-decoration:none;color:inherit"><div class="card"><div class="row" style="padding:0;border:0"><span>${esc(r.title)}</span>${badge(r.kind)}</div><div class="sub">${esc(r.created_at)} (${ago(r.created_at)}) | ${Math.round(r.size / 1024 * 10) / 10} KB</div></div></a>`).join('') || '<div class="card empty">No reports stored yet.</div>');
  }
};

// Minimal markdown: headings, bold, inline code, fenced code, lists, tables, links (http/https only). Escapes first.
function md(src) {
  const lines = String(src).replace(/\r/g, '').split('\n'); let out = '', i = 0, list = null;
  const inl = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a class="link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const close = () => { if (list) { out += `</${list}>`; list = null; } };
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('```')) { close(); let b = ''; i++; while (i < lines.length && !lines[i].startsWith('```')) b += lines[i++] + '\n'; i++; out += `<pre><code>${esc(b)}</code></pre>`; continue; }
    if (/^\|.*\|\s*$/.test(l) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      close(); const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inl(c.trim()));
      out += '<table><tr>' + cells(l).map((c) => `<th>${c}</th>`).join('') + '</tr>'; i += 2;
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) out += '<tr>' + cells(lines[i++]).map((c) => `<td>${c}</td>`).join('') + '</tr>'; out += '</table>'; continue;
    }
    let m;
    if ((m = l.match(/^(#{1,3})\s+(.*)/))) { close(); out += `<h${m[1].length}>${inl(m[2])}</h${m[1].length}>`; }
    else if ((m = l.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { close(); out += '<ul>'; list = 'ul'; } out += `<li>${inl(m[1])}</li>`; }
    else if ((m = l.match(/^\s*\d+\.\s+(.*)/))) { if (list !== 'ol') { close(); out += '<ol>'; list = 'ol'; } out += `<li>${inl(m[1])}</li>`; }
    else if (!l.trim()) close();
    else { close(); out += `<p>${inl(l)}</p>`; }
    i++;
  }
  close(); return out;
}

// REPLAY: steps through the recorded decision timeline of one signal (real stored timestamps only; nothing is simulated).
function replay(s) {
  const t0 = Date.parse(s.qualified_at); const steps = [];
  if (s.candle_start_ms != null) steps.push(['Surge candle starts', s.candle_start_ms]);
  if (s.detection_ms != null) steps.push(['Detected by the scanner', s.detection_ms]);
  if (!isNaN(t0)) steps.push(['Signal qualified (' + s.decision + ')', t0]);
  if (s.entry_ms != null) steps.push(['Paper entry quote taken', s.entry_ms]);
  steps.sort((a, b) => a[1] - b[1]);
  if (!steps.length) return sheet('<h2>Replay</h2><div class="sub">No stored timeline timestamps for this signal (UNVERIFIED).</div>');
  const base = steps[0][1]; sheet(`<h2>Replay</h2><div class="sub">Stored timestamps of signal ${esc(short(s.id, 4))}. Latencies are upper bounds.</div><div id="rpl"></div><div class="sub">Gate result: ${esc(s.decision)} | ${esc(s.reasons.join(', '))}</div>`);
  let i = 0; const host = $('#rpl'); const next = () => { if (!host || i >= steps.length) return; const st = steps[i++]; host.insertAdjacentHTML('beforeend', `<div class="tl"><i></i><div><b>${esc(st[0])}</b><div class="sub">+${((st[1] - base) / 1000).toFixed(1)} s | ${new Date(st[1]).toISOString().slice(11, 23)}Z</div></div></div>`); tick(); setTimeout(next, 700); }; next();
}
let timer;
async function render() {
  const h = location.hash.replace(/^#\/?/, ''); const [r, id] = h.split('/'); const route = V[r ?? ''] ? (r ?? '') : '';
  nav(route); if (typeof closeSheet === "function") closeSheet();
  $('#view').innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
  try { await V[route](id ? (route === 'reports' ? Number(id) : id) : undefined); } catch (e) { $('#view').innerHTML = STATIC_MODE && /snapshot/.test(e.message) ? `<a class="link" href="#/signals">&larr; Back</a><div class="card"><h2>Not in the current snapshot</h2><div class="sub">This public monitoring copy only pre-renders the top coins, open positions and a few wallets, refreshed every ~10 minutes. The full live version (on the host) can open any coin or wallet.</div></div>` : `<div class="card"><h2>Could not load</h2><div class="sub">${esc(e.message)}</div></div>`; }
  clearInterval(timer); clearInterval(coinTimer); if (!['coin', 'wallet'].includes(route) && (route !== 'reports' || !id)) timer = setInterval(() => V[route](id ? (route === 'reports' ? Number(id) : id) : undefined).catch(() => {}), 30000);
}
addEventListener('hashchange', render); render();
if ('serviceWorker' in navigator && !STATIC_MODE) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (STATIC_MODE) { document.body.classList.add('static'); const t = () => { const e = $('#snapage'); if (e) e.textContent = window.SNAP_AT ? 'snapshot ' + ago(window.SNAP_AT) : 'snapshot'; }; setInterval(t, 5000); setTimeout(t, 800); }
