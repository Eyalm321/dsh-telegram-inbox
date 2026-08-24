/**
 * Turning an inbound Telegram message into text, images and video frames the agent
 * can actually use.
 *
 * Before this existed the plugin accepted text and voice and returned early on everything
 * else — so a batch of screenshots with a caption vanished with no reply and no log line.
 * Worse, the cursor marks a message handled before processing (so one bad message cannot
 * wedge the poller), which means a silently dropped message is not retried either. Silence
 * was the worst possible behaviour: the sender has no idea it went nowhere.
 *
 * Video used to be on the unsupported list, which was the same bug wearing a different hat:
 * two videos and two images were sent, two images arrived, nothing was logged or said, and
 * the turn contained no evidence that half the message was missing, so the agent answered
 * as though it had seen all four. Anything this module cannot read must now say so IN THE
 * TURN, not only in the chat, because the model's only source of truth about what it was
 * given is the content it was given.
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

/**
 * The same idea for video, one level up: frames are cheap individually and ruinous in bulk.
 * A message may contribute at most this many frames in total however many clips it carries,
 * and the attached bytes of one message (photos and frames together) are capped as well,
 * because "12 images" and "12 images at 4 MB each" are very different turns.
 */
export const MAX_VIDEOS_PER_MESSAGE = 4;
export const MAX_FRAMES_PER_MESSAGE = 12;
export const MAX_ATTACHED_BYTES = 24 * 1024 * 1024;

/**
 * Telegram's Bot API will not serve a file larger than this through getFile, whatever the
 * bot's own limits are and however many times it is retried. It is a server-side refusal,
 * so the only correct response is to say so immediately rather than to attempt a download
 * that cannot succeed.
 */
export const TELEGRAM_FILE_LIMIT_BYTES = 20 * 1024 * 1024;
export const TELEGRAM_FILE_LIMIT_MB = Math.round(TELEGRAM_FILE_LIMIT_BYTES / 1048576);

/** Telegram media types worth trying to read, in the order we prefer them. */
export const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Kinds that carry something to look at. */
export const VISUAL_KINDS = new Set(['photo', 'video', 'media']);

/**
 * The video-shaped fields of a message.
 *
 * Four shapes, all of them ordinary things a phone sends: `video` is a normal clip,
 * `animation` is what Telegram calls a GIF (it is really a silent mp4), `video_note` is the
 * round bubble recorded in-app, and a clip sent "as a file" arrives as a `document` whose
 * mime type happens to start with `video/`. Missing any one of them puts the message back
 * on the silent-drop path this module exists to close.
 */
export function videoOf(msg) {
  if (msg?.video) return { media: msg.video, source: 'video' };
  if (msg?.animation) return { media: msg.animation, source: 'animation' };
  if (msg?.video_note) return { media: msg.video_note, source: 'video_note' };
  if (msg?.document && String(msg.document.mime_type ?? '').startsWith('video/')) {
    return { media: msg.document, source: 'document' };
  }
  return null;
}

const DEFAULT_VIDEO_NAME = {
  video: 'video.mp4',
  animation: 'animation.mp4',
  video_note: 'video-note.mp4',
  document: 'video',
};

/** Normalise one Telegram video object into what the rest of the plugin needs. */
export function describeVideo(media, source, index = 0) {
  const stated = Number(media?.file_size);
  const duration = Number(media?.duration);
  const suffix = index > 0 ? `-${index + 1}` : '';
  const fallback = DEFAULT_VIDEO_NAME[source] ?? 'video.mp4';
  const name = media?.file_name
    || (suffix ? fallback.replace(/(\.[^.]+)?$/, (ext) => `${suffix}${ext || ''}`) : fallback);
  return {
    fileId: media?.file_id,
    source,
    name,
    mediaType: media?.mime_type || 'video/mp4',
    fileSize: Number.isFinite(stated) && stated > 0 ? stated : null,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}

/**
 * Whether Telegram will refuse to serve this file at all.
 *
 * Only answers true when the size is actually known. An unknown size is not an excuse to
 * refuse in advance: the download either works or fails, and a failed download reports
 * itself.
 */
export function tooLargeToFetch(video, limit = TELEGRAM_FILE_LIMIT_BYTES) {
  return Number.isFinite(video?.fileSize) && video.fileSize > limit;
}

/** "23.4 MB": sizes belong in the refusal, so "too big" is checkable rather than a claim. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size';
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/**
 * What a message contains, as far as this plugin is concerned.
 * Returns `{ kind, text, photos, videos, unsupported, dropped, droppedVideos }`.
 *
 * `kind` is `media` when the message carries both pictures and clips. A mixed album is one
 * message and must produce one turn holding both, not a turn holding whichever kind was
 * checked for first.
 */
export function classify(msg) {
  const caption = (msg?.caption ?? '').trim();
  const text = (msg?.text ?? '').trim();

  if (msg?.voice || msg?.audio) return { kind: 'voice', text, photos: [], videos: [] };

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

  const videos = [];
  if (Array.isArray(msg?.videos) && msg.videos.length) {
    // A reassembled album carries its clips already tagged with which field they came from.
    msg.videos.forEach((v, i) => {
      const described = describeVideo(v?.media, v?.source ?? 'video', i);
      if (described.fileId) videos.push(described);
    });
  } else {
    const single = videoOf(msg);
    if (single) {
      const described = describeVideo(single.media, single.source);
      if (described.fileId) videos.push(described);
    }
  }

  if (photos.length || videos.length) {
    // Truncate rather than refuse: nine of twelve pictures plus the caption is far more
    // useful than an error, and the note tells the model what it is not seeing.
    const dropped = Math.max(0, photos.length - MAX_IMAGES_PER_MESSAGE);
    const droppedVideos = Math.max(0, videos.length - MAX_VIDEOS_PER_MESSAGE);
    const keptPhotos = photos.slice(0, MAX_IMAGES_PER_MESSAGE);
    const keptVideos = videos.slice(0, MAX_VIDEOS_PER_MESSAGE);
    const kind = keptPhotos.length && keptVideos.length ? 'media' : (keptPhotos.length ? 'photo' : 'video');
    return { kind, text: caption, photos: keptPhotos, videos: keptVideos, dropped, droppedVideos };
  }

  if (text) return { kind: 'text', text, photos: [], videos: [] };

  // Everything else: stickers, locations, contacts, polls, non-image non-video documents.
  const unsupported = ['sticker', 'location', 'contact', 'poll', 'venue', 'dice', 'document']
    .find((k) => msg?.[k]) ?? 'this message type';
  return { kind: 'unsupported', text: caption, photos: [], videos: [], unsupported };
}

/**
 * The content blocks for an agent turn.
 *
 * A caption travels as text even when the images cannot be attached, because the caption is
 * usually the actual request — "why does this fail?" is useless as silence and still useful
 * without the screenshot.
 *
 * An attachment may be given either bare or wrapped as `{ attachment, label }`. A labelled
 * one gets a text block immediately before its image, which is what lets the model answer
 * "at 0:34" instead of "in one of the frames": the position is only knowable if it is
 * written next to the picture.
 */
export function buildContent({ text, attachments = [], note }) {
  const blocks = [];
  const lead = [text, note].filter(Boolean).join('\n\n');
  if (lead) blocks.push({ type: 'text', text: lead });
  for (const item of attachments) {
    const wrapped = item && typeof item === 'object' && 'attachment' in item;
    const attachment = wrapped ? item.attachment : item;
    const label = wrapped ? item.label : null;
    if (!attachment) continue;
    if (label) blocks.push({ type: 'text', text: `[${label}]` });
    blocks.push({ type: 'image', attachment });
  }
  if (!blocks.length) blocks.push({ type: 'text', text: '[empty message]' });
  return blocks;
}

/**
 * The note that goes INTO THE TURN for everything that was sent and not delivered.
 *
 * This is the half of the fix that matters most. A reply in the chat tells the sender; only
 * a line in the content tells the model, and a model with no line in its content has no way
 * to know it is answering about half a message. It is written as a flat statement of fact so
 * it cannot be read as an instruction.
 */
export function describeUnreadable(failures = []) {
  if (!failures.length) return '';
  const lines = failures.map((f) => `- ${f.name}: ${f.why}`);
  const what = failures.length === 1 ? 'One thing' : `${failures.length} things`;
  return `[${what} sent with this message could not be read and is NOT included below:\n${lines.join('\n')}]`;
}

/** The same list, phrased for the chat rather than for the turn. */
export function refusalReply(failures = []) {
  if (!failures.length) return '';
  const lines = failures.map((f) => `• ${f.name}: ${f.why}`);
  const head = failures.length === 1
    ? 'One part of that message did not reach me:'
    : `${failures.length} parts of that message did not reach me:`;
  return `${head}\n${lines.join('\n')}`;
}
