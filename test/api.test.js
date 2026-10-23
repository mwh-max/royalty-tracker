import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_FILE = ':memory:';
const { server, parseMoney, parseCsv, normPeriod, detectDateOrder } = await import('../server.js');

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
  assert.equal(parseMoney('$0.0123456'), 0.0123456);
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
