'use strict';
// SEWL app P2: health cockpit, P&L/win-rate/latency, decision journal, weekly narrative, strategy lab, evidence hash-verify. Read-only; every number is a stored row.
const gauge = (used, cap, label) => { const p = Math.min(1, used / cap), R = 54, C = Math.PI * R, col = p > 0.9 ? '#ff5c6c' : p > 0.7 ? '#fbbf24' : '#2ee59d';
  return `<svg viewBox="0 0 140 84" class="gauge"><path d="M16 70 A54 54 0 0 1 124 70" fill="none" stroke="#1a1e26" stroke-width="12" stroke-linecap="round"/><path d="M16 70 A54 54 0 0 1 124 70" fill="none" stroke="${col}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${C * p} ${C}"/><text x="70" y="62" text-anchor="middle" fill="#eef1f6" font-size="17" font-weight="700">${(p * 100).toFixed(1)}%</text><text x="70" y="78" text-anchor="middle" fill="#8a93a6" font-size="8">${esc(label)}</text></svg>`; };
function srcCard(h) {
  const s = Object.entries(h.by_source ?? {}).sort((a, b) => b[1] - a[1]); if (!s.length) return '';
  const tot = s.reduce((a, [, v]) => a + v, 0) || 1;
  return `<div class="card"><h2>Credits by source</h2>${s.map(([k, v]) => `<div class="row" style="padding:6px 0"><span>${esc(k)}</span><span class="mono">${fnum(v, 0)} <span class="sub">${Math.round(100 * v / tot)}%</span></span></div><div style="height:5px;border-radius:3px;background:#1a1e26"><div style="height:5px;border-radius:3px;background:var(--accent);width:${Math.max(2, Math.round(100 * v / tot))}%"></div></div>`).join('')}<div class="sub">Counted by this worker since the per-source meter went live (UNVERIFIED against the Helius dashboard).</div></div>`;
}
function cockpit(d) {
  const h = d.helius ?? { used: 0, cap: 800000 };
  const buckets = new Map((d.cycles_6h ?? []).map((c) => [c.b, c.n])); const bars = []; const now = Date.now();
  for (let i = 35; i >= 0; i--) { const t = new Date(now - i * 600000).toISOString().slice(0, 15); bars.push([t, buckets.get(t) ?? 0]); }
  const exp = 10; // expected cycles per 10 min at a 60 s cadence
  return `<div class="card"><h2>Helius fuel gauge</h2><div class="dwrap">${gauge(h.used, h.cap, 'of ' + fnum(h.cap, 0) + ' credits')}<div class="sub"><b>${fnum(h.used, 0)}</b> credits used in ${esc(h.month)}.<br>Hard cap ${fnum(h.cap, 0)} enforced in code. Snapshot reads may use up to ${fnum(h.snapshot_budget, 0)}.<br>Free plan, no card, so nothing can be billed.<br><span ${tip('helius_usage table, counted by the app itself; the Helius dashboard is the authority')}>Self-counted (UNVERIFIED against the Helius dashboard).</span></div></div></div>
  ${srcCard(h)}<div class="card"><h2>Cycle heartbeat (last 6 h)</h2><div class="hbs">${bars.map(([t, n]) => `<i class="${n === 0 ? 'z' : n < exp * 0.5 ? 'w' : ''}" style="height:${Math.max(4, Math.min(100, n / exp * 100))}%" title="${t}0Z: ${n} cycles"></i>`).join('')}</div><div class="sub">Each bar = 10 min, full height = ${exp} cycles. Empty bars = no cycles: the host asleep or a stopped worker (cannot tell which from here).</div></div>
  <div class="card"><h2>Stall strip</h2>${(d.stall_events ?? []).length ? [...new Map(d.stall_events.map((s) => [s.at, s])).values()].slice(0, 8).map((s) => `<div class="row"><span class="sub">${esc(s.at)}</span><span>${s.age_s == null ? 'n/a' : Math.round(s.age_s / 60) + ' min late'}</span></div>`).join('') : '<div class="sub">No stall events recorded.</div>'}<div class="sub">A stall means a loop did not finish on time: a host pause or a hang.</div></div>`;
}
function lineSvg(pts, key, fmt, color = '#f0b90b') {
  if (pts.length < 2) return '<div class="sub">Not enough points yet.</div>';
  const w = 300, h = 80, v = pts.map((p) => Number(p[key])), lo = Math.min(...v), hi = Math.max(...v), sp = hi - lo || 1;
  const d = pts.map((p, i) => (i ? 'L' : 'M') + (i / (pts.length - 1) * w).toFixed(1) + ' ' + (h - 6 - (Number(p[key]) - lo) / sp * (h - 12)).toFixed(1)).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" class="spark" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="${color}" stroke-width="2"/></svg><div class="sub">min ${fmt(lo)} | max ${fmt(hi)} | ${pts.length} points</div>`;
}
function donutWL(by, total) {
  const keys = Object.keys(by); if (!total) return '<div class="sub">No closed positions yet, so no win-rate donut (it stays empty rather than showing 0%).</div>';
  const pal = ['#2ee59d', '#ff5c6c', '#fbbf24', '#60a5fa']; let a0 = -Math.PI / 2, out = '';
  keys.forEach((k, i) => { const sp = by[k] / total * 2 * Math.PI, x = (r, a) => 60 + r * Math.cos(a), y = (r, a) => 60 + r * Math.sin(a), L = sp > Math.PI ? 1 : 0;
    out += `<path d="M${x(50, a0)} ${y(50, a0)}A50 50 0 ${L} 1 ${x(50, a0 + sp - 0.01)} ${y(50, a0 + sp - 0.01)}L${x(32, a0 + sp - 0.01)} ${y(32, a0 + sp - 0.01)}A32 32 0 ${L} 0 ${x(32, a0)} ${y(32, a0)}Z" fill="${pal[i % 4]}"><title>${esc(k)}: ${by[k]}</title></path>`; a0 += sp; });
  return `<div class="dwrap"><svg viewBox="0 0 120 120" class="donut" style="width:120px;height:120px">${out}</svg><div class="sub">${keys.map((k, i) => `<span style="color:${pal[i % 4]}">&#9679;</span> ${esc(k)}: ${by[k]}`).join('<br>')}<br>Closed total: ${total}. States are the stored position states, not a profit claim.</div></div>`;
}
const P2 = {
  async dashExtra() {
    const d = await get('pnl'); const eq = d.equity_series.filter((p) => p.equity_usd != null);
    return `<div class="card"><h2>Paper P&amp;L curve</h2>${lineSvg(eq, 'equity_usd', (n) => '$' + Number(n).toFixed(2))}<div>${d.milestones.map((m) => badge(`${esc(short(m.mint, 3))} ${m.multiple}x`, 'ok')).join(' ') || '<span class="sub">No 1.5x/2x milestones reached yet.</span>'}</div><div class="sub">${esc(d.note)}</div></div>
    <div class="card"><h2>Outcomes</h2>${donutWL(d.closed_by_state, d.closed_total)}</div>
    <div class="card"><h2>Detection latency trend</h2>${lineSvg(d.latency_series, 'latency_ms', (n) => (n / 1000).toFixed(1) + ' s', '#22d3ee')}<div class="sub">Upper-bound entry latency of momentum events, from stored buy_events.</div></div>`;
  },
  cockpit,
  async journal() {
    const d = await get('journal'); const fl = sessionStorage.getItem('sewl_jf') || 'all'; const kinds = [['all', 'All'], ['signal', 'Signals'], ['entry', 'Entries'], ['exit', 'Exits'], ['event', 'Events']]; const rows = d.entries.filter((e) => fl === 'all' || e.kind === fl); const ic = { signal: '&#9889;', entry: '&#9654;', exit: '&#9632;', event: '&#9888;' };
    $('#view').innerHTML = `<a class="link" href="#/activity">&larr; Back</a>` + head('Decision journal', 'Every decision, entry, exit and notable event, newest first') + banner + `<div class="chips" id="jf">${kinds.map(([k, t]) => `<button class="chip ${k === fl ? 'on' : ''}" data-k="${k}">${t} ${k === 'all' ? d.entries.length : d.entries.filter((e) => e.kind === k).length}</button>`).join('')}</div>` + (rows.map((e) => `<div class="card jr" ${tip('row id ' + (e.ref_id ?? ''))}><div class="row" style="padding:0;border:0"><span>${ic[e.kind] ?? ''} <b>${esc(e.title)}</b></span><span class="sub">${ago(e.at)}</span></div>${e.mint ? `<a class="mono link" href="#/coin/${esc(e.mint)}">${esc(short(e.mint))}</a>` : ''}<div class="sub">${esc(e.at)} ${esc(e.detail ?? '')}</div></div>`).join('') || '<div class="card empty">Nothing recorded yet.</div>') + `<div class="sub" style="padding:8px">${esc(d.note)}</div>`;
    document.querySelectorAll('#jf .chip').forEach((c) => (c.onclick = () => { sessionStorage.setItem('sewl_jf', c.dataset.k); P2.journal(); }));
  },
  alertPrefs() { return Object.assign({ momentum: true, whale: true, entries_only: true, collapse: false, quiet: false, qfrom: 23, qto: 7 }, JSON.parse(localStorage.getItem('sewl_alerts') || '{}')); },
  quietNow(p = P2.alertPrefs()) { if (!p.quiet) return false; const h = new Date().getHours(); return p.qfrom > p.qto ? (h >= p.qfrom || h < p.qto) : (h >= p.qfrom && h < p.qto); },
  async alerts() {
    const p = P2.alertPrefs(); const tg = (k, t, sub) => `<label class="row" style="min-height:52px"><span>${t}<div class="sub">${sub}</div></span><input type="checkbox" data-k="${k}" ${p[k] ? 'checked' : ''} style="width:22px;height:22px;accent-color:var(--accent)"></label>`;
    $('#view').innerHTML = `<a class="link" href="#/activity">&larr; Back</a>` + head('Alert settings', 'Stored on this device only. In-app alerts show while the app is open.') + banner + `<div class="card">${tg('momentum', 'Momentum signals', 'Price-surge signals from the scanner')}${tg('whale', 'Whale signals', 'Signals from tracked wallets')}${tg('entries_only', 'Only paper entries', 'Skip rejected and incomplete decisions')}${tg('collapse', 'Collapse to one line', 'Digest mode: one banner instead of one per signal')}${tg('quiet', 'Quiet hours', 'No banner or notification inside this window')}
      <div class="row"><span>From hour</span><input type="number" min="0" max="23" id="qf" value="${p.qfrom}" class="mono" style="width:70px;background:#12151b;color:#fff;border:1px solid #1a1e26;border-radius:8px;padding:8px"></div>
      <div class="row"><span>To hour</span><input type="number" min="0" max="23" id="qt" value="${p.qto}" class="mono" style="width:70px;background:#12151b;color:#fff;border:1px solid #1a1e26;border-radius:8px;padding:8px"></div></div>
      <div class="card"><div class="sub">Not offered: a minimum-liquidity filter (the stored signal rows carry gate results, not a dollar liquidity figure) and background push (needs a push server; the existing Telegram bot stays the only push).</div></div>`;
    const save = () => { const n = { ...p }; document.querySelectorAll('input[data-k]').forEach((i) => (n[i.dataset.k] = i.checked)); n.qfrom = Math.min(23, Math.max(0, Number($('#qf').value) || 0)); n.qto = Math.min(23, Math.max(0, Number($('#qt').value) || 0)); localStorage.setItem('sewl_alerts', JSON.stringify(n)); };
    document.querySelectorAll('#view input').forEach((i) => (i.onchange = save));
  },
  async lab() {
    const d = await get('lab'); const f = d.frozen;
    $('#view').innerHTML = `<a class="link" href="#/activity">&larr; Back</a>` + head('Strategy lab', 'What-if on recorded marks. Does not change the live rules.') + banner + `<div class="card"><div class="lbl">Take-profit (gross multiple): <b id="tpv"></b></div><input type="range" id="tp" min="1.1" max="4" step="0.1" value="${f.tp_gross}" class="rng"><div class="lbl">Stop-loss (net): <b id="slv"></b></div><input type="range" id="sl" min="-0.9" max="-0.2" step="0.05" value="${f.sl_net}" class="rng"><div class="lbl">Size per coin (USD): <b id="szv"></b></div><input type="range" id="sz" min="5" max="50" step="5" value="${f.size_usd}" class="rng"><div id="labout"></div></div><div class="sub" style="padding:8px">${esc(d.note)} Live constants stay frozen: TP ${f.tp_gross}x gross, SL ${f.sl_net}, $${f.size_usd} per coin, ${f.max_open} slots.</div>`;
    const run = () => { const tp = Number($('#tp').value), sl = Number($('#sl').value), sz = Number($('#sz').value); $('#tpv').textContent = tp + 'x'; $('#slv').textContent = Math.round(sl * 100) + '%'; $('#szv').textContent = '$' + sz;
      let wins = 0, losses = 0, open = 0, pnl = 0; for (const p of d.positions) { let out = null; for (const m of p.series) { if (m.x >= tp) { out = tp - 1; break; } if (m.x - 1 <= sl) { out = sl; break; } } if (out == null) open++; else { out > 0 ? wins++ : losses++; pnl += out * sz; } }
      $('#labout').innerHTML = `<div class="row"><span>Positions replayed</span><b>${d.positions.length}</b></div><div class="row"><span>Would hit TP / SL / still open</span><b>${wins} / ${losses} / ${open}</b></div><div class="row"><span>Simulated realized (gross, no fees)</span><b>${d.positions.length ? '$' + pnl.toFixed(2) : 'n/a'}</b></div><div class="sub">${d.positions.length ? 'Replays only stored PRICED marks; a real exit can differ.' : 'No recorded positions with marks yet, so there is nothing to replay (no invented data).'} Payoff per coin at these settings: win +$${((tp - 1) * sz).toFixed(2)}, loss ${'-$' + (Math.abs(sl) * sz).toFixed(2)} (arithmetic, not a forecast).</div>`; };
    ['tp', 'sl', 'sz'].forEach((i) => ($('#' + i).oninput = run)); run();
  },
  async evidenceVerify(id) {
    if (typeof STATIC_MODE !== 'undefined' && STATIC_MODE) throw new Error('evidence payloads are not in the public snapshot');
    const r = await fetch('/api/evidence/' + encodeURIComponent(id), { cache: 'no-store' });
    if (!r.ok) throw new Error('evidence ' + r.status + (r.status === 403 ? ' (withheld: looks like a credential)' : ''));
    const d = await r.json(); const bytes = new TextEncoder().encode(d.payload); const dig = await crypto.subtle.digest('SHA-256', bytes); const hex = [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const ok = hex === d.sha256_stored;
    $('#view').innerHTML = `<a class="link" href="#/evidence">&larr; Evidence</a>` + head('Evidence receipt', short(d.id, 6)) + banner + `<div class="card"><div class="row"><span>Hash check (computed in your browser)</span>${badge(ok ? 'MATCH' : 'MISMATCH', ok ? 'ok' : 'bad')}</div><div class="mono sub">stored   ${esc(d.sha256_stored)}<br>computed ${esc(hex)}</div><div class="sub">SHA-256 of the stored payload bytes, re-hashed here. A match means the file was not altered since it was recorded.</div></div><div class="card"><h2>Payload</h2><pre class="pl">${esc(d.payload.slice(0, 6000))}${d.payload.length > 6000 ? '\n... (' + d.payload.length + ' chars total)' : ''}</pre></div>`;
  },
  async weekly() { const d = await get('weekly'); return `<div class="card"><h2>Weekly narrative</h2><div>${esc(d.text)}</div><div class="sub">${esc(d.note)}</div></div>`; }
};
