/**
 * Making `/new` mean what it says.
 *
 * A chat's session id was derived from the chat id alone, so "start a new conversation"
 * dropped the in-memory agent and the next message resumed the very same session from
 * disk — history, backlog and all — while the bot replied "Started a new conversation."
 * A command that reports success and changes nothing is worse than one that fails.
 *
 * A generation counter per chat fixes it: resetting bumps the counter, which changes the
 * session id, so the next message starts genuinely fresh. The old session stays on disk,
 * because a reset should end a conversation, not destroy it.
 *
 * @module dsh-telegram-inbox/generations
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Generations {
  constructor(path, opts = {}) {
    this.path = path ?? null;
    this.log = opts.log ?? { warn() {} };
    this.map = this.#load();
  }

  #load() {
    if (!this.path) return {};
    try {
      const d = JSON.parse(readFileSync(this.path, 'utf8'));
      return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    } catch {
      return {};
    }
  }

  #save() {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.map));
      renameSync(tmp, this.path);
    } catch (e) {
      // A lost counter means the next reset reuses an id, not data loss — warn and continue.
      this.log.warn(`could not persist session generations: ${e?.message ?? e}`);
    }
  }

  get(chatKey) { return Number(this.map[chatKey] ?? 0); }

  /** Start a new generation for this chat and return it. */
  bump(chatKey) {
    const next = this.get(chatKey) + 1;
    this.map[chatKey] = next;
    this.#save();
    return next;
  }

  /**
   * The session id for a chat's current generation.
   * Generation 0 keeps the historical id, so existing conversations are not orphaned.
   */
  sessionId(prefix, chatKey) {
    const g = this.get(chatKey);
    return g === 0 ? `${prefix}-${chatKey}` : `${prefix}-${chatKey}-g${g}`;
  }
}
