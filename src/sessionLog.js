/**
 * What a session log says about itself, read as cheaply as the question allows.
 *
 * The daemon has to answer two questions about a session it may not own: "has anything
 * been written to it since I last looked?" and "is a turn running on it right now?".
 * Those cost wildly different amounts, and that difference is the whole design here.
 *
 * A log is an append-only file of concatenated Zstandard frames. The first question is
 * one `stat`: if nothing has been appended, no amount of decoding would say otherwise.
 * The second means decoding, because a turn is open when the most recent `turn/start`
 * has no `turn/end` after it, and mid-turn the final row is a chunk, not a boundary
 * marker, so "read the last line" does not answer it on its own. So the poll runs on
 * the stat and the decode happens only when it would change a decision. On a
 * conversation of a few thousand lines that is the difference between a free check
 * every 25 seconds and one that is very much not.
 *
 * The cheap signal is the harness's own `readStoredRevision`, which is documented as
 * reading "one log's stat-derived revision without loading its event bytes". It is the
 * mtime *plus* size, inode and ctime, which is strictly better than mtime alone (an
 * append landing inside a single filesystem timestamp tick still changes the size),
 * and it needs no guess about where the backend put the file.
 *
 * @module dsh-telegram-inbox/sessionLog
 */

/** Storage rows the persistence layer writes as one packed run of chunk deltas. */
const PACKED = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks']);

/**
 * The sequence number of the last event a row stands for.
 * A packed run carries the run's first seq and one inter-arrival gap per extra member,
 * so its last member is `seq0 + dt.length`.
 */
export function rowSeq(row) {
  if (typeof row?.seq === 'number') return row.seq;
  if (typeof row?.seq0 === 'number') return row.seq0 + gaps(row).length;
  return null;
}

/** The timestamp of the last event a row stands for, by the same reasoning. */
export function rowTime(row) {
  if (typeof row?.time === 'number') return row.time;
  if (typeof row?.time0 === 'number') return row.time0 + gaps(row).reduce((a, b) => a + b, 0);
  return null;
}

function gaps(row) {
  return PACKED.has(row?.type) && Array.isArray(row?.data?.dt) ? row.data.dt : [];
}

/**
 * Read the tail state out of a log's raw JSONL text.
 * Walks backwards: the last row gives the sequence and the moment of the last write,
 * and the walk continues only as far as the nearest turn boundary.
 */
export function readTailText(text) {
  const lines = String(text ?? '').split('\n');
  let seq = null;
  let time = null;
  let turnOpen = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (seq === null) { seq = rowSeq(row); time = rowTime(row); }
    if (row?.type === 'turn/start') { turnOpen = true; break; }
    if (row?.type === 'turn/end') { turnOpen = false; break; }
    if (row?.type === 'session') break;   // reached the header: no turn has ever started
  }
  return seq === null ? null : { seq, time: time ?? 0, turnOpen };
}

/** The same walk over already-decoded events, for a backend with no raw artifact. */
export function readTailEvents(events) {
  const list = Array.isArray(events) ? events : [];
  let seq = null;
  let time = null;
  let turnOpen = false;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (seq === null) { seq = typeof e?.seq === 'number' ? e.seq : null; time = e?.time ?? 0; }
    if (e?.type === 'turn/start') { turnOpen = true; break; }
    if (e?.type === 'turn/end') { turnOpen = false; break; }
  }
  return seq === null ? null : { seq, time: time ?? 0, turnOpen };
}

export class SessionLog {
  /**
   * @param {{persistence: object|(() => object|undefined), log?: object}} deps
   *   `persistence` may be a getter, because the service is composed after this module
   *   is constructed and resolving it once at construction would capture `undefined`.
   */
  constructor(deps = {}) {
    this.persistence = deps.persistence ?? (() => undefined);
    this.log = deps.log ?? { warn() {}, debug() {} };
  }

  #svc() {
    const p = this.persistence;
    return typeof p === 'function' ? p() : p;
  }

  /**
   * A token that changes whenever this log changes, or null when there is nothing
   * stored yet. One stat; safe to call on every poll.
   */
  async revision(sessionId) {
    const svc = this.#svc();
    if (!svc?.readStoredRevision) return null;
    try {
      return (await svc.readStoredRevision(sessionId)) ?? null;
    } catch (e) {
      // A log we cannot stat is one we cannot reason about; treating that as "unchanged"
      // keeps the daemon where it already is rather than handing the chat to nobody.
      this.log.warn(`could not read the revision of ${sessionId}: ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * `{seq, time, turnOpen}` for a stored session, or null when there is none.
   * Decodes the log: call it when the answer decides something, not on a timer.
   */
  async tail(sessionId) {
    const svc = this.#svc();
    if (!svc) return null;
    try {
      if (svc.supportsRawArtifacts && svc.readRaw) {
        const raw = await svc.readRaw(sessionId);
        return raw ? readTailText(raw.content) : null;
      }
      const seen = await svc.inspect?.(sessionId);
      return seen ? readTailEvents(seen.events) : null;
    } catch (e) {
      this.log.warn(`could not read the tail of ${sessionId}: ${e?.message ?? e}`);
      return null;
    }
  }
}
