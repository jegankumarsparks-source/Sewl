import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { nowIso, uuid } from './db.js';

export function recordObservation(db, { provider, method, subject = null, requestedAt = null, body = null, status = 'OK', error = null, httpStatus = null, slot = null }) {
  const id = uuid();
  let hash = null, p = null;
  if (body != null) {
    const s = typeof body === 'string' ? body : JSON.stringify(body);
    hash = createHash('sha256').update(s).digest('hex');
    p = path.join('var', 'evidence', id + '.json');
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, s);
  }
  db.prepare(`INSERT INTO source_observations
    (id, provider, method, subject_key, requested_at, received_at, slot, http_status, payload_hash, payload_path, quality_state, error_code)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, provider, method, subject, requestedAt ?? nowIso(), nowIso(), slot, httpStatus, hash, p, status, error);
  return id;
}
