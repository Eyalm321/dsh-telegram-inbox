/**
 * Levelled logging.
 *
 * The plugin this replaces logged every session event unconditionally, behind a
 * comment marking it as debug output from a day of firefighting. In practice that
 * meant a journal of `assistant/chunk` lines with the real events buried. Here the
 * per-event firehose sits behind `debug`, which is off unless asked for.
 *
 * @module dsh-telegram-inbox/log
 */
const ORDER = { error: 0, warn: 1, info: 2, debug: 3 };

export function createLogger(name, level = 'info', sink = console.error) {
  const threshold = ORDER[level] ?? ORDER.info;
  const emit = (lvl, msg) => {
    if ((ORDER[lvl] ?? 9) > threshold) return;
    sink(`[${name}] ${lvl === 'info' ? '' : lvl + ': '}${msg}`);
  };
  const log = (lvl, msg) => emit(lvl, msg);
  log.error = (m) => emit('error', m);
  log.warn = (m) => emit('warn', m);
  log.info = (m) => emit('info', m);
  log.debug = (m) => emit('debug', m);
  log.level = level;
  return log;
}
