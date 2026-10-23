/**
 * Read a live session's durable events on either harness line.
 *
 * dsh 0.1.x exposed the log as the `session.events` array. dsh 0.2.x removed that getter:
 * `session.events` is undefined there, so `for (const e of session.events)` throws
 * "events is not iterable" and every `Array.isArray(session.events)` guard quietly turns
 * its feature off. The same frozen snapshot is now `session.snapshotEvents()`.
 *
 * @module dsh-headless-resume/sessionEvents
 */

/**
 * Every event in the session's log, oldest first, or undefined when the session
 * offers neither shape.
 *
 * @param {object} session - a live session
 * @returns {readonly object[]|undefined}
 */
export function sessionEvents(session) {
  if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents();
  if (Array.isArray(session?.events)) return session.events;
  return undefined;
}
