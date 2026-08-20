/**
 * Who may talk to the bot, and what happens when someone else tries.
 *
 * This agent has full shell access, so the allow-list is a security boundary
 * rather than a convenience. Two decisions follow from that:
 *
 *  - **Fail closed.** An empty list admits NOBODY. The plugin this replaces
 *    treated empty as "allow everyone", which turns a missing config line into
 *    an open shell.
 *  - **Alert, but at most once per stranger per window.** The attempt is worth
 *    knowing about; letting a stranger generate unlimited notifications to the
 *    owner turns the alert into the attack.
 *
 * @module dsh-telegram-inbox/allowlist
 */

export class AllowList {
  /**
   * @param {Array<number|string>} ids - user ids permitted to talk to the bot
   * @param {{alertWindowMs?: number, now?: () => number}} [opts]
   */
  constructor(ids, opts = {}) {
    this.ids = new Set((ids ?? []).map(Number).filter(Number.isFinite));
    this.alertWindowMs = opts.alertWindowMs ?? 3600_000;
    this.now = opts.now ?? (() => Date.now());
    this.lastAlert = new Map();
  }

  /** True when the list admits nobody — worth saying out loud at startup. */
  get isEmpty() { return this.ids.size === 0; }

  /** Owners to notify about an intrusion: everyone on the list. */
  get owners() { return [...this.ids]; }

  admits(userId) {
    return this.ids.has(Number(userId));
  }

  /**
   * Whether an intrusion by `userId` should raise an alert now. Records the
   * decision, so calling it twice in a window answers true then false.
   */
  shouldAlert(userId) {
    const key = Number(userId);
    const at = this.now();
    const prev = this.lastAlert.get(key);
    if (prev !== undefined && at - prev < this.alertWindowMs) return false;
    this.lastAlert.set(key, at);
    return true;
  }
}

/** A one-line description of an intruder, safe to send to the owner. */
export function describeIntruder(msg, text) {
  const from = msg?.from ?? {};
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'unknown';
  const handle = from.username ? `@${from.username}` : 'no username';
  const excerpt = String(text ?? '').slice(0, 200);
  return [
    'Blocked a message from someone not on the allow-list.',
    `id: ${from.id ?? '?'}`,
    `name: ${name} (${handle})`,
    `chat: ${msg?.chat?.id ?? '?'}`,
    `text: ${excerpt}`,
  ].join('\n');
}
