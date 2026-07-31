// UI wiring. Holds no task rules of its own — every change goes through a
// mutation from logic.js and out via sync.js.

import {
  DEFAULT_TOPICS, grouped, counts, isStale, daysOld,
  addMutation, toggleStateMutation, makeId, parseQuickAdd, effectiveTopic,
} from './logic.js';
import { GitHubStore, LocalStore } from './store.js';
import { Sync } from './sync.js';

const $ = (id) => document.getElementById(id);
const LS = window.localStorage;

// Device-local view state. Deliberately NOT in tasks.json: which states you are
// looking at is a property of the moment, not of the data, and syncing it would
// mean a commit every time you tap a chip.
const view = {
  filters: read('todo.filters', { flagged: true, normal: true, waiting: true }),
  collapsed: read('todo.collapsed', {}),
};

function read(key, fallback) {
  try {
    const v = JSON.parse(LS.getItem(key));
    return v && typeof v === 'object' ? { ...fallback, ...v } : fallback;
  } catch {
    return fallback;
  }
}
function write(key, val) {
  try { LS.setItem(key, JSON.stringify(val)); } catch { /* ignore */ }
}

function config() {
  return {
    owner: LS.getItem('todo.owner') || '',
    repo: LS.getItem('todo.repo') || '',
    path: LS.getItem('todo.path') || 'tasks.json',
    token: LS.getItem('todo.token') || '',
  };
}

function makeStore() {
  const c = config();
  if (c.owner && c.repo && c.token) return new GitHubStore(c);
  return new LocalStore();
}

let sync = new Sync({ store: makeStore(), storage: LS });
let reordering = false;
let dragging = null;
let undoTimer = null;

// --- rendering -------------------------------------------------------------

function render() {
  if (dragging) return; // never rebuild the DOM out from under a finger
  const state = sync.state;
  const groups = grouped(state, view.filters);
  const list = $('list');
  const now = new Date().toISOString();

  list.replaceChildren(...groups.map((g) => topicSection(g, now)));

  const c = counts(state);
  $('c-flagged').textContent = c.flagged;
  $('c-normal').textContent = c.normal;
  $('c-waiting').textContent = c.waiting;

  const hidden = c.total - groups.reduce((n, g) => n + g.tasks.length, 0);
  const empty = $('empty');
  if (groups.length === 0) {
    empty.hidden = false;
    empty.textContent = c.total === 0
      ? 'Nothing here. Add something below.'
      : `Nothing matches. ${hidden} task${hidden === 1 ? '' : 's'} hidden by the filters above.`;
  } else {
    empty.hidden = true;
  }

  fillTopicSelect($('add-topic'), state, $('add-topic').value || 'inbox');
}

function topicSection({ topic, tasks }, now) {
  const sec = document.createElement('section');
  sec.className = 'topic';
  sec.dataset.topic = topic.id;
  sec.dataset.collapsed = String(!!view.collapsed[topic.id]);

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'topic-head';
  head.setAttribute('aria-expanded', String(!view.collapsed[topic.id]));
  head.innerHTML = `<span class="caret">▼</span><span>${escapeHtml(topic.title)}</span><span class="count">${tasks.length}</span>`;
  head.addEventListener('click', () => {
    view.collapsed[topic.id] = !view.collapsed[topic.id];
    write('todo.collapsed', view.collapsed);
    render();
  });

  const ul = document.createElement('ul');
  ul.className = 'tasks';
  ul.dataset.topic = topic.id;
  tasks.forEach((t) => ul.appendChild(taskRow(t, now)));

  sec.append(head, ul);
  return sec;
}

function taskRow(task, now) {
  const li = document.createElement('li');
  li.className = 'task';
  li.dataset.id = task.id;
  li.dataset.state = task.state;

  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'done-btn';
  done.setAttribute('aria-label', 'Done');
  done.addEventListener('click', () => completeTask(task));

  const text = document.createElement('button');
  text.type = 'button';
  text.className = 'task-text';
  text.dir = 'auto';
  text.append(document.createTextNode(task.text));
  if (task.note) {
    const n = document.createElement('span');
    n.className = 'has-note';
    n.textContent = '¶';
    n.title = 'has a note';
    text.appendChild(n);
  }
  if (isStale(task, now)) {
    const age = document.createElement('span');
    age.className = 'age';
    age.textContent = `${daysOld(task, now)}d`;
    age.title = 'sitting here a while';
    text.appendChild(age);
  }
  // A long-press ends with a click on whatever was under the finger. Without
  // this guard, arming reorder mode also opens the edit sheet.
  text.addEventListener('click', () => { if (!reordering) openDetail(task); });

  const flag = markButton('mark-flag', '▲', 'Flag as critical', () =>
    sync.apply(toggleStateMutation(task, 'flagged')) && render());
  const wait = markButton('mark-wait', '◷', 'Mark as waiting', () =>
    sync.apply(toggleStateMutation(task, 'waiting')) && render());

  li.append(done, text, flag, wait);
  attachLongPress(li);
  return li;
}

function markButton(cls, glyph, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `mark ${cls}`;
  b.textContent = glyph;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

function fillTopicSelect(sel, state, selected) {
  sel.replaceChildren(...state.topics.map((t) => {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.title;
    if (t.id === selected) o.selected = true;
    return o;
  }));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// --- actions ---------------------------------------------------------------

function completeTask(task) {
  const index = sync.state.tasks.filter((t) => t.topic === task.topic).findIndex((t) => t.id === task.id);
  sync.apply({ op: 'delete', id: task.id });
  render();
  showUndo(task, index);
}

function showUndo(task, index) {
  const bar = $('snackbar');
  $('snackbar-text').textContent = 'Done';
  bar.hidden = false;
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { bar.hidden = true; }, 6000);
  $('undo').onclick = () => {
    sync.apply({ op: 'restore', task, index: Math.max(0, index) });
    bar.hidden = true;
    render();
  };
}

$('add').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('add-text');
  const raw = input.value.trim();
  if (!raw) return;
  // The picker wins unless the text explicitly names a topic.
  const parsed = parseQuickAdd(raw, sync.state);
  const topic = parsed.topic !== 'inbox' ? parsed.topic : ($('add-topic').value || 'inbox');
  sync.apply(addMutation({
    text: parsed.text || raw,
    topic,
    state: parsed.state,
    now: new Date().toISOString(),
    id: makeId(),
  }));
  input.value = '';
  render();
});

for (const [id, key] of [['f-flagged', 'flagged'], ['f-normal', 'normal'], ['f-waiting', 'waiting']]) {
  const el = $(id);
  el.checked = view.filters[key];
  el.addEventListener('change', () => {
    view.filters[key] = el.checked;
    write('todo.filters', view.filters);
    render();
  });
}

// --- detail sheet ----------------------------------------------------------

let detailTask = null;

function openDetail(task) {
  detailTask = task;
  $('d-text').value = task.text;
  $('d-note').value = task.note || '';
  fillTopicSelect($('d-topic'), sync.state, effectiveTopic(sync.state, task));
  $('d-age').textContent = task.created
    ? `Added ${new Date(task.created).toLocaleDateString()} — ${daysOld(task, new Date().toISOString())} days ago`
    : '';
  $('detail').showModal();
}

$('detail').addEventListener('close', () => {
  const dlg = $('detail');
  if (dlg.returnValue !== 'save' || !detailTask) { detailTask = null; return; }
  const t = detailTask;
  const text = $('d-text').value.trim();
  const note = $('d-note').value;
  const topic = $('d-topic').value;
  if (text && text !== t.text) sync.apply({ op: 'setText', id: t.id, text });
  if (note !== (t.note || '')) sync.apply({ op: 'setNote', id: t.id, note });
  if (topic !== t.topic) sync.apply({ op: 'move', id: t.id, topic, index: 0 });
  detailTask = null;
  render();
});

// --- settings --------------------------------------------------------------

$('settings-btn').addEventListener('click', () => {
  const c = config();
  $('s-owner').value = c.owner;
  $('s-repo').value = c.repo;
  $('s-path').value = c.path;
  $('s-token').value = c.token;
  $('s-expires').value = (LS.getItem('todo.tokenExpires') || '').slice(0, 10);
  $('s-msg').textContent = c.token ? 'A token is saved on this device.' : 'No token yet — changes stay on this device.';
  $('settings').showModal();
});

$('settings').addEventListener('close', async () => {
  if ($('settings').returnValue !== 'save') return;
  LS.setItem('todo.owner', $('s-owner').value.trim());
  LS.setItem('todo.repo', $('s-repo').value.trim());
  LS.setItem('todo.path', $('s-path').value.trim() || 'tasks.json');
  LS.setItem('todo.token', $('s-token').value.trim());
  LS.setItem('todo.tokenExpires', $('s-expires').value || '');
  await restart();
});

async function restart() {
  const pending = sync.pending;
  sync = new Sync({ store: makeStore(), storage: LS });
  sync.pending = pending;
  wireSync();
  await sync.start();
  render();
}

// --- reorder mode ----------------------------------------------------------
// Long-press arms it; nothing reorders until then, and leaving the mode disarms
// it again, so the order can't shift under an accidental swipe.

function attachLongPress(li) {
  let timer = null;
  let startY = 0;
  li.addEventListener('pointerdown', (e) => {
    if (reordering) { beginDrag(e, li); return; }
    startY = e.clientY;
    timer = setTimeout(() => { timer = null; enterReorder(); }, 500);
  });
  const cancel = (e) => {
    if (timer && e && e.type === 'pointermove' && Math.abs(e.clientY - startY) < 8) return;
    if (timer) { clearTimeout(timer); timer = null; }
  };
  li.addEventListener('pointermove', cancel);
  li.addEventListener('pointerup', cancel);
  li.addEventListener('pointercancel', cancel);
}

function enterReorder() {
  reordering = true;
  document.body.classList.add('reordering');
  $('dragbar').hidden = false;
  if (navigator.vibrate) navigator.vibrate(15);
}

function exitReorder() {
  reordering = false;
  dragging = null;
  document.body.classList.remove('reordering');
  $('dragbar').hidden = true;
  render();
}

$('dragdone').addEventListener('click', exitReorder);

function beginDrag(e, li) {
  dragging = { li, ul: li.parentElement, pointerId: e.pointerId };
  li.classList.add('dragging');
  // Listeners go on the document, NOT the row. Repositioning the row is a
  // remove-and-reinsert, which releases pointer capture — after the first
  // reposition a row-bound handler would simply stop receiving moves.
  document.addEventListener('pointermove', onDragMove, true);
  document.addEventListener('pointerup', endDrag, true);
  document.addEventListener('pointercancel', endDrag, true);
}

function onDragMove(e) {
  if (!dragging) return;
  e.preventDefault();
  const { li, ul } = dragging;
  const y = e.clientY;
  let before = null;
  for (const sib of ul.children) {
    if (sib === li) continue;
    const r = sib.getBoundingClientRect();
    if (y < r.top + r.height / 2) { before = sib; break; }
  }
  // Skip no-op moves; every DOM move costs a reflow and drops capture.
  if (before) {
    if (li.nextElementSibling !== before) ul.insertBefore(li, before);
  } else if (ul.lastElementChild !== li) {
    ul.appendChild(li);
  }
}

function endDrag() {
  if (!dragging) return;
  const { li, ul } = dragging;
  li.classList.remove('dragging');
  document.removeEventListener('pointermove', onDragMove, true);
  document.removeEventListener('pointerup', endDrag, true);
  document.removeEventListener('pointercancel', endDrag, true);
  const index = [...ul.children].indexOf(li);
  const id = li.dataset.id;
  dragging = null;
  sync.apply({ op: 'move', id, topic: ul.dataset.topic, index });
}

// --- sync status -----------------------------------------------------------

function wireSync() {
  sync.addEventListener('state', render);
  sync.addEventListener('status', (e) => {
    const { status } = e.detail;
    $('status').dataset.status = status;
    const banner = $('banner');
    if (status === 'auth-error') {
      banner.hidden = false;
      banner.innerHTML = '<b>GitHub rejected the token.</b><br>Fine-grained tokens expire after at most a year. Your changes are saved on this device and will sync once the token is replaced.<br>';
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = 'Replace token';
      b.onclick = () => $('settings-btn').click();
      banner.appendChild(b);
    } else if (status !== 'error') {
      banner.hidden = true;
    }
  });
}

// Only relevant when the token actually expires. A permanent token records no
// expiry, and then this never fires; the 401 banner still covers revocation.
function checkTokenAge() {
  const expires = LS.getItem('todo.tokenExpires');
  if (!expires || !config().token) return;
  const daysLeft = (Date.parse(expires) - Date.now()) / 86400000;
  if (Number.isNaN(daysLeft) || daysLeft > 30) return;
  const already = sync.state.tasks.some((t) => t.text.startsWith('Renew the todo GitHub token'));
  if (already) return;
  sync.apply(addMutation({
    text: 'Renew the todo GitHub token',
    topic: 'ai-native',
    state: 'flagged',
    note: 'Fine-grained tokens expire after 366 days max. Create a new one scoped to the data repo (Contents: read and write) and paste it into Settings.',
    now: new Date().toISOString(),
    id: makeId(),
  }));
}

// --- boot ------------------------------------------------------------------

wireSync();
sync.start().then(() => {
  if (!sync.state.topics.length) sync.state.topics = DEFAULT_TOPICS.map((t) => ({ ...t }));
  checkTokenAge();
  render();
});

window.addEventListener('online', () => sync.flushSoon(0));
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync.flushSoon(0); });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// Exposed for the test harness only.
window.__todo = { get sync() { return sync; }, render, view };
