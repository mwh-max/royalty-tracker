// Read-side domain queries: song stats, dashboard, payouts, advances and payments.
import { all, get } from './db.js';
import { usd } from './parse.js';

export function songsWithStats(db) {
  const songs = all(db, `
    SELECT s.*, COALESCE(SUM(e.amount_micros),0) AS earned, COALESCE(SUM(e.units),0) AS units
    FROM songs s LEFT JOIN earnings e ON e.song_id = s.id GROUP BY s.id ORDER BY s.title`);
  const splits = all(db, `SELECT sp.song_id, sp.contributor_id, sp.pct, c.name
                      FROM splits sp JOIN contributors c ON c.id = sp.contributor_id`);
  for (const s of songs) {
    s.earned = usd(s.earned);
    s.splits = splits.filter((x) => x.song_id === s.id);
    s.splitTotal = s.splits.reduce((a, b) => a + b.pct, 0);
  }
  return songs;
}

export function dashboard(db, q) {
  const from = q.get('from') || '0000-00', to = q.get('to') || '9999-99';
  // With a date filter, earnings of unknown period can't be placed in the range, so they drop out
  // (reported separately as `undated`); with no filter they're all included.
  const filtered = q.has('from') || q.has('to');
  const where = filtered ? `WHERE e.period >= ? AND e.period <= ?` : `WHERE ? IS NOT NULL AND ? IS NOT NULL`;
  const args = [from, to];
  const total = get(db, `SELECT COALESCE(SUM(amount_micros),0) t, COALESCE(SUM(units),0) u FROM earnings e ${where}`, ...args);
  const byPeriod = all(db, `SELECT COALESCE(period,'unknown') k, SUM(amount_micros) v FROM earnings e ${where} GROUP BY period ORDER BY period`, ...args);
  const byPlatform = all(db, `SELECT COALESCE(platform,'Unknown') k, SUM(amount_micros) v, SUM(units) u FROM earnings e ${where} GROUP BY platform ORDER BY v DESC`, ...args);
  const byTerritory = all(db, `SELECT COALESCE(territory,'Unknown') k, SUM(amount_micros) v FROM earnings e ${where} GROUP BY territory ORDER BY v DESC LIMIT 15`, ...args);
  const byTrack = all(db, `SELECT COALESCE(s.title, e.raw_title, 'Unknown') k, e.song_id, SUM(e.amount_micros) v, SUM(e.units) u
                       FROM earnings e LEFT JOIN songs s ON s.id = e.song_id ${where}
                       GROUP BY COALESCE(e.song_id, 'raw:' || e.raw_title) ORDER BY v DESC LIMIT 15`, ...args);
  const unmatched = get(db, `SELECT COUNT(*) c, COALESCE(SUM(amount_micros),0) t FROM earnings e ${where} AND e.song_id IS NULL`, ...args);
  const undated = get(db, `SELECT COUNT(*) c, COALESCE(SUM(amount_micros),0) t FROM earnings WHERE period IS NULL`);
  // payments and advances are dated YYYY-MM-DD; filter on the month, and (as with earnings) leave out
  // undated ones when a filter is active, counting them instead of hiding them.
  const payDate = `substr(COALESCE(received_date, expected_date),1,7)`;
  const payWhere = filtered ? `WHERE ${payDate} >= ? AND ${payDate} <= ?` : `WHERE ? IS NOT NULL AND ? IS NOT NULL`;
  const pay = get(db, `SELECT COALESCE(SUM(expected_micros),0) exp, COALESCE(SUM(received_micros),0) rec FROM payments ${payWhere}`, ...args);
  const undatedPayments = get(db, `SELECT COUNT(*) c FROM payments WHERE COALESCE(received_date, expected_date) IS NULL`).c;
  const advWhere = filtered ? `WHERE substr(date,1,7) >= ? AND substr(date,1,7) <= ?` : `WHERE ? IS NOT NULL AND ? IS NOT NULL`;
  const adv = get(db, `SELECT COALESCE(SUM(amount_micros),0) t FROM advances ${advWhere}`, ...args);
  const undatedAdvances = get(db, `SELECT COUNT(*) c FROM advances WHERE date IS NULL`).c;
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

function payoutData(db) {
  const earned = new Map(all(db, 'SELECT song_id, SUM(amount_micros) t FROM earnings WHERE song_id IS NOT NULL GROUP BY song_id')
    .map((r) => [r.song_id, r.t]));
  const splits = all(db, `SELECT sp.song_id, sp.contributor_id, sp.pct, s.title
                      FROM splits sp JOIN songs s ON s.id = sp.song_id ORDER BY s.title`)
    .map((sp) => { const e = earned.get(sp.song_id) || 0; return { ...sp, earned: e, share: shareOf(e, sp.pct) }; });
  const contributors = all(db, 'SELECT id, name, email FROM contributors ORDER BY name').map((c) => {
    const songs = splits.filter((x) => x.contributor_id === c.id);
    return { ...c, owed: songs.reduce((a, x) => a + x.share, 0), songs };
  }).sort((a, b) => b.owed - a.owed);
  return { earned, splits, contributors };
}

export function payouts(db) {
  return payoutData(db).contributors.map((c) => ({
    ...c, owed: usd(c.owed),
    songs: c.songs.map((x) => ({ contributor_id: x.contributor_id, song_id: x.song_id, title: x.title, pct: x.pct,
                                 earned: usd(x.earned), share: usd(x.share) })),
  }));
}

export function payoutSummary(db) {
  const { earned, splits, contributors } = payoutData(db);
  const allocated = new Map(), pctTotal = new Map();
  for (const sp of splits) {
    allocated.set(sp.song_id, (allocated.get(sp.song_id) || 0) + sp.share);
    pctTotal.set(sp.song_id, (pctTotal.get(sp.song_id) || 0) + sp.pct);
  }
  const titles = new Map(all(db, 'SELECT id, title FROM songs').map((r) => [r.id, r.title]));
  const underSplitSongs = [...earned].filter(([id, e]) => e !== 0 && (pctTotal.get(id) || 0) < 99.9999)
    .map(([id, e]) => ({ song_id: id, title: titles.get(id), earned: usd(e), splitTotal: pctTotal.get(id) || 0,
                         unallocated: usd(e - (allocated.get(id) || 0)) }));
  const total = get(db, 'SELECT COALESCE(SUM(amount_micros),0) t FROM earnings').t;
  const unmatched = get(db, 'SELECT COALESCE(SUM(amount_micros),0) t FROM earnings WHERE song_id IS NULL').t;
  const owed = contributors.reduce((a, c) => a + c.owed, 0);
  return { contributors: payouts(db), total: usd(total), owed: usd(owed), unallocated: usd(total - owed),
           unmatched: usd(unmatched), underSplitSongs };
}

export function advances(db) {
  // Earnings from one source are a shared pool: advances recoup in date order, so
  // an earlier advance uses up earnings before a later one can claim them. (Integer micros throughout.)
  const asc = all(db, 'SELECT * FROM advances ORDER BY date ASC, id ASC');
  const groups = new Map();
  for (const a of asc) {
    a.earnedSince = get(db, `SELECT COALESCE(SUM(e.amount_micros),0) t FROM earnings e JOIN statements st ON st.id = e.statement_id
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

export function payments(db) {
  const today = new Date().toISOString().slice(0, 10);
  return all(db, 'SELECT * FROM payments ORDER BY COALESCE(received_date, expected_date) DESC, id DESC').map((p) => {
    let status = 'pending';
    if (p.received_micros != null) {
      const diff = (p.expected_micros ?? p.received_micros) - p.received_micros;
      status = p.expected_micros == null || Math.abs(diff) < 5000 ? 'received' : diff > 0 ? 'short' : 'over'; // within half a cent counts as paid in full
    } else if (p.expected_date && p.expected_date < today) status = 'overdue';
    return { id: p.id, source: p.source, expected_amount: usd(p.expected_micros), expected_date: p.expected_date,
             received_amount: usd(p.received_micros), received_date: p.received_date, notes: p.notes, status };
  });
}
