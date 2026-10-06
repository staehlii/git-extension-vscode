// Interactive rebase editor webview.
import type { RebaseFromWebview, RebaseToWebview } from '../../rebase/rebaseEditor';
import { RebaseAction, validateEntries } from '../../rebase/rebaseModel';
import type { RebaseCommit } from '../../rebase/rebaseRunner';

declare function acquireVsCodeApi(): { postMessage(m: RebaseFromWebview): void };
const vscode = acquireVsCodeApi();

interface Row {
  commit: RebaseCommit;
  action: RebaseAction;
  message: string;
}

const ACTIONS: RebaseAction[] = ['pick', 'edit', 'reword', 'squash', 'fixup', 'drop'];
const KEYS: Record<string, RebaseAction> = { p: 'pick', e: 'edit', r: 'reword', s: 'squash', f: 'fixup', d: 'drop' };

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const list = byId('list');
const errorEl = byId('error');
const startBtn = byId<HTMLButtonElement>('start');

let original: Row[] = [];
let rows: Row[] = [];
let current = 0;
let dragFrom = -1;

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

function entries() {
  return rows.map((r) => ({
    sha: r.commit.sha,
    action: r.action,
    message: r.action === 'reword' ? r.message : undefined,
  }));
}

/** Index of the commit a squash/fixup at `i` melds into (previous kept row). */
function targetOf(i: number): number {
  for (let j = i - 1; j >= 0; j--) {
    if (rows[j].action !== 'drop' && rows[j].action !== 'squash' && rows[j].action !== 'fixup') {
      return j;
    }
  }
  return -1;
}

function render(focusMessage = false): void {
  list.replaceChildren();
  rows.forEach((row, i) => {
    const item = el('div', `row action-${row.action}${i === current ? ' current' : ''}`);
    item.draggable = true;
    item.dataset.index = String(i);
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(i === current));

    const select = el('select');
    select.title = 'Action';
    for (const a of ACTIONS) {
      const opt = el('option', undefined, a);
      opt.value = a;
      opt.selected = a === row.action;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => setAction(i, select.value as RebaseAction));

    const subject = el('div', 'subject');
    subject.appendChild(el('span', 'text', row.action === 'reword' ? row.message.split('\n')[0] : row.commit.subject));
    if (row.action === 'squash' || row.action === 'fixup') {
      const t = targetOf(i);
      subject.appendChild(el('span', 'into', t >= 0 ? `→ into ${rows[t].commit.sha.slice(0, 8)}` : '→ no earlier commit'));
    }

    item.append(
      el('span', 'grip', '⋮⋮'),
      select,
      el('code', 'hash', row.commit.sha.slice(0, 8)),
      subject,
      el('span', 'author', row.commit.author),
      el('span', 'date', new Date(row.commit.date * 1000).toLocaleDateString()),
    );
    list.appendChild(item);

    if (row.action === 'reword') {
      const editor = el('textarea', 'message');
      editor.value = row.message;
      editor.rows = Math.min(8, Math.max(2, row.message.split('\n').length + 1));
      editor.addEventListener('input', () => {
        row.message = editor.value;
        (item.querySelector('.subject .text') as HTMLElement).textContent = editor.value.split('\n')[0];
        validate();
      });
      editor.addEventListener('keydown', (e) => e.stopPropagation());
      list.appendChild(editor);
      if (focusMessage && i === current) {
        setTimeout(() => editor.focus(), 0);
      }
    }
  });
  validate();
}

function validate(): void {
  const problem = validateEntries(entries());
  const unchanged = rows.every((r, i) => r.commit.sha === original[i].commit.sha && r.action === 'pick');
  errorEl.textContent = problem ?? (unchanged ? 'Nothing to change yet.' : '');
  errorEl.className = problem ? 'error' : 'hint';
  startBtn.disabled = !!problem || unchanged;
}

function setAction(i: number, action: RebaseAction): void {
  current = i;
  rows[i].action = action;
  if (action === 'reword' && !rows[i].message) {
    rows[i].message = rows[i].commit.message;
  }
  render(action === 'reword');
}

function move(from: number, to: number): void {
  if (to < 0 || to >= rows.length || from === to) {
    return;
  }
  const [row] = rows.splice(from, 1);
  rows.splice(to, 0, row);
  current = to;
  render();
}

// ---- events ----

list.addEventListener('mousedown', (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>('.row');
  if (item && !(e.target as HTMLElement).closest('select')) {
    current = Number(item.dataset.index);
    list.querySelectorAll('.row').forEach((n, i) => n.classList.toggle('current', i === current));
  }
});

list.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    move(current, current + (e.key === 'ArrowUp' ? -1 : 1));
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    current = Math.min(rows.length - 1, Math.max(0, current + (e.key === 'ArrowUp' ? -1 : 1)));
    render();
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey && KEYS[e.key.toLowerCase()]) {
    e.preventDefault();
    setAction(current, KEYS[e.key.toLowerCase()]);
  }
});

list.addEventListener('dragstart', (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>('.row');
  dragFrom = item ? Number(item.dataset.index) : -1;
  e.dataTransfer?.setData('text/plain', String(dragFrom));
});
list.addEventListener('dragover', (e) => {
  e.preventDefault();
  list.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
  (e.target as HTMLElement).closest('.row')?.classList.add('drop-target');
});
list.addEventListener('drop', (e) => {
  e.preventDefault();
  const item = (e.target as HTMLElement).closest<HTMLElement>('.row');
  if (item && dragFrom >= 0) {
    move(dragFrom, Number(item.dataset.index));
  }
  dragFrom = -1;
});

document.querySelectorAll<HTMLButtonElement>('#toolbar button[data-action]').forEach((b) =>
  b.addEventListener('click', () => setAction(current, b.dataset.action as RebaseAction)),
);
byId('up').addEventListener('click', () => move(current, current - 1));
byId('down').addEventListener('click', () => move(current, current + 1));
byId('reset').addEventListener('click', () => {
  rows = original.map((r) => ({ ...r }));
  current = 0;
  render();
});
byId('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
startBtn.addEventListener('click', () => {
  if (!validateEntries(entries())) {
    startBtn.disabled = true;
    vscode.postMessage({ type: 'start', entries: entries() });
  }
});

window.addEventListener('message', (event: MessageEvent<RebaseToWebview>) => {
  const m = event.data;
  if (m.type !== 'init') {
    return;
  }
  original = m.commits.map((commit) => ({ commit, action: 'pick' as RebaseAction, message: '' }));
  rows = original.map((r) => ({ ...r }));
  byId('title').textContent = `Rebase ${rows.length} commit${rows.length === 1 ? '' : 's'} of '${m.branch}'`;
  byId('subtitle').textContent = `Onto ${m.base}. Commits are applied from top to bottom. Keys: P E R S F D set the action, Alt+↑/↓ moves, or drag rows.`;
  const warning = byId('warning');
  warning.hidden = !m.warning;
  warning.textContent = m.warning ?? '';
  render();
  list.focus();
});

vscode.postMessage({ type: 'ready' });
