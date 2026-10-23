// Pure parsing and conversion: CSV, money and dates. No database, no HTTP.
import { bad } from './errors.js';

// Money is stored as integer micro-dollars (1e-6 USD) so sums are exact and sub-cent per-stream
// amounts survive; the API still speaks decimal dollars. Floats only appear when converting at the edges.
export const MICROS = 1_000_000;
export const usd = (m) => (m == null ? null : m / MICROS);

export const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
export const str = (v) => (v == null ? null : String(v).trim() || null);

// RFC 4180-ish CSV parser (quotes, escaped quotes, CRLF, embedded newlines).
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0];
  const delim = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const COLS = {
  title: ['title', 'track', 'track title', 'song', 'song title', 'track name', 'work title', 'title of work'],
  isrc: ['isrc'],
  platform: ['platform', 'store', 'dsp', 'service', 'channel', 'retailer', 'source', 'sales type'],
  territory: ['territory', 'country', 'country of sale', 'region', 'country/region'],
  units: ['units', 'quantity', 'streams', 'plays', 'quantity sold', 'unit', 'performances'],
  amount: ['amount', 'earnings', 'revenue', 'royalty', 'royalties', 'net', 'net revenue', 'earnings (usd)', 'payable', 'total earned', 'amount (usd)', 'net amount'],
  period: ['period', 'date', 'month', 'sale month', 'reporting month', 'sales period', 'reporting period', 'sale date', 'statement period'],
};

export function mapHeaders(headers) {
  const norm = headers.map((h) => h.trim().toLowerCase());
  const map = {};
  for (const [key, names] of Object.entries(COLS)) {
    let idx = -1;
    for (const n of names) { idx = norm.indexOf(n); if (idx >= 0) break; }
    if (idx >= 0) map[key] = idx;
  }
  return map;
}

// Exact decimal parsing of a statement amount to integer micro-dollars (no float arithmetic on the
// digits). Digits beyond the sixth decimal place are rounded half-up. NaN if there's no usable number.
export const parseMoneyMicros = (s) => {
  if (s == null) return NaN;
  let t = String(s).trim();
  if (!/\d/.test(t)) return NaN;
  const neg = /^\(.*\)$/.test(t) || t.startsWith('-');
  t = t.replace(/[^0-9.,]/g, '');
  const lastDot = t.lastIndexOf('.'), lastComma = t.lastIndexOf(',');
  let dec = -1; // index of the decimal separator, if any
  if (lastDot >= 0 && lastComma >= 0) dec = Math.max(lastDot, lastComma);
  else {
    const sep = lastDot >= 0 ? '.' : lastComma >= 0 ? ',' : null;
    if (sep && t.split(sep).length === 2) {
      // a lone separator followed by exactly 3 digits after a short non-zero integer is a thousands
      // separator (1,234); anything else (0.005, 12.5, 0.00456) is a decimal point
      const [int, frac] = t.split(sep);
      if (!(frac.length === 3 && int.length >= 1 && int.length <= 3 && !int.startsWith('0'))) dec = t.indexOf(sep);
    }
  }
  const digits = (x) => x.replace(/[.,]/g, '');
  const whole = digits(dec >= 0 ? t.slice(0, dec) : t) || '0';
  const frac = dec >= 0 ? digits(t.slice(dec + 1)) : '';
  let m = Number(whole) * MICROS + Number(frac.slice(0, 6).padEnd(6, '0')) + (frac[6] >= '5' ? 1 : 0);
  if (!Number.isSafeInteger(m)) return NaN;
  return neg ? -m : m;
};
// dollars as a float, for the places that only need a rough number (e.g. unit counts)
export const parseMoney = (s) => parseMoneyMicros(s) / MICROS;

// Integer micros -> plain decimal string without float error ("1234.50456", "-3.5").
export const microsToString = (m) => {
  const abs = Math.abs(m);
  const frac = String(abs % MICROS).padStart(6, '0').replace(/0+$/, '');
  return `${m < 0 ? '-' : ''}${Math.floor(abs / MICROS)}${frac ? '.' + frac : ''}`;
};
// A JSON dollar amount from a client -> micros
export const toMicros = (dollars) => {
  const m = Math.round(dollars * MICROS);
  if (!Number.isSafeInteger(m)) throw bad('Amount is out of range');
  return m;
};

// Day-first vs month-first dates (05/03/2025) can't be told apart from one value, so the
// order is decided per file: any value with a first or second part above 12 settles it.
const DATE_PARTS = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/;
export function detectDateOrder(values) {
  let dmy = false, mdy = false, any = false;
  for (const v of values) {
    const m = String(v ?? '').trim().match(DATE_PARTS);
    if (!m) continue;
    any = true;
    if (+m[1] > 12) dmy = true;
    if (+m[2] > 12) mdy = true;
  }
  if (dmy && mdy) throw bad('Period column mixes day-first and month-first dates');
  if (dmy) return 'dmy';
  if (mdy) return 'mdy';
  return any ? 'ambiguous' : null;
}

// normalise to YYYY-MM when possible; order ('mdy' | 'dmy') only matters for D/M/YYYY-style dates
export const normPeriod = (s, order = 'mdy') => {
  if (!s) return null;
  s = String(s).trim();
  const ym = (y, mo) => `${y}-${String(mo).padStart(2, '0')}`;
  const validMonth = (mo) => +mo >= 1 && +mo <= 12;
  let m = s.match(/^(\d{4})[-/](\d{1,2})/);
  if (m && validMonth(m[2])) return ym(m[1], m[2]);
  m = s.match(/^(\d{1,2})[-/](\d{4})$/);
  if (m && validMonth(m[1])) return ym(m[2], m[1]);
  m = s.match(DATE_PARTS);
  if (m) {
    const mo = order === 'dmy' ? m[2] : m[1];
    if (validMonth(mo)) return ym(m[3], mo);
  }
  const d = new Date(s + ' 1');
  if (!isNaN(d)) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const d2 = new Date(s);
  if (!isNaN(d2)) return `${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, '0')}`;
  return s;
};

// ---------- title similarity (for suggesting songs; never used to assign automatically) ----------

// Words that mark a different cut of the same song, not a different song.
const VERSION_WORD = /\b(remix|mix|edit|version|live|remaster(?:ed)?|acoustic|instrumental|extended|mono|stereo|demo|original|radio|club|dub|vip|bonus|deluxe|explicit|clean)\b/;
const FEATURING = /\b(feat|ft|featuring)\b\.?/;

// Lower-cased, accent-free title with version and featured-artist tags removed, so
// "Midnight Drive (Radio Edit)" and "Midnight Drive - Remastered 2020" both become "midnight drive".
// A bracket or dash suffix that is not a version tag ("(Part 2)") is kept, so different songs stay different.
export function normTitle(s) {
  let t = String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  t = t.replace(/\s*[([]([^)\]]*)[)\]]/g, (_, inner) => (VERSION_WORD.test(inner) || FEATURING.test(inner) ? ' ' : ` ${inner} `));
  t = t.replace(/\s+-\s+(.*)$/, (m, tail) => (VERSION_WORD.test(tail) ? ' ' : m));
  t = t.replace(/\s+(?:feat|ft|featuring)\b\.?\s+.*$/, ' ');
  return t.replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const editDistance = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
};

// 0..1: 1 when the normalised titles are identical, otherwise 1 minus the edit distance as a share
// of the longer title. 0 when either title is empty once normalised.
export function titleSimilarity(a, b) {
  const x = normTitle(a).slice(0, 200), y = normTitle(b).slice(0, 200);
  if (!x || !y) return 0;
  if (x === y) return 1;
  return 1 - editDistance(x, y) / Math.max(x.length, y.length);
}
