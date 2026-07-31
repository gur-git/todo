// Storage. One implementation of the read/write/conflict protocol, used by the
// phone app; the PowerShell helper speaks the same GitHub Contents API against
// the same file, so there is exactly one storage contract to reason about.

import { deserialize, serialize, emptyState, applyAll } from './logic.js';

const API = 'https://api.github.com';

// btoa() throws on anything outside Latin-1, which would break the moment Gal
// writes a task in Hebrew. Encode UTF-8 bytes first.
export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function fromBase64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export class AuthError extends Error {}
export class OfflineError extends Error {}

export class GitHubStore {
  constructor({ owner, repo, path = 'tasks.json', branch = 'main', token, fetchImpl }) {
    Object.assign(this, { owner, repo, path, branch, token });
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.sha = null;
  }

  get url() {
    return `${API}/repos/${this.owner}/${this.repo}/contents/${this.path}`;
  }

  headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async load() {
    let res;
    try {
      res = await this.fetch(`${this.url}?ref=${encodeURIComponent(this.branch)}`, {
        headers: this.headers(),
        cache: 'no-store',
      });
    } catch (e) {
      throw new OfflineError(e.message);
    }
    if (res.status === 401 || res.status === 403) throw new AuthError(`GitHub rejected the token (${res.status})`);
    if (res.status === 404) {
      // First run: the file does not exist yet. Not an error.
      this.sha = null;
      return emptyState();
    }
    if (!res.ok) throw new Error(`GitHub load failed: ${res.status}`);
    const body = await res.json();
    this.sha = body.sha;
    return deserialize(fromBase64(body.content)) || emptyState();
  }

  // Writes `state`. If the remote moved underneath us (409/422 on a stale sha),
  // reload and replay `mutations` on top of the fresh state instead of
  // clobbering it, then retry. This is why every UI action is a mutation.
  async save(state, mutations = [], attempt = 0) {
    const payload = {
      message: commitMessage(mutations),
      content: toBase64(serialize(state)),
      branch: this.branch,
    };
    if (this.sha) payload.sha = this.sha;

    let res;
    try {
      res = await this.fetch(this.url, {
        method: 'PUT',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new OfflineError(e.message);
    }

    if (res.status === 401 || res.status === 403) throw new AuthError(`GitHub rejected the token (${res.status})`);

    if ((res.status === 409 || res.status === 422) && attempt < 3) {
      const fresh = await this.load();
      const merged = applyAll(fresh, mutations);
      return this.save(merged, mutations, attempt + 1);
    }

    if (!res.ok) throw new Error(`GitHub save failed: ${res.status}`);
    const body = await res.json();
    this.sha = body.content && body.content.sha;
    return deserialize(serialize(state));
  }
}

function commitMessage(mutations) {
  if (!mutations.length) return 'todo: sync';
  if (mutations.length === 1) {
    const m = mutations[0];
    const label = { add: 'add', delete: 'done', setState: 'mark', move: 'reorder', setText: 'edit', setNote: 'note', restore: 'undo' }[m.op] || m.op;
    const what = m.task ? m.task.text : m.text || m.id;
    return `todo: ${label} ${String(what).slice(0, 60)}`;
  }
  return `todo: ${mutations.length} changes`;
}

// A store backed by localStorage. Used for the offline queue's mirror and for
// running the app (and its tests) with no network at all.
export class LocalStore {
  constructor({ key = 'todo.state', storage } = {}) {
    this.key = key;
    this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : new MemoryStorage());
  }
  async load() {
    const raw = this.storage.getItem(this.key);
    return (raw && deserialize(raw)) || emptyState();
  }
  async save(state) {
    this.storage.setItem(this.key, serialize(state));
    return state;
  }
}

export class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}
