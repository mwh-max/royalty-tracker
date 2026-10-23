import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';

const app = createTestApp();
const { call } = app;
let base;
before(async () => { await app.start(); base = app.base; });
after(() => app.stop());

const dash = async (qs = '') => (await call('GET', `/api/dashboard${qs}`)).data;

test('advances from one source share a pool of earnings', async () => {
  const csv = 'Track,Earnings,Sale Month\nPool,1500.00,2025-02\n';
  await call('POST', '/api/statements/import', { source: 'PoolSrc', csv });
  await call('POST', '/api/advances', { source: 'PoolSrc', amount: 1000, date: '2025-01-01' });
  await call('POST', '/api/advances', { source: 'PoolSrc', amount: 1000, date: '2025-01-15' });

  const rows = (await call('GET', '/api/advances')).data.filter((a) => a.source === 'PoolSrc');
  const [later, earlier] = rows; // newest first
  assert.equal(earlier.recouped, 1000);
  assert.equal(earlier.balance, 0);
  assert.equal(later.recouped, 500, 'only the 500 left after the first advance');
  assert.equal(later.balance, 500);
  assert.equal(rows.reduce((a, r) => a + r.recouped, 0), 1500, 'never recoups more than was earned');
});

test('advance ignores earnings from before its date and other sources', async () => {
  const csv = 'Track,Earnings,Sale Month\nOld,300.00,2024-06\nNew,50.00,2025-03\n';
  await call('POST', '/api/statements/import', { source: 'DateSrc', csv });
  await call('POST', '/api/advances', { source: 'DateSrc', amount: 200, date: '2025-01-01' });
  const a = (await call('GET', '/api/advances')).data.find((r) => r.source === 'DateSrc');
  assert.equal(a.recouped, 50);
  assert.equal(a.balance, 150);
});

test('dashboard: earnings filter excludes undated rows and unmatched respects the range', async () => {
  const csvA = 'Track,Earnings,Sale Month\nDashA,10.00,2031-01\nDashB,20.00,2031-02\nDashNoPeriod,5.00,\n';
  await call('POST', '/api/statements/import', { source: 'DashSrc', csv: csvA });

  const all = await dash();
  const jan = await dash('?from=2031-01&to=2031-01');
  const feb = await dash('?from=2031-02&to=2031-02');
  assert.equal(jan.total, 10);
  assert.equal(feb.total, 20);
  assert.equal(jan.byPeriod.length, 1);
  assert.ok(all.byPeriod.some((p) => p.k === 'unknown'), 'undated rows are visible when unfiltered');
  assert.ok(!jan.byPeriod.some((p) => p.k === 'unknown'));
  assert.equal(jan.undated.t, 5, 'excluded undated earnings are reported, not hidden');
  assert.equal(jan.unmatched.t, 10, 'unmatched follows the filter');
  assert.equal(feb.unmatched.t, 20);
});

test('dashboard: open-ended filters work', async () => {
  assert.equal((await dash('?from=2031-02')).total, 20);
  const upToJan = (await dash('?to=2031-01')).total, upToDec = (await dash('?to=2030-12')).total;
  assert.ok(Math.abs(upToJan - upToDec - 10) < 1e-9);
});

test('dashboard: payments and advances follow the date filter', async () => {
  await call('POST', '/api/payments', { source: 'FPay', expected_amount: 100, expected_date: '2032-01-15', received_amount: 90, received_date: '2032-02-03' });
  await call('POST', '/api/payments', { source: 'FPay', expected_amount: 40, expected_date: '2032-03-10' });
  await call('POST', '/api/payments', { source: 'FPay', expected_amount: 7 });
  await call('POST', '/api/advances', { source: 'FAdv', amount: 500, date: '2032-01-01' });
  await call('POST', '/api/advances', { source: 'FAdv', amount: 300, date: '2032-04-01' });
  await call('POST', '/api/advances', { source: 'FAdv', amount: 11 });

  const feb = await dash('?from=2032-02&to=2032-02'); // received 2032-02 counts under February
  assert.equal(feb.payments.exp, 100);
  assert.equal(feb.payments.rec, 90);
  assert.equal(feb.advances, 0);

  const q1 = await dash('?from=2032-01&to=2032-03');
  assert.equal(q1.payments.exp, 140);
  assert.equal(q1.advances, 500);
  assert.equal(q1.undatedPayments, 1);
  assert.equal(q1.undatedAdvances, 1);

  const none = await dash();
  assert.ok(none.payments.exp >= 147, 'unfiltered includes undated payments');
  assert.ok(none.advances >= 811);
});

test('payout summary reports unallocated earnings instead of dropping them', async () => {
  const { data: a } = await call('POST', '/api/contributors', { name: 'Payee A' });
  const { data: b } = await call('POST', '/api/contributors', { name: 'Payee B' });
  const { data: full } = await call('POST', '/api/songs', { title: 'Fully Split 2035' });
  const { data: part } = await call('POST', '/api/songs', { title: 'Partly Split 2035' });
  await call('POST', '/api/songs', { title: 'No Split 2035' });
  await call('PUT', `/api/songs/${full.id}/splits`, { splits: [{ contributor_id: a.id, pct: 60 }, { contributor_id: b.id, pct: 40 }] });
  await call('PUT', `/api/songs/${part.id}/splits`, { splits: [{ contributor_id: a.id, pct: 50 }] });
  const csv = 'Track,Earnings,Sale Month\nFully Split 2035,100,2035-01\nPartly Split 2035,200,2035-01\nNo Split 2035,40,2035-01\nNobody 2035,10,2035-01\n';
  await call('POST', '/api/statements/import', { source: 'PaySumSrc', csv });

  const before = await call('GET', '/api/payouts');
  assert.ok(Array.isArray(before.data), '/api/payouts keeps its original shape');

  const { data } = await call('GET', '/api/payouts/summary');
  const pa = data.contributors.find((c) => c.id === a.id), pb = data.contributors.find((c) => c.id === b.id);
  assert.equal(pa.owed, 60 + 100);
  assert.equal(pb.owed, 40);
  const ps = data.underSplitSongs.find((s) => s.song_id === part.id);
  assert.equal(ps.unallocated, 100);
  assert.ok(!data.underSplitSongs.some((s) => s.song_id === full.id));
  assert.ok(data.underSplitSongs.some((s) => s.title === 'No Split 2035' && s.unallocated === 40));
  assert.equal(data.unmatched >= 10, true);
  // every dollar is either owed to someone or reported as unallocated
  assert.ok(Math.abs(data.owed + data.unallocated - data.total) < 1e-6, `${data.owed} + ${data.unallocated} != ${data.total}`);
});

test('many small amounts add up exactly, in totals and in the export', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => `Float ${i % 7},0.1,2036-01`).join('\n');
  await call('POST', '/api/statements/import', { source: 'FloatSrc', csv: `Track,Earnings,Sale Month\n${rows}\n` });
  const jan = (await call('GET', '/api/dashboard?from=2036-01&to=2036-01')).data;
  assert.equal(jan.total, 100, `1000 x 0.1 should be exactly 100, got ${jan.total}`);
  const exp = await fetch(base + '/api/export/earnings.csv').then((r) => r.text());
  assert.ok(exp.split('\n').filter((l) => l.startsWith('Float ')).every((l) => l.split(',')[6] === '0.1'));
});

test('three-way splits stay exact and nothing is lost or invented', async () => {
  const cs = [];
  for (const n of ['T1', 'T2', 'T3']) cs.push((await call('POST', '/api/contributors', { name: `Third ${n}` })).data.id);
  const { data: song } = await call('POST', '/api/songs', { title: 'Thirds 2037' });
  await call('PUT', `/api/songs/${song.id}/splits`, { splits: cs.map((id, i) => ({ contributor_id: id, pct: i < 2 ? 33.33 : 33.34 })) });
  await call('POST', '/api/statements/import', { source: 'ThirdSrc', csv: 'Track,Earnings,Sale Month\nThirds 2037,100.00,2037-01\nThirds 2037,0.01,2037-01\n' });
  const { data } = await call('GET', '/api/payouts/summary');
  const mine = data.contributors.filter((c) => cs.includes(c.id));
  assert.deepEqual(mine.map((c) => c.owed).sort((a, b) => a - b), [33.333333, 33.333333, 33.343334]);
  assert.ok(Math.abs(data.owed + data.unallocated - data.total) < 1e-9);
  // in whole micros the books balance exactly
  const m = (x) => Math.round(x * 1e6);
  assert.equal(m(data.owed) + m(data.unallocated), m(data.total));
});

test('payments and advances keep sub-cent precision and status tolerance', async () => {
  const { data: p } = await call('POST', '/api/payments', { source: 'MoneyPay', expected_amount: 10.005, received_amount: 10.005 });
  let row = (await call('GET', '/api/payments')).data.find((x) => x.id === p.id);
  assert.equal(row.expected_amount, 10.005);
  assert.equal(row.status, 'received');
  await call('PUT', `/api/payments/${p.id}`, { received_amount: 10.0 }); // 0.005 short = exactly half a cent
  row = (await call('GET', '/api/payments')).data.find((x) => x.id === p.id);
  assert.equal(row.status, 'short');
  await call('PUT', `/api/payments/${p.id}`, { received_amount: 10.0051 });
  row = (await call('GET', '/api/payments')).data.find((x) => x.id === p.id);
  assert.equal(row.status, 'received', 'within half a cent counts as paid in full');
  assert.equal((await call('POST', '/api/payments', { source: 'x', expected_amount: 1e15 })).status, 400);
});

// ---------- MLC bulk match ----------

test('mlcBulkMatch pairs ISRCs with MLC Song Codes and says why a song was skipped', async () => {
  const mk = async (title, isrc, code) => Number(app.db.prepare('INSERT INTO songs (title, isrc, mlc_song_code) VALUES (?,?,?)').run(title, isrc, code).lastInsertRowid);
  const ok = await mk('Mlc Ok', 'US-ZZ1-26-00001', 'M0001');
  await mk('Mlc Not Registered', 'USZZ12600002', null);
  const noIsrc = await mk('Mlc No Isrc', null, 'M0003');
  const badIsrc = await mk('Mlc Bad Isrc', 'USZZ126', 'M0004');
  const clashA = await mk('Mlc Clash A', 'USZZ12600005', 'M0005');
  const clashB = await mk('Mlc Clash B', 'USZZ12600005', 'M0006');
  await mk('Mlc Same A', 'USZZ12600007', 'M0007');
  await mk('Mlc Same B', 'USZZ12600007', 'M0007');
  const { mlcBulkMatch, mlcBulkMatchCsv } = await import('../queries.js');

  const { rows, skipped } = mlcBulkMatch(app.db);
  assert.deepEqual(rows, [
    { isrc: 'USZZ12600001', mlc_song_code: 'M0001' },
    { isrc: 'USZZ12600007', mlc_song_code: 'M0007' },
  ]);
  const why = Object.fromEntries(skipped.map((s) => [s.song_id, s.reason]));
  assert.deepEqual(Object.keys(why).map(Number).sort((a, b) => a - b), [noIsrc, badIsrc, clashA, clashB].sort((a, b) => a - b));
  assert.match(why[noIsrc], /no ISRC/);
  assert.match(why[badIsrc], /12 letters/);
  assert.match(why[clashA], /different MLC Song Codes/);
  assert.match(why[clashB], /different MLC Song Codes/, 'a clash skips both songs, not just one');
  assert.ok(!(ok in why));
  assert.equal(mlcBulkMatchCsv(rows), 'ISRC,MLC Song Code\nUSZZ12600001,M0001\nUSZZ12600007,M0007\n');
});

test('mlcBulkMatch rejects codes that could be read as formulas or break the CSV', async () => {
  const bad = ['=SUM(1)', '+1', '-1', '@x', 'a b', 'a,b', 'a"b'];
  const ids = [];
  for (const [i, code] of bad.entries()) {
    ids.push(Number(app.db.prepare('INSERT INTO songs (title, isrc, mlc_song_code) VALUES (?,?,?)').run(`Mlc Code ${i}`, `USZZ1270000${i}`, code).lastInsertRowid));
  }
  const { mlcBulkMatch } = await import('../queries.js');
  const { rows, skipped } = mlcBulkMatch(app.db);
  for (const id of ids) assert.ok(skipped.some((s) => s.song_id === id), `song ${id} should be skipped`);
  assert.ok(!rows.some((r) => r.isrc.startsWith('USZZ1270000')));
});
