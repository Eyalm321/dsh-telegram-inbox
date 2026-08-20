/**
 * Splitting a reply into Telegram-sized messages.
 *
 * Telegram's hard limit is 4096 characters. Splitting matters more than it looks:
 * an agent reply is usually markdown, and a cut in the middle of a fenced code
 * block turns the remainder of the message into prose in the reader's client.
 *
 * @module dsh-telegram-inbox/chunk
 */

export const TELEGRAM_LIMIT = 4096;

/** Prefer a paragraph break, then a line break, then a space, then a hard cut. */
function breakPoint(text, limit) {
  for (const sep of ['\n\n', '\n', ' ']) {
    const at = text.lastIndexOf(sep, limit);
    // Refuse a break that wastes more than half the message; a hard cut is better
    // than emitting a stream of nearly empty messages.
    if (at > limit * 0.5) return { cut: at, skip: sep.length };
  }
  return { cut: limit, skip: 0 };
}

/**
 * Split `text` into chunks that fit Telegram, reopening an unbalanced code fence
 * so a split reply still renders as code on both sides of the break.
 */
export function splitMessage(text, limit = 3900) {
  const body = String(text ?? '').trim();
  if (!body) return [];
  if (body.length <= limit) return [body];

  const chunks = [];
  let rest = body;
  let fence = null; // the language tag of a fence left open by the previous chunk

  while (rest.length > limit) {
    const { cut, skip } = breakPoint(rest, limit);
    let piece = rest.slice(0, cut);
    if (fence !== null) piece = '```' + fence + '\n' + piece;

    const open = openFence(piece);
    if (open !== null) piece += '\n```';
    fence = open;

    chunks.push(piece);
    rest = rest.slice(cut + skip).replace(/^\s+/, '');
  }
  if (rest) chunks.push(fence !== null ? '```' + fence + '\n' + rest : rest);
  return chunks;
}

/**
 * The language tag of a code fence left open at the end of `text`, or null when
 * every fence is closed. An odd number of fences means one is still open.
 */
export function openFence(text) {
  const fences = text.match(/^```[^\n]*$/gm);
  if (!fences || fences.length % 2 === 0) return null;
  return fences[fences.length - 1].slice(3).trim();
}
