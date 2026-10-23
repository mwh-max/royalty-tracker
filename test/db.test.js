import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.js';
import { createServer } from '../routes.js';

test('a database with dollar REAL columns is migrated to integer micros', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-migrate-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT NOT NULL, isrc TEXT, release TEXT, notes TEXT);
    CREATE TABLE contributors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
    CREATE TABLE splits (song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      contributor_id INTEGER NOT NULL REFERENCES contributors(id) ON DELETE CASCADE, pct REAL NOT NULL, PRIMARY KEY (song_id, contributor_id));
    CREATE TABLE statements (id INTEGER PRIMARY KEY, source TEXT NOT NULL, filename TEXT,
      imported_at TEXT NOT NULL DEFAULT (datetime('now')), row_count INTEGER DEFAULT 0);
    CREATE TABLE earnings (id INTEGER PRIMARY KEY, statement_id INTEGER NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
      song_id INTEGER REFERENCES songs(id) ON DELETE SET NULL, raw_title TEXT, raw_isrc TEXT, platform TEXT, territory TEXT,
      period TEXT, units INTEGER DEFAULT 0, amount REAL NOT NULL);
    CREATE INDEX idx_earn_song ON earnings(song_id);
    CREATE TABLE payments (id INTEGER PRIMARY KEY, source TEXT NOT NULL, expected_amount REAL, expected_date TEXT,
      received_amount REAL, received_date TEXT, notes TEXT);
    CREATE TABLE advances (id INTEGER PRIMARY KEY, source TEXT NOT NULL, amount REAL NOT NULL, date TEXT, notes TEXT);
    INSERT INTO songs (id, title) VALUES (1, 'Old Song');
    INSERT INTO contributors (id, name) VALUES (1, 'Old Pal');
    INSERT INTO splits VALUES (1, 1, 50);
    INSERT INTO statements (id, source, row_count) VALUES (1, 'OldSrc', 3);
    INSERT INTO earnings (statement_id, song_id, raw_title, period, units, amount) VALUES
      (1, 1, 'Old Song', '2024-01', 10, 0.1), (1, 1, 'Old Song', '2024-01', 10, 0.2), (1, NULL, 'Stray', '2024-02', 1, 1234.5);
    INSERT INTO payments (source, expected_amount, expected_date, received_amount) VALUES ('OldSrc', 100.25, '2024-03-01', 100.25);
    INSERT INTO advances (source, amount, date) VALUES ('OldSrc', 500, '2024-01-01');
  `);
  old.close();

  // open the file the way server.js does, read the API once, and close again
  const snapshot = async () => {
    const db = openDb(file);
    const server = createServer(db);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const get = (p) => fetch(base + p).then((r) => r.json());
      return { dash: await get('/api/dashboard'), pay: await get('/api/payments'),
        adv: await get('/api/advances'), songs: await get('/api/songs'), payouts: await get('/api/payouts/summary') };
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      db.close();
    }
  };

  const out = await snapshot();
  assert.equal(out.dash.total, 1234.8, 'floats converted without drift');
  assert.equal(out.dash.unmatched.t, 1234.5);
  assert.equal(out.pay[0].expected_amount, 100.25);
  assert.equal(out.pay[0].status, 'received');
  assert.equal(out.adv[0].amount, 500);
  assert.equal(out.adv[0].recouped, 500);
  assert.equal(out.songs[0].earned, 0.3);
  assert.equal(out.payouts.contributors[0].owed, 0.15);

  // idempotent: opening the migrated file again changes nothing
  assert.deepEqual(await snapshot(), out);

  const check = new DatabaseSync(file);
  const cols = check.prepare('PRAGMA table_info(earnings)').all().map((c) => c.name);
  assert.ok(cols.includes('amount_micros') && !cols.includes('amount'));
  assert.equal(check.prepare('SELECT typeof(amount_micros) t FROM earnings LIMIT 1').get().t, 'integer');
  assert.equal(check.prepare("SELECT count(*) c FROM sqlite_master WHERE name = 'idx_earn_song'").get().c, 1, 'index recreated');
  check.close();
});

test('existing splits become master splits, and a contributor can then also hold a composition split', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-splits-'));
  const file = path.join(dir, 'prev.db');
  const prev = new DatabaseSync(file);
  prev.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT NOT NULL, isrc TEXT, release TEXT, notes TEXT);
    CREATE TABLE contributors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
    CREATE TABLE splits (song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      contributor_id INTEGER NOT NULL REFERENCES contributors(id) ON DELETE CASCADE, pct REAL NOT NULL, PRIMARY KEY (song_id, contributor_id));
    INSERT INTO songs (id, title) VALUES (1, 'Split Song');
    INSERT INTO contributors (id, name) VALUES (1, 'Ann'), (2, 'Bo');
    INSERT INTO splits VALUES (1, 1, 60), (1, 2, 40);
  `);
  prev.close();

  for (let i = 0; i < 2; i++) { // second open proves the migration is idempotent
    const db = openDb(file);
    const rows = db.prepare('SELECT contributor_id, pct, type FROM splits ORDER BY contributor_id').all().map((r) => ({ ...r }));
    assert.deepEqual(rows, [{ contributor_id: 1, pct: 60, type: 'master' }, { contributor_id: 2, pct: 40, type: 'master' }]);
    db.close();
  }

  const db = openDb(file);
  db.prepare("INSERT INTO splits (song_id, contributor_id, pct, type) VALUES (1, 1, 50, 'composition')").run();
  assert.throws(() => db.prepare("INSERT INTO splits (song_id, contributor_id, pct, type) VALUES (1, 1, 10, 'master')").run(), /UNIQUE|constraint/i);
  assert.throws(() => db.prepare("INSERT INTO splits (song_id, contributor_id, pct, type) VALUES (1, 2, 10, 'publishing')").run(), /CHECK|constraint/i);
  db.exec('DELETE FROM contributors WHERE id = 1');
  assert.equal(db.prepare('SELECT count(*) c FROM splits WHERE contributor_id = 1').get().c, 0, 'cascade still removes both kinds');
  db.close();
});
