/**
 * Ownership follows whoever spoke last.
 *
 * Handing a conversation over used to mean running a command. That is a reasonable
 * price for a rare, deliberate act and an unreasonable one for switching between
 * Telegram and the web UI mid-thought, which is the thing that actually happens. So
 * the daemon infers the handover instead.
 *
 * What it is defending against is narrower than it looks. Two writes in sequence are
 * safe: a web resume after an external append continues from the true tail and rewinds
 * nothing. The hazard is two LIVE AGENTS on one session at once, and the daemon keeps
 * its agent in memory for hours after answering, so typing in the web UI while it still
 * holds that chat is exactly that state. Everything below exists to make sure only one
 * agent is alive on a session at a time.
 *
 * The rule, and nothing more elaborate than the rule:
 *
 *   1. Someone else wrote to the session      -> the daemon drops its agent at once and
 *                                                claims the session for "the web UI (auto)",
 *                                                so parking, replay and `dsh-handoff.sh
 *                                                status` all keep working unchanged.
 *   2. A Telegram message arrives, nothing running -> Telegram wins immediately. The
 *                                                auto-claim is released, anything parked is
 *                                                replayed in order, then the new message.
 *                                                His message IS the signal to switch; making
 *                                                him wait for a timer would defeat the point.
 *   3. A Telegram message arrives mid-turn    -> park it, say why, replay when the turn ends.
 *                                                A running turn is never interrupted.
 *   4. A MANUAL claim                         -> never auto-released. Explicit beats inferred.
 *
 * Two details are load-bearing. The daemon must not detect its own writes, or it hands
 * the chat to nobody: every event it writes passes through `noteEvent`, so the highest
 * sequence number it has seen is the line between "we wrote that" and "someone else
 * did". And a turn that started long ago and never ended is a crashed process, not a
 * running turn: waiting on one would park his messages forever, so a turn counts as
 * running only while the log is still being written to.
 *
 * @module dsh-telegram-inbox/autoHandoff
 */

/** The suffix that marks a claim the daemon made for itself rather than one a person made. */
export const AUTO_MARKER = '(auto)';
export const AUTO_OWNER = `the web UI ${AUTO_MARKER}`;

export const DEFAULT_STALE_TURN_MS = 15 * 60 * 1000;

/** Whether a claim was inferred by the daemon. Anything else is somebody's explicit choice. */
export function isAutoClaim(claim) {
  return typeof claim?.owner === 'string' && claim.owner.endsWith(AUTO_MARKER);
}

export class AutoHandoff {
  /**
   * @param {{
   *   handoff: object,
   *   logs: {revision: Function, tail: Function},
   *   liveSessions?: () => string[],
   *   dropAgent?: (sessionId: string) => Promise<boolean>,
   *   deliver?: (sessionId: string, message: object) => Promise<void>,
   *   enabled?: boolean, quietMs?: number, staleTurnMs?: number,
   *   now?: () => number, log?: object,
   * }} deps
   */
  constructor(deps) {
    this.handoff = deps.handoff;
    this.logs = deps.logs;
    this.liveSessions = deps.liveSessions ?? (() => []);
    this.dropAgent = deps.dropAgent ?? (async () => false);
    this.deliver = deps.deliver ?? (async () => {});
    this.enabled = deps.enabled !== false;
    this.quietMs = Number(deps.quietMs ?? 0);
    this.staleTurnMs = Number(deps.staleTurnMs ?? DEFAULT_STALE_TURN_MS);
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? { error() {}, info() {}, warn() {}, debug() {} };
    /** sessionId -> {revision, seq, turnRunning, foreignAt, tail, tailRev} */
    this.state = new Map();
  }

  #stateOf(sessionId) {
    let s = this.state.get(sessionId);
    if (!s) {
      s = { revision: undefined, seq: -1, turnRunning: false, foreignAt: 0, tail: undefined, tailRev: undefined };
      this.state.set(sessionId, s);
    }
    return s;
  }

  /**
   * A session's log tail, decoded at most once per revision of that log.
   *
   * `#reclaim` asks for this on every poll for as long as a message sits parked, and a
   * decode per poll is exactly the cost this module exists to avoid. So the cheap signal
   * gates the expensive one here too: a log that has not changed cannot have grown a
   * different tail than the one already read.
   */
  async #tail(sessionId, known) {
    const st = this.#stateOf(sessionId);
    const revision = known === undefined ? await this.logs.revision(sessionId) : known;
    if (revision !== null && revision === st.tailRev && st.tail !== undefined) return st.tail;
    st.tail = await this.logs.tail(sessionId);
    st.tailRev = revision;
    return st.tail;
  }

  /** Is any of this switched on? Without a handoff directory there is nowhere to record a claim. */
  get active() { return this.enabled && Boolean(this.handoff?.dir); }

  /**
   * Take a baseline for a session the daemon has just taken an agent for.
   *
   * Both halves of the baseline come from one read on purpose. Resuming a session can
   * append events the daemon never observes as events (the closers persistence writes
   * for an interrupted turn, for one), and without reading the stored tail here those
   * would look like somebody else's writing on the very next poll.
   */
  async watch(sessionId) {
    if (!this.active) return;
    const st = this.#stateOf(sessionId);
    const revision = await this.logs.revision(sessionId);
    const tail = await this.#tail(sessionId, revision);
    if (tail && tail.seq > st.seq) st.seq = tail.seq;
    st.revision = revision ?? undefined;
    st.turnRunning = false;
  }

  /** Every event the daemon writes passes through here: this is how it recognises itself. */
  noteEvent(sessionId, event) {
    if (!this.active) return;
    const st = this.#stateOf(sessionId);
    if (typeof event?.seq === 'number' && event.seq > st.seq) st.seq = event.seq;
    if (event?.type === 'turn/start') st.turnRunning = true;
    else if (event?.type === 'turn/end') st.turnRunning = false;
  }

  /** Forget a session the daemon no longer holds. */
  forget(sessionId) { this.state.delete(sessionId); }

  /**
   * One pass of everything the daemon owes a claimed session, in the only order that
   * works: notice the handover, honour it, then take the session back when the other
   * side has finished and something is waiting.
   */
  async service() {
    if (!this.handoff?.dir) return;
    if (this.enabled) await this.#detect();
    await this.#honourClaims();
    if (this.enabled) await this.#reclaim();
    await this.#replayReleased();
  }

  /**
   * Rule 1. A write the daemon did not make means the other side is live on this
   * session, so it lets go before the two agents can collide.
   */
  async #detect() {
    const watched = this.#watched();
    // What is neither held here nor handed over is dead weight; a daemon that runs for
    // weeks sees a lot of chats come and go.
    for (const id of [...this.state.keys()]) if (!watched.has(id)) this.state.delete(id);

    for (const sessionId of watched) {
      const st = this.#stateOf(sessionId);
      const claim = this.handoff.claimOf(sessionId);
      if (claim && !isAutoClaim(claim)) continue;        // rule 4: not the daemon's business

      const revision = await this.logs.revision(sessionId);
      if (revision === null || revision === st.revision) continue;   // nothing was written
      const first = st.revision === undefined;
      st.revision = revision;

      // Already handed over: every write is theirs by definition, so the only thing worth
      // recording is that they are still active (which is what `quietMs` waits out).
      if (claim) { st.foreignAt = this.now(); continue; }

      if (first) continue;              // the first sighting is a baseline, not a change
      if (st.turnRunning) continue;     // the daemon's own turn is the writer

      const tail = await this.#tail(sessionId, revision);
      if (!tail || tail.seq <= st.seq) continue;   // a sequence we have already written is ours

      st.seq = tail.seq;
      st.foreignAt = this.now();
      this.handoff.claim(sessionId, AUTO_OWNER);
      this.log.info(`${sessionId} was written from elsewhere: handing it to ${AUTO_OWNER}`);
    }
  }

  /** Sessions worth watching: the ones held here, plus the ones already handed over. */
  #watched() {
    const ids = new Set(this.liveSessions());
    for (const claim of this.handoff.claims()) if (isAutoClaim(claim)) ids.add(claim.sessionId);
    return ids;
  }

  /**
   * A claimed session must lose its daemon-side agent. An agent holding the session
   * writes to its log the moment anything wakes it, which is exactly the second writer
   * the claim exists to prevent. Then the claim is stamped, so a client waiting to open
   * the session learns the daemon has let go instead of guessing from a timer.
   */
  async #honourClaims() {
    for (const claim of this.handoff.claims()) {
      if (await this.dropAgent(claim.sessionId)) {
        this.log.info(`releasing ${claim.sessionId} to ${claim.owner}`);
      }
      // Stamped whether or not we held it: "nothing to release" is still a handover.
      if (!claim.ackedAt) this.handoff.ack(claim.sessionId);
    }
  }

  /**
   * The tail of rule 3. A message parked because a turn was running has to be answered
   * when that turn ends, and the only thing that would otherwise wake it is another
   * Telegram message, which is precisely the person we already told to wait.
   */
  async #reclaim() {
    for (const claim of this.handoff.claims()) {
      if (!isAutoClaim(claim)) continue;                       // rule 4
      const waiting = this.handoff.parked(claim.sessionId).length;
      if (!waiting) continue;                                  // nothing waiting: leave them to it
      if (await this.#turnRunning(claim.sessionId)) continue;
      if (!(await this.#quietEnough(claim.sessionId))) continue;
      this.handoff.release(claim.sessionId);
      this.#stateOf(claim.sessionId).revision = undefined;
      this.log.info(`${claim.owner} has finished: taking ${claim.sessionId} back for ${waiting} parked message(s)`);
      await this.#replay(claim.sessionId);
    }
  }

  /** Sessions handed back by a person, with something waiting. Unchanged behaviour. */
  async #replayReleased() {
    for (const sessionId of this.handoff.releasedWithPending()) await this.#replay(sessionId);
  }

  async #replay(sessionId) {
    const queue = this.handoff.drain(sessionId);
    if (!queue.length) return;
    this.log.info(`replaying ${queue.length} parked message(s) for ${sessionId}`);
    for (const message of queue) {
      try { await this.deliver(sessionId, message); }
      catch (e) { this.log.error(`replaying a parked message for ${sessionId}: ${e?.message ?? e}`); }
    }
  }

  /**
   * What to do with a message that has just arrived.
   *
   * Returns `{delivered}` or `{parked, reason, owner}`. The caller says the parking out
   * loud, because a message that is silently held is indistinguishable from one that was
   * dropped.
   */
  async admit(sessionId, message) {
    const claim = this.handoff.claimOf(sessionId);

    if (!this.active) {
      // Exactly the behaviour before any of this existed. Reading a log to answer a
      // question nothing here can act on would be cost for nothing.
      if (claim) return this.#park(sessionId, message, 'claimed', claim.owner);
      await this.deliver(sessionId, message);
      return { delivered: true };
    }

    if (claim && !isAutoClaim(claim)) return this.#park(sessionId, message, 'claimed', claim.owner);   // rule 4

    // A session the daemon still holds has no second agent on it, so a turn running there
    // is its own: the harness queues the message for the next turn, which is what it is for.
    if (!this.liveSessions().includes(sessionId) && await this.#turnRunning(sessionId)) {
      // Claim it on the way in, even when detection had not noticed yet. A parked message
      // with no claim over it is picked up by the released-with-pending path on the very
      // next poll, which would walk it straight back into the turn we just declined to
      // interrupt. The claim is what makes "queued" mean queued.
      if (!claim) {
        this.handoff.claim(sessionId, AUTO_OWNER);
        this.#stateOf(sessionId).foreignAt = this.now();
        this.log.info(`${sessionId} has a turn running elsewhere: holding it for ${AUTO_OWNER}`);
      }
      return this.#park(sessionId, message, 'turn', claim?.owner ?? AUTO_OWNER);   // rule 3
    }

    if (claim) {
      if (!(await this.#quietEnough(sessionId))) return this.#park(sessionId, message, 'busy', claim.owner);
      // Rule 2. Park first and drain immediately after, so the new message lands behind
      // whatever was already waiting instead of jumping the queue, and so a crash between
      // the two leaves it on disk rather than losing it.
      this.handoff.release(sessionId);
      this.#stateOf(sessionId).revision = undefined;
      this.log.info(`Telegram spoke last: taking ${sessionId} back from ${claim.owner}`);
      this.handoff.park(sessionId, message);
      await this.#replay(sessionId);
      return { delivered: true, tookBack: true };
    }

    await this.deliver(sessionId, message);
    return { delivered: true };
  }

  #park(sessionId, message, reason, owner) {
    this.handoff.park(sessionId, message);
    this.log.info(`parked a message for ${sessionId}: ${reason}${owner ? ` (${owner})` : ''}`);
    return { parked: true, reason, owner };
  }

  /**
   * Is somebody else's turn running on this session right now?
   *
   * The staleness test is the whole reason this is not just "is a turn open": a process
   * that died between `turn/start` and `turn/end` leaves an open turn in the log forever,
   * and treating that as running would park every future message with no one to answer it.
   */
  async #turnRunning(sessionId) {
    const tail = await this.#tail(sessionId);
    if (!tail?.turnOpen) return false;
    return this.now() - Number(tail.time ?? 0) <= this.staleTurnMs;
  }

  /** Has the other side been silent long enough? With `quietMs` at 0 the answer is always yes. */
  async #quietEnough(sessionId) {
    if (this.quietMs <= 0) return true;
    const st = this.#stateOf(sessionId);
    const revision = await this.logs.revision(sessionId);
    if (revision !== null && revision !== st.revision) { st.revision = revision; st.foreignAt = this.now(); }
    return this.now() - st.foreignAt >= this.quietMs;
  }
}
