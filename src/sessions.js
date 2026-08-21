/**
 * One chat is one durable agent session.
 *
 * Two things here are load-bearing and were learned the hard way (by the plugin
 * this replaces, and independently while building `dsh-headless-resume`):
 *
 *  - A session already on disk must be RESUMED, not recreated with the same id.
 *    `create()` with a used id makes a fresh live session whose seed disagrees with
 *    the stored events, and persistence then aborts every turn with an id collision.
 *    From the outside it looks like the bot silently ignoring you.
 *  - Chats must be evicted. Holding a live agent per chat forever is a slow leak in
 *    a process that is meant to run for weeks.
 *
 * @module dsh-telegram-inbox/sessions
 */
import { pruneStaleContext } from './staleContext.js';
import { alignSandboxMode } from './sandboxMode.js';

export class ChatSessions {
  /**
   * @param {{agents: object, sessionId: Function, idleMs?: number, max?: number,
   *          now?: () => number, log?: object}} deps
   */
  constructor(deps) {
    this.agents = deps.agents;
    this.sessionId = deps.sessionId;
    this.idleMs = deps.idleMs ?? 6 * 3600_000;
    this.max = deps.max ?? 32;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? { debug() {}, warn() {}, info() {} };
    this.byChat = new Map();     // chatKey -> {handle, sessionId, touched}
    this.bySession = new Map();  // sessionId -> chatKey
  }

  chatFor(sessionId) { return this.bySession.get(String(sessionId)); }

  touch(chatKey) {
    const e = this.byChat.get(chatKey);
    if (e) e.touched = this.now();
  }

  /** Resume a stored session when one exists, else create a fresh one. */
  async acquire(chatKey, { persistence, create, resume }) {
    const existing = this.byChat.get(chatKey);
    if (existing) { existing.touched = this.now(); return existing; }

    const sessionId = this.sessionId(chatKey);
    let handle;

    if (persistence && await this.#onDisk(persistence, sessionId)) {
      try {
        handle = await resume(sessionId);
        // A chat resumed from disk carries runtime-context snapshots describing previous
        // processes — sandbox policy, cwd, model. Observed live: an agent read a stale
        // `workspace-write` line and worked around a read-only filesystem that no longer
        // existed. Drop them so it reads the world it is actually in.
        pruneStaleContext(handle.agent?.session, { log: this.log });
        // The session's own sandbox mode outranks the deployment default, so a chat
        // created before the operator set DSH_PERMISSION_MODE would stay restricted.
        alignSandboxMode(handle.agent?.session, process.env.DSH_PERMISSION_MODE, { log: this.log });
        this.log.info(`resumed session ${sessionId} (history preserved)`);
      } catch (e) {
        // Falling back to a fresh session loses history but keeps the bot answering,
        // which is the better failure for a chat surface.
        this.log.warn(`could not resume ${sessionId}: ${e?.message ?? e}; starting fresh`);
      }
    }
    if (!handle) handle = await create(sessionId);

    const entry = { handle, sessionId, touched: this.now() };
    this.byChat.set(chatKey, entry);
    this.bySession.set(sessionId, chatKey);
    await this.evict();
    return entry;
  }

  async #onDisk(persistence, sessionId) {
    try {
      return (await persistence.list()).some((h) => h.id === sessionId);
    } catch (e) {
      this.log.warn(`could not list stored sessions: ${e?.message ?? e}`);
      return false;
    }
  }

  async forget(chatKey) {
    const e = this.byChat.get(chatKey);
    if (!e) return false;
    try { await e.handle.dispose(); } catch { /* already gone */ }
    this.byChat.delete(chatKey);
    this.bySession.delete(e.sessionId);
    return true;
  }

  /**
   * Drop chats idle past the window, and the oldest beyond `max`. The session stays
   * on disk, so the next message resumes it with its history intact — eviction costs
   * a resume, not a conversation.
   */
  async evict() {
    const cutoff = this.now() - this.idleMs;
    for (const [key, e] of [...this.byChat]) {
      if (e.touched < cutoff) { this.log.debug(`evicting idle chat ${key}`); await this.forget(key); }
    }
    if (this.byChat.size <= this.max) return;
    const oldest = [...this.byChat.entries()].sort((a, b) => a[1].touched - b[1].touched);
    for (const [key] of oldest.slice(0, this.byChat.size - this.max)) {
      this.log.debug(`evicting chat ${key} over the ${this.max}-chat cap`);
      await this.forget(key);
    }
  }
}
