// Database: schema, migrations and thin query helpers. Nothing opens on import; call openDb().
import { DatabaseSync } from 'node:sqlite';
import { MICROS } from './parse.js';

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS songs (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, isrc TEXT, release TEXT, notes TEXT,
  mlc_song_code TEXT
);
CREATE TABLE IF NOT EXISTS contributors (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT
);
CREATE TABLE IF NOT EXISTS splits (
  song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  contributor_id INTEGER NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  pct REAL NOT NULL,
  PRIMARY KEY (song_id, contributor_id)
);
CREATE TABLE IF NOT EXISTS statements (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, filename TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')), row_count INTEGER DEFAULT 0,
  content_hash TEXT
);
CREATE TABLE IF NOT EXISTS earnings (
  id INTEGER PRIMARY KEY,
  statement_id INTEGER NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
  song_id INTEGER REFERENCES songs(id) ON DELETE SET NULL,
  raw_title TEXT, raw_isrc TEXT, platform TEXT, territory TEXT,
  period TEXT, units INTEGER DEFAULT 0, amount_micros INTEGER NOT NULL,
  match_reason TEXT
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL,
  expected_micros INTEGER, expected_date TEXT,
  received_micros INTEGER, received_date TEXT, notes TEXT
);
CREATE TABLE IF NOT EXISTS advances (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, amount_micros INTEGER NOT NULL,
  date TEXT, notes TEXT
);
`;

export const all = (db, sql, ...p) => db.prepare(sql).all(...p);
export const get = (db, sql, ...p) => db.prepare(sql).get(...p);
export const run = (db, sql, ...p) => db.prepare(sql).run(...p);
export const tx = (db, fn) => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
};

const hasCol = (db, table, col) => all(db, `PRAGMA table_info(${table})`).some((c) => c.name === col);

function migrate(db) {
  // databases created before duplicate detection lack content_hash
  if (!hasCol(db, 'statements', 'content_hash')) {
    db.exec('ALTER TABLE statements ADD COLUMN content_hash TEXT');
  }
  // the MLC's identifier for a work, needed for its bulk-match upload
  if (!hasCol(db, 'songs', 'mlc_song_code')) {
    db.exec('ALTER TABLE songs ADD COLUMN mlc_song_code TEXT');
  }

  // Older databases stored dollars as REAL (earnings.amount, payments.*_amount, advances.amount);
  // rebuild those tables with integer micro-dollars.
  if (hasCol(db, 'earnings', 'amount') || hasCol(db, 'payments', 'expected_amount') || hasCol(db, 'advances', 'amount')) {
    const toMicro = (col) => `CAST(ROUND(${col} * ${MICROS}) AS INTEGER)`;
    tx(db, () => {
      if (hasCol(db, 'earnings', 'amount')) {
        db.exec(`ALTER TABLE earnings RENAME TO earnings_old;
          CREATE TABLE earnings (
            id INTEGER PRIMARY KEY,
            statement_id INTEGER NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
            song_id INTEGER REFERENCES songs(id) ON DELETE SET NULL,
            raw_title TEXT, raw_isrc TEXT, platform TEXT, territory TEXT,
            period TEXT, units INTEGER DEFAULT 0, amount_micros INTEGER NOT NULL
          );
          INSERT INTO earnings SELECT id, statement_id, song_id, raw_title, raw_isrc, platform, territory, period, units, ${toMicro('amount')} FROM earnings_old;
          DROP TABLE earnings_old;`);
      }
      if (hasCol(db, 'payments', 'expected_amount')) {
        db.exec(`ALTER TABLE payments RENAME TO payments_old;
          CREATE TABLE payments (
            id INTEGER PRIMARY KEY, source TEXT NOT NULL,
            expected_micros INTEGER, expected_date TEXT,
            received_micros INTEGER, received_date TEXT, notes TEXT
          );
          INSERT INTO payments SELECT id, source, ${toMicro('expected_amount')}, expected_date, ${toMicro('received_amount')}, received_date, notes FROM payments_old;
          DROP TABLE payments_old;`);
      }
      if (hasCol(db, 'advances', 'amount')) {
        db.exec(`ALTER TABLE advances RENAME TO advances_old;
          CREATE TABLE advances (
            id INTEGER PRIMARY KEY, source TEXT NOT NULL, amount_micros INTEGER NOT NULL,
            date TEXT, notes TEXT
          );
          INSERT INTO advances SELECT id, source, ${toMicro('amount')}, date, notes FROM advances_old;
          DROP TABLE advances_old;`);
      }
    });
  }
  // why an earnings row has no song: 'none' (nothing matched) or 'ambiguous' (several songs matched);
  // NULL on matched rows. Added after the micros rebuild above, which recreates earnings without it.
  if (!hasCol(db, 'earnings', 'match_reason')) {
    db.exec('ALTER TABLE earnings ADD COLUMN match_reason TEXT');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_earn_song ON earnings(song_id);
CREATE INDEX IF NOT EXISTS idx_earn_period ON earnings(period);`);
}

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
