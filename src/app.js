// SEWL read-only web app. PAPER ONLY. GET only, no write endpoints, no secrets in any response.
// Binds to 127.0.0.1 by default; expose only through an SSH tunnel / firewalled IP (see DEPLOYMENT.md).
// Optional HTTP Basic auth: set SEWL_APP_PASSWORD in the environment (never in git).
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { latencyStats } from './momentum.js';
import { createHash, timingSafeEqual } from 'node:crypto';
const safeEq = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());

const ROOT = path.resolve('app');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.json': 'application/json' };
const STATIC = new Set(['index.html', 'app.css', 'app.js', 'coin.js', 'p2.js', 'manifest.webmanifest', 'sw.js', 'icon.svg']);
const num = (x) => (x == null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));

export function buildApi(db, cfg) {
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const start = Number(cfg.starting_cash_usd), budget = Number(cfg.position_budget_usd), maxOpen = Number(cfg.max_open_positions);
  return {
    dashboard() {
      const exp = one(`SELECT * FROM experiments WHERE id='exp-1'`);
      const val = one(`SELECT * FROM equity_valuations ORDER BY at DESC LIMIT 1`);
      const cash = num(one(`SELECT balance_usd b FROM accounts WHERE name='cash'`)?.b);
      const open = q(`SELECT p.id, p.mint, p.entry_at, p.entry_total_usd, p.origin, p.signal_id,
        (SELECT net_multiple FROM position_marks m WHERE m.position_id=p.id AND m.valuation_state='PRICED' ORDER BY marked_at DESC LIMIT 1) last_multiple,
        (SELECT marked_at FROM position_marks m WHERE m.position_id=p.id AND m.valuation_state='PRICED' ORDER BY marked_at DESC LIMIT 1) last_mark_at
        FROM paper_positions p WHERE p.state='OPEN' ORDER BY p.entry_at DESC`).map(p => ({ ...p,
          sl_value_usd: (Number(p.entry_total_usd) * Number(cfg.exit_policy.stop_loss_net)).toFixed(2),
          tp_gross_value_usd: (Number(p.entry_total_usd) * Number(cfg.take_profit_multiple)).toFixed(2) }));
      const closed = q(`SELECT id, mint, entry_at, closed_at, entry_total_usd, origin FROM paper_positions WHERE state!='OPEN' ORDER BY closed_at DESC LIMIT 10`);
      const deployed = open.reduce((a, p) => a + Number(p.entry_total_usd), 0);
      const equity = val && val.complete_data ? num(val.equity_usd) : null;
      const target = Number(cfg.target_equity_usd);
      return {
        state: exp?.state ?? null, pause_reason: exp?.pause_reason ?? null,
        cash_usd: cash, equity_usd: equity, equity_note: equity == null ? 'NOT EXACT (open position without a fresh priced mark) or no valuation yet' : 'cash + fresh liquidation marks',
        valuation_at: val?.at ?? null, realized_pnl_usd: num(val?.realized_pnl_usd), unrealized_pnl_usd: num(val?.unrealized_pnl_usd),
        pnl_vs_start_usd: equity == null ? null : +(equity - start).toFixed(2),
        target_usd: target, progress: equity == null ? null : Math.max(0, Math.min(1, (equity - start) / (target - start))),
        split: { max_deployed_usd: budget * maxOpen, reserve_usd: start - budget * maxOpen, deployed_now_usd: +deployed.toFixed(2), cash_usd: cash },
        open_positions: open, recent_closed: closed,
        equity_series: q(`SELECT at, equity_usd FROM equity_valuations WHERE complete_data=1 ORDER BY at DESC LIMIT 120`).reverse().map(r => ({ at: r.at, equity_usd: num(r.equity_usd) })),
        banner: 'PAPER TRADING ONLY. No real funds, no signing key. Not proof of profitability.'
      };
    },
    signals() {
      return { signals: q(`SELECT s.id, s.mint, s.qualified_at, s.decision, s.rule_version, s.reason_codes_json,
        b.origin, b.latency_ms, (SELECT checks_json FROM risk_assessments ra WHERE ra.id = s.risk_assessment_id) checks_json, b.candle_start_ms, b.detection_ms, b.entry_ms, b.candle_time_source
        FROM signals s LEFT JOIN buy_events b ON b.id = json_extract(s.buy_event_ids_json,'$[0]') ORDER BY s.qualified_at DESC LIMIT 60`)
        .map(r => ({ ...r, checks: parse(r.checks_json), checks_json: undefined, origin: r.origin ?? (r.rule_version === 'momentum-v1' ? 'momentum' : 'whale'), reasons: parse(r.reason_codes_json) ?? [], reason_codes_json: undefined })) };
    },
    momentum() {
      const cyc = (hours) => one(`SELECT COUNT(*) cycles, COALESCE(SUM(json_extract(detail_json,'$.leads')),0) leads, COALESCE(SUM(json_extract(detail_json,'$.scanned')),0) scanned,
        COALESCE(SUM(json_extract(detail_json,'$.triggered')),0) triggered, COALESCE(SUM(json_extract(detail_json,'$.opened')),0) opened FROM health_events
        WHERE code='momentum-cycle' AND at >= ?`, new Date(Date.now() - hours * 3600_000).toISOString());
      return { last: parse(one(`SELECT detail_json d, at FROM health_events WHERE code='momentum-cycle' ORDER BY at DESC LIMIT 1`)?.d ?? 'null'),
        last_at: one(`SELECT MAX(at) t FROM health_events WHERE code='momentum-cycle'`).t, last_1h: cyc(1), last_24h: cyc(24),
        expected_cycles_per_hour: 3600 / Number(cfg.momentum.cycle_seconds),
        trigger: cfg.momentum, latency: latencyStats(db),
        history: q(`SELECT s.qualified_at, s.mint, s.decision, s.reason_codes_json FROM signals s WHERE s.rule_version='momentum-v1' ORDER BY s.qualified_at DESC LIMIT 30`).map(r => ({ ...r, reasons: parse(r.reason_codes_json) ?? [], reason_codes_json: undefined })),
        coverage_note: 'Scans boosted/profiled Solana leads only (no all-new-pairs feed on the free API). Zero triggers can mean no coverage. Latency is an upper bound: candle start = 5-minute window bound.' };
    },
    wallets() {
      return { gates: cfg.quality, wallets: q(`SELECT w.address, w.status, w.discovered_at, w.discovery_method, s.score, s.win_rate, s.wilson_lower, s.profit_factor, s.closed_round_trips, s.distinct_mints,
        s.parse_coverage, s.priced_coverage, s.status score_status, s.reason_codes_json, s.computed_at
        FROM wallets w LEFT JOIN wallet_scores s ON s.id = (SELECT id FROM wallet_scores WHERE wallet_address=w.address ORDER BY computed_at DESC LIMIT 1)
        ORDER BY CAST(s.score AS REAL) DESC NULLS LAST LIMIT 100`).map(r => ({ ...r, reasons: parse(r.reason_codes_json) ?? [], reason_codes_json: undefined })) };
    },
    evidence() {
      return { total: one(`SELECT COUNT(*) n FROM source_observations`).n, observations: q(`SELECT id, provider, method, subject_key, requested_at, received_at, http_status, quality_state, error_code, substr(payload_hash,1,16) hash
        FROM source_observations ORDER BY requested_at DESC LIMIT 100`).map(r => ({ ...r, latency_ms: r.received_at && r.requested_at ? new Date(r.received_at) - new Date(r.requested_at) : null })) };
    },
    health() {
      const startup = one(`SELECT at, detail_json FROM health_events WHERE code='startup' ORDER BY at DESC LIMIT 1`);
      return { now: new Date().toISOString(), process_uptime_s: Math.round(process.uptime()), last_startup: startup ? { at: startup.at, detail: parse(startup.detail_json) } : null,
        startups: one(`SELECT COUNT(*) n FROM health_events WHERE code='startup'`).n,
        summary: q(`SELECT severity, code, COUNT(*) n, MAX(at) last_at FROM health_events GROUP BY 1,2 ORDER BY last_at DESC`),
        stalls: q(`SELECT at, component, detail_json FROM health_events WHERE code='loop-stalled' ORDER BY at DESC LIMIT 15`).map(r => ({ at: r.at, component: r.component, detail: parse(r.detail_json) })),
        recent: q(`SELECT at, component, severity, code, detail_json FROM health_events WHERE code!='momentum-cycle' ORDER BY at DESC LIMIT 30`).map(r => ({ ...r, detail: parse(r.detail_json), detail_json: undefined })),
        outbox: q(`SELECT state, COUNT(*) n FROM telegram_outbox GROUP BY state`),
        key_quota: { configured: false, note: 'No API keys configured (keyless public RPC). Per-key quota counters arrive with the key plan (Phase 2).' },
        helius: (() => { const r = one(`SELECT credits FROM helius_usage WHERE month=?`, new Date().toISOString().slice(0, 7)); return { month: new Date().toISOString().slice(0, 7), used: r?.credits ?? 0, cap: 800000, snapshot_budget: 120000 }; })(),
        cycles_6h: q(`SELECT substr(at,1,15) b, COUNT(*) n FROM health_events WHERE code='momentum-cycle' AND at >= ? GROUP BY 1 ORDER BY 1`, new Date(Date.now() - 6 * 3600_000).toISOString()),
        stall_events: q(`SELECT at, detail_json FROM health_events WHERE code='loop-stalled' ORDER BY at DESC LIMIT 20`).map(s => ({ at: s.at, age_s: parse(s.detail_json)?.last_done_age_s ?? null })),
        stall_note: 'loop-stalled = a loop did not finish within 3x its interval: a hang OR a host pause (this sandbox freezes between sessions).' };
    },

    pnl() {
      const eq = q(`SELECT at, equity_usd FROM equity_valuations WHERE complete_data=1 ORDER BY at DESC LIMIT 500`).reverse();
      const ms = q(`SELECT m.position_id, m.multiple, m.first_observed_at, p.mint FROM milestones m JOIN paper_positions p ON p.id=m.position_id ORDER BY m.first_observed_at DESC LIMIT 50`);
      const closed = q(`SELECT id, mint, state, entry_total_usd FROM paper_positions WHERE state!='OPEN'`);
      const by = {}; for (const c of closed) by[c.state] = (by[c.state] ?? 0) + 1;
      const lat = q(`SELECT b.detected_at at, b.latency_ms FROM buy_events b WHERE b.origin='momentum' AND b.latency_ms IS NOT NULL ORDER BY b.detected_at DESC LIMIT 100`).reverse();
      return { equity_series: eq, milestones: ms, closed_by_state: by, closed_total: closed.length, latency_series: lat,
        note: 'Every point is a stored valuation row. Empty series are shown as empty, never as zero. Not proof of profitability.' };
    },
    journal() {
      const sig = q(`SELECT s.id, s.qualified_at at, s.mint, s.decision, s.reason_codes_json r, s.rule_version FROM signals s ORDER BY s.qualified_at DESC LIMIT 60`).map(r => ({ at: r.at, kind: 'signal', ref: r.id, mint: r.mint, title: r.decision + ' (' + r.rule_version + ')', detail: parse(r.r)?.join(', ') ?? '' }));
      const pos = q(`SELECT id, mint, entry_at, closed_at, state, origin FROM paper_positions ORDER BY entry_at DESC LIMIT 60`).flatMap(p => [{ at: p.entry_at, kind: 'entry', ref: p.id, mint: p.mint, title: 'Paper entry (' + p.origin + ')', detail: '' }, ...(p.closed_at ? [{ at: p.closed_at, kind: 'exit', ref: p.id, mint: p.mint, title: 'Position ' + p.state, detail: '' }] : [])]);
      const ev = q(`SELECT id, at, severity, code, detail_json FROM health_events WHERE code IN ('startup','loop-stalled','digest-failed','helius-credit-cap','credit-cap-warning') OR severity='ERROR' ORDER BY at DESC LIMIT 40`).map(h => ({ at: h.at, kind: 'event', ref: h.id, title: h.code + ' (' + h.severity + ')', detail: String(h.detail_json ?? '').slice(0, 160) }));
      return { entries: [...sig, ...pos, ...ev].sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, 100), note: 'Merged from stored signals, positions and health events. Tooltip/ref = row id.' };
    },
    weekly() {
      const since = new Date(Date.now() - 7 * 86400_000).toISOString();
      const cy = one(`SELECT COUNT(*) c, COALESCE(SUM(json_extract(detail_json,'$.leads')),0) l, COALESCE(SUM(json_extract(detail_json,'$.scanned')),0) s, COALESCE(SUM(json_extract(detail_json,'$.triggered')),0) t, COALESCE(SUM(json_extract(detail_json,'$.opened')),0) o FROM health_events WHERE code='momentum-cycle' AND at >= ?`, since);
      const sg = q(`SELECT decision, COUNT(*) n FROM signals WHERE qualified_at >= ? GROUP BY 1`, since);
      const st = one(`SELECT COUNT(*) n FROM health_events WHERE code='loop-stalled' AND at >= ?`, since).n;
      const pos = one(`SELECT COUNT(*) n FROM paper_positions WHERE entry_at >= ?`, since).n;
      const first = one(`SELECT MIN(at) t FROM health_events WHERE code='momentum-cycle'`).t;
      const parts = [`Window: last 7 days (data exists since ${first ?? 'n/a'}).`, `The scanner ran ${cy.c} cycles, saw ${cy.l} leads and scanned ${cy.s}.`, `${cy.t} coin(s) met the surge trigger and ${cy.o} paper entr${cy.o === 1 ? 'y was' : 'ies were'} opened.`,
        sg.length ? 'Signal decisions: ' + sg.map(x => `${x.n} ${x.decision}`).join(', ') + '.' : 'No signals were recorded.', `${pos} paper position(s) opened. ${st} loop-stall warning(s), usually the host sleeping rather than a hang.`,
        'This is a count of what happened, not a performance claim. Zero entries is a legitimate outcome.'];
      return { text: parts.join(' '), facts: { cycles: cy.c, leads: cy.l, scanned: cy.s, triggered: cy.t, opened: cy.o, signals: sg, stalls: st, positions: pos }, generated_at: new Date().toISOString(), note: 'Template text built only from stored rows; no model-written claims.' };
    },
    lab() {
      const marks = q(`SELECT position_id, marked_at, net_multiple FROM position_marks WHERE valuation_state='PRICED' AND net_multiple IS NOT NULL ORDER BY position_id, marked_at LIMIT 5000`);
      const pos = {}; for (const m of marks) (pos[m.position_id] ??= []).push({ t: m.marked_at, x: Number(m.net_multiple) });
      return { positions: Object.entries(pos).slice(0, 60).map(([id, series]) => ({ id, series: series.slice(-200) })), frozen: { size_usd: budget, max_open: maxOpen, tp_gross: cfg.take_profit_multiple, sl_net: cfg.exit_policy.stop_loss_net },
        note: 'What-if replays recorded PRICED marks only. It never changes the live frozen constants.' };
    },
    reports(id) {
      if (id) return one(`SELECT id, kind, title, body_md, created_at, period FROM reports WHERE id=?`, id) ?? null;
      return { reports: q(`SELECT id, kind, title, created_at, period, length(body_md) size FROM reports ORDER BY created_at DESC LIMIT 200`) };
    }
  };
}

export function startApp(cfg, { file = 'var/sewl.sqlite', chain = null, gecko = null, state = null } = {}) {
  const a = cfg.app ?? {};
  if (!a.enabled) return null;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const api = buildApi(db, cfg);
  const pw = process.env.SEWL_APP_PASSWORD;
  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end((typeof body === 'string' || Buffer.isBuffer(body)) ? body : JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'read-only app: GET only' });
    if (pw) {
      const got = (req.headers.authorization ?? '').startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':').slice(1).join(':') : null;
      if (got === null || !safeEq(got, pw)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SEWL"' }); return res.end('auth required'); }
    }
    const url = new URL(req.url, 'http://x'); const p = url.pathname;
    try {
      if (p.startsWith('/api/')) {
        const m = p.slice(5).split('/');
        if (m[0] === 'markets') return send(200, { source: 'worker scan (DEX Screener pairs for the current lead set)', at: state?.lastPairsAt ?? null, coins: state?.lastPairs ?? [] });
        if (m[0] === 'coin' && m[1]) { if (!chain) return send(503, { error: 'chain data unavailable (no Helius key)' }); try { return send(200, await chain.coin(m[1])); } catch (e) { return send(e.message === 'bad-address' ? 400 : e.message === 'rate-limited' ? 429 : 502, { error: String(e.message).slice(0, 100) }); } }
        if (m[0] === 'wallet' && m[1]) { if (!chain) return send(503, { error: 'chain data unavailable (no Helius key)' }); try { return send(200, await chain.wallet(m[1])); } catch (e) { return send(e.message === 'bad-address' ? 400 : e.message === 'rate-limited' ? 429 : 502, { error: String(e.message).slice(0, 100) }); } }
        if (m[0] === 'ohlcv' && m[1]) { if (!gecko) return send(503, { error: 'candles unavailable' }); try { return send(200, await gecko.ohlcv(m[1], url.searchParams.get('tf') ?? '1m')); } catch (e) { return send(e.message.startsWith('bad-') ? 400 : e.message === 'rate-limited' ? 429 : 502, { error: String(e.message).slice(0, 100) }); } }
        if (m[0] === 'reports' && m[1]) { const r = api.reports(Number(m[1])); return r ? send(200, r) : send(404, { error: 'not found' }); }
        if (['dashboard', 'signals', 'momentum', 'wallets', 'evidence', 'health', 'reports', 'pnl', 'journal', 'weekly', 'lab'].includes(m[0]) && m.length === 1) return send(200, api[m[0]]());
        if (m[0] === 'evidence' && m.length === 2) { // raw stored payload, so the browser can re-hash it. Localhost/full version only (never in snapshots).
          if (!/^[0-9a-f-]{36}$/i.test(m[1])) return send(400, { error: 'bad-id' });
          const row = db.prepare('SELECT id, payload_hash, payload_path FROM source_observations WHERE id=?').get(m[1]); if (!row?.payload_path) return send(404, { error: 'not found' });
          const f = path.resolve(row.payload_path); if (!f.startsWith(path.resolve('var', 'evidence') + path.sep) || !existsSync(f)) return send(404, { error: 'payload file not available' });
          if (statSync(f).size > 300_000) return send(413, { error: 'payload too large to verify in the browser' });
          const text = readFileSync(f, 'utf8');
          if (/api[-_]?key\s*[=:]|[?&]api-key=/i.test(text) || [process.env.HELIUS_API_KEY, process.env.TELEGRAM_BOT_TOKEN].some(s => s && s.length >= 8 && text.includes(s))) return send(403, { error: 'payload withheld: looks like it contains a credential' });
          return send(200, { id: row.id, sha256_stored: row.payload_hash, payload: text });
        }
        return send(404, { error: 'not found' });
      }
      const name = p === '/' ? 'index.html' : p.slice(1);
      if (!STATIC.has(name)) return send(404, { error: 'not found' });
      const f = path.join(ROOT, name);
      if (!existsSync(f)) return send(404, { error: 'not found' });
      return send(200, readFileSync(f), TYPES[path.extname(name)] ?? 'application/octet-stream');
    } catch (e) { return send(500, { error: 'internal', detail: String(e.message).slice(0, 120) }); }
  });
  server.listen(Number(process.env.SEWL_APP_PORT ?? a.port ?? 8787), process.env.SEWL_APP_HOST ?? a.host ?? '127.0.0.1');
  server.unref();
  return server;
}
