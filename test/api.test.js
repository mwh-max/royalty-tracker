import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_FILE = ':memory:';
const { server, parseMoney, parseMoneyMicros, microsToString, parseCsv, normPeriod, detectDateOrder } = await import('../server.js');

let base;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return { status: res.status, data };
};

test('parseMoney: sub-cent decimals are not read as whole numbers', () => {
  assert.equal(parseMoney('0.00456'), 0.00456);
  assert.equal(parseMoney('0.005'), 0.005);
  assert.equal(parseMoney('0,00456'), 0.00456);
  assert.equal(parseMoney('$0.012345'), 0.012345);
});

test('parseMoney: common formats', () => {
  assert.equal(parseMoney('12.5'), 12.5);
  assert.equal(parseMoney('41.20'), 41.2);
  assert.equal(parseMoney('1,234'), 1234);
  assert.equal(parseMoney('1,234.50'), 1234.5);
  assert.equal(parseMoney('1.234,50'), 1234.5);
  assert.equal(parseMoney('1,234,567'), 1234567);
  assert.equal(parseMoney('(5.00)'), -5);
  assert.equal(parseMoney('-3.25'), -3.25);
  assert.ok(Number.isNaN(parseMoney('n/a')));
  assert.ok(Number.isNaN(parseMoney(null)));
});

test('parseCsv handles quotes, CRLF and delimiters', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
});

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

// ---------- cross-site protection ----------

const raw = (method, path, { headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(body);
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

// ---------- period / date handling ----------

test('normPeriod: unambiguous formats', () => {
  assert.equal(normPeriod('2025-01'), '2025-01');
  assert.equal(normPeriod('2025/3/15'), '2025-03');
  assert.equal(normPeriod('03/2025'), '2025-03');
  assert.equal(normPeriod('Jan 2025'), '2025-01');
});

test('normPeriod: day-first vs month-first', () => {
  assert.equal(normPeriod('05/03/2025', 'mdy'), '2025-05');
  assert.equal(normPeriod('05/03/2025', 'dmy'), '2025-03');
  assert.equal(normPeriod('25.03.2025', 'dmy'), '2025-03');
  assert.equal(normPeriod('03/25/2025', 'mdy'), '2025-03');
});

test('detectDateOrder', () => {
  assert.equal(detectDateOrder(['25/03/2025', '01/04/2025']), 'dmy');
  assert.equal(detectDateOrder(['03/25/2025', '04/01/2025']), 'mdy');
  assert.equal(detectDateOrder(['01/03/2025', '02/03/2025']), 'ambiguous');
  assert.equal(detectDateOrder(['2025-01', '2025-02']), null);
  assert.throws(() => detectDateOrder(['25/03/2025', '03/25/2025']), /mixes/);
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

// ---------- dashboard filtering ----------

const dash = async (qs = '') => (await call('GET', `/api/dashboard${qs}`)).data;

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

// ---------- CSV export ----------

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

// ---------- missing ids ----------

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

// ---------- ambiguous song matching ----------

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

// ---------- payouts ----------

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

// ---------- static UI ----------

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

// ---------- split validation ----------

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

// ---------- integer money ----------

import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

test('parseMoneyMicros is exact and rounds past the sixth decimal', () => {
  assert.equal(parseMoneyMicros('0.00456'), 4560);
  assert.equal(parseMoneyMicros('1,234.50'), 1234500000);
  assert.equal(parseMoneyMicros('0.1'), 100000);
  assert.equal(parseMoneyMicros('0.0000004'), 0);
  assert.equal(parseMoneyMicros('0.0000005'), 1);
  assert.equal(parseMoneyMicros('0.0000015'), 2);
  assert.equal(parseMoneyMicros('(2.50)'), -2500000);
  assert.equal(parseMoneyMicros('-0.000001'), -1);
  assert.ok(Number.isNaN(parseMoneyMicros('99999999999999999999')), 'beyond the safe range');
  assert.ok(Number.isNaN(parseMoneyMicros('')));
});

test('microsToString has no float artefacts', () => {
  assert.equal(microsToString(1234500000), '1234.5');
  assert.equal(microsToString(4560), '0.00456');
  assert.equal(microsToString(-3500000), '-3.5');
  assert.equal(microsToString(0), '0');
  assert.equal(microsToString(1), '0.000001');
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

test('a database with dollar REAL columns is migrated to integer micros', () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'rt-migrate-'));
  const file = nodePath.join(dir, 'old.db');
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

  const script = `
    const { server } = await import(${JSON.stringify(new URL('../server.js', import.meta.url).href)});
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    const get = (p) => fetch(base + p).then((r) => r.json());
    console.log(JSON.stringify({ dash: await get('/api/dashboard'), pay: await get('/api/payments'),
      adv: await get('/api/advances'), songs: await get('/api/songs'), payouts: await get('/api/payouts/summary') }));
    process.exit(0);`;
  const run = () => spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
    env: { ...process.env, DB_FILE: file }, encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const out = JSON.parse(first.stdout);
  assert.equal(out.dash.total, 1234.8, 'floats converted without drift');
  assert.equal(out.dash.unmatched.t, 1234.5);
  assert.equal(out.pay[0].expected_amount, 100.25);
  assert.equal(out.pay[0].status, 'received');
  assert.equal(out.adv[0].amount, 500);
  assert.equal(out.adv[0].recouped, 500);
  assert.equal(out.songs[0].earned, 0.3);
  assert.equal(out.payouts.contributors[0].owed, 0.15);

  // idempotent: opening the migrated file again changes nothing
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), out);

  const check = new DatabaseSync(file);
  const cols = check.prepare('PRAGMA table_info(earnings)').all().map((c) => c.name);
  assert.ok(cols.includes('amount_micros') && !cols.includes('amount'));
  assert.equal(check.prepare('SELECT typeof(amount_micros) t FROM earnings LIMIT 1').get().t, 'integer');
  assert.equal(check.prepare("SELECT count(*) c FROM sqlite_master WHERE name = 'idx_earn_song'").get().c, 1, 'index recreated');
  check.close();
});
