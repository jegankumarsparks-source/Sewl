import { uuid, nowIso } from './db.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TEMPLATE_VERSION = 'tg-v1';

export class Outbox {
  constructor(db) { this.db = db; }
  enqueue(kind, payload) {
    const key = `${kind}:${payload.mint ?? ''}:${payload.position ?? ''}:${payload.multiple ?? ''}:${payload.at ?? ''}:${Date.now()}`;
    this.db.prepare(`INSERT OR IGNORE INTO telegram_outbox (id, event_key, destination_ref, template_version, payload_json, state)
      VALUES (?,?,?,?,?, 'PENDING')`).run(uuid(), key, 'default', TEMPLATE_VERSION, JSON.stringify({ kind, ...payload }));
  }
  card(kind, p) {
    switch (kind) {
      case 'signal': return `🟡 PAPER SIGNAL\nmint: ${esc(p.mint)}\nscore: ${p.score ?? 'n/a'} | risk: ${p.risk ?? 'n/a'}\nnotional: $${p.notional ?? 'n/a'} | venue: ${p.venue ?? 'n/a'}\ndecision: ${p.decision}\nreasons: ${(p.reasons ?? []).map(esc).join(', ') || '-'}`;
      case 'milestone': return `📈 MILESTONE\nposition: ${esc(p.position)}\nmint: ${esc(p.mint)}\n${p.multiple}X first observed\nliquidation estimate: $${p.liquidation} (budget $${p.budget})\nPaper mark only - NOT booked profit.`;
      case 'exit': return `🔴 PAPER EXIT\nposition: ${esc(p.position)}\nmint: ${esc(p.mint)}\nreason: ${esc(p.reason)}\nproceeds: $${p.proceeds} | basis: $${p.basis}\nrealized P&L: $${p.pnl}`;
      case 'digest': return `📋 DAILY DIGEST\ncash: $${p.cash}\nrealized P&L: $${p.realized}\nequity: ${p.equity ?? 'UNPRICEABLE'}\nopen positions: ${p.open}\nstate: ${p.state}`;
      case 'boot': return `✅ SEWL boot ok\npaper-only worker alive\nat: ${esc(p.at)}`;
      case 'warn': return `⚠️ SEWL WARNING\n${esc(p.text)}`;
      case 'complete': return `🏁 EXPERIMENT COMPLETE\ntarget equity reached: $${p.equity}\nno new entries are allowed now.`;
      default: return esc(JSON.stringify(p));
    }
  }
  async flush(botToken, chatId) {
    if (!botToken || !chatId) return { skipped: true };
    const rows = this.db.prepare(`SELECT * FROM telegram_outbox WHERE state IN ('PENDING','RETRY') AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY rowid LIMIT 5`).all(nowIso());
    let sent = 0;
    for (const r of rows) {
      const text = this.card(JSON.parse(r.payload_json).kind, JSON.parse(r.payload_json));
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(10000)
        });
        const j = await res.json().catch(() => null);
        if (res.ok && j?.ok) {
          this.db.prepare(`UPDATE telegram_outbox SET state='SENT', telegram_message_id=?, attempts=attempts+1 WHERE id=?`).run(String(j.result.message_id), r.id);
          sent++;
        } else if (res.status === 429) {
          this.db.prepare(`UPDATE telegram_outbox SET state='RETRY', attempts=attempts+1, next_attempt_at=?, last_error=? WHERE id=?`)
            .run(new Date(Date.now() + 2000).toISOString(), '429', r.id);
        } else {
          this.db.prepare(`UPDATE telegram_outbox SET state='BLOCKED', attempts=attempts+1, last_error=? WHERE id=?`).run(JSON.stringify(j).slice(0, 200), r.id);
        }
      } catch (e) {
        // initiated HTTP call is not confirmed delivery; a timeout (TimeoutError/AbortError) leaves delivery UNKNOWN -> never SENT
        this.db.prepare(`UPDATE telegram_outbox SET state='AMBIGUOUS_DELIVERY', attempts=attempts+1, last_error=? WHERE id=?`).run(String(e).slice(0, 200), r.id);
      }
      await new Promise(r2 => setTimeout(r2, 1100)); // <=1/sec per chat
    }
    return { sent };
  }
}
