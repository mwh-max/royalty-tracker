import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';
import { suggestSongs } from '../import.js';

const app = createTestApp();
const { call } = app;
let base;
before(async () => { await app.start(); base = app.base; });
after(() => app.stop());

test('import keeps sub-cent amounts exact', async () => {
  const csv = 'Track,Store,Earnings,Sale Month\nTiny,Spotify,0.00456,2025-01\nBig,Spotify,"1,234.50",2025-01\n';
  const { status, data } = await call('POST', '/api/statements/import', { source: 'Sub-cent', csv });
  assert.equal(status, 200);
  assert.ok(Math.abs(data.total - 1234.50456) < 1e-9, `total was ${data.total}`);
});

test('importing the same statement twice is rejected unless forced', async () => {
  const csv = 'Track,Earnings,Sale Month\nDupe,10.00,2025-01\n';
  const first = await call('POST', '/api/statements/import', { source: 'DupSrc', csv });
  assert.equal(first.status, 200);

  const again = await call('POST', '/api/statements/import', { source: 'dupsrc', csv });
  assert.equal(again.status, 409);
  assert.match(again.data.error, new RegExp(`#${first.data.id}\\b`));

  const other = await call('POST', '/api/statements/import', { source: 'OtherSrc', csv });
  assert.equal(other.status, 200, 'same CSV from a different source is a different statement');

  const forced = await call('POST', '/api/statements/import', { source: 'DupSrc', csv, force: true });
  assert.equal(forced.status, 200);

  const list = (await call('GET', '/api/statements')).data.filter((s) => s.source === 'DupSrc');
  assert.equal(list.length, 2);
});

test('deleting a statement lets it be imported again', async () => {
  const csv = 'Track,Earnings,Sale Month\nReimport,5.00,2025-01\n';
  const first = await call('POST', '/api/statements/import', { source: 'ReSrc', csv });
  await call('DELETE', `/api/statements/${first.data.id}`);
  const again = await call('POST', '/api/statements/import', { source: 'ReSrc', csv });
  assert.equal(again.status, 200);
});

test('import detects day-first dates from the file', async () => {
  const csv = 'Track,Earnings,Date\nDmyA,1.00,25/03/2025\nDmyB,1.00,05/03/2025\n';
  const r = await call('POST', '/api/statements/import', { source: 'DmySrc', csv });
  assert.equal(r.status, 200);
  const export_ = await fetch(base + '/api/export/earnings.csv').then((x) => x.text());
  const lines = export_.split('\n').filter((l) => l.startsWith('DmyA') || l.startsWith('DmyB'));
  assert.equal(lines.length, 2);
  for (const l of lines) assert.equal(l.split(',')[4], '2025-03', l);
});

test('import detects month-first dates from the file', async () => {
  const csv = 'Track,Earnings,Date\nMdyA,1.00,03/25/2025\nMdyB,1.00,05/03/2025\n';
  await call('POST', '/api/statements/import', { source: 'MdySrc', csv });
  const export_ = await fetch(base + '/api/export/earnings.csv').then((x) => x.text());
  const l = export_.split('\n').find((x) => x.startsWith('MdyB'));
  assert.equal(l.split(',')[4], '2025-05');
});

test('import rejects fully ambiguous dates unless dateOrder is given', async () => {
  const csv = 'Track,Earnings,Date\nAmbA,1.00,05/03/2025\n';
  const r = await call('POST', '/api/statements/import', { source: 'AmbSrc', csv });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /dateOrder/);
  assert.equal((await call('GET', '/api/statements')).data.filter((s) => s.source === 'AmbSrc').length, 0);

  const ok = await call('POST', '/api/statements/import', { source: 'AmbSrc', csv, dateOrder: 'dmy' });
  assert.equal(ok.status, 200);
  const export_ = await fetch(base + '/api/export/earnings.csv').then((x) => x.text());
  assert.equal(export_.split('\n').find((x) => x.startsWith('AmbA')).split(',')[4], '2025-03');
});

test('import rejects a dateOrder that contradicts the file, and invalid values', async () => {
  const csv = 'Track,Earnings,Date\nConA,1.00,25/03/2025\n';
  const r = await call('POST', '/api/statements/import', { source: 'ConSrc', csv, dateOrder: 'mdy' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /contradicts/);
  const bad = await call('POST', '/api/statements/import', { source: 'ConSrc', csv, dateOrder: 'ymd' });
  assert.equal(bad.status, 400);
});

test('statement rows whose title matches several songs are left unmatched, not guessed', async () => {
  await call('POST', '/api/songs', { title: 'Twin' });
  await call('POST', '/api/songs', { title: 'twin ' });
  await call('POST', '/api/songs', { title: 'Solo Match' });
  const csv = 'Track,Earnings,Sale Month\nTwin,10.00,2034-01\nSolo Match,5.00,2034-01\n';
  const r = await call('POST', '/api/statements/import', { source: 'TwinSrc', csv });
  assert.equal(r.data.matched, 1);
  assert.equal(r.data.ambiguous, 1);
  assert.equal(r.data.unmatched, 1);
});

test('an ISRC settles a duplicate title; a shared ISRC is ambiguous', async () => {
  const { data: a } = await call('POST', '/api/songs', { title: 'Dup Title', isrc: 'USZZ12500001' });
  await call('POST', '/api/songs', { title: 'Dup Title', isrc: 'USZZ12500002' });
  const r = await call('POST', '/api/statements/import', {
    source: 'IsrcSrc', csv: 'Track,ISRC,Earnings,Sale Month\nDup Title,US-ZZ1-25-00001,3.00,2034-02\n',
  });
  assert.equal(r.data.matched, 1);
  const songs = (await call('GET', '/api/songs')).data;
  assert.equal(songs.find((s) => s.id === a.id).earned, 3);

  await call('POST', '/api/songs', { title: 'Shared A', isrc: 'USZZ12500009' });
  await call('POST', '/api/songs', { title: 'Shared B', isrc: 'USZZ12500009' });
  const r2 = await call('POST', '/api/statements/import', {
    source: 'IsrcSrc2', csv: 'ISRC,Earnings,Sale Month\nUSZZ12500009,1.00,2034-02\n',
  });
  assert.equal(r2.data.matched, 0);
  assert.equal(r2.data.ambiguous, 1);
});

test('relinking skips ambiguous titles, and manual assign still works', async () => {
  const { data: one } = await call('POST', '/api/songs', { title: 'Late Twin' });
  const { data: two } = await call('POST', '/api/songs', { title: 'Late Twin' });
  await call('POST', '/api/statements/import', { source: 'LateSrc', csv: 'Track,Earnings,Sale Month\nLate Twin,8.00,2034-03\n' });
  const { data: other } = await call('POST', '/api/songs', { title: 'Unrelated' });
  assert.equal(other.linked, 0, 'adding a song triggers relink, which must not guess');
  const um = (await call('GET', '/api/unmatched')).data.find((u) => u.raw_title === 'Late Twin');
  assert.ok(um);
  const asg = await call('POST', '/api/unmatched/assign', { song_id: two.id, raw_title: um.raw_title, raw_isrc: um.raw_isrc });
  assert.equal(asg.data.updated, 1);
  const songs = (await call('GET', '/api/songs')).data;
  assert.equal(songs.find((s) => s.id === two.id).earned, 8);
  assert.equal(songs.find((s) => s.id === one.id).earned, 0);
});

// ---------- match_reason ----------

const reasonOf = (title) => app.db.prepare('SELECT song_id, match_reason FROM earnings WHERE raw_title = ?').all(title)
  .map((r) => ({ song_id: r.song_id, match_reason: r.match_reason }));

test('import records why a row is unmatched: none, ambiguous, or matched', async () => {
  await call('POST', '/api/songs', { title: 'Reason Twin' });
  await call('POST', '/api/songs', { title: 'reason twin ' });
  const { data: solo } = await call('POST', '/api/songs', { title: 'Reason Solo' });
  const csv = 'Track,Earnings,Sale Month\nReason Twin,1.00,2040-01\nReason Solo,2.00,2040-01\nReason Nobody,3.00,2040-01\n';
  await call('POST', '/api/statements/import', { source: 'ReasonSrc', csv });
  assert.deepEqual(reasonOf('Reason Twin'), [{ song_id: null, match_reason: 'ambiguous' }]);
  assert.deepEqual(reasonOf('Reason Solo'), [{ song_id: solo.id, match_reason: null }]);
  assert.deepEqual(reasonOf('Reason Nobody'), [{ song_id: null, match_reason: 'none' }]);
});

test('relinking refreshes the reason: stays, clears when matched, and resolves when a twin goes', async () => {
  const { data: t1 } = await call('POST', '/api/songs', { title: 'Shift Twin' });
  await call('POST', '/api/songs', { title: 'Shift Twin' });
  await call('POST', '/api/statements/import', {
    source: 'ShiftSrc', csv: 'Track,Earnings,Sale Month\nShift Twin,1.00,2041-01\nShift Late,2.00,2041-01\n',
  });
  assert.equal(reasonOf('Shift Twin')[0].match_reason, 'ambiguous');
  assert.equal(reasonOf('Shift Late')[0].match_reason, 'none');

  // an unrelated song changes nothing, even when a stale NULL needs recomputing
  app.db.exec("UPDATE earnings SET match_reason = NULL WHERE raw_title = 'Shift Twin'");
  await call('POST', '/api/songs', { title: 'Shift Unrelated' });
  assert.equal(reasonOf('Shift Twin')[0].match_reason, 'ambiguous');
  assert.equal(reasonOf('Shift Late')[0].match_reason, 'none');

  // the missing song arrives: linked, reason cleared
  const { data: late } = await call('POST', '/api/songs', { title: 'Shift Late' });
  assert.deepEqual(reasonOf('Shift Late'), [{ song_id: late.id, match_reason: null }]);

  // one twin deleted: the other is now the only candidate
  await call('DELETE', `/api/songs/${t1.id}`);
  await call('POST', '/api/songs', { title: 'Shift Poke' });
  const [row] = reasonOf('Shift Twin');
  assert.ok(row.song_id && row.song_id !== t1.id);
  assert.equal(row.match_reason, null);
});

// ---------- suggestions ----------

test('suggestSongs ranks by score, applies the cut-off and the limit, and handles no title', () => {
  const songs = [
    { id: 1, title: 'Midnight Drive', isrc: null },
    { id: 2, title: 'Midnight Drive (Radio Edit)', isrc: null },
    { id: 3, title: 'Midnigth Drive', isrc: null },
    { id: 4, title: 'Summer Rain', isrc: null },
    { id: 5, title: 'Midnight Dive', isrc: null },
  ];
  const got = suggestSongs(songs, 'Midnight Drive - Remastered');
  assert.deepEqual(got.map((s) => s.song_id), [1, 2, 5], 'exact normalised matches first, then the closest near-miss (one edit beats a transposition); limit is 3');
  assert.equal(got[0].score, 1);
  assert.ok(got[2].score < 1 && got[2].score >= 0.8);
  assert.deepEqual(suggestSongs(songs, 'Midnight Drive', { limit: 4 }).map((s) => s.song_id), [1, 2, 5, 3], 'the transposed typo is next');
  assert.ok(!suggestSongs(songs, 'Midnight Drive', { limit: 10 }).some((s) => s.song_id === 4), 'an unrelated title is below the cut-off');
  assert.deepEqual(suggestSongs(songs, 'Totally Different'), []);
  assert.deepEqual(suggestSongs(songs, null), []);
  assert.deepEqual(suggestSongs(songs, 'Midnight Drive', { limit: 1 }).length, 1);
  assert.equal(suggestSongs(songs, 'Midnight Drive', { min: 1 }).every((s) => s.score === 1), true);
});
