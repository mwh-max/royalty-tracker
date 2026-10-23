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
