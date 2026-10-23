// Song matching and statement import.
import crypto from 'node:crypto';
import { all, get, run, tx } from './db.js';
import { HttpError, bad } from './errors.js';
import { usd, str, parseCsv, mapHeaders, parseMoneyMicros, parseMoney, detectDateOrder, normPeriod, titleSimilarity } from './parse.js';

// Returns the song id for a title/ISRC pair, or null. A key shared by several songs is ambiguous:
// guessing would put earnings on the wrong song, so it falls through (ISRC, then title) and is left
// unmatched for the user to assign. `ambiguous` is set on the result when that happened.
export function matchSong(db, title, isrc, out = {}) {
  const pick = (rows) => {
    if (rows.length === 1) return rows[0].id;
    if (rows.length > 1) out.ambiguous = true;
    return null;
  };
  if (isrc) {
    const id = pick(all(db, `SELECT id FROM songs WHERE upper(replace(isrc,'-','')) = ?`, isrc.toUpperCase().replace(/-/g, '')));
    if (id) return id;
  }
  if (title) return pick(all(db, 'SELECT id FROM songs WHERE lower(trim(title)) = ?', title.trim().toLowerCase()));
  return null;
}

export function importStatement(db, { source, filename, csv, force, dateOrder }) {
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
  const dupe = get(db, 'SELECT id, imported_at FROM statements WHERE content_hash = ?', hash);
  if (dupe && !force) {
    throw new HttpError(409, `This statement was already imported as #${dupe.id} on ${dupe.imported_at}. Delete it first, or re-import with force to add it again.`);
  }
  let skipped = 0, matched = 0, ambiguous = 0;
  const id = tx(db, () => {
    const st = run(db, 'INSERT INTO statements (source, filename, content_hash) VALUES (?, ?, ?)', source, filename || null, hash);
    const sid = Number(st.lastInsertRowid);
    const ins = db.prepare(`INSERT INTO earnings (statement_id, song_id, raw_title, raw_isrc, platform, territory, period, units, amount_micros, match_reason)
                            VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const r of rows.slice(1)) {
      const amount = parseMoneyMicros(r[map.amount]);
      if (!Number.isFinite(amount)) { skipped++; continue; }
      const title = map.title != null ? str(r[map.title]) : null;
      const isrc = map.isrc != null ? str(r[map.isrc]) : null;
      const hit = {};
      const songId = matchSong(db, title, isrc, hit);
      if (songId) matched++;
      else if (hit.ambiguous) ambiguous++;
      const units = map.units != null ? Math.round(parseMoney(r[map.units]) || 0) : 0;
      ins.run(sid, songId, title, isrc,
        map.platform != null ? str(r[map.platform]) : null,
        map.territory != null ? str(r[map.territory]) : null,
        map.period != null ? normPeriod(r[map.period], order) : null,
        units, amount, songId ? null : hit.ambiguous ? 'ambiguous' : 'none');
    }
    const count = get(db, 'SELECT COUNT(*) c FROM earnings WHERE statement_id = ?', sid).c;
    run(db, 'UPDATE statements SET row_count = ? WHERE id = ?', count, sid);
    return sid;
  });
  const total = get(db, 'SELECT COUNT(*) c, COALESCE(SUM(amount_micros),0) t FROM earnings WHERE statement_id = ?', id);
  return { id, imported: total.c, matched, unmatched: total.c - matched, ambiguous, skipped, total: usd(total.t) };
}

// Links unmatched earnings to songs that now match, and refreshes match_reason on the ones that still
// don't. Returns the number of rows linked.
export function relink(db) {
  let n = 0;
  const rows = all(db, 'SELECT DISTINCT raw_title, raw_isrc FROM earnings WHERE song_id IS NULL');
  for (const r of rows) {
    const hit = {};
    const id = matchSong(db, r.raw_title, r.raw_isrc, hit);
    if (id) n += Number(run(db, `UPDATE earnings SET song_id=?, match_reason=NULL WHERE song_id IS NULL AND raw_title IS ? AND raw_isrc IS ?`, id, r.raw_title, r.raw_isrc).changes);
    else run(db, `UPDATE earnings SET match_reason=? WHERE song_id IS NULL AND raw_title IS ? AND raw_isrc IS ?`, hit.ambiguous ? 'ambiguous' : 'none', r.raw_title, r.raw_isrc);
  }
  return n;
}

// Likely songs for an unmatched title, best first, from a preloaded [{ id, title, isrc }] list. Only
// suggestions: nothing here links earnings, a person confirms through the assign action. 0.8 is a first
// guess at the cut-off (a one-letter slip in a 10-letter title scores 0.9); tune it against real statements.
export function suggestSongs(songs, rawTitle, { limit = 3, min = 0.8 } = {}) {
  if (!rawTitle) return [];
  return songs
    .map((s) => ({ song_id: s.id, title: s.title, isrc: s.isrc, score: titleSimilarity(rawTitle, s.title) }))
    .filter((s) => s.score >= min)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.song_id - b.song_id)
    .slice(0, limit);
}
