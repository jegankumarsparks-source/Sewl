import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { startApp } from '../src/app.js';
import { writeSnapshots } from '../src/snapshot.js';

const cfg = { ...JSON.parse(readFileSync('config/experiment.json', 'utf8')), app: { enabled: true, host: '127.0.0.1', port: 0 } };
const listen = (s) => new Promise((r) => s.listening ? r(s.address().port) : s.on('listening', () => r(s.address().port)));
function seed() {
  const d = mkdtempSync(path.join(tmpdir(), 'p2-')); const file = path.join(d, 't.sqlite'); const db = openDb(file);
  db.prepare(`INSERT INTO experiments (id, name, state, starting_cash_usd, target_equity_usd, position_budget_usd, max_open_positions, policy_version, created_at) VALUES ('exp-1','t','PAPER_ACTIVE','500','800','20','12','v','2026-10-04T00:00:00Z')`).run();
  db.prepare(`INSERT INTO accounts (name, balance_usd) VALUES ('cash','500')`).run();
  const now = new Date().toISOString();
  for (let i = 0; i < 3; i++) db.prepare(`INSERT INTO health_events (id, component, at, severity, code, detail_json) VALUES (?,?,?,?,?,?)`).run('hc' + i, 'momentum', now, 'INFO', 'momentum-cycle', '{"leads":10,"scanned":9,"triggered":1,"opened":0}');
  db.prepare(`INSERT INTO health_events (id, component, at, severity, code, detail_json) VALUES ('hs','worker',?,'WARN','loop-stalled','{"last_done_age_s":900}')`).run(now);
  db.prepare(`INSERT INTO paper_positions (id, experiment_id, signal_id, mint, entry_at, entry_total_usd, state, origin) VALUES ('p1','exp-1',NULL,'MINT1',?,'20','OPEN','momentum')`).run(now);
  for (const [i, x] of [1.0, 1.2, 1.6].entries()) db.prepare(`INSERT INTO position_marks (id, position_id, marked_at, net_multiple, valuation_state) VALUES (?,?,?,?,'PRICED')`).run('m' + i, 'p1', now.slice(0, 19) + '.00' + i + 'Z', String(x));
  db.prepare(`INSERT INTO milestones (position_id, multiple, first_observed_at, mark_id) VALUES ('p1',1,?,'m2')`).run(now);
  return { d, file, db };
}
test('P2 API: pnl, journal, weekly, lab, health cockpit come from stored rows only', async () => {
  const { file } = seed(); const srv = startApp(cfg, { file }); const base = `http://127.0.0.1:${await listen(srv)}`;
  try {
    const j = async (p) => (await fetch(`${base}/api/${p}`)).json();
    const w = await j('weekly'); assert.equal(w.facts.cycles, 3); assert.equal(w.facts.leads, 30); assert.equal(w.facts.triggered, 3); assert.equal(w.facts.stalls, 1); assert.match(w.text, /3 cycles/); assert.match(w.text, /cycles completed this week: 3 vs \d+ expected if always-on/); assert.ok(w.facts.cycles_expected >= 0); assert.match(w.text, /not a performance claim/);
    const l = await j('lab'); assert.equal(l.positions[0].series.length, 3); assert.deepEqual(l.positions[0].series.map(s => s.x), [1.0, 1.2, 1.6]);
    const p = await j('pnl'); assert.equal(p.milestones[0].multiple, 1); assert.equal(p.closed_total, 0); assert.deepEqual(p.equity_series, []);
    const jr = await j('journal'); assert.ok(jr.entries.some(e => e.kind === 'entry') && jr.entries.some(e => e.title.startsWith('loop-stalled')));
    const h = await j('health'); assert.equal(h.helius.cap, 800000); assert.equal(h.helius.used, 0); assert.equal(h.cycles_6h.reduce((a, c) => a + c.n, 0), 3); assert.equal(h.stall_events[0].age_s, 900);
  } finally { srv.close(); }
});
test('evidence verify route: payload hash matches the stored hash; bad ids, traversal and credential-looking payloads are refused', async () => {
  const { file, db, d } = seed(); const cwd = process.cwd(); process.chdir(d); mkdirSync('var/evidence', { recursive: true });
  const good = JSON.stringify({ ok: 1 }), bad = '{"u":"https://x/?api-key=abc"}';
  writeFileSync('var/evidence/g.json', good); writeFileSync('var/evidence/b.json', bad);
  const ins = (id, p, body) => db.prepare(`INSERT INTO source_observations (id, provider, method, subject_key, requested_at, payload_hash, payload_path, quality_state) VALUES (?,?,?,?,?,?,?,?)`).run(id, 'x', 'm', 's', 't', createHash('sha256').update(body).digest('hex'), p, 'OK');
  const G = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', T = '33333333-3333-4333-8333-333333333333';
  ins(G, 'var/evidence/g.json', good); ins(B, 'var/evidence/b.json', bad); ins(T, '../../etc/passwd', 'x'); db.close();
  const srv = startApp(cfg, { file }); const base = `http://127.0.0.1:${await listen(srv)}`;
  try {
    const r = await (await fetch(`${base}/api/evidence/${G}`)).json(); assert.equal(r.payload, good); assert.equal(createHash('sha256').update(r.payload).digest('hex'), r.sha256_stored);
    assert.equal((await fetch(`${base}/api/evidence/${B}`)).status, 403); assert.equal((await fetch(`${base}/api/evidence/${T}`)).status, 404);
    assert.equal((await fetch(`${base}/api/evidence/..%2f..%2fetc`)).status, 400); assert.equal((await fetch(`${base}/api/evidence/${G}`, { method: 'POST' })).status, 405);
  } finally { srv.close(); process.chdir(cwd); }
});
test('snapshots include the P2 pages and still hold no secrets', async () => {
  const { db, d } = seed(); const dir = path.join(d, 'site', 'snap');
  const r = await writeSnapshots({ db, cfg, state: {}, dir, sleep: async () => {}, secrets: ['SUPERSECRETVALUE123'] });
  for (const f of ['pnl.json', 'journal.json', 'weekly.json', 'lab.json', 'health.json']) assert.ok(r.written.includes(f), f);
  assert.equal(r.rejected.length, 0);
  assert.ok(!readFileSync(path.join(dir, 'journal.json'), 'utf8').includes('evidence'), 'no evidence payloads in snapshots');
});
