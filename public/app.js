// Royalty Tracker UI. Vanilla JS; every value from the API is inserted as text or DOM nodes,
// never parsed as HTML, because titles, sources and notes come from imported files.

const $ = (sel) => document.querySelector(sel);
const money = (n) => (n == null ? '' : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }));
const int = (n) => Number(n || 0).toLocaleString();

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

function say(text, isError) {
  const m = $('#msg');
  m.textContent = text || '';
  m.hidden = !text;
  m.className = isError ? 'error' : '';
}

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// run an action (clearing any old message), show errors, then re-render the current page
const act = (fn) => async (...args) => {
  say(''); // fn may set its own success message
  try { await fn(...args); } catch (e) { say(e.message, true); return; }
  render();
};

const formData = (form) => Object.fromEntries(new FormData(form).entries());
const field = (label, input) => h('label', null, label, input);
const table = (heads, rows, empty = 'Nothing here yet.') => rows.length
  ? h('table', null, h('thead', null, h('tr', null, heads.map((x) => h('th', { class: x.endsWith('#') ? 'n' : '' }, x.replace(/#$/, ''))))), h('tbody', null, rows))
  : h('div', { class: 'empty' }, empty);
const td = (v, n) => h('td', { class: n ? 'n' : '' }, v); // n: right-align (numbers)
const actions = (...btns) => h('td', null, btns);
const btn = (label, onclick, cls = 'link') => h('button', { type: 'button', class: cls, onclick }, label);
const confirmed = (text, fn) => () => (confirm(text) ? fn() : undefined);

// ---------- pages ----------

const pages = {
  async dashboard() {
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    const d = await api('GET', '/dashboard' + (q.toString() ? '?' + q : ''));
    const filter = h('form', { class: 'row', onsubmit: (e) => {
      e.preventDefault();
      const f = formData(e.target), p = new URLSearchParams();
      if (f.from) p.set('from', f.from);
      if (f.to) p.set('to', f.to);
      location.hash = '#/dashboard' + (p.toString() ? '?' + p : '');
    } },
    field('From', h('input', { type: 'month', name: 'from', value: q.get('from') || '' })),
    field('To', h('input', { type: 'month', name: 'to', value: q.get('to') || '' })),
    h('button', { class: 'primary' }, 'Apply'),
    h('a', { href: '#/dashboard' }, 'Clear'),
    h('a', { href: '/api/export/earnings.csv', download: 'earnings.csv', style: 'margin-left:auto' }, 'Export CSV'));
    const note = [];
    if (d.unmatched.c) note.push(`${d.unmatched.c} unmatched rows (${money(d.unmatched.t)}) need a song`);
    if (q.size && d.undated.c) note.push(`${d.undated.c} earnings rows without a period are not included`);
    if (q.size && (d.undatedPayments || d.undatedAdvances)) note.push(`${d.undatedPayments} payments and ${d.undatedAdvances} advances without a date are not included`);
    const list = (title, rows, unit) => h('section', null, h('h2', null, title),
      table([title.replace('By ', ''), 'Earned#'], rows.map((r) => h('tr', null, td(r.k), td(money(r.v), true))), 'No data.'));
    return [filter,
      h('div', { class: 'cards' },
        h('div', { class: 'card' }, h('b', null, money(d.total)), h('span', null, 'Earned')),
        h('div', { class: 'card' }, h('b', null, int(d.units)), h('span', null, 'Units')),
        h('div', { class: 'card' }, h('b', null, `${money(d.payments.rec)}`), h('span', null, `Received of ${money(d.payments.exp)} expected`)),
        h('div', { class: 'card' }, h('b', null, money(d.advances)), h('span', null, 'Advances'))),
      note.length ? h('p', { class: 'muted' }, note.join(' · ')) : null,
      h('div', { class: 'grid2' }, list('By period', d.byPeriod), list('By platform', d.byPlatform),
        list('By territory', d.byTerritory), list('By track', d.byTrack))];
  },

  async songs() {
    const [songs, contribs] = await Promise.all([api('GET', '/songs'), api('GET', '/contributors')]);
    const add = h('form', { class: 'row', onsubmit: act(async (e) => {
      e.preventDefault();
      const r = await api('POST', '/songs', formData(e.target));
      say(r.linked ? `Added. Linked ${r.linked} earnings rows.` : 'Added.');
    }) },
    field('Title', h('input', { name: 'title', required: true })), field('ISRC', h('input', { name: 'isrc' })),
    field('Release', h('input', { name: 'release' })), h('button', { class: 'primary' }, 'Add song'));
    const rows = songs.map((s) => h('tr', null,
      td(s.title), td(s.isrc || ''), td(money(s.earned), true),
      td(s.splits.length ? `${s.splits.map((x) => `${x.name} ${x.pct}%`).join(', ')}${s.splitTotal < 99.9999 ? ` (${s.splitTotal}% assigned)` : ''}` : 'No splits'),
      td(s.compositionSplits.length ? `${s.compositionSplits.map((x) => `${x.name} ${x.pct}%`).join(', ')}${s.compositionSplitTotal < 99.9999 ? ` (${s.compositionSplitTotal}% assigned)` : ''}` : 'None'),
      actions(btn('Splits', () => splitsDialog(s, contribs)), btn('Delete', confirmed(`Delete "${s.title}"? Its earnings become unmatched.`, act(() => api('DELETE', `/songs/${s.id}`))), 'link danger'))));
    return [h('h2', null, 'Catalog & splits'), add, table(['Title', 'ISRC', 'Earned#', 'Master splits', 'Composition splits', ''], rows, 'No songs yet.')];
  },

  async contributors() {
    const list = await api('GET', '/contributors');
    const add = h('form', { class: 'row', onsubmit: act(async (e) => { e.preventDefault(); await api('POST', '/contributors', formData(e.target)); }) },
      field('Name', h('input', { name: 'name', required: true })), field('Email', h('input', { name: 'email', type: 'email' })),
      h('button', { class: 'primary' }, 'Add contributor'));
    const rows = list.map((c) => h('tr', null, td(c.name), td(c.email || ''),
      actions(btn('Delete', confirmed(`Delete ${c.name}? Their splits are removed.`, act(() => api('DELETE', `/contributors/${c.id}`))), 'link danger'))));
    return [h('h2', null, 'Contributors'), add, table(['Name', 'Email', ''], rows, 'No contributors yet.')];
  },

  async statements() {
    const [list, unmatched, songs] = await Promise.all([api('GET', '/statements'), api('GET', '/unmatched'), api('GET', '/songs')]);
    const form = h('form', { class: 'row', onsubmit: act(async (e) => {
      e.preventDefault();
      const f = formData(e.target), file = e.target.file.files[0];
      if (!file) throw new Error('Choose a CSV file');
      const body = { source: f.source, filename: file.name, csv: await file.text(), force: !!e.target.force.checked };
      if (f.dateOrder) body.dateOrder = f.dateOrder;
      const r = await api('POST', '/statements/import', body);
      say(`Imported ${r.imported} rows (${money(r.total)}): ${r.matched} matched, ${r.unmatched} unmatched` +
        `${r.ambiguous ? `, ${r.ambiguous} ambiguous` : ''}${r.skipped ? `, ${r.skipped} skipped` : ''}.`);
    }) },
    field('Source (e.g. DistroKid)', h('input', { name: 'source', required: true })),
    field('CSV file', h('input', { name: 'file', type: 'file', accept: '.csv,text/csv' })),
    field('Dates', h('select', { name: 'dateOrder' }, h('option', { value: '' }, 'Auto-detect'), h('option', { value: 'mdy' }, 'Month first'), h('option', { value: 'dmy' }, 'Day first'))),
    h('label', { style: 'flex-direction:row;align-items:center;gap:4px' }, h('input', { name: 'force', type: 'checkbox' }), 'Allow duplicate'),
    h('button', { class: 'primary' }, 'Import'));
    const srows = list.map((s) => h('tr', null, td(s.source), td(s.filename || ''), td(s.imported_at), td(int(s.row_count), true), td(money(s.total), true),
      td(s.unmatched ? `${s.unmatched} unmatched` : ''),
      actions(btn('Delete', confirmed('Delete this statement and its earnings?', act(() => api('DELETE', `/statements/${s.id}`))), 'link danger'))));
    const urows = unmatched.map((u) => {
      const sel = h('select', null, h('option', { value: '' }, 'Assign to…'), songs.map((s) => h('option', { value: s.id }, s.title)));
      return h('tr', null, td(u.name), td(u.raw_isrc || ''), td(u.reason === 'ambiguous' ? 'Several songs match' : 'No song matches'), td(int(u.rows), true), td(money(u.total), true), actions(sel,
        btn('Assign', act(async () => {
          if (!sel.value) throw new Error('Pick a song first');
          const r = await api('POST', '/unmatched/assign', { song_id: Number(sel.value), raw_title: u.raw_title, raw_isrc: u.raw_isrc });
          say(`Assigned ${r.updated} rows.`);
        }))));
    });
    return [h('h2', null, 'Import statement'), form,
      table(['Source', 'File', 'Imported', 'Rows#', 'Total#', '', ''], srows, 'No statements imported.'),
      h('h2', null, 'Unmatched earnings'),
      table(['Track', 'ISRC', 'Why', 'Rows#', 'Total#', ''], urows, 'Everything is matched.')];
  },

  async payments() {
    const list = await api('GET', '/payments');
    const add = h('form', { class: 'row', onsubmit: act(async (e) => { e.preventDefault(); await api('POST', '/payments', formData(e.target)); }) },
      field('Source', h('input', { name: 'source', required: true })),
      field('Expected', h('input', { name: 'expected_amount', type: 'number', step: 'any' })),
      field('Expected date', h('input', { name: 'expected_date', type: 'date' })),
      field('Received', h('input', { name: 'received_amount', type: 'number', step: 'any' })),
      field('Received date', h('input', { name: 'received_date', type: 'date' })),
      h('button', { class: 'primary' }, 'Add payment'));
    const rows = list.map((p) => h('tr', null, td(p.source), td(p.expected_amount == null ? '' : money(p.expected_amount), true), td(p.expected_date || ''),
      td(p.received_amount == null ? '' : money(p.received_amount), true), td(p.received_date || ''),
      td(h('span', { class: `status-${p.status}` }, p.status)),
      actions(btn('Record received', act(async () => {
        const amt = prompt('Amount received', p.expected_amount ?? '');
        if (amt == null) return;
        const date = prompt('Date received (YYYY-MM-DD)', new Date().toISOString().slice(0, 10));
        if (date == null) return;
        await api('PUT', `/payments/${p.id}`, { received_amount: amt === '' ? null : Number(amt), received_date: date || null });
      })), btn('Delete', confirmed('Delete this payment?', act(() => api('DELETE', `/payments/${p.id}`))), 'link danger'))));
    return [h('h2', null, 'Payments: expected vs received'), add, table(['Source', 'Expected#', 'Due', 'Received#', 'On', 'Status', ''], rows, 'No payments yet.')];
  },

  async advances() {
    const list = await api('GET', '/advances');
    const add = h('form', { class: 'row', onsubmit: act(async (e) => { e.preventDefault(); await api('POST', '/advances', formData(e.target)); }) },
      field('Source (must match statement source)', h('input', { name: 'source', required: true })),
      field('Amount', h('input', { name: 'amount', type: 'number', step: 'any', required: true })),
      field('Date', h('input', { name: 'date', type: 'date' })), field('Notes', h('input', { name: 'notes' })),
      h('button', { class: 'primary' }, 'Add advance'));
    const rows = list.map((a) => h('tr', null, td(a.source), td(a.date || ''), td(money(a.amount), true), td(money(a.recouped), true), td(money(a.balance), true),
      actions(btn('Delete', confirmed('Delete this advance?', act(() => api('DELETE', `/advances/${a.id}`))), 'link danger'))));
    return [h('h2', null, 'Advances & recoupment'),
      h('p', { class: 'muted' }, 'Earnings from the same source after the advance date recoup it, oldest advance first.'), add,
      table(['Source', 'Date', 'Advance#', 'Recouped#', 'Balance#', ''], rows, 'No advances yet.')];
  },

  async payouts() {
    const d = await api('GET', '/payouts/summary');
    const rows = d.contributors.map((c) => h('tr', null, td(c.name), td(c.email || ''), td(money(c.owed), true),
      td(c.songs.map((s) => `${s.title} (${s.pct}% of ${money(s.earned)} = ${money(s.share)})`).join('; ') || '')));
    const under = d.underSplitSongs.map((s) => h('tr', null, td(s.title), td(`${s.splitTotal}%`, true), td(money(s.earned), true), td(money(s.unallocated), true)));
    return [h('h2', null, 'Payouts'),
      h('p', { class: 'muted' }, 'Gross shares from each song\'s splits. This app does not track payments made to contributors, so nothing is netted.'),
      h('div', { class: 'cards' },
        h('div', { class: 'card' }, h('b', null, money(d.total)), h('span', null, 'Total earned')),
        h('div', { class: 'card' }, h('b', null, money(d.owed)), h('span', null, 'Owed to contributors')),
        h('div', { class: 'card' }, h('b', null, money(d.unallocated)), h('span', null, `Unallocated (${money(d.unmatched)} unmatched)`))),
      table(['Contributor', 'Email', 'Owed#', 'Songs'], rows, 'No contributors yet.'),
      h('h2', null, 'Songs with unallocated earnings'),
      table(['Song', 'Split total#', 'Earned#', 'Unallocated#'], under, 'Every song with earnings is fully split.')];
  },
};

function splitsDialog(song, contribs, type = 'master') {
  const dlg = $('#dlg');
  const rowsBox = h('div');
  const addRow = (sp = {}) => {
    const sel = h('select', { name: 'c' }, contribs.map((c) => h('option', { value: c.id, selected: c.id === sp.contributor_id }, c.name)));
    const row = h('div', { class: 'row', style: 'margin:4px 0' }, sel,
      h('input', { name: 'p', type: 'number', step: 'any', min: '0', max: '100', value: sp.pct ?? '', style: 'width:90px', 'aria-label': 'Percent' }), '%',
      btn('Remove', () => row.remove(), 'link danger'));
    rowsBox.append(row);
  };
  (type === 'composition' ? song.compositionSplits : song.splits).forEach(addRow);
  const kind = h('select', { 'aria-label': 'Split type', onchange: () => splitsDialog(song, contribs, kind.value) },
    h('option', { value: 'master', selected: type === 'master' }, 'Master (the recording)'),
    h('option', { value: 'composition', selected: type === 'composition' }, 'Composition (the song, for the MLC)'));
  dlg.replaceChildren(h('h2', { style: 'margin-top:0' }, `Splits: ${song.title}`), kind,
    h('p', { class: 'muted' }, type === 'composition'
      ? 'Writer and publisher shares of the song. Used for MLC registration; they do not change payouts.'
      : 'Shares of the recording. These decide what each contributor is owed from statements. Switching type discards unsaved edits.'),
    contribs.length ? null : h('p', { class: 'muted' }, 'Add contributors first.'),
    rowsBox,
    h('div', { class: 'row' },
      btn('+ Add contributor', () => contribs.length && addRow(), 'link'),
      h('span', { style: 'flex:1' }),
      btn('Cancel', () => dlg.close(), ''),
      btn('Save', async () => {
        const splits = [...rowsBox.children].map((r) => ({ contributor_id: Number(r.querySelector('select').value), pct: Number(r.querySelector('input').value) }));
        try { await api('PUT', `/songs/${song.id}/splits`, { type, splits }); dlg.close(); say(type === 'composition' ? 'Composition splits saved.' : 'Splits saved.'); render(); }
        catch (e) { say(e.message, true); }
      }, 'primary')));
  dlg.showModal();
}

// ---------- shell ----------

const NAV = [['dashboard', 'Dashboard'], ['songs', 'Songs'], ['contributors', 'Contributors'], ['statements', 'Statements'],
  ['payments', 'Payments'], ['advances', 'Advances'], ['payouts', 'Payouts']];

async function render() {
  const page = (location.hash.slice(2).split('?')[0]) || 'dashboard';
  $('#nav').replaceChildren(...NAV.map(([k, label]) => h('a', { href: `#/${k}`, 'aria-current': k === page ? 'page' : null }, label)));
  const view = $('#view');
  try {
    view.replaceChildren(...(await (pages[page] || pages.dashboard)()).filter(Boolean));
  } catch (e) {
    view.replaceChildren(h('p', null, 'Could not load this page.'));
    say(e.message, true);
  }
}

let last = location.hash;
addEventListener('hashchange', () => { if (location.hash.split('?')[0] !== last.split('?')[0]) say(''); last = location.hash; render(); });
render();
