// Sync engine: local-first, debounced, offline-durable.
//
// Every UI action applies its mutation to memory immediately (so the phone never
// feels like it is waiting on a network) and appends it to a queue persisted in
// localStorage. The queue is flushed after a quiet period, so a morning triage of
// six flags becomes one commit rather than six.

import { applyMutation, applyAll, serialize, deserialize, emptyState } from './logic.js';
import { AuthError, OfflineError } from './store.js';

export const QUIET_MS = 1500;

export class Sync extends EventTarget {
  constructor({ store, storage, quietMs = QUIET_MS, now = () => Date.now() }) {
    super();
    this.store = store;
    this.storage = storage || localStorage;
    this.quietMs = quietMs;
    this.now = now;
    this.state = emptyState();
    this.pending = this._readQueue();
    this.status = 'idle';
    this.lastError = null;
    this._timer = null;
    this._flushing = false;
  }

  // --- lifecycle -----------------------------------------------------------

  async start() {
    const mirror = this.storage.getItem('todo.mirror');
    if (mirror) {
      const parsed = deserialize(mirror);
      if (parsed) this.state = applyAll(parsed, this.pending);
      this._emit();
    }
    try {
      const remote = await this.store.load();
      // Anything queued while we were away still wins locally until it lands.
      this.state = applyAll(remote, this.pending);
      this._setStatus('idle');
      this._mirror();
      this._emit();
      if (this.pending.length) this.flushSoon(0);
    } catch (e) {
      this._handleError(e);
    }
    return this.state;
  }

  // --- writes --------------------------------------------------------------

  apply(mutation) {
    this.state = applyMutation(this.state, mutation);
    this.pending.push(mutation);
    this._writeQueue();
    this._mirror();
    this._emit();
    this.flushSoon();
    return this.state;
  }

  flushSoon(delay = this.quietMs) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, delay);
  }

  async flush() {
    if (this._flushing || !this.pending.length) return;
    this._flushing = true;
    const batch = this.pending.slice();
    this._setStatus('saving');
    try {
      const saved = await this.store.save(this.state, batch);
      // Drop exactly the mutations we sent; anything queued mid-flight survives.
      this.pending = this.pending.slice(batch.length);
      this._writeQueue();
      if (this.pending.length) {
        this.state = applyAll(saved, this.pending);
      } else {
        this.state = saved;
      }
      this._setStatus('idle');
      this._mirror();
      this._emit();
    } catch (e) {
      this._handleError(e);
    } finally {
      this._flushing = false;
    }
    if (this.pending.length && this.status === 'idle') this.flushSoon();
  }

  // --- status --------------------------------------------------------------

  _handleError(e) {
    this.lastError = e;
    if (e instanceof AuthError) {
      // Fine-grained tokens expire (366 days max), so this is a matter of when,
      // not if. It must never look like a silent failure to save.
      this._setStatus('auth-error');
    } else if (e instanceof OfflineError) {
      this._setStatus('offline');
    } else {
      this._setStatus('error');
    }
    this._emit();
  }

  _setStatus(s) {
    this.status = s;
    this.dispatchEvent(new CustomEvent('status', { detail: { status: s, error: this.lastError, pending: this.pending.length } }));
  }

  _emit() {
    this.dispatchEvent(new CustomEvent('state', { detail: { state: this.state } }));
  }

  // --- durability ----------------------------------------------------------

  _mirror() {
    try {
      this.storage.setItem('todo.mirror', serialize(this.state));
    } catch {
      /* quota — the remote is still the source of truth */
    }
  }

  _readQueue() {
    try {
      const raw = this.storage.getItem('todo.queue');
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  _writeQueue() {
    try {
      this.storage.setItem('todo.queue', JSON.stringify(this.pending));
    } catch {
      /* ignore */
    }
  }
}
