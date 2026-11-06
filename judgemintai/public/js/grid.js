import { el, statusChip, severityText, AGENT_LABEL } from './util.js';

// Findings table. Uses AG Grid (sponsor tool) when its script loaded; otherwise a plain accessible table
// shows the same data, so a blocked CDN never breaks the report.

const STATUS_RANK = { fail: 0, warn: 1, pass: 2, na: 3 };
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const isProblem = (f) => f.status === 'fail' || f.status === 'warn';

export function mountFindings(host, findings, { onSelect }) {
  const state = { mode: 'problems', quick: '', selectedId: null };
  const rows = findings.map((f) => ({ ...f, agentLabel: AGENT_LABEL[f.agent] || f.agent }));

  const visible = () => rows.filter((r) => {
    if (state.mode === 'problems' && !isProblem(r)) return false;
    if (!state.quick) return true;
    const hay = `${r.title} ${r.detail} ${r.fix} ${r.agentLabel} ${r.status} ${r.severity}`.toLowerCase();
    return hay.includes(state.quick.toLowerCase());
  });

  const select = (row) => {
    state.selectedId = row?.id ?? null;
    onSelect?.(row || null);
    controller.refreshSelection?.();
  };

  let controller = null;

  if (window.agGrid?.createGrid) {
    try {
      controller = mountAgGrid(host, rows, state, select);
    } catch (err) {
      console.warn('AG Grid failed, using the plain table instead:', err);
      host.replaceChildren();
    }
  }
  if (!controller) controller = mountPlainTable(host, state, visible, select);

  return {
    engine: controller.engine,
    setMode(mode) { state.mode = mode; controller.refresh(); },
    setQuick(text) { state.quick = text.trim(); controller.refresh(); },
    count: () => controller.count(),
    total: () => rows.length,
    problemCount: () => rows.filter(isProblem).length,
    selectFirst() { const first = visible()[0]; if (first) select(first); },
  };
}

function mountAgGrid(host, rows, state, select) {
  host.classList.add('ag-theme-quartz');
  host.replaceChildren();

  const chipRenderer = (p) => statusChip(p.value);
  const wrap = { wrapText: true, autoHeight: true, cellClass: 'cell-wrap' };

  const gridOptions = {
    columnDefs: [
      { field: 'status', headerName: 'Result', width: 128, cellRenderer: chipRenderer, comparator: (a, b) => STATUS_RANK[a] - STATUS_RANK[b], sort: 'asc', sortIndex: 0 },
      { field: 'severity', headerName: 'Severity', width: 116, valueFormatter: (p) => severityText(p.value), comparator: (a, b) => SEV_RANK[a] - SEV_RANK[b], sort: 'asc', sortIndex: 1 },
      { field: 'agentLabel', headerName: 'Agent', width: 140 },
      { field: 'title', headerName: 'Check', flex: 2, minWidth: 220, ...wrap },
      { field: 'detail', headerName: 'What the agent found', flex: 3, minWidth: 260, ...wrap },
      { field: 'fix', headerName: 'How to fix it', flex: 3, minWidth: 260, ...wrap },
    ],
    rowData: rows,
    getRowId: (p) => p.data.id,
    domLayout: 'autoHeight',
    defaultColDef: { sortable: true, resizable: true, filter: true },
    isExternalFilterPresent: () => state.mode === 'problems',
    doesExternalFilterPass: (node) => isProblem(node.data),
    rowClassRules: { 'row-selected': (p) => p.data?.id === state.selectedId },
    onRowClicked: (e) => select(e.data),
    onCellKeyDown: (e) => { if (e.event?.key === 'Enter') select(e.data); },
    suppressMovableColumns: true,
    animateRows: false,
  };
  const api = window.agGrid.createGrid(host, gridOptions);

  return {
    engine: 'ag-grid',
    refresh() {
      api.setGridOption('quickFilterText', state.quick);
      api.onFilterChanged();
    },
    refreshSelection() { api.redrawRows(); },
    count: () => api.getDisplayedRowCount(),
  };
}

function mountPlainTable(host, state, visible, select) {
  host.classList.remove('ag-theme-quartz');
  const tbody = el('tbody');
  const table = el('table', { class: 'plain-grid' },
    el('thead', {}, el('tr', {},
      el('th', { scope: 'col' }, 'Result'), el('th', { scope: 'col' }, 'Severity'), el('th', { scope: 'col' }, 'Agent'),
      el('th', { scope: 'col' }, 'Check'), el('th', { scope: 'col' }, 'What the agent found'), el('th', { scope: 'col' }, 'How to fix it'))),
    tbody);
  host.replaceChildren(el('div', { class: 'plain-grid__scroll', role: 'region', 'aria-label': 'Audit checks', tabindex: 0 }, table));

  let shown = [];
  const render = () => {
    shown = visible().sort((a, b) => (STATUS_RANK[a.status] - STATUS_RANK[b.status]) || (SEV_RANK[a.severity] - SEV_RANK[b.severity]));
    tbody.replaceChildren(...shown.map((r) => {
      const tr = el('tr', { tabindex: 0, class: r.id === state.selectedId ? 'row-selected' : '', 'aria-selected': r.id === state.selectedId ? 'true' : 'false' },
        el('td', { 'data-label': 'Result' }, statusChip(r.status)), el('td', { 'data-label': 'Severity' }, severityText(r.severity)), el('td', { 'data-label': 'Agent' }, r.agentLabel),
        el('td', { 'data-label': 'Check' }, r.title), el('td', { 'data-label': 'Found' }, r.detail), el('td', { 'data-label': 'Fix' }, r.fix));
      tr.addEventListener('click', () => select(r));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(r); } });
      return tr;
    }));
    if (!shown.length) tbody.replaceChildren(el('tr', {}, el('td', { colspan: 6, class: 'plain-grid__empty' }, 'No checks match. Clear the filter or switch to all checks.')));
  };
  render();

  return { engine: 'table', refresh: render, refreshSelection: render, count: () => shown.length };
}
