import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, parseMoneyMicros, microsToString, parseCsv, normPeriod, detectDateOrder, normIsrc, hasIsrcLayout, normTitle, titleSimilarity } from '../parse.js';

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

test('normIsrc: 12 letters/digits, hyphens and spaces dropped, anything else is null', () => {
  assert.equal(normIsrc('US-ZZ1-25-00001'), 'USZZ12500001');
  assert.equal(normIsrc(' uszz12500001 '), 'USZZ12500001');
  assert.equal(normIsrc('USZZ1250000'), null, 'too short');
  assert.equal(normIsrc('USZZ125000012'), null, 'too long');
  assert.equal(normIsrc('USZZ1250000!'), null);
  assert.equal(normIsrc(null), null);
  assert.equal(normIsrc(''), null);
});

test('normTitle drops version and featured-artist tags but keeps other parentheticals', () => {
  assert.equal(normTitle('Midnight Drive (Radio Edit)'), 'midnight drive');
  assert.equal(normTitle('Midnight Drive - Remastered 2020'), 'midnight drive');
  assert.equal(normTitle('Midnight Drive [Live at Rio]'), 'midnight drive');
  assert.equal(normTitle('Midnight Drive (feat. Ana)'), 'midnight drive');
  assert.equal(normTitle('Midnight Drive feat. Ana'), 'midnight drive');
  assert.equal(normTitle('  Café   del  Mar  '), 'cafe del mar');
  assert.equal(normTitle('Rock & Roll!'), 'rock and roll');
  assert.equal(normTitle('Song (Part 2)'), 'song part 2', 'a part number is not a version tag');
  assert.equal(normTitle('Live Forever'), 'live forever', 'a version word in the title itself is kept');
  assert.equal(normTitle(null), '');
});

test('titleSimilarity: 1 for the same song, high for a typo, low for different songs', () => {
  assert.equal(titleSimilarity('Midnight Drive', 'midnight drive (Radio Edit)'), 1);
  assert.ok(titleSimilarity('Midnigth Drive', 'Midnight Drive') > 0.8);
  assert.ok(titleSimilarity('Song (Part 1)', 'Song (Part 2)') < 1, 'different parts are not identical');
  assert.ok(titleSimilarity('Midnight Drive', 'Summer Rain') < 0.4);
  assert.equal(titleSimilarity('', 'Anything'), 0);
  assert.equal(titleSimilarity('(Live)', 'Midnight Drive'), 0, 'nothing left after normalising');
});

test('hasIsrcLayout: 2 letters, 3 letters or digits, 2 digits, 5 digits', () => {
  assert.equal(hasIsrcLayout('USZZ12600001'), true);
  assert.equal(hasIsrcLayout('GBAB12400123'), true);
  assert.equal(hasIsrcLayout('QM9A12400123'), true, 'the registrant part may mix letters and digits');
  assert.equal(hasIsrcLayout('1SZZ12600001'), false, 'country part must be letters');
  assert.equal(hasIsrcLayout('USZZ1AB00001'), false, 'year part must be digits');
  assert.equal(hasIsrcLayout('USZZ1260000A'), false, 'designation part must be digits');
  assert.equal(hasIsrcLayout('USZZ1260001'), false, 'too short');
  assert.equal(hasIsrcLayout('USZZ126000012'), false, 'too long');
  assert.equal(hasIsrcLayout('uszz12600001'), false, 'expects the upper-cased value that normIsrc returns');
});
