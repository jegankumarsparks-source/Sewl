import { d, add, sub, mul, div, cmp, min, fmt, floorRaw } from './decimal.js';
import { uuid, nowIso, withTx } from './db.js';
import { USDC } from './sources/jupiter.js';

const EXP_ID = 'exp-1';

export function getExperiment(db) { return db.prepare(`SELECT * FROM experiments WHERE id=?`).get(EXP_ID); }
export function cashUsd(db) { return d(db.prepare(`SELECT balance_usd FROM accounts WHERE name='cash'`).get()?.balance_usd ?? '0'); }
export function realizedPnl(db) {
  const g = d(db.prepare(`SELECT balance_usd FROM accounts WHERE name='realized_gain'`).get()?.balance_usd ?? '0');
  const l = d(db.prepare(`SELECT balance_usd FROM accounts WHERE name='realized_loss'`).get()?.balance_usd ?? '0');
  return -(g + l); // balances are debit-normal: gains hold credit (negative), losses hold debit (positive)
}

function post(db, eventType, referenceId, lines) {
  const txId = uuid();
  const debitSum = lines.reduce((a, l) => a + d(l.debit), 0n);
  const creditSum = lines.reduce((a, l) => a + d(l.credit), 0n);
  if (cmp(debitSum, creditSum) !== 0) throw new Error('unbalanced journal: ' + eventType);
  db.prepare(`INSERT INTO journal_transactions (id, experiment_id, event_type, reference_id, posted_at, idempotency_key) VALUES (?,?,?,?,?,?)`)
    .run(txId, EXP_ID, eventType, referenceId, nowIso(), uuid());
  const ins = db.prepare(`INSERT INTO journal_lines (transaction_id, line_no, account, debit_usd, credit_usd) VALUES (?,?,?,?,?)`);
  lines.forEach((l, i) => {
    ins.run(txId, i, l.account, l.debit, l.credit);
    db.prepare(`INSERT INTO accounts (name, balance_usd) VALUES (?, '0') ON CONFLICT(name) DO NOTHING`).run(l.account);
    const bal = db.prepare(`SELECT balance_usd FROM accounts WHERE name=?`).get(l.account).balance_usd;
    const balRow = db.prepare(`SELECT balance_usd FROM accounts WHERE name=?`).get(l.account);
    if ((l.account === 'cash' || l.account.startsWith('position_cost')) &&
        cmp(d(balRow.balance_usd) + d(l.debit) - d(l.credit), 0n) < 0) throw new Error('negative balance: ' + l.account);
    db.prepare(`UPDATE accounts SET balance_usd=? WHERE name=?`).run(fmt(d(balRow.balance_usd) + d(l.debit) - d(l.credit)), l.account);
  });
  return txId;
}

// Conservative equity = cash + sum of FRESH liquidation marks of open positions.
export function conservativeEquity(db) {
  const open = db.prepare(`SELECT * FROM paper_positions WHERE state='OPEN'`).all();
  let openValue = 0n; const markIds = []; let complete = true;
  for (const pos of open) {
    // Latest PRICED mark wins. Never-marked position: book value = entry cost
    // (real accounting data, not a fabricated quote). Attempted-but-never-priced
    // (UNPRICEABLE with no PRICED mark anywhere): exact equity is NULL.
    const m = db.prepare(`SELECT * FROM position_marks WHERE position_id=? AND valuation_state='PRICED' ORDER BY marked_at DESC LIMIT 1`).get(pos.id);
    if (m) { openValue += d(m.liquidation_value_usd); markIds.push(m.id); continue; }
    const anyMark = db.prepare(`SELECT 1 FROM position_marks WHERE position_id=? LIMIT 1`).get(pos.id);
    if (anyMark) { complete = false; continue; }
    openValue += d(pos.entry_total_usd); // book value; documented relaxation
  }
  const cash = cashUsd(db);
  return { cash, openValue, equity: complete ? cash + openValue : null, complete, markIds };
}

// ATOMIC capacity + completion-latch check, then entry. Returns position row or {denied}.
export async function paperEntry(db, deps, { signalId, mint, entryUnitsRaw, decimals, quoteEvidenceId }) {
  const cfg = deps.cfg;
  return withTx(db, () => {
    const exp = getExperiment(db);
    if (exp.state === 'EXPERIMENT_COMPLETE') return { denied: 'experiment-complete' };
    if (exp.state !== 'PAPER_ACTIVE') return { denied: 'experiment-not-active:' + exp.state };
    const equity = conservativeEquity(db);
    if (equity.equity != null && cmp(equity.equity, d(cfg.target_equity_usd)) >= 0) {
      db.prepare(`UPDATE experiments SET state='EXPERIMENT_COMPLETE', completed_at=?, pause_reason='target-reached' WHERE id=? AND state!='EXPERIMENT_COMPLETE'`)
        .run(nowIso(), EXP_ID);
      return { denied: 'target-latched' };
    }
    if (!equity.complete) return { denied: 'unpriceable-holdings' };
    const cash = cashUsd(db);
    const openLimit = cfg.mode === 'rotation' ? Number(cfg.rotation.max_positions) : exp.max_open_positions;
    const openCount = Number(db.prepare(`SELECT COUNT(*) c FROM paper_positions WHERE state='OPEN'`).get().c);
    if (cfg.mode === 'rotation') {
      const totalEntries = Number(db.prepare(`SELECT COUNT(*) c FROM paper_positions WHERE experiment_id=?`).get(EXP_ID).c);
      if (totalEntries >= Number(cfg.rotation.max_total_entries)) return { denied: 'rotation-complete' };
    }
    let budget = d(cfg.position_budget_usd);
    if (cfg.mode === 'rotation' && cfg.rotation.position_pct_of_cash) {
      budget = mul(cash, d(cfg.rotation.position_pct_of_cash)); // compounding: size grows with equity
      if (cmp(budget, 1n) < 0) return { denied: 'budget-too-small' };
    }
    const remaining = min(d(openLimit - openCount), div(cash, budget));
    if (cmp(remaining, 1n) < 0) return { denied: 'no-capacity' };
    if (db.prepare(`SELECT 1 FROM paper_positions WHERE state='OPEN' AND mint=?`).get(mint)) return { denied: 'mint-already-open' };
    const id = uuid();
    db.prepare(`INSERT INTO paper_positions (id, experiment_id, signal_id, mint, entry_at, entry_units_raw, remaining_units_raw, decimals, entry_total_usd, entry_unit_cost_usd, state, exit_policy_version)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'OPEN', ?)`)
      .run(id, EXP_ID, signalId, mint, nowIso(), entryUnitsRaw, entryUnitsRaw, decimals, fmt(budget), fmt(div(budget, d(entryUnitsRaw))), 'exit-v1');
    db.prepare(`INSERT INTO paper_fills (id, position_id, side, at, units_raw, gross_usd, estimated_cost_usd, net_cash_delta_usd, fill_method, quote_evidence_id, idempotency_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), id, 'BUY', nowIso(), entryUnitsRaw, fmt(budget), cfg.friction.entry_fee_usd, '-' + fmt(budget), 'jupiter-quote-readonly', quoteEvidenceId, uuid());
    post(db, 'ENTRY', id, [
      { account: 'position_cost:' + id, debit: fmt(budget), credit: '0' },
      { account: 'cash', debit: '0', credit: fmt(budget) }
    ]);
    return { id };
  });
}

// Quote-based marks, milestones, exit policy. Called on a schedule.
export async function markAndExitCycle(db, deps) {
  const cfg = deps.cfg;
  const jupiter = deps.jupiter;
  const outbox = deps.outbox;
  const open = db.prepare(`SELECT * FROM paper_positions WHERE state='OPEN'`).all();
  const markIds = [];
  for (const pos of open) {
    let grossUsd = null, liquidation = null, state = 'UNPRICEABLE', qeId = null;
    try {
      const q = await jupiter.sellQuote(pos.mint, pos.remaining_units_raw);
      qeId = q.evidenceId;
      grossUsd = div(d(q.quote.outAmount), d(1e6)); // USDC 6dp, full-size sell quote
      liquidation = grossUsd - mul(grossUsd, d(cfg.friction.exit_haircut)) - d(cfg.friction.exit_fee_usd);
      if (cmp(liquidation, 0n) < 0) liquidation = 0n;
      state = 'PRICED';
    } catch { /* one failed call is NOT evidence of zero value */ }
    const markId = uuid();
    const multiple = liquidation == null ? null : div(liquidation, d(pos.entry_total_usd));
    db.prepare(`INSERT INTO position_marks (id, position_id, marked_at, units_raw, liquidation_value_usd, indicative_value_usd, net_multiple, valuation_state, quote_evidence_id)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(markId, pos.id, nowIso(), pos.remaining_units_raw, liquidation == null ? null : fmt(liquidation), grossUsd == null ? null : fmt(grossUsd), multiple == null ? null : fmt(multiple), state, qeId);
    markIds.push(markId);
    if (liquidation != null) {
      for (const m of [2, 3, 5, 10]) {
        if (cmp(liquidation, mul(d(m), d(pos.entry_total_usd))) >= 0 &&
            !db.prepare(`SELECT 1 FROM milestones WHERE position_id=? AND multiple=?`).get(pos.id, m)) {
          db.prepare(`INSERT INTO milestones (position_id, multiple, first_observed_at, mark_id) VALUES (?,?,?,?)`).run(pos.id, m, nowIso(), markId);
          outbox?.enqueue('milestone', { position: pos.id, mint: pos.mint, multiple: m, liquidation: fmt(liquidation), budget: pos.entry_total_usd });
        }
      }
      const holdMs = Date.now() - new Date(pos.entry_at).getTime();
      const stopNet = cfg.mode === 'rotation' ? cfg.rotation.stop_loss_net : cfg.exit_policy.stop_loss_net;
      const holdHours = cfg.mode === 'rotation' ? Number(cfg.rotation.max_hold_hours) : Number(cfg.exit_policy.max_hold_hours);
      const stop = cmp(liquidation, mul(d(pos.entry_total_usd), d(stopNet))) <= 0;
      const timed = holdMs >= holdHours * 3600_000;
      // TP triggers on the GROSS quote reaching budget*multiple; friction is deducted from proceeds.
      // (Requiring NET >= 1.5x would make TP unreachable at exactly 1.5x spot: 30*0.99-0.25 = 29.45.)
      const tpMult = cfg.mode === 'rotation' ? cfg.rotation.take_profit_multiple : cfg.take_profit_multiple;
      const tp = grossUsd != null && tpMult && cmp(grossUsd, mul(d(pos.entry_total_usd), d(tpMult))) >= 0;
      if (stop || timed || tp) await paperExit(db, deps, pos.id, tp ? 'TAKE_PROFIT' : stop ? 'STOP_LOSS' : 'TIME_LIMIT', fmt(liquidation), qeId);
    } else {
      // Approved evidence policy: no sell quote for N consecutive mark cycles since the last
      // PRICED mark => treat as worthless (rug). One failed call is never evidence by itself.
      const cycles = Number(cfg.rug_writeoff_unpriceable_cycles ?? 0);
      if (cycles > 0) {
        const consec = db.prepare(`SELECT COUNT(*) c FROM position_marks WHERE position_id=? AND valuation_state='UNPRICEABLE'
          AND marked_at >= COALESCE((SELECT MAX(marked_at) FROM position_marks WHERE position_id=? AND valuation_state='PRICED'), '1970-01-01')`)
          .get(pos.id, pos.id).c;
        if (consec >= cycles) await paperExit(db, deps, pos.id, 'RUG_WRITE_OFF', '0', null);
      }
    }
  }
  // equity valuation snapshot
  const e = conservativeEquity(db);
  const valId = uuid();
  const openBasisRow = db.prepare(`SELECT SUM(CAST(entry_total_usd AS REAL)) s FROM paper_positions WHERE state='OPEN'`).get().s ?? 0;
  const unrealized = e.complete ? e.openValue - d(String(openBasisRow)) : null;
  db.prepare(`INSERT INTO equity_valuations (id, experiment_id, at, cash_usd, open_value_usd, equity_usd, unrealized_pnl_usd, realized_pnl_usd, complete_data, mark_ids_json)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(valId, EXP_ID, nowIso(), fmt(e.cash), e.complete ? fmt(e.openValue) : null, e.equity == null ? null : fmt(e.equity),
      unrealized == null ? null : fmt(unrealized), fmt(realizedPnl(db)), e.complete ? 1 : 0, JSON.stringify(markIds));
  if (e.equity != null && cmp(e.equity, d(cfg.target_equity_usd)) >= 0) {
    withTx(db, () => {
      db.prepare(`UPDATE experiments SET state='EXPERIMENT_COMPLETE', completed_at=?, completion_valuation_id=?, pause_reason='target-reached' WHERE id=? AND state!='EXPERIMENT_COMPLETE'`)
        .run(nowIso(), valId, EXP_ID);
    });
    outbox?.enqueue('complete', { equity: fmt(e.equity), at: nowIso() });
  }
  if (cfg.mode === 'rotation') {
    const openLeft = Number(db.prepare(`SELECT COUNT(*) c FROM paper_positions WHERE state='OPEN'`).get().c);
    const totalEntries = Number(db.prepare(`SELECT COUNT(*) c FROM paper_positions WHERE experiment_id=?`).get(EXP_ID).c);
    if (totalEntries >= Number(cfg.rotation.max_total_entries) && openLeft === 0) {
      withTx(db, () => {
        db.prepare(`UPDATE experiments SET state='EXPERIMENT_COMPLETE', completed_at=?, completion_valuation_id=?, pause_reason='rotation-complete' WHERE id=? AND state!='EXPERIMENT_COMPLETE'`)
          .run(nowIso(), valId, EXP_ID);
      });
      outbox?.enqueue('complete', { equity: e.equity == null ? null : fmt(e.equity), at: nowIso(), reason: 'rotation coins exhausted' });
    }
  }
  return e;
}

export async function paperExit(db, deps, positionId, reason, liquidationUsd, quoteEvidenceId) {
  const cfg = deps.cfg;
  return withTx(db, () => {
    const pos = db.prepare(`SELECT * FROM paper_positions WHERE id=? AND state='OPEN'`).get(positionId);
    if (!pos) return { denied: 'not-open' };
    const proceeds = d(liquidationUsd);
    const basis = d(pos.entry_total_usd);
    const pnl = proceeds - basis;
    db.prepare(`UPDATE paper_positions SET state='CLOSED', closed_at=? WHERE id=?`).run(nowIso(), positionId);
    db.prepare(`INSERT INTO paper_fills (id, position_id, side, at, units_raw, gross_usd, estimated_cost_usd, net_cash_delta_usd, fill_method, quote_evidence_id, idempotency_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), positionId, 'SELL', nowIso(), pos.remaining_units_raw, fmt(proceeds), cfg.friction.exit_fee_usd, fmt(proceeds), 'jupiter-quote-readonly', quoteEvidenceId, uuid());
    const lines = [
      { account: 'cash', debit: fmt(proceeds), credit: '0' },
      { account: 'position_cost:' + positionId, debit: '0', credit: fmt(basis) }
    ];
    if (pnl >= 0n) lines.push({ account: 'realized_gain', debit: '0', credit: fmt(pnl) });
    else lines.push({ account: 'realized_loss', debit: fmt(-pnl), credit: '0' });
    post(db, 'EXIT', positionId, lines);
    deps.outbox?.enqueue('exit', { position: positionId, mint: pos.mint, reason, proceeds: fmt(proceeds), basis: fmt(basis), pnl: fmt(pnl) });
    return { pnl: fmt(pnl) };
  });
}
