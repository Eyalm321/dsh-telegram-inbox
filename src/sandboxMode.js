/**
 * Bring a resumed session's sandbox mode in line with the operator's stated default.
 *
 * A session records its permission preset and sandbox mode at creation, and
 * `dsh-sandbox-policy` resolves each call as
 * `explicit grant ?? fold(session events) ?? deployment default`. The session's own
 * events therefore OUTRANK the deployment default — by design, so an in-session
 * override survives a restart.
 *
 * The consequence is easy to misread: a session created while `DSH_PERMISSION_MODE`
 * was unset is permanently `workspace-write`, and resuming it keeps that mode however
 * the harness is configured now. Observed live — a chat created during an early probe
 * run kept reporting a read-only filesystem long after the deployment had moved to
 * `danger-full-access`, and the agent dutifully worked around a restriction that
 * applied to nothing else on the machine.
 *
 * Alignment runs ONLY when the operator set `DSH_PERMISSION_MODE` explicitly. Without
 * that statement of intent, a session's own recorded mode is left exactly as it is:
 * silently re-privileging sessions from an ambient default is not a decision a resume
 * helper should make.
 *
 * @module dsh-headless-resume/sandboxMode
 */

export const MODES = ['read-only', 'workspace-write', 'danger-full-access'];

/** The mode a session currently resolves to from its own events, or undefined. */
export function foldSessionMode(session) {
  const events = session?.events;
  if (!Array.isArray(events)) return undefined;
  let mode;
  for (const event of events) {
    if (event?.type === 'sandbox/mode' && typeof event.data?.mode === 'string') mode = event.data.mode;
  }
  return mode;
}

/**
 * Append the runtime switch when the session disagrees with `desired`.
 *
 * @param {object} session - the live session, after resume
 * @param {string|undefined} desired - the deployment default (usually $DSH_PERMISSION_MODE)
 * @param {{log?: object}} [opts]
 * @returns {{changed: boolean, from?: string, to?: string, skipped?: string}}
 */
export function alignSandboxMode(session, desired, opts = {}) {
  const log = opts.log ?? { info() {}, warn() {}, debug() {} };
  if (!desired) return { changed: false, skipped: 'no explicit deployment mode' };
  if (!MODES.includes(desired)) return { changed: false, skipped: `unknown mode ${desired}` };
  if (typeof session?.append !== 'function') return { changed: false, skipped: 'session unavailable' };

  const current = foldSessionMode(session);
  if (current === undefined) return { changed: false, skipped: 'session records no mode' };
  if (current === desired) return { changed: false };

  try {
    // Both events, so the approval policy stays coherent with the sandbox mode; the
    // docs describe this as a log-only switch, so neither carries a surfaceOp.
    session.append('permission/preset', { preset: desired });
    session.append('sandbox/mode', { mode: desired });
  } catch (e) {
    log.warn(`could not align sandbox mode to ${desired}: ${e?.message ?? e}`);
    return { changed: false, skipped: String(e?.message ?? e) };
  }
  log.info(`sandbox mode realigned on resume: ${current} -> ${desired}`);
  return { changed: true, from: current, to: desired };
}
