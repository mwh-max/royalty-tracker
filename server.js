// Royalty Tracker: dependency-free server (Node 22+, built-in node:sqlite).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import * as sql from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const db = sql.openDb(process.env.DB_FILE || path.join(__dirname, 'royalties.db'));

// Money is stored as integer micro-dollars (1e-6 USD) so sums are exact and sub-cent per-stream
// amounts survive; the API still speaks decimal dollars. Floats only appear when converting at the edges.
const MICROS = 1_000_000;
const usd = (m) => (m == null ? null : m / MICROS);

// ---------- helpers ----------
const all = (q, ...p) => sql.all(db, q, ...p);
const get = (q, ...p) => sql.get(db, q, ...p);
const run = (q, ...p) => sql.run(db, q, ...p);
const tx = (fn) => sql.tx(db, fn);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);
const notFound = (what) => new HttpError(404, `${what} not found`);
// run() on an UPDATE/DELETE by id; 404 when no row matched
const runOne = (what, sql, ...p) => { const r = run(sql, ...p); if (!Number(r.changes)) throw notFound(what); return r; };


const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v == null ? null : String(v).trim() || null);

// RFC 4180-ish CSV parser (quotes, escaped quotes, CRLF, embedded newlines).
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0];
  const delim = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const COLS = {
  title: ['title', 'track', 'track title', 'song', 'song title', 'track name', 'work title', 'title of work'],
  isrc: ['isrc'],
  platform: ['platform', 'store', 'dsp', 'service', 'channel', 'retailer', 'source', 'sales type'],
  territory: ['territory', 'country', 'country of sale', 'region', 'country/region'],
  units: ['units', 'quantity', 'streams', 'plays', 'quantity sold', 'unit', 'performances'],
  amount: ['amount', 'earnings', 'revenue', 'royalty', 'royalties', 'net', 'net revenue', 'earnings (usd)', 'payable', 'total earned', 'amount (usd)', 'net amount'],
  period: ['period', 'date', 'month', 'sale month', 'reporting month', 'sales period', 'reporting period', 'sale date', 'statement period'],
};

function mapHeaders(headers) {
  const norm = headers.map((h) => h.trim().toLowerCase());
  const map = {};
  for (const [key, names] of Object.entries(COLS)) {
    let idx = -1;
    for (const n of names) { idx = norm.indexOf(n); if (idx >= 0) break; }
    if (idx >= 0) map[key] = idx;
  }
  return map;
}

// Exact decimal parsing of a statement amount to integer micro-dollars (no float arithmetic on the
// digits). Digits beyond the sixth decimal place are rounded half-up. NaN if there's no usable number.
export const parseMoneyMicros = (s) => {
  if (s == null) return NaN;
  let t = String(s).trim();
  if (!/\d/.test(t)) return NaN;
  const neg = /^\(.*\)$/.test(t) || t.startsWith('-');
  t = t.replace(/[^0-9.,]/g, '');
  const lastDot = t.lastIndexOf('.'), lastComma = t.lastIndexOf(',');
  let dec = -1; // index of the decimal separator, if any
  if (lastDot >= 0 && lastComma >= 0) dec = Math.max(lastDot, lastComma);
  else {
    const sep = lastDot >= 0 ? '.' : lastComma >= 0 ? ',' : null;
    if (sep && t.split(sep).length === 2) {
      // a lone separator followed by exactly 3 digits after a short non-zero integer is a thousands
      // separator (1,234); anything else (0.005, 12.5, 0.00456) is a decimal point
      const [int, frac] = t.split(sep);
      if (!(frac.length === 3 && int.length >= 1 && int.length <= 3 && !int.startsWith('0'))) dec = t.indexOf(sep);
    }
  }
  const digits = (x) => x.replace(/[.,]/g, '');
  const whole = digits(dec >= 0 ? t.slice(0, dec) : t) || '0';
  const frac = dec >= 0 ? digits(t.slice(dec + 1)) : '';
  let m = Number(whole) * MICROS + Number(frac.slice(0, 6).padEnd(6, '0')) + (frac[6] >= '5' ? 1 : 0);
  if (!Number.isSafeInteger(m)) return NaN;
  return neg ? -m : m;
};
// dollars as a float, for the places that only need a rough number (e.g. unit counts)
export const parseMoney = (s) => parseMoneyMicros(s) / MICROS;

// Integer micros -> plain decimal string without float error ("1234.50456", "-3.5").
export const microsToString = (m) => {
  const abs = Math.abs(m);
  const frac = String(abs % MICROS).padStart(6, '0').replace(/0+$/, '');
  return `${m < 0 ? '-' : ''}${Math.floor(abs / MICROS)}${frac ? '.' + frac : ''}`;
};
// A JSON dollar amount from a client -> micros
const toMicros = (dollars) => {
  const m = Math.round(dollars * MICROS);
  if (!Number.isSafeInteger(m)) throw bad('Amount is out of range');
  return m;
};

// Day-first vs month-first dates (05/03/2025) can't be told apart from one value, so the
// order is decided per file: any value with a first or second part above 12 settles it.
const DATE_PARTS = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/;
export function detectDateOrder(values) {
  let dmy = false, mdy = false, any = false;
  for (const v of values) {
    const m = String(v ?? '').trim().match(DATE_PARTS);
    if (!m) continue;
    any = true;
    if (+m[1] > 12) dmy = true;
    if (+m[2] > 12) mdy = true;
  }
  if (dmy && mdy) throw bad('Period column mixes day-first and month-first dates');
  if (dmy) return 'dmy';
  if (mdy) return 'mdy';
  return any ? 'ambiguous' : null;
}

// normalise to YYYY-MM when possible; order ('mdy' | 'dmy') only matters for D/M/YYYY-style dates
export const normPeriod = (s, order = 'mdy') => {
  if (!s) return null;
  s = String(s).trim();
  const ym = (y, mo) => `${y}-${String(mo).padStart(2, '0')}`;
  const validMonth = (mo) => +mo >= 1 && +mo <= 12;
  let m = s.match(/^(\d{4})[-/](\d{1,2})/);
  if (m && validMonth(m[2])) return ym(m[1], m[2]);
  m = s.match(/^(\d{1,2})[-/](\d{4})$/);
  if (m && validMonth(m[1])) return ym(m[2], m[1]);
  m = s.match(DATE_PARTS);
  if (m) {
    const mo = order === 'dmy' ? m[2] : m[1];
    if (validMonth(mo)) return ym(m[3], mo);
  }
  const d = new Date(s + ' 1');
  if (!isNaN(d)) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const d2 = new Date(s);
  if (!isNaN(d2)) return `${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, '0')}`;
  return s;
};

// Returns the song id for a title/ISRC pair, or null. A key shared by several songs is ambiguous:
// guessing would put earnings on the wrong song, so it falls through (ISRC, then title) and is left
// unmatched for the user to assign. `ambiguous` is set on the result when that happened.
function matchSong(title, isrc, out = {}) {
  const pick = (rows) => {
    if (rows.length === 1) return rows[0].id;
    if (rows.length > 1) out.ambiguous = true;
    return null;
  };
  if (isrc) {
    const id = pick(all(`SELECT id FROM songs WHERE upper(replace(isrc,'-','')) = ?`, isrc.toUpperCase().replace(/-/g, '')));
    if (id) return id;
  }
  if (title) return pick(all('SELECT id FROM songs WHERE lower(trim(title)) = ?', title.trim().toLowerCase()));
  return null;
}

function importStatement({ source, filename, csv, force, dateOrder }) {
  if (!source) throw bad('source is required');
  const rows = parseCsv(csv || '');
  if (rows.length < 2) throw bad('CSV needs a header row and at least one data row');
  const map = mapHeaders(rows[0]);
  if (map.amount == null) throw bad(`Could not find an amount column. Headers seen: ${rows[0].join(', ')}`);
  if (map.title == null && map.isrc == null) throw bad('Need a title or ISRC column');
  if (dateOrder != null && dateOrder !== 'mdy' && dateOrder !== 'dmy') throw bad("dateOrder must be 'mdy' or 'dmy'");
  let order = dateOrder;
  if (map.period != null) {
    const detected = detectDateOrder(rows.slice(1).map((r) => r[map.period]));
    if (detected === 'ambiguous' && !order) {
      throw bad("Period dates like 05/03/2025 could be day-first or month-first. Re-import with dateOrder: 'dmy' or 'mdy'.");
    }
    if (detected && detected !== 'ambiguous' && order && order !== detected) {
      throw bad(`dateOrder '${order}' contradicts the file, whose dates are ${detected === 'dmy' ? 'day-first' : 'month-first'}`);
    }
    order = order || detected || 'mdy';
  }
  const hash = crypto.createHash('sha256').update(source.toLowerCase()).update('\0').update(csv).digest('hex');
  const dupe = get('SELECT id, imported_at FROM statements WHERE content_hash = ?', hash);
  if (dupe && !force) {
    throw new HttpError(409, `This statement was already imported as #${dupe.id} on ${dupe.imported_at}. Delete it first, or re-import with force to add it again.`);
  }
  let skipped = 0, matched = 0, ambiguous = 0;
  const id = tx(() => {
    const st = run('INSERT INTO statements (source, filename, content_hash) VALUES (?, ?, ?)', source, filename || null, hash);
    const sid = Number(st.lastInsertRowid);
    const ins = db.prepare(`INSERT INTO earnings (statement_id, song_id, raw_title, raw_isrc, platform, territory, period, units, amount_micros)
                            VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const r of rows.slice(1)) {
      const amount = parseMoneyMicros(r[map.amount]);
      if (!Number.isFinite(amount)) { skipped++; continue; }
      const title = map.title != null ? str(r[map.title]) : null;
      const isrc = map.isrc != null ? str(r[map.isrc]) : null;
      const hit = {};
      const songId = matchSong(title, isrc, hit);
      if (songId) matched++;
      else if (hit.ambiguous) ambiguous++;
      const units = map.units != null ? Math.round(parseMoney(r[map.units]) || 0) : 0;
      ins.run(sid, songId, title, isrc,
        map.platform != null ? str(r[map.platform]) : null,
        map.territory != null ? str(r[map.territory]) : null,
        map.period != null ? normPeriod(r[map.period], order) : null,
        units, amount);
    }
    const count = get('SELECT COUNT(*) c FROM earnings WHERE statement_id = ?', sid).c;
    run('UPDATE statements SET row_count = ? WHERE id = ?', count, sid);
    return sid;
  });
  const total = get('SELECT COUNT(*) c, COALESCE(SUM(amount_micros),0) t FROM earnings WHERE statement_id = ?', id);
  return { id, imported: total.c, matched, unmatched: total.c - matched, ambiguous, skipped, total: usd(total.t) };
}

// ---------- domain queries ----------
function songsWithStats() {
  const songs = all(`
    SELECT s.*, COALESCE(SUM(e.amount_micros),0) AS earned, COALESCE(SUM(e.units),0) AS units
    FROM songs s LEFT JOIN earnings e ON e.song_id = s.id GROUP BY s.id ORDER BY s.title`);
  const splits = all(`SELECT sp.song_id, sp.contributor_id, sp.pct, c.name
                      FROM splits sp JOIN contributors c ON c.id = sp.contributor_id`);
  for (const s of songs) {
    s.earned = usd(s.earned);
    s.splits = splits.filter((x) => x.song_id === s.id);
    s.splitTotal = s.splits.reduce((a, b) => a + b.pct, 0);
  }
  return songs;
}

function dashboard(q) {
  const from = q.get('from') || '0000-00', to = q.get('to') || '9999-99';
  // With a date filter, earnings of unknown period can't be placed in the range, so they drop out
  // (reported separately as `undated`); with no filter they're all included.
  const filtered = q.has('from') || q.has('to');
  const where = filtered ? `WHERE e.period >= ? AND e.period <= ?` : `WHERE ? IS NOT NULL AND ? IS NOT NULL`;
  const args = [from, to];
  const total = get(`SELECT COALESCE(SUM(amount_micros),0) t, COALESCE(SUM(units),0) u FROM earnings e ${where}`, ...args);
  const byPeriod = all(`SELECT COALESCE(period,'unknown') k, SUM(amount_micros) v FROM earnings e ${where} GROUP BY period ORDER BY period`, ...args);
  const byPlatform = all(`SELECT COALESCE(platform,'Unknown') k, SUM(amount_micros) v, SUM(units) u FROM earnings e ${where} GROUP BY platform ORDER BY v DESC`, ...args);
  const byTerritory = all(`SELECT COALESCE(territory,'Unknown') k, SUM(amount_micros) v FROM earnings e ${where} GROUP BY territory ORDER BY v DESC LIMIT 15`, ...args);
  const byTrack = all(`SELECT COALESCE(s.title, e.raw_title, 'Unknown') k, e.song_id, SUM(e.amount_micros) v, SUM(e.units) u
                       FROM earnings e LEFT JOIN songs s ON s.id = e.song_id ${where}
                       GROUP BY COALESCE(e.song_id, 'raw:' || e.raw_title) ORDER BY v DESC LIMIT 15`, ...args);
  const unmatched = get(`SELECT COUNT(*) c, COALESCE(SUM(amount_micros),0) t FROM earnings e ${where} AND e.song_id IS NULL`, ...args);
  const undated = get(`SELECT COUNT(*) c, COALESCE(SUM(amount_micros),0) t FROM earnings WHERE period IS NULL`);
  // payments and advances are dated YYYY-MM-DD; filter on the month, and (as with earnings) leave out
  // undated ones when a filter is active, counting them instead of hiding them.
  const payDate = `substr(COALESCE(received_date, expected_date),1,7)`;
  const payWhere = filtered ? `WHERE ${payDate} >= ? AND ${payDate} <= ?` : `WHERE ? IS NOT NULL AND ? IS NOT NULL`;
  const pay = get(`SELECT COALESCE(SUM(expected_micros),0) exp, COALESCE(SUM(received_micros),0) rec FROM payments ${payWhere}`, ...args);
  const undatedPayments = get(`SELECT COUNT(*) c FROM payments WHERE COALESCE(received_date, expected_date) IS NULL`).c;
  const advWhere = filtered ? `WHERE substr(date,1,7) >= ? AND substr(date,1,7) <= ?` : `WHERE ? IS NOT NULL AND ? IS NOT NULL`;
  const adv = get(`SELECT COALESCE(SUM(amount_micros),0) t FROM advances ${advWhere}`, ...args);
  const undatedAdvances = get(`SELECT COUNT(*) c FROM advances WHERE date IS NULL`).c;
  const dollars = (rows) => rows.map((r) => ({ ...r, v: usd(r.v) }));
  const count = (r) => ({ c: r.c, t: usd(r.t) });
  return { total: usd(total.t), units: total.u, byPeriod: dollars(byPeriod), byPlatform: dollars(byPlatform),
           byTerritory: dollars(byTerritory), byTrack: dollars(byTrack), unmatched: count(unmatched), undated: count(undated),
           payments: { exp: usd(pay.exp), rec: usd(pay.rec) }, advances: usd(adv.t), undatedPayments, undatedAdvances };
}

// Payouts are gross: each contributor's split of the earnings on matched songs. Nothing is netted
// (the app records no payments *to* contributors). Shares are rounded to whole micro-dollars per
// song and split, so a contributor's total is an exact integer sum; whatever isn't owed to anyone
// (the part of a song not covered by its splits, earnings matched to no song, and any sub-micro
// rounding dust) is reported as `unallocated`, so owed + unallocated always equals total earnings.
const shareOf = (earned, pct) => { const r = Math.round(Math.abs(earned) * pct / 100); return earned < 0 ? -r : r; };

function payoutData() {
  const earned = new Map(all('SELECT song_id, SUM(amount_micros) t FROM earnings WHERE song_id IS NOT NULL GROUP BY song_id')
    .map((r) => [r.song_id, r.t]));
  const splits = all(`SELECT sp.song_id, sp.contributor_id, sp.pct, s.title
                      FROM splits sp JOIN songs s ON s.id = sp.song_id ORDER BY s.title`)
    .map((sp) => { const e = earned.get(sp.song_id) || 0; return { ...sp, earned: e, share: shareOf(e, sp.pct) }; });
  const contributors = all('SELECT id, name, email FROM contributors ORDER BY name').map((c) => {
    const songs = splits.filter((x) => x.contributor_id === c.id);
    return { ...c, owed: songs.reduce((a, x) => a + x.share, 0), songs };
  }).sort((a, b) => b.owed - a.owed);
  return { earned, splits, contributors };
}

function payouts() {
  return payoutData().contributors.map((c) => ({
    ...c, owed: usd(c.owed),
    songs: c.songs.map((x) => ({ contributor_id: x.contributor_id, song_id: x.song_id, title: x.title, pct: x.pct,
                                 earned: usd(x.earned), share: usd(x.share) })),
  }));
}

function payoutSummary() {
  const { earned, splits, contributors } = payoutData();
  const allocated = new Map(), pctTotal = new Map();
  for (const sp of splits) {
    allocated.set(sp.song_id, (allocated.get(sp.song_id) || 0) + sp.share);
    pctTotal.set(sp.song_id, (pctTotal.get(sp.song_id) || 0) + sp.pct);
  }
  const titles = new Map(all('SELECT id, title FROM songs').map((r) => [r.id, r.title]));
  const underSplitSongs = [...earned].filter(([id, e]) => e !== 0 && (pctTotal.get(id) || 0) < 99.9999)
    .map(([id, e]) => ({ song_id: id, title: titles.get(id), earned: usd(e), splitTotal: pctTotal.get(id) || 0,
                         unallocated: usd(e - (allocated.get(id) || 0)) }));
  const total = get('SELECT COALESCE(SUM(amount_micros),0) t FROM earnings').t;
  const unmatched = get('SELECT COALESCE(SUM(amount_micros),0) t FROM earnings WHERE song_id IS NULL').t;
  const owed = contributors.reduce((a, c) => a + c.owed, 0);
  return { contributors: payouts(), total: usd(total), owed: usd(owed), unallocated: usd(total - owed),
           unmatched: usd(unmatched), underSplitSongs };
}

function advances() {
  // Earnings from one source are a shared pool: advances recoup in date order, so
  // an earlier advance uses up earnings before a later one can claim them. (Integer micros throughout.)
  const asc = all('SELECT * FROM advances ORDER BY date ASC, id ASC');
  const groups = new Map();
  for (const a of asc) {
    a.earnedSince = get(`SELECT COALESCE(SUM(e.amount_micros),0) t FROM earnings e JOIN statements st ON st.id = e.statement_id
                         WHERE lower(st.source) = lower(?) AND (? IS NULL OR e.period IS NULL OR e.period >= substr(?,1,7))`,
      a.source, a.date, a.date).t;
    const key = a.source.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  for (const list of groups.values()) {
    const poolStart = list[0].earnedSince; // widest eligible window
    let consumed = 0;
    for (const a of list) {
      // earnings dated before this advance were the first to be used up by earlier advances
      const preDated = poolStart - a.earnedSince;
      const available = Math.max(0, a.earnedSince - Math.max(0, consumed - preDated));
      a.recouped = Math.min(a.amount_micros, available);
      a.balance = a.amount_micros - a.recouped;
      consumed += a.recouped;
    }
  }
  return asc.reverse().map((a) => ({ id: a.id, source: a.source, amount: usd(a.amount_micros), date: a.date, notes: a.notes,
    earnedSince: usd(a.earnedSince), recouped: usd(a.recouped), balance: usd(a.balance) }));
}

function payments() {
  const today = new Date().toISOString().slice(0, 10);
  return all('SELECT * FROM payments ORDER BY COALESCE(received_date, expected_date) DESC, id DESC').map((p) => {
    let status = 'pending';
    if (p.received_micros != null) {
      const diff = (p.expected_micros ?? p.received_micros) - p.received_micros;
      status = p.expected_micros == null || Math.abs(diff) < 5000 ? 'received' : diff > 0 ? 'short' : 'over'; // within half a cent counts as paid in full
    } else if (p.expected_date && p.expected_date < today) status = 'overdue';
    return { id: p.id, source: p.source, expected_amount: usd(p.expected_micros), expected_date: p.expected_date,
             received_amount: usd(p.received_micros), received_date: p.received_date, notes: p.notes, status };
  });
}

// ---------- routing ----------
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

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/dashboard', ({ url }) => dashboard(url.searchParams));
route('GET', '/api/songs', () => songsWithStats());
route('POST', '/api/songs', ({ body }) => {
  const r = run('INSERT INTO songs (title, isrc, release, notes) VALUES (?,?,?,?)',
    requireStr(body.title, 'title'), str(body.isrc), str(body.release), str(body.notes));
  const id = Number(r.lastInsertRowid);
  // link any previously unmatched earnings
  const linked = relink();
  return { id, linked };
});
route('PUT', '/api/songs/:id', ({ params, body }) => {
  runOne('Song', 'UPDATE songs SET title=?, isrc=?, release=?, notes=? WHERE id=?',
    requireStr(body.title, 'title'), str(body.isrc), str(body.release), str(body.notes), params.id);
  return { linked: relink() };
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
route('GET', '/api/payouts', () => payouts());
route('GET', '/api/payouts/summary', () => payoutSummary());

route('GET', '/api/statements', () => all(`
  SELECT st.*, COALESCE(SUM(e.amount_micros),0) total,
         SUM(CASE WHEN e.song_id IS NULL THEN 1 ELSE 0 END) unmatched
  FROM statements st LEFT JOIN earnings e ON e.statement_id = st.id
  GROUP BY st.id ORDER BY st.id DESC`).map((st) => ({ ...st, total: usd(st.total) })));
route('POST', '/api/statements/import', ({ body }) => importStatement(body));
route('DELETE', '/api/statements/:id', ({ params }) => { runOne('Statement', 'DELETE FROM statements WHERE id=?', params.id); return { ok: true }; });
route('GET', '/api/unmatched', () => all(`
  SELECT COALESCE(raw_title, raw_isrc, 'Unknown') name, raw_title, raw_isrc, COUNT(*) rows, SUM(amount_micros) total
  FROM earnings WHERE song_id IS NULL GROUP BY raw_title, raw_isrc ORDER BY total DESC`).map((u) => ({ ...u, total: usd(u.total) })));
route('POST', '/api/unmatched/assign', ({ body }) => {
  const sid = requireNum(body.song_id, 'song_id');
  if (!get('SELECT 1 FROM songs WHERE id=?', sid)) throw notFound('Song');
  const r = run(`UPDATE earnings SET song_id = ? WHERE song_id IS NULL AND COALESCE(raw_title,'') = ? AND COALESCE(raw_isrc,'') = ?`,
    sid, body.raw_title || '', body.raw_isrc || '');
  return { updated: Number(r.changes) };
});

route('GET', '/api/payments', () => payments());
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

route('GET', '/api/advances', () => advances());
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

function relink() {
  let n = 0;
  const rows = all('SELECT DISTINCT raw_title, raw_isrc FROM earnings WHERE song_id IS NULL');
  for (const r of rows) {
    const id = matchSong(r.raw_title, r.raw_isrc);
    if (id) n += Number(run(`UPDATE earnings SET song_id=? WHERE song_id IS NULL AND raw_title IS ? AND raw_isrc IS ?`, id, r.raw_title, r.raw_isrc).changes);
  }
  return n;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Guards against other websites driving the API from the user's browser: a Host check stops DNS
// rebinding, an Origin check stops cross-site requests, and requiring a JSON content type forces
// a CORS preflight (which this server never approves) for anything that writes.
function guardRequest(req) {
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

export const server = http.createServer(async (req, res) => {
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
    const full = path.join(__dirname, 'public', file);
    if (!full.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404); return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    const status = e.status || (/UNIQUE|constraint/i.test(e.message) ? 409 : 500);
    json(res, status, { error: e.message });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '127.0.0.1', () => console.log(`Royalty Tracker running at http://localhost:${PORT}`));
}
