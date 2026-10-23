import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTestApp } from './helpers.js';
import { parseCsv } from '../parse.js';

const app = createTestApp();
const { call, raw, server } = app;
let base;
before(async () => { await app.start(); base = app.base; });
after(() => app.stop());

test('payment update only changes fields that were sent', async () => {
  const { data: p } = await call('POST', '/api/payments', {
    source: 'PaySrc', expected_amount: 100, received_amount: 100, received_date: '2025-02-01',
  });
  await call('PUT', `/api/payments/${p.id}`, { notes: 'cleared by bank' });
  let row = (await call('GET', '/api/payments')).data.find((x) => x.id === p.id);
  assert.equal(row.received_amount, 100);
  assert.equal(row.received_date, '2025-02-01');
  assert.equal(row.notes, 'cleared by bank');
  assert.equal(row.status, 'received');

  await call('PUT', `/api/payments/${p.id}`, { received_amount: 90 });
  row = (await call('GET', '/api/payments')).data.find((x) => x.id === p.id);
  assert.equal(row.received_amount, 90);
  assert.equal(row.received_date, '2025-02-01');
  assert.equal(row.notes, 'cleared by bank', 'notes survive when not sent');
  assert.equal(row.status, 'short');
});

test('payment update can explicitly clear received fields', async () => {
  const { data: p } = await call('POST', '/api/payments', {
    source: 'ClearSrc', expected_amount: 50, expected_date: '2999-01-01', received_amount: 50, received_date: '2025-02-01',
  });
  await call('PUT', `/api/payments/${p.id}`, { received_amount: null, received_date: null });
  const row = (await call('GET', '/api/payments')).data.find((x) => x.id === p.id);
  assert.equal(row.received_amount, null);
  assert.equal(row.received_date, null);
  assert.equal(row.status, 'pending');
});

test('updating a missing payment returns 404', async () => {
  const { status } = await call('PUT', '/api/payments/999999', { notes: 'x' });
  assert.equal(status, 404);
});

test('writes without a JSON content type are rejected (no-preflight cross-site form/fetch)', async () => {
  const before = (await call('GET', '/api/contributors')).data.length;
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', undefined]) {
    const r = await raw('POST', '/api/contributors', { headers: ct ? { 'Content-Type': ct } : {}, body: '{"name":"evil"}' });
    assert.equal(r.status, 415, `content type ${ct}`);
  }
  assert.equal((await call('GET', '/api/contributors')).data.length, before);
});

test('requests from a foreign Origin are rejected', async () => {
  const r = await raw('POST', '/api/contributors', {
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"name":"evil"}',
  });
  assert.equal(r.status, 403);
  const g = await raw('GET', '/api/contributors', { headers: { Origin: 'https://evil.example' } });
  assert.equal(g.status, 403);
});

test('requests with a non-local Host header are rejected (DNS rebinding)', async () => {
  const r = await raw('GET', '/api/contributors', { headers: { Host: 'evil.example' } });
  assert.equal(r.status, 403);
});

test('same-origin JSON requests still work', async () => {
  const port = server.address().port;
  const r = await raw('POST', '/api/contributors', {
    headers: { 'Content-Type': 'application/json; charset=utf-8', Origin: `http://127.0.0.1:${port}` },
    body: '{"name":"ok"}',
  });
  assert.equal(r.status, 200);
});

test('export neutralises spreadsheet formulas but leaves numbers alone', async () => {
  const csv = [
    'Track,ISRC,Store,Earnings,Sale Month',
    '"=HYPERLINK(""http://evil.example"")",,+cmd,-3.50,2033-01',
    '@SUM(1+1),,-store,2.00,2033-01',
    '"Plain, with comma",,Ok,1.00,2033-01',
  ].join('\n');
  await call('POST', '/api/statements/import', { source: '=src', csv });
  const rows = parseCsv(await fetch(base + '/api/export/earnings.csv').then((r) => r.text()));
  const mine = rows.filter((r) => r[4] === '2033-01');
  assert.equal(mine.length, 3);
  const byTitle = Object.fromEntries(mine.map((r) => [r[0], r]));

  const link = byTitle[`'=HYPERLINK("http://evil.example")`];
  assert.ok(link, 'title is prefixed with a quote');
  assert.equal(link[2], "'+cmd");
  assert.equal(link[6], '-3.5', 'negative amount stays numeric');
  assert.equal(link[7], "'=src", 'source is neutralised too');
  assert.equal(byTitle["'@SUM(1+1)"][2], "'-store");
  assert.equal(byTitle['Plain, with comma'][2], 'Ok', 'ordinary text is untouched');
  for (const r of mine) for (const cell of r) assert.ok(!/^[=+\-@]/.test(cell) || /^-?\d/.test(cell), `live formula: ${cell}`);
});

test('PUT/DELETE on a missing id returns 404', async () => {
  const body = { title: 'x', name: 'x', source: 'x' };
  const cases = [
    ['PUT', '/api/songs/987654', body],
    ['DELETE', '/api/songs/987654'],
    ['PUT', '/api/songs/987654/splits', { splits: [] }],
    ['DELETE', '/api/contributors/987654'],
    ['DELETE', '/api/statements/987654'],
    ['DELETE', '/api/payments/987654'],
    ['DELETE', '/api/advances/987654'],
    ['PUT', '/api/payments/987654', { notes: 'x' }],
    ['POST', '/api/unmatched/assign', { song_id: 987654, raw_title: 'x' }],
  ];
  for (const [m, p, b] of cases) {
    const r = await call(m, p, b);
    assert.equal(r.status, 404, `${m} ${p}`);
    assert.match(r.data.error, /not found/i);
  }
});

test('PUT/DELETE on existing ids still succeed, and a second DELETE is 404', async () => {
  const { data: song } = await call('POST', '/api/songs', { title: 'Exists' });
  assert.equal((await call('PUT', `/api/songs/${song.id}`, { title: 'Exists 2' })).status, 200);
  assert.equal((await call('PUT', `/api/songs/${song.id}/splits`, { splits: [] })).status, 200);

  const { data: c } = await call('POST', '/api/contributors', { name: 'Gone' });
  assert.equal((await call('DELETE', `/api/contributors/${c.id}`)).status, 200);
  assert.equal((await call('DELETE', `/api/contributors/${c.id}`)).status, 404);

  assert.equal((await call('DELETE', `/api/songs/${song.id}`)).status, 200);
  assert.equal((await call('DELETE', `/api/songs/${song.id}`)).status, 404);

  const { data: a } = await call('POST', '/api/advances', { source: 'DelSrc', amount: 1 });
  assert.equal((await call('DELETE', `/api/advances/${a.id}`)).status, 200);
  const { data: p } = await call('POST', '/api/payments', { source: 'DelSrc', expected_amount: 1 });
  assert.equal((await call('DELETE', `/api/payments/${p.id}`)).status, 200);
});

test('editing a song with no field changes still succeeds', async () => {
  const { data: song } = await call('POST', '/api/songs', { title: 'Same' });
  assert.equal((await call('PUT', `/api/songs/${song.id}`, { title: 'Same' })).status, 200);
});

test('serves the UI files', async () => {
  for (const [path, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/style.css', 'text/css']]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('content-type'), type);
    await res.text();
  }
  assert.equal((await fetch(base + '/nope.js')).status, 404);
});

test('static serving cannot escape public/', async () => {
  for (const path of ['/../server.js', '/..%2fserver.js', '/%2e%2e/server.js', '/../package.json', '/public/../../server.js']) {
    const r = await raw('GET', path);
    assert.ok(r.status === 404 || r.status === 400, `${path} -> ${r.status}`);
    assert.ok(!r.body.includes('DatabaseSync'), `${path} leaked source`);
  }
});

test('UI never builds HTML from API data', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src), 'use textContent/DOM nodes, not HTML strings');
});

test('splits naming a nonexistent contributor return 404 and change nothing', async () => {
  const { data: c } = await call('POST', '/api/contributors', { name: 'Real Split' });
  const { data: song } = await call('POST', '/api/songs', { title: 'Split Guard' });
  await call('PUT', `/api/songs/${song.id}/splits`, { splits: [{ contributor_id: c.id, pct: 50 }] });

  const r = await call('PUT', `/api/songs/${song.id}/splits`, {
    splits: [{ contributor_id: c.id, pct: 30 }, { contributor_id: 987654, pct: 20 }],
  });
  assert.equal(r.status, 404);
  assert.match(r.data.error, /Contributor 987654 not found/);

  const s = (await call('GET', '/api/songs')).data.find((x) => x.id === song.id);
  assert.deepEqual(s.splits.map((x) => [x.contributor_id, x.pct]), [[c.id, 50]], 'existing splits untouched');
});

test('malformed split entries are 400s, not 409s or 500s', async () => {
  const { data: song } = await call('POST', '/api/songs', { title: 'Split Shapes' });
  for (const splits of [[null], ['x'], [{ pct: 10 }], [{ contributor_id: 'abc', pct: 10 }], [{ contributor_id: 1.5, pct: 10 }]]) {
    const r = await call('PUT', `/api/songs/${song.id}/splits`, { splits });
    assert.equal(r.status, 400, JSON.stringify(splits));
  }
});

// ---------- MLC bulk match ----------

test('songs store an MLC Song Code; PUT keeps it unless told otherwise', async () => {
  const { data: s } = await call('POST', '/api/songs', { title: 'Code Keeper', isrc: 'USZZ12800001', mlc_song_code: ' M9001 ' });
  const code = async () => (await call('GET', '/api/songs')).data.find((x) => x.id === s.id).mlc_song_code;
  assert.equal(await code(), 'M9001', 'trimmed on save');
  await call('PUT', `/api/songs/${s.id}`, { title: 'Code Keeper 2' });
  assert.equal(await code(), 'M9001', 'an update that omits the field leaves it alone');
  await call('PUT', `/api/songs/${s.id}`, { title: 'Code Keeper 2', mlc_song_code: 'M9002' });
  assert.equal(await code(), 'M9002');
  await call('PUT', `/api/songs/${s.id}`, { title: 'Code Keeper 2', mlc_song_code: null });
  assert.equal(await code(), null, 'null clears it');
});

test('MLC bulk-match preview and CSV download', async () => {
  await call('POST', '/api/songs', { title: 'Csv Ready', isrc: 'US-ZZ1-28-00002', mlc_song_code: 'M9101' });
  const { data: bad } = await call('POST', '/api/songs', { title: 'Csv Bad Code', isrc: 'USZZ12800003', mlc_song_code: '=1+1' });

  const preview = (await call('GET', '/api/mlc/bulk-match')).data;
  assert.ok(preview.ready >= 1);
  assert.ok(preview.skipped.some((s) => s.song_id === bad.id));

  const res = await fetch(base + '/api/export/mlc-bulk-match.csv');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(res.headers.get('content-disposition'), /filename="mlc-bulk-match\.csv"/);
  const lines = (await res.text()).split('\n');
  assert.equal(lines[0], 'ISRC,MLC Song Code');
  assert.ok(lines.includes('USZZ12800002,M9101'), 'ISRC normalised to 12 characters');
  assert.ok(!lines.some((l) => l.includes('=1+1')));

  const earnings = await fetch(base + '/api/export/earnings.csv');
  assert.equal(earnings.headers.get('content-type'), 'text/csv');
  assert.match(earnings.headers.get('content-disposition'), /filename="earnings\.csv"/);
});
