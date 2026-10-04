import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { startApp } from '../src/app.js';

const cfg = { ...JSON.parse(readFileSync('config/experiment.json', 'utf8')), app: { enabled: true, host: '127.0.0.1', port: 0 } };
function seed() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'sewl-')), 't.sqlite'); const db = openDb(file);
  db.prepare(`INSERT INTO experiments (id, name, state, starting_cash_usd, target_equity_usd, position_budget_usd, max_open_positions, policy_version, created_at) VALUES ('exp-1','t','PAPER_ACTIVE','500','800','20',12,'v','now')`).run();
  db.prepare(`INSERT INTO accounts (name, balance_usd) VALUES ('cash','500')`).run();
  db.prepare(`INSERT INTO reports (kind, title, body_md, created_at) VALUES ('hourly','H1','# Hi\n\n- a\n\n<script>alert(1)</script>','2026-10-04T00:00:00Z')`).run();
  db.prepare(`INSERT INTO health_events (id, component, at, severity, code, detail_json) VALUES ('h1','worker','2026-10-04T00:00:00Z','INFO','startup','{"version":"x"}')`).run();
  return { file, db };
}
const listen = (s) => new Promise((r) => s.listening ? r(s.address().port) : s.on('listening', () => r(s.address().port)));

test('app: GET endpoints answer, non-GET is refused (read-only)', async () => {
  const { file } = seed(); const srv = startApp(cfg, { file }); const port = await listen(srv); const base = `http://127.0.0.1:${port}`;
  try {
    for (const p of ['dashboard', 'signals', 'momentum', 'wallets', 'evidence', 'health', 'reports', 'reports/1']) {
      const r = await fetch(`${base}/api/${p}`); assert.equal(r.status, 200, p);
    }
    assert.equal((await fetch(`${base}/api/reports/999`)).status, 404);
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await fetch(`${base}/api/dashboard`, { method: m })).status, 405, m);
    const dash = await (await fetch(`${base}/api/dashboard`)).json();
    assert.equal(dash.split.reserve_usd, 260); assert.equal(dash.equity_usd, null); // no valuation yet -> NULL, not 0
  } finally { srv.close(); }
});

test('app: static whitelist blocks traversal and secrets; responses carry no secrets', async () => {
  const { file } = seed(); const srv = startApp(cfg, { file }); const port = await listen(srv); const base = `http://127.0.0.1:${port}`;
  try {
    for (const p of ['/.env', '/../.env', '/..%2f.env', '/var/sewl.sqlite', '/config/experiment.json', '/src/main.js', '/package.json']) assert.equal((await fetch(base + p)).status, 404, p);
    const home = await fetch(base + '/'); assert.equal(home.status, 200); assert.match(await home.text(), /^<!doctype html>/i); // real HTML, not a JSON-serialised Buffer
    assert.match(await (await fetch(base + '/app.css')).text(), /--/);
    let all = '';
    for (const p of ['dashboard', 'signals', 'momentum', 'wallets', 'evidence', 'health', 'reports']) all += await (await fetch(`${base}/api/${p}`)).text();
    assert.ok(!/[0-9]{8,10}:[A-Za-z0-9_-]{30,}|github_pat_|ghp_|TELEGRAM|HELIUS_API_KEY|api-key=/.test(all));
  } finally { srv.close(); }
});

test('app: optional password (Basic) is enforced when set', async () => {
  const { file } = seed(); process.env.SEWL_APP_PASSWORD = 'pw-test';
  const srv = startApp(cfg, { file }); const port = await listen(srv); const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/api/dashboard`)).status, 401);
    assert.equal((await fetch(`${base}/api/dashboard`, { headers: { authorization: 'Basic ' + Buffer.from('u:pw-test').toString('base64') } })).status, 200);
  } finally { srv.close(); delete process.env.SEWL_APP_PASSWORD; }
});

test('reports archive: stored report is listed and returned verbatim (escaped by the client renderer)', async () => {
  const { file } = seed(); const srv = startApp(cfg, { file }); const port = await listen(srv); const base = `http://127.0.0.1:${port}`;
  try {
    const list = await (await fetch(`${base}/api/reports`)).json(); assert.equal(list.reports.length, 1);
    const r = await (await fetch(`${base}/api/reports/1`)).json(); assert.ok(r.body_md.includes('<script>')); // raw text stored, escaped at render time
    const js = readFileSync('app/app.js', 'utf8'); assert.ok(js.includes('const esc =') && js.includes('esc(b)')); // renderer escapes code/text
  } finally { srv.close(); }
});
