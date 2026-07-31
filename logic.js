// Pure task logic. No DOM, no network, no globals.
// Every UI action becomes a mutation; mutations are what get replayed on top of
// fresh remote state when a write conflicts. Keeping this file pure is what makes
// both the unit tests and the conflict replay honest.

export const STATES = ['normal', 'flagged', 'waiting'];

export const DEFAULT_TOPICS = [
  { id: 'inbox', title: 'Inbox' },
  { id: 'personal', title: 'Personal' },
  { id: 'lab', title: 'Lab' },
  { id: 'degree', title: 'Degree' },
  { id: 'entrepreneurship', title: 'Entrepreneurship' },
  { id: 'ai-native', title: 'AI Native' },
  { id: 'explore', title: 'Explore' },
  { id: 'relationships', title: 'Relationships' },
];

export const STALE_DAYS = 30;

export function emptyState(topics = DEFAULT_TOPICS) {
  return { version: 1, topics: topics.map((t) => ({ ...t })), tasks: [] };
}

// --- helpers ---------------------------------------------------------------

export function makeId(rand = Math.random) {
  // Not security-sensitive; just needs to not collide within one list.
  let s = '';
  for (let i = 0; i < 10; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rand() * 36)];
  return 't_' + s;
}

export function topicIds(state) {
  return state.topics.map((t) => t.id);
}

// A task whose topic no longer exists must never become invisible.
export function effectiveTopic(state, task) {
  return topicIds(state).includes(task.topic) ? task.topic : 'inbox';
}

function indicesOfTopic(tasks, topicId) {
  const out = [];
  tasks.forEach((t, i) => {
    if (t.topic === topicId) out.push(i);
  });
  return out;
}

// Insert `task` so that it lands at position `index` *among that topic's tasks*,
// leaving every other topic's relative order untouched.
function insertIntoTopic(tasks, task, index) {
  const idxs = indicesOfTopic(tasks, task.topic);
  const clamped = Math.max(0, Math.min(index, idxs.length));
  let at;
  if (idxs.length === 0) at = tasks.length;
  else if (clamped === idxs.length) at = idxs[idxs.length - 1] + 1;
  else at = idxs[clamped];
  const next = tasks.slice();
  next.splice(at, 0, task);
  return next;
}

// --- mutations -------------------------------------------------------------
// Each returns a NEW state. Unknown ops and unknown ids are no-ops rather than
// throwing, so replaying a stale queue can never wedge the app.

export function applyMutation(state, m) {
  switch (m.op) {
    case 'add': {
      if (state.tasks.some((t) => t.id === m.task.id)) return state;
      return { ...state, tasks: insertIntoTopic(state.tasks, { ...m.task }, m.index ?? 0) };
    }
    case 'setState': {
      if (!STATES.includes(m.state)) return state;
      return mapTask(state, m.id, (t) => ({ ...t, state: m.state }));
    }
    case 'setText':
      return mapTask(state, m.id, (t) => ({ ...t, text: m.text }));
    case 'setNote':
      return mapTask(state, m.id, (t) => ({ ...t, note: m.note }));
    case 'delete':
      return { ...state, tasks: state.tasks.filter((t) => t.id !== m.id) };
    case 'move': {
      const from = state.tasks.findIndex((t) => t.id === m.id);
      if (from < 0) return state;
      const tasks = state.tasks.slice();
      const [task] = tasks.splice(from, 1);
      return { ...state, tasks: insertIntoTopic(tasks, { ...task, topic: m.topic }, m.index) };
    }
    case 'restore': {
      if (state.tasks.some((t) => t.id === m.task.id)) return state;
      return { ...state, tasks: insertIntoTopic(state.tasks, { ...m.task }, m.index ?? 0) };
    }
    default:
      return state;
  }
}

export function applyAll(state, mutations) {
  return mutations.reduce(applyMutation, state);
}

function mapTask(state, id, fn) {
  let hit = false;
  const tasks = state.tasks.map((t) => {
    if (t.id !== id) return t;
    hit = true;
    return fn(t);
  });
  return hit ? { ...state, tasks } : state;
}

// --- mutation builders -----------------------------------------------------

export function addMutation({ text, topic = 'inbox', state = 'normal', note = '', now, id }) {
  return {
    op: 'add',
    index: 0, // new tasks land at the top of their topic
    task: { id: id || makeId(), text: text.trim(), topic, state, note, created: now },
  };
}

// The danger triangle and the waiting marker are toggles: pressing the state a
// task already has returns it to normal. States are mutually exclusive.
export function toggleStateMutation(task, target) {
  return { op: 'setState', id: task.id, state: task.state === target ? 'normal' : target };
}

// --- views -----------------------------------------------------------------

export const ALL_VISIBLE = { flagged: true, normal: true, waiting: true };

export function isStale(task, now, days = STALE_DAYS) {
  if (!task.created) return false;
  const ageMs = Date.parse(now) - Date.parse(task.created);
  if (Number.isNaN(ageMs)) return false;
  return ageMs >= days * 86400000;
}

export function daysOld(task, now) {
  if (!task.created) return 0;
  const ageMs = Date.parse(now) - Date.parse(task.created);
  return Number.isNaN(ageMs) ? 0 : Math.floor(ageMs / 86400000);
}

// Returns [{ topic, tasks }] in topic order, skipping topics with nothing to show.
export function grouped(state, filters = ALL_VISIBLE) {
  const byTopic = new Map(state.topics.map((t) => [t.id, []]));
  for (const task of state.tasks) {
    if (!filters[task.state]) continue;
    const key = effectiveTopic(state, task);
    if (byTopic.has(key)) byTopic.get(key).push(task);
  }
  return state.topics
    .map((topic) => ({ topic, tasks: byTopic.get(topic.id) }))
    .filter((g) => g.tasks.length > 0);
}

export function counts(state) {
  const c = { flagged: 0, normal: 0, waiting: 0, total: state.tasks.length };
  for (const t of state.tasks) if (c[t.state] !== undefined) c[t.state]++;
  return c;
}

// --- quick add -------------------------------------------------------------
// Two shortcuts only: a leading `!` flags, a leading `topic:` files. Everything
// else is the task text verbatim. Gal types neither on the phone (icons do it);
// this exists so the scripts and the app share one input format.

export function parseQuickAdd(input, state) {
  let rest = String(input);
  let flagged = false;
  let topic = null;

  for (;;) {
    const before = rest;
    rest = rest.replace(/^\s+/, '');
    if (rest.startsWith('!')) {
      flagged = true;
      rest = rest.slice(1);
    }
    if (topic === null) {
      const m = rest.match(/^([\p{L}][\p{L}\d _-]*):\s*/u);
      if (m) {
        const found = resolveTopic(state, m[1]);
        if (found) {
          topic = found;
          rest = rest.slice(m[0].length);
        }
      }
    }
    if (rest === before) break;
  }

  return { text: rest.trim(), topic: topic || 'inbox', state: flagged ? 'flagged' : 'normal' };
}

export function resolveTopic(state, name) {
  const norm = (s) => String(s).trim().toLowerCase().replace(/[\s_]+/g, '-');
  const target = norm(name);
  const hit = state.topics.find((t) => norm(t.id) === target || norm(t.title) === target);
  return hit ? hit.id : null;
}

// --- serialization ---------------------------------------------------------

export function serialize(state) {
  return JSON.stringify({ version: 1, topics: state.topics, tasks: state.tasks }, null, 2) + '\n';
}

// Tolerant on purpose: a hand-edited file with a missing field should degrade,
// not blank the list.
export function deserialize(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const topics = Array.isArray(raw.topics) && raw.topics.length
    ? raw.topics.filter((t) => t && t.id).map((t) => ({ id: String(t.id), title: String(t.title || t.id) }))
    : DEFAULT_TOPICS.map((t) => ({ ...t }));
  const tasks = (Array.isArray(raw.tasks) ? raw.tasks : [])
    .filter((t) => t && t.id && typeof t.text === 'string')
    .map((t) => ({
      id: String(t.id),
      text: t.text,
      topic: String(t.topic || 'inbox'),
      state: STATES.includes(t.state) ? t.state : 'normal',
      note: typeof t.note === 'string' ? t.note : '',
      created: t.created || null,
    }));
  return { version: 1, topics, tasks };
}
