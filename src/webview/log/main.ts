// Git Log webview: virtualized commit table with graph, filters toolbar and details pane.
import type { GraphRow } from '../../log/graphLayout';
import type { CommitDetailsData, FilterSummary, FromWebview, LogCommit, RefLabel, ToWebview } from '../../log/protocol';

interface VsCodeApi {
  postMessage(message: FromWebview): void;
  getState(): { detailsWidth?: number } | undefined;
  setState(state: { detailsWidth?: number }): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const post = (m: FromWebview) => vscode.postMessage(m);

const ROW_H = 22;
const LANE_W = 12;
const GRAPH_PAD = 6;
const MAX_GRAPH_W = 240;
const COLORS = 8;
const SVG_NS = 'http://www.w3.org/2000/svg';

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const scroller = byId('scroller');
const spacer = byId('spacer');
const rowsEl = byId('rows');
const detailsEl = byId('details');
const statusEl = byId('status');
const messageEl = byId('message');
const search = byId<HTMLInputElement>('search');
const clearBtn = byId<HTMLButtonElement>('clear');
const mainEl = byId('main');

let commits: LogCommit[] = [];
let graph: GraphRow[] | null = null;
let refs: Record<string, RefLabel[]> = {};
let head: string | null = null;
let hasMore = false;
let loadingMore = false;
let graphWidth = 0;
const indexOf = new Map<string, number>();
let selected = new Set<string>();
let anchor = -1;
let cursor = -1;
let detailsSha: string | null = null;

// ---------- helpers ----------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) {
    e.className = className;
  }
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}

function formatDate(seconds: number): string {
  const d = new Date(seconds * 1000);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) {
    return `Today ${time}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${time}`;
  }
  return `${d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })} ${time}`;
}

const REF_TITLE: Record<RefLabel['kind'], string> = {
  local: 'Local branch',
  remote: 'Remote branch',
  tag: 'Tag',
  head: 'Detached HEAD',
};

// ---------- table ----------

function graphSvg(row: GraphRow, commit: LogCommit): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(graphWidth));
  svg.setAttribute('height', String(ROW_H));
  const x = (col: number) => GRAPH_PAD + col * LANE_W + LANE_W / 2;
  const mid = ROW_H / 2;
  for (const line of row.lines) {
    const [y1, y2] = line.kind === 'top' ? [0, mid] : line.kind === 'bottom' ? [mid, ROW_H] : [0, ROW_H];
    const x1 = x(line.from);
    const x2 = x(line.to);
    const ym = (y1 + y2) / 2;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', x1 === x2 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`);
    path.setAttribute('class', `edge lane${line.color % COLORS}`);
    svg.appendChild(path);
  }
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', String(x(row.col)));
  dot.setAttribute('cy', String(mid));
  dot.setAttribute('r', commit.sha === head ? '4.5' : '3.5');
  dot.setAttribute('class', `node lane${row.color % COLORS}${commit.sha === head ? ' head-node' : ''}`);
  svg.appendChild(dot);
  return svg;
}

function rowElement(i: number): HTMLElement {
  const c = commits[i];
  const row = el('div', 'row commit');
  row.classList.toggle('selected', selected.has(c.sha));
  row.classList.toggle('cursor', i === cursor);
  row.classList.toggle('head', c.sha === head);
  row.style.top = `${i * ROW_H}px`;
  row.dataset.index = String(i);
  row.dataset.vscodeContext = JSON.stringify({
    webviewSection: 'commit',
    sha: c.sha,
    isHead: c.sha === head,
    preventDefaultContextMenuItems: true,
  });

  const graphCell = el('div', 'c-graph');
  if (graph) {
    graphCell.appendChild(graphSvg(graph[i], c));
  }
  const subject = el('div', 'c-subject');
  for (const r of refs[c.sha] ?? []) {
    const badge = el('span', `ref ref-${r.kind}${r.current ? ' ref-current' : ''}`, r.name);
    badge.title = REF_TITLE[r.kind] + (r.current ? ' (checked out)' : '');
    subject.appendChild(badge);
  }
  subject.appendChild(el('span', 'subject-text', c.subject));
  subject.title = c.subject;
  const author = el('div', 'c-author', c.author);
  author.title = `${c.author} <${c.email}>`;
  row.append(graphCell, subject, author, el('div', 'c-date', formatDate(c.date)), el('div', 'c-hash', c.sha.slice(0, 8)));
  return row;
}

let renderQueued = false;
function queueRender(): void {
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }
}

function render(): void {
  spacer.style.height = `${commits.length * ROW_H}px`;
  const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_H) - 5);
  const last = Math.min(commits.length, Math.ceil((scroller.scrollTop + scroller.clientHeight) / ROW_H) + 5);
  const frag = document.createDocumentFragment();
  for (let i = first; i < last; i++) {
    frag.appendChild(rowElement(i));
  }
  rowsEl.replaceChildren(frag);
  if (hasMore && !loadingMore && last >= commits.length - 50) {
    loadingMore = true;
    statusEl.textContent = 'Loading more…';
    post({ type: 'loadMore' });
  }
}

/** Updates selection classes in place (keeps the DOM node under the mouse for context menus). */
function updateRowClasses(): void {
  for (const node of Array.from(rowsEl.children) as HTMLElement[]) {
    const i = Number(node.dataset.index);
    node.classList.toggle('selected', selected.has(commits[i].sha));
    node.classList.toggle('cursor', i === cursor);
  }
}

// ---------- selection ----------

function notifySelection(): void {
  updateRowClasses();
  const shas = [...selected].sort((a, b) => indexOf.get(a)! - indexOf.get(b)!);
  if (shas.length === 1 && shas[0] !== detailsSha) {
    detailsEl.replaceChildren(el('div', 'placeholder', 'Loading…'));
  }
  post({ type: 'select', shas });
}

function selectSingle(i: number): void {
  selected = new Set([commits[i].sha]);
  anchor = cursor = i;
  notifySelection();
}

function selectRange(from: number, to: number): void {
  const [lo, hi] = from < to ? [from, to] : [to, from];
  selected = new Set(commits.slice(lo, hi + 1).map((c) => c.sha));
  cursor = to;
  notifySelection();
}

function toggle(i: number): void {
  const sha = commits[i].sha;
  if (selected.has(sha) && selected.size > 1) {
    selected.delete(sha);
  } else {
    selected.add(sha);
  }
  anchor = cursor = i;
  notifySelection();
}

function ensureVisible(i: number): void {
  const top = i * ROW_H;
  if (top < scroller.scrollTop) {
    scroller.scrollTop = top;
  } else if (top + ROW_H > scroller.scrollTop + scroller.clientHeight) {
    scroller.scrollTop = top + ROW_H - scroller.clientHeight;
  }
}

rowsEl.addEventListener('mousedown', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.row.commit');
  if (!row) {
    return;
  }
  const i = Number(row.dataset.index);
  if (e.button === 2) {
    if (!selected.has(commits[i].sha)) {
      selectSingle(i);
    }
    post({ type: 'contextTarget', sha: commits[i].sha });
    return;
  }
  if (e.button !== 0) {
    return;
  }
  if (e.shiftKey && anchor >= 0) {
    selectRange(anchor, i);
  } else if (e.ctrlKey || e.metaKey) {
    toggle(i);
  } else {
    selectSingle(i);
  }
  scroller.focus();
});

scroller.addEventListener('keydown', (e) => {
  if (commits.length === 0) {
    return;
  }
  const page = Math.max(1, Math.floor(scroller.clientHeight / ROW_H) - 1);
  const keys: Record<string, number> = {
    ArrowDown: cursor + 1,
    ArrowUp: cursor - 1,
    PageDown: cursor + page,
    PageUp: cursor - page,
    Home: 0,
    End: commits.length - 1,
  };
  if (!(e.key in keys)) {
    return;
  }
  e.preventDefault();
  const next = Math.min(commits.length - 1, Math.max(0, keys[e.key]));
  if (e.shiftKey && anchor >= 0) {
    selectRange(anchor, next);
  } else {
    selectSingle(next);
  }
  ensureVisible(next);
});

scroller.addEventListener('scroll', queueRender);
new ResizeObserver(queueRender).observe(scroller);

// ---------- details ----------

function showDetails(d: CommitDetailsData): void {
  detailsSha = d.sha;
  const files = el('div', 'files');
  files.appendChild(el('div', 'files-title', `${d.files.length} changed file${d.files.length === 1 ? '' : 's'}`));
  for (const f of d.files) {
    const row = el('div', 'file');
    row.title = f.oldPath !== f.path ? `${f.oldPath} → ${f.path}` : f.path;
    const slash = f.path.lastIndexOf('/');
    row.append(
      el('span', `st st-${f.status}`, f.status),
      el('span', 'name', f.path.slice(slash + 1)),
      el('span', 'dir', slash > 0 ? f.path.slice(0, slash) : ''),
    );
    row.addEventListener('click', () => {
      files.querySelectorAll('.file.active').forEach((n) => n.classList.remove('active'));
      row.classList.add('active');
      post({ type: 'openDiff', sha: d.sha, path: f.path });
    });
    files.appendChild(row);
  }

  const meta = el('div', 'meta');
  const hash = el('code', 'hash', d.sha);
  hash.title = 'Commit hash';
  meta.append(hash, el('br'));
  meta.append(`${d.author} <${d.email}>, ${formatDate(d.authorDate)}`, el('br'));
  if (d.committer !== d.author || d.commitDate !== d.authorDate) {
    meta.append(`committed by ${d.committer}, ${formatDate(d.commitDate)}`, el('br'));
  }
  if (d.parents.length > 1) {
    meta.append(`Merge of ${d.parents.map((p) => p.slice(0, 8)).join(', ')}`, el('br'));
  }
  const branches = el('div', 'branches', 'In branches: …');
  branches.id = 'branches';
  detailsEl.replaceChildren(files, el('div', 'msg', d.message), meta, branches);
}

// ---------- splitter ----------

function setDetailsWidth(px: number): void {
  const max = Math.max(200, mainEl.clientWidth - 300);
  detailsEl.style.width = `${Math.min(max, Math.max(200, px))}px`;
}
setDetailsWidth(vscode.getState()?.detailsWidth ?? 380);

byId('splitter').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const move = (ev: MouseEvent) => setDetailsWidth(mainEl.getBoundingClientRect().right - ev.clientX);
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    vscode.setState({ detailsWidth: detailsEl.getBoundingClientRect().width });
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

// ---------- toolbar ----------

let searchTimer: ReturnType<typeof setTimeout> | undefined;
search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => post({ type: 'text', value: search.value }), 400);
});
search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(searchTimer);
    post({ type: 'text', value: search.value });
  }
});
document.querySelectorAll<HTMLButtonElement>('button.filter').forEach((b) =>
  b.addEventListener('click', () => post({ type: 'pickFilter', kind: b.dataset.filter as 'branch' | 'user' | 'date' | 'path' })),
);
clearBtn.addEventListener('click', () => {
  search.value = '';
  post({ type: 'clearFilters' });
});
byId('refresh').addEventListener('click', () => post({ type: 'refresh' }));

function showFilters(f: FilterSummary): void {
  if (document.activeElement !== search) {
    search.value = f.text;
  }
  const values: Record<string, string> = { branch: f.branch, user: f.user, date: f.date, path: f.path };
  document.querySelectorAll<HTMLButtonElement>('button.filter').forEach((b) => {
    const value = values[b.dataset.filter!];
    b.querySelector('span')!.textContent = value;
    b.classList.toggle('active', value !== 'All');
    b.title = value;
  });
  clearBtn.hidden = !f.active;
}

// ---------- messages ----------

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const m = event.data;
  switch (m.type) {
    case 'loading':
      statusEl.textContent = 'Loading…';
      break;
    case 'data': {
      commits = m.commits;
      graph = m.graph;
      refs = m.refs;
      head = m.head;
      hasMore = m.hasMore;
      loadingMore = false;
      indexOf.clear();
      commits.forEach((c, i) => indexOf.set(c.sha, i));
      graphWidth = graph ? Math.min(GRAPH_PAD * 2 + Math.max(1, m.maxLanes) * LANE_W, MAX_GRAPH_W) : 0;
      document.documentElement.style.setProperty('--graph-w', `${graphWidth}px`);
      showFilters(m.filters);
      statusEl.textContent = `${commits.length}${hasMore ? '+' : ''} commits · ${m.repoName}`;
      messageEl.hidden = commits.length > 0;
      messageEl.textContent = m.filters.active ? 'No commits match the filters.' : 'No commits yet.';

      if (m.keepView) {
        selected = new Set([...selected].filter((s) => indexOf.has(s)));
        cursor = selected.size ? Math.min(...[...selected].map((s) => indexOf.get(s)!)) : -1;
        anchor = cursor;
        render();
        if (selected.size === 0) {
          detailsSha = null;
          detailsEl.replaceChildren(el('div', 'placeholder', 'Select a commit to see its details'));
        }
      } else {
        scroller.scrollTop = 0;
        selected.clear();
        detailsSha = null;
        render();
        if (commits.length) {
          const start = head && indexOf.has(head) ? indexOf.get(head)! : 0;
          selectSingle(start);
          ensureVisible(start);
        } else {
          detailsEl.replaceChildren(el('div', 'placeholder', 'Select a commit to see its details'));
        }
      }
      break;
    }
    case 'details':
      if (selected.size === 1 && selected.has(m.sha)) {
        showDetails(m.details);
      }
      break;
    case 'multiSelection':
      detailsSha = null;
      detailsEl.replaceChildren(el('div', 'placeholder', `${m.count} commits selected`));
      break;
    case 'branches': {
      const target = document.getElementById('branches');
      if (target && detailsSha === m.sha) {
        const shown = m.branches.slice(0, 20).join(', ');
        target.textContent = m.branches.length
          ? `In ${m.branches.length} branch${m.branches.length === 1 ? '' : 'es'}: ${shown}${m.branches.length > 20 ? ', …' : ''}`
          : 'Not in any branch';
      }
      break;
    }
    case 'error':
      statusEl.textContent = '';
      messageEl.hidden = false;
      messageEl.textContent = m.message;
      break;
  }
});

post({ type: 'ready' });
