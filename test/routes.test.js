import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
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

// ---------- unmatched reasons ----------

test('/api/unmatched says why each group is unmatched, and assigning clears it', async () => {
  await call('POST', '/api/songs', { title: 'Why Twin' });
  await call('POST', '/api/songs', { title: 'Why Twin' });
  const csv = 'Track,Earnings,Sale Month\nWhy Twin,4.00,2042-01\nWhy Nobody,6.00,2042-01\n';
  await call('POST', '/api/statements/import', { source: 'WhySrc', csv });

  const list = (await call('GET', '/api/unmatched')).data;
  const twin = list.find((u) => u.raw_title === 'Why Twin'), nobody = list.find((u) => u.raw_title === 'Why Nobody');
  assert.equal(twin.reason, 'ambiguous');
  assert.equal(nobody.reason, 'none');

  const { data: song } = await call('POST', '/api/songs', { title: 'Why Chosen' });
  await call('POST', '/api/unmatched/assign', { song_id: song.id, raw_title: twin.raw_title, raw_isrc: twin.raw_isrc });
  assert.ok(!(await call('GET', '/api/unmatched')).data.some((u) => u.raw_title === 'Why Twin'));
  assert.equal(app.db.prepare("SELECT match_reason FROM earnings WHERE raw_title = 'Why Twin'").get().match_reason, null);
});

test('rows left unmatched by a deleted song are reported as none', async () => {
  const { data: gone } = await call('POST', '/api/songs', { title: 'Why Gone' });
  await call('POST', '/api/statements/import', { source: 'GoneSrc', csv: 'Track,Earnings,Sale Month\nWhy Gone,2.00,2042-02\n' });
  await call('DELETE', `/api/songs/${gone.id}`);
  const row = (await call('GET', '/api/unmatched')).data.find((u) => u.raw_title === 'Why Gone');
  assert.equal(row.reason, 'none');
});

// ---------- split types ----------

test('splits default to master; composition splits are saved and replaced independently', async () => {
  const { data: a } = await call('POST', '/api/contributors', { name: 'Typed A' });
  const { data: b } = await call('POST', '/api/contributors', { name: 'Typed B' });
  const { data: song } = await call('POST', '/api/songs', { title: 'Typed Splits' });
  const get = async () => (await call('GET', '/api/songs')).data.find((x) => x.id === song.id);

  const m = await call('PUT', `/api/songs/${song.id}/splits`, { splits: [{ contributor_id: a.id, pct: 100 }] });
  assert.equal(m.data.type, 'master', 'no type means master, as before');
  const c = await call('PUT', `/api/songs/${song.id}/splits`, { type: 'composition', splits: [{ contributor_id: a.id, pct: 40 }, { contributor_id: b.id, pct: 60 }] });
  assert.equal(c.status, 200);
  assert.equal(c.data.type, 'composition');

  let s = await get();
  assert.deepEqual(s.splits.map((x) => [x.contributor_id, x.pct]), [[a.id, 100]], 'master untouched by the composition save');
  assert.equal(s.compositionSplitTotal, 100);

  await call('PUT', `/api/songs/${song.id}/splits`, { type: 'composition', splits: [{ contributor_id: b.id, pct: 100 }] });
  await call('PUT', `/api/songs/${song.id}/splits`, { splits: [] });
  s = await get();
  assert.deepEqual(s.splits, [], 'clearing master leaves composition alone');
  assert.deepEqual(s.compositionSplits.map((x) => [x.contributor_id, x.pct]), [[b.id, 100]]);
});

test('split types are validated per type', async () => {
  const { data: a } = await call('POST', '/api/contributors', { name: 'Typed C' });
  const { data: song } = await call('POST', '/api/songs', { title: 'Typed Rules' });
  const put = (body) => call('PUT', `/api/songs/${song.id}/splits`, body);

  assert.equal((await put({ type: 'publishing', splits: [] })).status, 400);
  assert.equal((await put({ type: 'composition', splits: [{ contributor_id: a.id, pct: 60 }, { contributor_id: a.id, pct: 20 }] })).status, 400, 'twice within one type');
  assert.equal((await put({ type: 'composition', splits: [{ contributor_id: a.id, pct: 101 }] })).status, 400, 'over 100% within one type');
  await put({ splits: [{ contributor_id: a.id, pct: 100 }] });
  assert.equal((await put({ type: 'composition', splits: [{ contributor_id: a.id, pct: 100 }] })).status, 200, 'the same contributor may hold both kinds, each up to 100%');
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

// ---------- suggestions on unmatched groups ----------

test('/api/unmatched suggests likely songs and never assigns them', async () => {
  const { data: drive } = await call('POST', '/api/songs', { title: 'Sugg Midnight Drive' });
  await call('POST', '/api/songs', { title: 'Sugg Summer Rain' });
  const { data: twinA } = await call('POST', '/api/songs', { title: 'Sugg Twin' });
  const { data: twinB } = await call('POST', '/api/songs', { title: 'Sugg Twin' });
  const csv = [
    'Track,Earnings,Sale Month',
    'Sugg Midnight Drive (Radio Edit),5.00,2043-01', // version tag: exact after normalising
    'Sugg Midnigth Drive,4.00,2043-01', // typo
    'Sugg Twin,3.00,2043-01', // matches two songs exactly: ambiguous
    'Sugg Unrelated Thing,2.00,2043-01',
  ].join('\n');
  await call('POST', '/api/statements/import', { source: 'SuggSrc', csv });

  const list = (await call('GET', '/api/unmatched')).data;
  const by = (title) => list.find((u) => u.raw_title === title);

  const edit = by('Sugg Midnight Drive (Radio Edit)');
  assert.equal(edit.suggestions[0].song_id, drive.id);
  assert.equal(edit.suggestions[0].score, 1);
  assert.equal(by('Sugg Midnigth Drive').suggestions[0].song_id, drive.id);
  assert.ok(by('Sugg Midnigth Drive').suggestions[0].score < 1);

  const twin = by('Sugg Twin');
  assert.equal(twin.reason, 'ambiguous');
  assert.deepEqual(twin.suggestions.map((s) => s.song_id).sort((a, b) => a - b), [twinA.id, twinB.id].sort((a, b) => a - b), 'both candidates offered');

  assert.deepEqual(by('Sugg Unrelated Thing').suggestions, []);
  assert.ok(list.every((u) => Array.isArray(u.suggestions)), 'every group carries the field');

  // suggesting is read-only: the rows are still unmatched
  assert.equal(app.db.prepare("SELECT count(*) c FROM earnings WHERE raw_title LIKE 'Sugg %' AND song_id IS NOT NULL").get().c, 0);
});

// ---------- composition readiness ----------

test('/api/composition/readiness reports each song and updates as splits change', async () => {
  const { data: a } = await call('POST', '/api/contributors', { name: 'Route Ready' });
  const { data: song } = await call('POST', '/api/songs', { title: 'Route Readiness Song' });
  const find = async () => (await call('GET', '/api/composition/readiness')).data.songs.find((s) => s.song_id === song.id);

  assert.equal((await find()).status, 'missing');
  await call('PUT', `/api/songs/${song.id}/splits`, { type: 'composition', splits: [{ contributor_id: a.id, pct: 40 }] });
  const short = await find();
  assert.equal(short.status, 'short');
  assert.equal(short.total, 40);
  await call('PUT', `/api/songs/${song.id}/splits`, { type: 'composition', splits: [{ contributor_id: a.id, pct: 100 }] });
  assert.equal((await find()).status, 'ready');

  const all = (await call('GET', '/api/composition/readiness')).data;
  assert.ok(all.ready >= 1 && all.total >= all.ready);
});

// ---------- request body decoding ----------

test('a large import keeps a multibyte character that straddles two body chunks intact', async () => {
  const rows = Array.from({ length: 8000 }, (_, i) => `Café Ñandú ${i} 東京,1.00`).join('\n');
  const body = Buffer.from(JSON.stringify({ source: 'MultibyteSrc', csv: `Track,Earnings\n${rows}\n` }));
  // cut the body just after the lead byte of a multibyte character (the next byte is a continuation byte)
  let cut = body.length >> 1;
  while ((body[cut] & 0xc0) !== 0x80) cut++;

  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/api/statements/import',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.write(body.subarray(0, cut));
    setTimeout(() => req.end(body.subarray(cut)), 50); // long enough for the server to see two separate chunks
  });
  assert.equal(status, 200);

  const titles = (await call('GET', '/api/unmatched')).data.map((u) => u.raw_title).filter((t) => t.startsWith('Café Ñandú '));
  assert.equal(titles.length, 8000);
  assert.deepEqual(titles.filter((t) => t.includes('\uFFFD')), [], 'no title was corrupted at the chunk boundary');
});
