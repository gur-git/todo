// Browser-side test suites. Run inside the real Chromium the phone will use,
// so module semantics, TextEncoder, atob/btoa and fetch all behave as in production.

import * as L from '../logic.js';
import { GitHubStore, toBase64, fromBase64, AuthError, OfflineError } from '../store.js';

const results = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, detail: e && e.message ? e.message : String(e) });
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, detail: e && e.message ? e.message : String(e) });
  }
}

function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`);
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'expected truthy');
}

const T0 = '2026-01-01T00:00:00.000Z';

function seed() {
  let s = L.emptyState();
  const add = (id, text, topic, state) =>
    (s = L.applyMutation(s, { op: 'add', index: 999, task: { id, text, topic, state, note: '', created: T0 } }));
  add('a', 'lab one', 'lab', 'normal');
  add('b', 'lab two', 'lab', 'flagged');
  add('c', 'lab three', 'lab', 'waiting');
  add('d', 'personal one', 'personal', 'normal');
  return s;
}
const ids = (s, topic) => s.tasks.filter((t) => t.topic === topic).map((t) => t.id);

// --- logic -----------------------------------------------------------------

export function runLogic() {
  results.length = 0;

  check('add places a new task at the top of its topic', () => {
    const s = L.applyMutation(seed(), L.addMutation({ text: 'fresh', topic: 'lab', now: T0, id: 'z' }));
    eq(ids(s, 'lab'), ['z', 'a', 'b', 'c']);
  });

  check('add does not disturb other topics', () => {
    const s = L.applyMutation(seed(), L.addMutation({ text: 'fresh', topic: 'lab', now: T0, id: 'z' }));
    eq(ids(s, 'personal'), ['d']);
  });

  check('add into an empty topic works', () => {
    const s = L.applyMutation(seed(), L.addMutation({ text: 'x', topic: 'degree', now: T0, id: 'z' }));
    eq(ids(s, 'degree'), ['z']);
  });

  check('flag toggle sets flagged', () => {
    const s = seed();
    const t = s.tasks.find((x) => x.id === 'a');
    const s2 = L.applyMutation(s, L.toggleStateMutation(t, 'flagged'));
    eq(s2.tasks.find((x) => x.id === 'a').state, 'flagged');
  });

  check('flag toggle twice returns to normal', () => {
    let s = seed();
    let t = s.tasks.find((x) => x.id === 'a');
    s = L.applyMutation(s, L.toggleStateMutation(t, 'flagged'));
    t = s.tasks.find((x) => x.id === 'a');
    s = L.applyMutation(s, L.toggleStateMutation(t, 'flagged'));
    eq(s.tasks.find((x) => x.id === 'a').state, 'normal');
  });

  check('states are mutually exclusive: flagging a waiting task makes it flagged', () => {
    const s = seed();
    const t = s.tasks.find((x) => x.id === 'c');
    eq(t.state, 'waiting');
    const s2 = L.applyMutation(s, L.toggleStateMutation(t, 'flagged'));
    eq(s2.tasks.find((x) => x.id === 'c').state, 'flagged');
  });

  check('delete removes the task', () => {
    const s = L.applyMutation(seed(), { op: 'delete', id: 'b' });
    eq(ids(s, 'lab'), ['a', 'c']);
  });

  check('restore puts the task back at its original index', () => {
    const before = seed();
    const task = before.tasks.find((t) => t.id === 'b');
    const idx = ids(before, 'lab').indexOf('b');
    let s = L.applyMutation(before, { op: 'delete', id: 'b' });
    s = L.applyMutation(s, { op: 'restore', task, index: idx });
    eq(ids(s, 'lab'), ['a', 'b', 'c']);
  });

  check('move reorders within a topic', () => {
    const s = L.applyMutation(seed(), { op: 'move', id: 'c', topic: 'lab', index: 0 });
    eq(ids(s, 'lab'), ['c', 'a', 'b']);
  });

  check('move to the end of a topic', () => {
    const s = L.applyMutation(seed(), { op: 'move', id: 'a', topic: 'lab', index: 2 });
    eq(ids(s, 'lab'), ['b', 'c', 'a']);
  });

  check('move across topics', () => {
    const s = L.applyMutation(seed(), { op: 'move', id: 'a', topic: 'personal', index: 0 });
    eq(ids(s, 'lab'), ['b', 'c']);
    eq(ids(s, 'personal'), ['a', 'd']);
  });

  check('grouped hides filtered-out states', () => {
    const g = L.grouped(seed(), { flagged: true, normal: false, waiting: false });
    eq(g.map((x) => x.topic.id), ['lab']);
    eq(g[0].tasks.map((t) => t.id), ['b']);
  });

  check('grouped hides topics with nothing to show', () => {
    // Only lab and personal are seeded; the other six topics must not render.
    const g = L.grouped(seed(), L.ALL_VISIBLE);
    eq(g.map((x) => x.topic.id), ['personal', 'lab']);
  });

  check('grouped follows the topic order in the file, not insertion order', () => {
    // Seeded lab-first, but the file lists personal before lab.
    let s = seed();
    s = L.applyMutation(s, L.addMutation({ text: 'i', topic: 'inbox', now: T0, id: 'i1' }));
    eq(L.grouped(s, L.ALL_VISIBLE).map((x) => x.topic.id), ['inbox', 'personal', 'lab']);
  });

  check('a task in an unknown topic still shows, under Inbox', () => {
    let s = seed();
    s = L.applyMutation(s, { op: 'add', index: 0, task: { id: 'orphan', text: 'lost', topic: 'nope', state: 'normal', note: '', created: T0 } });
    eq(L.effectiveTopic(s, s.tasks.find((t) => t.id === 'orphan')), 'inbox');
    const g = L.grouped(s, L.ALL_VISIBLE);
    ok(g.find((x) => x.topic.id === 'inbox').tasks.some((t) => t.id === 'orphan'), 'orphan not shown under inbox');
  });

  check('stale marker is off at 29 days and on at 30', () => {
    const task = { created: '2026-01-01T00:00:00.000Z' };
    eq(L.isStale(task, '2026-01-30T00:00:00.000Z'), false);
    eq(L.isStale(task, '2026-01-31T00:00:00.000Z'), true);
    eq(L.daysOld(task, '2026-01-31T00:00:00.000Z'), 30);
  });

  check('a task with no created date is never stale', () => {
    eq(L.isStale({ created: null }, '2027-01-01T00:00:00.000Z'), false);
  });

  check('quick add: leading ! flags', () => {
    const r = L.parseQuickAdd('!buy milk', L.emptyState());
    eq([r.text, r.topic, r.state], ['buy milk', 'inbox', 'flagged']);
  });

  check('quick add: topic: prefix files the task', () => {
    const r = L.parseQuickAdd('lab: fix the bias', L.emptyState());
    eq([r.text, r.topic, r.state], ['fix the bias', 'lab', 'normal']);
  });

  check('quick add: ! and topic: together', () => {
    const r = L.parseQuickAdd('!lab: fix the bias', L.emptyState());
    eq([r.text, r.topic, r.state], ['fix the bias', 'lab', 'flagged']);
  });

  check('quick add: topic title matches case-insensitively', () => {
    const r = L.parseQuickAdd('AI Native: ship it', L.emptyState());
    eq([r.text, r.topic], ['ship it', 'ai-native']);
  });

  check('quick add: an unknown prefix stays part of the text', () => {
    const r = L.parseQuickAdd('note: call the bank', L.emptyState());
    eq([r.text, r.topic], ['note: call the bank', 'inbox']);
  });

  check('quick add: plain text lands in inbox as normal', () => {
    const r = L.parseQuickAdd('just a thing', L.emptyState());
    eq([r.text, r.topic, r.state], ['just a thing', 'inbox', 'normal']);
  });

  check('quick add: Hebrew text survives intact', () => {
    const r = L.parseQuickAdd('!lab: לבדוק את המדידה', L.emptyState());
    eq([r.text, r.topic, r.state], ['לבדוק את המדידה', 'lab', 'flagged']);
  });

  check('counts report per state', () => {
    eq(L.counts(seed()), { flagged: 1, normal: 2, waiting: 1, total: 4 });
  });

  check('serialize/deserialize round-trips', () => {
    const s = seed();
    eq(L.deserialize(L.serialize(s)), s);
  });

  check('deserialize survives Hebrew and quotes', () => {
    let s = L.emptyState();
    s = L.applyMutation(s, L.addMutation({ text: 'שלום "world" \\ ok', topic: 'inbox', now: T0, id: 'h' }));
    eq(L.deserialize(L.serialize(s)).tasks[0].text, 'שלום "world" \\ ok');
  });

  check('deserialize returns null on non-JSON', () => {
    eq(L.deserialize('not json at all'), null);
  });

  check('deserialize drops malformed tasks but keeps the good ones', () => {
    const s = L.deserialize(JSON.stringify({ tasks: [{ id: 'x', text: 'fine' }, { id: 'y' }, null, { text: 'no id' }] }));
    eq(s.tasks.map((t) => t.id), ['x']);
    eq(s.tasks[0].state, 'normal');
  });

  check('deserialize falls back to default topics when none are present', () => {
    eq(L.deserialize('{}').topics.length, L.DEFAULT_TOPICS.length);
  });

  check('an unknown mutation op is a no-op', () => {
    const s = seed();
    eq(L.applyMutation(s, { op: 'nonsense', id: 'a' }), s);
  });

  check('mutating an unknown id is a no-op', () => {
    const s = seed();
    eq(L.applyMutation(s, { op: 'setState', id: 'ghost', state: 'flagged' }), s);
  });

  check('an invalid state is rejected', () => {
    const s = seed();
    eq(L.applyMutation(s, { op: 'setState', id: 'a', state: 'urgent' }), s);
  });

  check('adding a task that already exists is a no-op (replay safety)', () => {
    const s = seed();
    const m = { op: 'add', index: 0, task: { id: 'a', text: 'dup', topic: 'lab', state: 'normal', note: '', created: T0 } };
    eq(L.applyAll(s, [m, m]), s);
  });

  check('applyAll replays a queue in order', () => {
    let s = seed();
    const out = L.applyAll(s, [
      { op: 'setState', id: 'a', state: 'flagged' },
      { op: 'delete', id: 'b' },
      { op: 'move', id: 'c', topic: 'lab', index: 0 },
    ]);
    eq(ids(out, 'lab'), ['c', 'a']);
    eq(out.tasks.find((t) => t.id === 'a').state, 'flagged');
  });

  return results;
}

// --- store -----------------------------------------------------------------

function mockRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function b64json(obj) {
  return toBase64(JSON.stringify(obj));
}

export async function runStore() {
  results.length = 0;

  check('base64 round-trips ASCII', () => {
    eq(fromBase64(toBase64('hello world')), 'hello world');
  });

  check('base64 round-trips Hebrew (btoa would throw here)', () => {
    const s = 'לבדוק את המדידה — 100% ✓';
    eq(fromBase64(toBase64(s)), s);
  });

  check('base64 round-trips a large payload', () => {
    const s = 'x'.repeat(200000) + 'שלום';
    eq(fromBase64(toBase64(s)).length, s.length);
  });

  await checkAsync('load returns an empty state when the file does not exist yet', async () => {
    const store = new GitHubStore({ owner: 'o', repo: 'r', token: 't', fetchImpl: async () => mockRes(404, {}) });
    const s = await store.load();
    eq(s.tasks, []);
    eq(s.topics.length, L.DEFAULT_TOPICS.length);
  });

  await checkAsync('load parses the remote file', async () => {
    const remote = { version: 1, topics: L.DEFAULT_TOPICS, tasks: [{ id: 'a', text: 'hi', topic: 'inbox', state: 'flagged', note: '', created: T0 }] };
    const store = new GitHubStore({ owner: 'o', repo: 'r', token: 't', fetchImpl: async () => mockRes(200, { sha: 'S1', content: b64json(remote) }) });
    const s = await store.load();
    eq(s.tasks.map((t) => t.id), ['a']);
    eq(store.sha, 'S1');
  });

  await checkAsync('a 401 raises AuthError, not a generic failure', async () => {
    const store = new GitHubStore({ owner: 'o', repo: 'r', token: 'bad', fetchImpl: async () => mockRes(401, {}) });
    let caught = null;
    try { await store.load(); } catch (e) { caught = e; }
    ok(caught instanceof AuthError, `expected AuthError, got ${caught}`);
  });

  await checkAsync('a network failure raises OfflineError', async () => {
    const store = new GitHubStore({ owner: 'o', repo: 'r', token: 't', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    let caught = null;
    try { await store.load(); } catch (e) { caught = e; }
    ok(caught instanceof OfflineError, `expected OfflineError, got ${caught}`);
  });

  await checkAsync('save sends the known sha so GitHub can reject a stale write', async () => {
    let seen = null;
    const store = new GitHubStore({
      owner: 'o', repo: 'r', token: 't',
      fetchImpl: async (url, init) => {
        if (!init || init.method !== 'PUT') return mockRes(200, { sha: 'S1', content: b64json(L.emptyState()) });
        seen = JSON.parse(init.body);
        return mockRes(200, { content: { sha: 'S2' } });
      },
    });
    await store.load();
    await store.save(L.emptyState(), []);
    eq(seen.sha, 'S1');
    eq(store.sha, 'S2');
  });

  await checkAsync('a conflicting save reloads, replays the mutations, and retries', async () => {
    // The remote gained a task while we were editing. Our own add must survive,
    // and so must theirs.
    const theirs = {
      version: 1, topics: L.DEFAULT_TOPICS,
      tasks: [{ id: 'remote', text: 'added elsewhere', topic: 'inbox', state: 'normal', note: '', created: T0 }],
    };
    let puts = 0;
    let finalBody = null;
    const store = new GitHubStore({
      owner: 'o', repo: 'r', token: 't',
      fetchImpl: async (url, init) => {
        if (!init || init.method !== 'PUT') return mockRes(200, { sha: 'S9', content: b64json(theirs) });
        puts++;
        if (puts === 1) return mockRes(409, {});
        finalBody = JSON.parse(init.body);
        return mockRes(200, { content: { sha: 'S10' } });
      },
    });
    store.sha = 'STALE';
    const mine = L.addMutation({ text: 'mine', topic: 'inbox', now: T0, id: 'mine' });
    const local = L.applyMutation(L.emptyState(), mine);
    await store.save(local, [mine]);

    eq(puts, 2, 'should have retried exactly once');
    const written = L.deserialize(fromBase64(finalBody.content));
    eq(written.tasks.map((t) => t.id).sort(), ['mine', 'remote'], 'neither side should be lost');
    eq(finalBody.sha, 'S9', 'retry must use the fresh sha');
  });

  await checkAsync('a save that keeps conflicting gives up rather than looping', async () => {
    let puts = 0;
    const store = new GitHubStore({
      owner: 'o', repo: 'r', token: 't',
      fetchImpl: async (url, init) => {
        if (!init || init.method !== 'PUT') return mockRes(200, { sha: 'S', content: b64json(L.emptyState()) });
        puts++;
        return mockRes(409, {});
      },
    });
    let threw = false;
    try { await store.save(L.emptyState(), []); } catch { threw = true; }
    ok(threw, 'expected the save to fail');
    ok(puts <= 4, `expected at most 4 attempts, saw ${puts}`);
  });

  await checkAsync('a 403 on save raises AuthError so the UI can show the token banner', async () => {
    const store = new GitHubStore({
      owner: 'o', repo: 'r', token: 't',
      fetchImpl: async (url, init) => (init && init.method === 'PUT' ? mockRes(403, {}) : mockRes(200, { sha: 'S', content: b64json(L.emptyState()) })),
    });
    let caught = null;
    try { await store.save(L.emptyState(), []); } catch (e) { caught = e; }
    ok(caught instanceof AuthError, `expected AuthError, got ${caught}`);
  });

  await checkAsync('the commit message describes a single change', async () => {
    let msg = null;
    const store = new GitHubStore({
      owner: 'o', repo: 'r', token: 't',
      fetchImpl: async (url, init) => {
        if (init && init.method === 'PUT') { msg = JSON.parse(init.body).message; return mockRes(200, { content: { sha: 'S' } }); }
        return mockRes(200, { sha: 'S', content: b64json(L.emptyState()) });
      },
    });
    await store.save(L.emptyState(), [L.addMutation({ text: 'call the bank', topic: 'inbox', now: T0, id: 'q' })]);
    ok(/call the bank/.test(msg), `unhelpful commit message: ${msg}`);
  });

  return results;
}
