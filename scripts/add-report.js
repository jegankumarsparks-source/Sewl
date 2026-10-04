// Persist a report into the DB so the app can render it. Usage:
//   node scripts/add-report.js --kind hourly --title "Hourly 11:10" [--period 2026-10-04T11] --file report.md   (or body on stdin)
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
if (!args.kind || !args.title) { console.error('need --kind and --title'); process.exit(2); }
const body = args.file ? readFileSync(args.file, 'utf8') : readFileSync(0, 'utf8');
if (!body.trim()) { console.error('empty body'); process.exit(2); }
const db = openDb(args.db ?? 'var/sewl.sqlite');
const r = db.prepare(`INSERT INTO reports (kind, title, body_md, created_at, period) VALUES (?,?,?,?,?)`).run(args.kind, args.title, body, new Date().toISOString(), args.period ?? null);
console.log('report stored id=' + r.lastInsertRowid);
