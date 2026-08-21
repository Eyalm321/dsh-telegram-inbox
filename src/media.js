/**
 * Turning an inbound Telegram message into text and images the agent can actually use.
 *
 * Before this existed the plugin accepted text and voice and returned early on everything
 * else — so a batch of screenshots with a caption vanished with no reply and no log line.
 * Worse, the cursor marks a message handled before processing (so one bad message cannot
 * wedge the poller), which means a silently dropped message is not retried either. Silence
 * was the worst possible behaviour: the sender has no idea it went nowhere.
 *
 * @module dsh-telegram-inbox/media
 */

/**
 * Bounds on what will be pulled into memory.
 *
 * Not chosen from a memory scare: measured, a typical album of 8 phone photos is under
 * 2 MB total and the daemon's footprint is dominated by the model client and MCP servers.
 * These exist for the pathological case — Telegram allows 10 MB per photo and far more as
 * a document, so an album of those is the only image path that could matter.
 */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 12;

/** Telegram media types worth trying to read, in the order we prefer them. */
export const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * What a message contains, as far as this plugin is concerned.
 * Returns `{ kind, text, photos, unsupported }`.
 */
export function classify(msg) {
  const caption = (msg?.caption ?? '').trim();
  const text = (msg?.text ?? '').trim();

  if (msg?.voice || msg?.audio) return { kind: 'voice', text, photos: [] };

  const photos = [];
  if (Array.isArray(msg?.photo) && msg.photo.length) {
    if (msg.album) {
      // A reassembled album: every entry is a DIFFERENT picture, already reduced to its
      // largest size by the merge. Taking only the last would silently discard the rest.
      msg.photo.forEach((p, i) => {
        if (p?.file_id) photos.push({ fileId: p.file_id, mediaType: 'image/jpeg', name: `photo-${i + 1}.jpg` });
      });
    } else {
      // A single photo: `photo` is the SAME image at several sizes, ascending. Take the last.
      const largest = msg.photo[msg.photo.length - 1];
      if (largest?.file_id) photos.push({ fileId: largest.file_id, mediaType: 'image/jpeg', name: 'photo.jpg' });
    }
  }
  // An image sent "as a file" arrives as a document, which keeps its real mime type.
  if (msg?.document && IMAGE_MIME.has(msg.document.mime_type)) {
    photos.push({
      fileId: msg.document.file_id,
      mediaType: msg.document.mime_type,
      name: msg.document.file_name || 'image',
    });
  }
  if (photos.length) {
    // Truncate rather than refuse: nine of twelve pictures plus the caption is far more
    // useful than an error, and the note tells the model what it is not seeing.
    const dropped = Math.max(0, photos.length - MAX_IMAGES_PER_MESSAGE);
    return { kind: 'photo', text: caption, photos: photos.slice(0, MAX_IMAGES_PER_MESSAGE), dropped };
  }

  if (text) return { kind: 'text', text, photos: [] };

  // Everything else: stickers, video, location, contacts, polls, non-image documents.
  const unsupported = ['video', 'sticker', 'animation', 'location', 'contact', 'poll', 'document']
    .find((k) => msg?.[k]) ?? 'this message type';
  return { kind: 'unsupported', text: caption, photos: [], unsupported };
}

/**
 * The content blocks for an agent turn.
 *
 * A caption travels as text even when the images cannot be attached, because the caption is
 * usually the actual request — "why does this fail?" is useless as silence and still useful
 * without the screenshot.
 */
export function buildContent({ text, attachments = [], note }) {
  const blocks = [];
  const lead = [text, note].filter(Boolean).join('\n\n');
  if (lead) blocks.push({ type: 'text', text: lead });
  for (const attachment of attachments) blocks.push({ type: 'image', attachment });
  if (!blocks.length) blocks.push({ type: 'text', text: '[empty message]' });
  return blocks;
}

/** Human-readable note for images that arrived but could not be attached. */
export function describeSkipped(count, why) {
  if (!count) return '';
  const s = count === 1 ? 'image' : `${count} images`;
  return `[${s} attached to this message could not be read: ${why}]`;
}
