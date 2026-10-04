// SEWL read-only web app. PAPER ONLY. GET only, no write endpoints, no secrets in any response.
// Binds to 127.0.0.1 by default; expose only through an SSH tunnel / firewalled IP (see DEPLOYMENT.md).
// Optional HTTP Basic auth: set SEWL_APP_PASSWORD in the environment (never in git).
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { latencyStats } from './momentum.js';

const ROOT = path.resolve('app');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.json': 'application/json' };
const STATIC = new Set(['index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'sw.js', 'icon.svg']);
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
        b.origin, b.latency_ms, b.candle_start_ms, b.detection_ms, b.entry_ms, b.candle_time_source
        FROM signals s LEFT JOIN buy_events b ON b.id = json_extract(s.buy_event_ids_json,'$[0]') ORDER BY s.qualified_at DESC LIMIT 60`)
        .map(r => ({ ...r, origin: r.origin ?? (r.rule_version === 'momentum-v1' ? 'momentum' : 'whale'), reasons: parse(r.reason_codes_json) ?? [], reason_codes_json: undefined })) };
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
        stall_note: 'loop-stalled = a loop did not finish within 3x its interval: a hang OR a host pause (this sandbox freezes between sessions).' };
    },
    reports(id) {
      if (id) return one(`SELECT id, kind, title, body_md, created_at, period FROM reports WHERE id=?`, id) ?? null;
      return { reports: q(`SELECT id, kind, title, created_at, period, length(body_md) size FROM reports ORDER BY created_at DESC LIMIT 200`) };
    }
  };
}

export function startApp(cfg, { file = 'var/sewl.sqlite' } = {}) {
  const a = cfg.app ?? {};
  if (!a.enabled) return null;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const api = buildApi(db, cfg);
  const pw = process.env.SEWL_APP_PASSWORD;
  const server = http.createServer((req, res) => {
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end((typeof body === 'string' || Buffer.isBuffer(body)) ? body : JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'read-only app: GET only' });
    if (pw) {
      const got = (req.headers.authorization ?? '').startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':').slice(1).join(':') : null;
      if (got !== pw) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SEWL"' }); return res.end('auth required'); }
    }
    const url = new URL(req.url, 'http://x'); const p = url.pathname;
    try {
      if (p.startsWith('/api/')) {
        const m = p.slice(5).split('/');
        if (m[0] === 'reports' && m[1]) { const r = api.reports(Number(m[1])); return r ? send(200, r) : send(404, { error: 'not found' }); }
        if (['dashboard', 'signals', 'momentum', 'wallets', 'evidence', 'health', 'reports'].includes(m[0]) && m.length === 1) return send(200, api[m[0]]());
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
