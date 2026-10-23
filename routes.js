// Routes, request guard and the HTTP server. createServer(db) builds a server around a given database.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all as dbAll, get as dbGet, run as dbRun, tx as dbTx } from './db.js';
import { HttpError, bad, notFound } from './errors.js';
import { usd, num, str, microsToString, toMicros } from './parse.js';
import { importStatement, relink } from './import.js';
import { songsWithStats, dashboard, payouts, payoutSummary, advances, payments } from './queries.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 25e6) { reject(new HttpError(413, 'Body too large')); req.destroy(); } });
  req.on('end', () => {
    if (!data) return resolve({});
    try { resolve(JSON.parse(data)); } catch { reject(bad('Invalid JSON')); }
  });
  req.on('error', reject);
});

const requireStr = (v, name) => { const s = str(v); if (!s) throw bad(`${name} is required`); return s; };
const requireNum = (v, name) => { const n = num(v); if (n == null) throw bad(`${name} must be a number`); return n; };

export function createRoutes(db) {
  const all = (q, ...p) => dbAll(db, q, ...p);
  const get = (q, ...p) => dbGet(db, q, ...p);
  const run = (q, ...p) => dbRun(db, q, ...p);
  const tx = (fn) => dbTx(db, fn);
  // run() on an UPDATE/DELETE by id; 404 when no row matched
  const runOne = (what, sql, ...p) => { const r = run(sql, ...p); if (!Number(r.changes)) throw notFound(what); return r; };

  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

  route('GET', '/api/dashboard', ({ url }) => dashboard(db, url.searchParams));
  route('GET', '/api/songs', () => songsWithStats(db));
  route('POST', '/api/songs', ({ body }) => {
    const r = run('INSERT INTO songs (title, isrc, release, notes) VALUES (?,?,?,?)',
      requireStr(body.title, 'title'), str(body.isrc), str(body.release), str(body.notes));
    const id = Number(r.lastInsertRowid);
    // link any previously unmatched earnings
    const linked = relink(db);
    return { id, linked };
  });
  route('PUT', '/api/songs/:id', ({ params, body }) => {
    runOne('Song', 'UPDATE songs SET title=?, isrc=?, release=?, notes=? WHERE id=?',
      requireStr(body.title, 'title'), str(body.isrc), str(body.release), str(body.notes), params.id);
    return { linked: relink(db) };
  });
  route('DELETE', '/api/songs/:id', ({ params }) => { runOne('Song', 'DELETE FROM songs WHERE id=?', params.id); return { ok: true }; });
  route('PUT', '/api/songs/:id/splits', ({ params, body }) => {
    if (!get('SELECT 1 FROM songs WHERE id=?', params.id)) throw notFound('Song');
    const list = Array.isArray(body.splits) ? body.splits : [];
    if (list.some((s) => s == null || typeof s !== 'object')) throw bad('Each split must be an object with contributor_id and pct');
    for (const s of list) {
      if (!Number.isInteger(s.contributor_id)) throw bad('Each split needs an integer contributor_id');
      if (!get('SELECT 1 FROM contributors WHERE id=?', s.contributor_id)) throw notFound(`Contributor ${s.contributor_id}`);
    }
    const total = list.reduce((a, s) => a + requireNum(s.pct, 'pct'), 0);
    if (total > 100.0001) throw bad(`Splits total ${total}%, which exceeds 100%`);
    if (list.some((s) => s.pct < 0)) throw bad('Split percentages cannot be negative');
    const ids = list.map((s) => s.contributor_id);
    if (new Set(ids).size !== ids.length) throw bad('A contributor appears twice on this song');
    tx(() => {
      run('DELETE FROM splits WHERE song_id=?', params.id);
      for (const s of list) run('INSERT INTO splits (song_id, contributor_id, pct) VALUES (?,?,?)', params.id, s.contributor_id, s.pct);
    });
    return { ok: true, total };
  });

  route('GET', '/api/contributors', () => all('SELECT * FROM contributors ORDER BY name'));
  route('POST', '/api/contributors', ({ body }) => ({
    id: Number(run('INSERT INTO contributors (name, email) VALUES (?,?)', requireStr(body.name, 'name'), str(body.email)).lastInsertRowid),
  }));
  route('DELETE', '/api/contributors/:id', ({ params }) => { runOne('Contributor', 'DELETE FROM contributors WHERE id=?', params.id); return { ok: true }; });
  route('GET', '/api/payouts', () => payouts(db));
  route('GET', '/api/payouts/summary', () => payoutSummary(db));

  route('GET', '/api/statements', () => all(`
    SELECT st.*, COALESCE(SUM(e.amount_micros),0) total,
           SUM(CASE WHEN e.song_id IS NULL THEN 1 ELSE 0 END) unmatched
    FROM statements st LEFT JOIN earnings e ON e.statement_id = st.id
    GROUP BY st.id ORDER BY st.id DESC`).map((st) => ({ ...st, total: usd(st.total) })));
  route('POST', '/api/statements/import', ({ body }) => importStatement(db, body));
  route('DELETE', '/api/statements/:id', ({ params }) => { runOne('Statement', 'DELETE FROM statements WHERE id=?', params.id); return { ok: true }; });
  route('GET', '/api/unmatched', () => all(`
    SELECT COALESCE(raw_title, raw_isrc, 'Unknown') name, raw_title, raw_isrc, COUNT(*) rows, SUM(amount_micros) total,
           CASE WHEN SUM(match_reason = 'ambiguous') > 0 THEN 'ambiguous' ELSE 'none' END reason
    FROM earnings WHERE song_id IS NULL GROUP BY raw_title, raw_isrc ORDER BY total DESC`).map((u) => ({ ...u, total: usd(u.total) })));
  route('POST', '/api/unmatched/assign', ({ body }) => {
    const sid = requireNum(body.song_id, 'song_id');
    if (!get('SELECT 1 FROM songs WHERE id=?', sid)) throw notFound('Song');
    const r = run(`UPDATE earnings SET song_id = ?, match_reason = NULL WHERE song_id IS NULL AND COALESCE(raw_title,'') = ? AND COALESCE(raw_isrc,'') = ?`,
      sid, body.raw_title || '', body.raw_isrc || '');
    return { updated: Number(r.changes) };
  });

  route('GET', '/api/payments', () => payments(db));
  route('POST', '/api/payments', ({ body }) => {
    const exp = num(body.expected_amount), rec = num(body.received_amount);
    if (exp == null && rec == null) throw bad('Provide an expected or received amount');
    return { id: Number(run('INSERT INTO payments (source, expected_micros, expected_date, received_micros, received_date, notes) VALUES (?,?,?,?,?,?)',
      requireStr(body.source, 'source'), exp == null ? null : toMicros(exp), str(body.expected_date), rec == null ? null : toMicros(rec), str(body.received_date), str(body.notes)).lastInsertRowid) };
  });
  route('PUT', '/api/payments/:id', ({ params, body }) => {
    const cur = get('SELECT * FROM payments WHERE id=?', params.id);
    if (!cur) throw notFound('Payment');
    // only fields present in the body change; an explicit null clears received_*
    const has = (k) => Object.hasOwn(body, k);
    run('UPDATE payments SET received_micros=?, received_date=?, notes=? WHERE id=?',
      has('received_amount') ? (num(body.received_amount) == null ? null : toMicros(num(body.received_amount))) : cur.received_micros,
      has('received_date') ? str(body.received_date) : cur.received_date,
      str(body.notes) ?? cur.notes, params.id);
    return { ok: true };
  });
  route('DELETE', '/api/payments/:id', ({ params }) => { runOne('Payment', 'DELETE FROM payments WHERE id=?', params.id); return { ok: true }; });

  route('GET', '/api/advances', () => advances(db));
  route('POST', '/api/advances', ({ body }) => ({
    id: Number(run('INSERT INTO advances (source, amount_micros, date, notes) VALUES (?,?,?,?)',
      requireStr(body.source, 'source'), toMicros(requireNum(body.amount, 'amount')), str(body.date), str(body.notes)).lastInsertRowid),
  }));
  route('DELETE', '/api/advances/:id', ({ params }) => { runOne('Advance', 'DELETE FROM advances WHERE id=?', params.id); return { ok: true }; });

  route('GET', '/api/export/earnings.csv', () => {
    const rows = all(`SELECT COALESCE(s.title, e.raw_title) title, e.raw_isrc isrc, e.platform, e.territory, e.period, e.units, e.amount_micros, st.source
                      FROM earnings e JOIN statements st ON st.id = e.statement_id LEFT JOIN songs s ON s.id = e.song_id
                      ORDER BY e.period, title`);
    // Text starting with = + - @ (or tab/CR) is executed as a formula by Excel/Sheets, and titles, sources etc.
    // come from imported files, so prefix a quote to keep them inert. Numbers (incl. negatives) are left alone.
    const esc = (v) => {
      if (v == null) return '';
      let t = String(v);
      if (typeof v === 'string' && /^[=+\-@\t\r]/.test(t)) t = `'${t}`;
      return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const head = 'title,isrc,platform,territory,period,units,amount,source';
    return { __csv: [head, ...rows.map((r) => [...[r.title, r.isrc, r.platform, r.territory, r.period].map(esc), r.units, microsToString(r.amount_micros), esc(r.source)].join(','))].join('\n') };
  });
  return routes;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Guards against other websites driving the API from the user's browser: a Host check stops DNS
// rebinding, an Origin check stops cross-site requests, and requiring a JSON content type forces
// a CORS preflight (which this server never approves) for anything that writes.
export function guardRequest(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!LOCAL_HOSTS.has(host)) throw new HttpError(403, 'Forbidden host');
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) throw new HttpError(403, 'Cross-origin requests are not allowed');
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) {
      throw new HttpError(415, 'Content-Type must be application/json');
    }
  }
}

export function createServer(db) {
  const routes = createRoutes(db);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        guardRequest(req);
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.re);
          if (!m) continue;
          const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
          const out = r.fn({ params: m.groups || {}, body, url });
          if (out && out.__csv != null) {
            res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="earnings.csv"' });
            return res.end(out.__csv);
          }
          return json(res, 200, out);
        }
        return json(res, 404, { error: 'Not found' });
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const full = path.join(PUBLIC_DIR, file);
      if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        res.writeHead(404); return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      fs.createReadStream(full).pipe(res);
    } catch (e) {
      const status = e.status || (/UNIQUE|constraint/i.test(e.message) ? 409 : 500);
      json(res, status, { error: e.message });
    }
  });
}
