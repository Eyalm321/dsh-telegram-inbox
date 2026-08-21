/**
 * Drop superseded runtime-context snapshots from a resumed session's surface.
 *
 * Why this exists: `dsh-system-prompt` injects a "Current runtime context" snapshot as a
 * durable `user/message`, describing things like the file-sandbox policy. The loop keeps
 * one *retained* snapshot and re-emits only when the text changes — but every earlier
 * snapshot stays in the transcript. On resume the model therefore reads facts that were
 * true in some previous process.
 *
 * Observed: a chat session resumed carrying `file policy: workspace-write` recorded when
 * the harness had been started without `DSH_PERMISSION_MODE`. The policy was by then
 * `danger-full-access`, but the agent believed the stale line and spent its turn routing
 * around a read-only filesystem that no longer existed.
 *
 * The fix uses the surface-replacement mechanism the compaction plugins already use: the
 * original event stays in the append-only log, only the model-facing surface changes.
 * Replacing every snapshot (not all-but-one) is deliberate — `RuntimeContextProjection`
 * clears its retained pointer when a replacement cites it, so the next request emits a
 * fresh snapshot describing the process that is actually running.
 *
 * @module dsh-headless-resume/staleContext
 */

/** The plugin whose `user/message` events are runtime-context snapshots. */
export const CONTEXT_SOURCE = '@deepseek-ai/dsh-system-prompt';

export const MARKER =
  '(A runtime-context snapshot from an earlier process was omitted on resume. ' +
  'The current snapshot supersedes it.)';

/** True when this event is a runtime-context snapshot emitted by the system-prompt plugin. */
export function isContextSnapshot(event) {
  return event?.type === 'user/message'
    && event.data?.source?.kind === 'plugin'
    && event.data.source.plugin === CONTEXT_SOURCE;
}

/**
 * Replace every runtime-context snapshot currently on the surface.
 *
 * @param {object} session - the live session, after resume
 * @param {{log?: object, marker?: string}} [opts]
 * @returns {{replaced: number[], skipped: string|null}} seqs replaced, or why nothing happened
 */
export function pruneStaleContext(session, opts = {}) {
  const log = opts.log ?? { debug() {}, warn() {}, info() {} };
  const marker = opts.marker ?? MARKER;

  const nodes = session?.surface?.nodes;
  const events = session?.events;
  if (!Array.isArray(events) || !nodes) {
    // A harness that changes this shape should degrade to "no pruning", never to a
    // failed resume: a stale snapshot is a nuisance, a lost session is not.
    return { replaced: [], skipped: 'session surface unavailable' };
  }
  const onSurface = new Set(nodes);
  const stale = events.filter((e) => onSurface.has(e.seq) && isContextSnapshot(e));
  if (stale.length === 0) return { replaced: [], skipped: null };

  const replaced = [];
  for (const event of stale) {
    try {
      session.append(
        'user/message',
        { ...event.data, content: [{ type: 'text', text: marker }] },
        { surfaceOp: { op: 'replace', start: event.seq, end: event.seq }, sourceEventSeqs: [event.seq] },
      );
      replaced.push(event.seq);
    } catch (e) {
      log.warn(`could not replace runtime-context snapshot at seq ${event.seq}: ${e?.message ?? e}`);
    }
  }
  if (replaced.length) log.info(`pruned ${replaced.length} stale runtime-context snapshot(s) on resume`);
  return { replaced, skipped: null };
}
