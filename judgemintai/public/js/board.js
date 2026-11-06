import { el } from './util.js';

// The leaderboard. AG Grid Community (sponsor tool) shows it when the script loaded; otherwise a plain accessible table
// shows exactly the same rows, so a blocked CDN never stops judges from working.
//
// A row looks like:
//   { id, name, repo, href, rank (number or null), final, merit, audit (number or null), flags: [{ tone, text }], why, first, last }

const clampPct = (n) => Math.max(0, Math.min(100, Number(n) || 0));
const byRank = (a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.name.localeCompare(b.name);
const flagText = (r) => r.flags.map((f) => f.text).join(' ');

function rankEl(r) {
  return r.rank == null
    ? el('span', { class: 'rankno rankno--none', title: 'Not ranked' }, el('span', { 'aria-hidden': 'true' }, '–'), el('span', { class: 'sr-only' }, 'Not ranked'))
    : el('span', { class: 'rankno' }, String(r.rank));
}

function nameEl(r) {
  return el('div', { class: 'entryname' },
    el('a', { href: r.href, 'data-link': '' }, r.name),
    r.repo ? el('span', { class: 'entryname__repo' }, r.repo) : null);
}

function scoreEl(r) {
  if (r.rank == null && !r.final) return el('span', { class: 'muted' }, '–');
  return el('div', { class: 'score' },
    el('span', { class: 'bar bar--neutral', role: 'img', 'aria-label': `${r.final} out of 100` }, el('span', { class: 'bar__fill', style: `width:${clampPct(r.final)}%` })),
    el('span', { class: 'score__num' }, String(Math.round(r.final))));
}

const numOrDash = (n) => (n == null ? '–' : String(n));

function flagsEl(r) {
  if (!r.flags.length) return el('span', { class: 'muted' }, 'None');
  return el('ul', { class: 'flags' }, r.flags.map((f) => el('li', { class: `flag flag--${f.tone}` }, f.text)));
}

function moveEl(r, canReorder, onMove) {
  if (!canReorder || r.rank == null) return el('span', { class: 'muted' }, '');
  const btn = (dir, label, glyph, disabled) => {
    const b = el('button', { type: 'button', class: 'mv', 'aria-label': label, disabled }, glyph);
    b.addEventListener('click', () => onMove?.(r.id, dir));
    return b;
  };
  return el('div', { class: 'mvs' },
    btn(-1, `Move ${r.name} up to rank ${(r.rank || 1) - 1}`, '↑', r.first),
    btn(1, `Move ${r.name} down to rank ${(r.rank || 0) + 1}`, '↓', r.last));
}

export function mountBoard(host, { onMove } = {}) {
  const state = { rows: [], quick: '', canReorder: false };
  let engine = null;

  if (window.agGrid?.createGrid) {
    try { engine = mountAgGrid(host, state, onMove); } catch (err) {
      console.warn('AG Grid failed, using the plain table instead:', err);
      host.replaceChildren();
    }
  }
  if (!engine) engine = mountPlain(host, state, onMove);

  return {
    engine: engine.name,
    update(rows, { canReorder = false } = {}) { state.rows = [...rows].sort(byRank); state.canReorder = canReorder; engine.refresh(); },
    setQuick(text) { state.quick = String(text || '').trim(); engine.refresh(); },
    count: () => engine.count(),
    total: () => state.rows.length,
  };
}

function mountAgGrid(host, state, onMove) {
  host.classList.add('ag-theme-quartz');
  host.replaceChildren();
  const wrap = { wrapText: true, autoHeight: true, cellClass: 'cell-wrap' };
  const api = window.agGrid.createGrid(host, {
    columnDefs: [
      { colId: 'rank', field: 'rank', headerName: 'Rank', width: 96, cellRenderer: (p) => rankEl(p.data), comparator: (a, b) => (a ?? 1e9) - (b ?? 1e9), sort: 'asc' },
      { colId: 'name', field: 'name', headerName: 'Entry', flex: 2, minWidth: 220, cellRenderer: (p) => nameEl(p.data), ...wrap },
      { colId: 'final', field: 'final', headerName: 'Score', width: 170, cellRenderer: (p) => scoreEl(p.data) },
      { colId: 'merit', field: 'merit', headerName: 'Merit', width: 96, valueFormatter: (p) => (p.data.rank == null && !p.value ? '–' : String(p.value)) },
      { colId: 'audit', field: 'audit', headerName: 'Audit', width: 96, valueFormatter: (p) => numOrDash(p.value) },
      { colId: 'flags', headerName: 'Flags', flex: 2, minWidth: 200, valueGetter: (p) => flagText(p.data), cellRenderer: (p) => flagsEl(p.data), sortable: false, ...wrap },
      { colId: 'why', field: 'why', headerName: 'Why this rank', flex: 4, minWidth: 280, ...wrap },
      { colId: 'move', headerName: 'Order', width: 104, sortable: false, filter: false, hide: true, cellRenderer: (p) => moveEl(p.data, state.canReorder, onMove) },
    ],
    rowData: [],
    getRowId: (p) => p.data.id,
    domLayout: 'autoHeight',
    defaultColDef: { sortable: true, resizable: true, filter: false },
    suppressCellFocus: true, // the links and buttons inside the cells are reached with Tab like on any page
    suppressMovableColumns: true,
    animateRows: false,
  });
  return {
    name: 'ag-grid',
    refresh() {
      api.setGridOption('quickFilterText', state.quick);
      api.setGridOption('rowData', state.rows);
      api.setColumnsVisible(['move'], state.canReorder);
      api.refreshCells({ force: true, columns: ['move'] });
    },
    count: () => api.getDisplayedRowCount(),
  };
}

function mountPlain(host, state, onMove) {
  host.classList.remove('ag-theme-quartz');
  const tbody = el('tbody');
  const th = (t) => el('th', { scope: 'col' }, t);
  const head = el('tr', {}, th('Rank'), th('Entry'), th('Score'), th('Merit'), th('Audit'), th('Flags'), th('Why this rank'), th('Order'));
  host.replaceChildren(el('div', { class: 'plain-grid__scroll', role: 'region', 'aria-label': 'Leaderboard', tabindex: 0 },
    el('table', { class: 'plain-grid board' }, el('thead', {}, head), tbody)));
  let shown = [];
  return {
    name: 'table',
    refresh() {
      const q = state.quick.toLowerCase();
      shown = state.rows.filter((r) => !q || `${r.name} ${r.repo} ${r.why} ${flagText(r)}`.toLowerCase().includes(q));
      head.lastElementChild.hidden = !state.canReorder;
      tbody.replaceChildren(...shown.map((r) => {
        const order = el('td', { 'data-label': 'Order' }, moveEl(r, state.canReorder, onMove));
        order.hidden = !state.canReorder;
        return el('tr', { class: r.rank == null ? 'is-unranked' : '' },
          el('td', { 'data-label': 'Rank' }, rankEl(r)),
          el('td', { 'data-label': 'Entry' }, nameEl(r)),
          el('td', { 'data-label': 'Score' }, scoreEl(r)),
          el('td', { 'data-label': 'Merit' }, r.rank == null && !r.merit ? '–' : String(r.merit)),
          el('td', { 'data-label': 'Audit' }, numOrDash(r.audit)),
          el('td', { 'data-label': 'Flags' }, flagsEl(r)),
          el('td', { 'data-label': 'Why' }, r.why),
          order);
      }));
      if (!shown.length) tbody.replaceChildren(el('tr', {}, el('td', { colspan: 8, class: 'plain-grid__empty' }, state.rows.length ? 'No entries match the filter.' : 'No entries yet.')));
    },
    count: () => shown.length,
  };
}
