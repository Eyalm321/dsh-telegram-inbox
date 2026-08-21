/**
 * Handing a conversation to another client, safely.
 *
 * A session may have exactly one writer. Two processes appending to one log interleave
 * sequence numbers and the harness rejects the whole file — that is not a theoretical
 * hazard here, it cost 4,635 lines of conversation on 2026-08-21. So "open this chat in the
 * web UI" cannot mean "also open it": the daemon has to let go first.
 *
 * A claim is a small file naming the holder. While one exists the daemon does not touch
 * that session at all; inbound messages are parked and replayed when the claim is dropped,
 * so nothing is lost while a person is typing somewhere else.
 *
 * Claims expire. A client that crashes mid-handoff must not lock a conversation forever,
 * and the failure mode of a stale claim — the daemon takes over again — is the safe one.
 *
 * @module dsh-telegram-inbox/handoff
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_TTL_MS = 30 * 60 * 1000;

export class Handoff {
  /** @param {string|null} dir @param {{ttlMs?: number, now?: () => number, log?: object}} [opts] */
  constructor(dir, opts = {}) {
    this.dir = dir ?? null;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? { info() {}, warn() {} };
  }

  #path(sessionId) { return join(this.dir, `${sessionId}.claim.json`); }
  #pending(sessionId) { return join(this.dir, `${sessionId}.pending.json`); }

  /** Claim a session for `owner`. Returns the claim record. */
  claim(sessionId, owner = 'unknown') {
    if (!this.dir) throw new Error('no handoff directory configured');
    mkdirSync(this.dir, { recursive: true });
    const rec = { sessionId, owner, claimedAt: this.now(), pid: process.pid };
    const tmp = `${this.#path(sessionId)}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec));
    renameSync(tmp, this.#path(sessionId));
    return rec;
  }

  /** The live claim on a session, or null. Expired claims are cleared as a side effect. */
  claimOf(sessionId) {
    if (!this.dir) return null;
    const p = this.#path(sessionId);
    if (!existsSync(p)) return null;
    let rec;
    try { rec = JSON.parse(readFileSync(p, 'utf8')); }
    catch { this.#drop(p); return null; }          // unreadable claim blocks nothing
    if (this.now() - Number(rec.claimedAt ?? 0) > this.ttlMs) {
      this.log.warn(`handoff claim on ${sessionId} by ${rec.owner} expired; reclaiming`);
      this.#drop(p);
      return null;
    }
    return rec;
  }

  isClaimed(sessionId) { return this.claimOf(sessionId) !== null; }

  release(sessionId) {
    if (!this.dir) return false;
    const p = this.#path(sessionId);
    if (!existsSync(p)) return false;
    this.#drop(p);
    return true;
  }

  #drop(p) { try { unlinkSync(p); } catch { /* already gone */ } }

  /** Park a message that arrived while the session was claimed. */
  park(sessionId, message) {
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true });
    const p = this.#pending(sessionId);
    const queue = this.parked(sessionId);
    queue.push(message);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(queue));
    renameSync(tmp, p);
  }

  /** Everything parked for a session, oldest first. */
  parked(sessionId) {
    if (!this.dir) return [];
    try {
      const v = JSON.parse(readFileSync(this.#pending(sessionId), 'utf8'));
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }

  /** Take the parked messages and clear the queue. */
  drain(sessionId) {
    const queue = this.parked(sessionId);
    if (queue.length) this.#drop(this.#pending(sessionId));
    return queue;
  }

  /** Sessions whose claims have just been released, so the daemon can drain them. */
  releasedWithPending() {
    if (!this.dir || !existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.pending.json'))
      .map((f) => f.replace('.pending.json', ''))
      .filter((id) => !this.isClaimed(id));
  }
}
