// commits var/sewl.sqlite back to the GitHub repo so state survives restarts
const fs = await import('node:fs');
const TOK = process.env.GITHUB_STATE_TOKEN;
const REPO = process.env.GITHUB_STATE_REPO || 'jegankumarsparks-source/Sewl';
if (!TOK || !fs.existsSync('var/sewl.sqlite')) process.exit(0);
const api = 'https://api.github.com/repos/' + REPO;
const H = { Authorization: 'Bearer ' + TOK, Accept: 'application/vnd.github+json', 'User-Agent': 'sewl-state' };
try {
  const cur = await fetch(api + '/contents/var/sewl.sqlite?ref=main', { headers: H }).then(r => r.ok ? r.json() : null);
  const content = fs.readFileSync('var/sewl.sqlite').toString('base64');
  const r = await fetch(api + '/contents/var/sewl.sqlite', { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'state sync [skip ci]', content, branch: 'main', sha: cur?.sha }) });
  console.log('[state-sync]', r.ok ? 'ok' : r.status);
} catch (e) { console.log('[state-sync] skipped:', e.message); }
process.exit(0);
