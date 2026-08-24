/**
 * Committing what arrived in a message to the attachment service.
 *
 * Split out of the plugin body for one reason: this is where a message quietly loses half
 * of itself, and a function that only exists inside `apply()` can only be tested by
 * standing up a harness. The refusal paths (a file Telegram will not serve, an ffmpeg
 * that fell over, a budget already spent) are the paths that matter most and the ones
 * hardest to provoke against a live bot, so they are reachable here with no network at all.
 *
 * Every return carries `failures`. Nothing is allowed to disappear without an entry in it:
 * the caller puts that list into the turn AND into the chat, which is the whole fix.
 *
 * @module dsh-telegram-inbox/attach
 */
import {
  tooLargeToFetch, formatBytes,
  MAX_IMAGE_BYTES, MAX_ATTACHED_BYTES, MAX_FRAMES_PER_MESSAGE, TELEGRAM_FILE_LIMIT_MB,
} from './media.js';
import { formatPosition, VIDEO_FRAMES_DEFAULT } from './video.js';

/**
 * @param {{photos?: Array, videos?: Array}} what   the result of classify()
 * @param {{
 *   store?: {saveImage: Function},
 *   download: (fileId: string) => Promise<{bytes: Buffer}>,
 *   sample: (video: object, opts: object) => Promise<{frames: Array, duration: number|null}>,
 *   log?: object, videoFrames?: number, videoEnabled?: boolean,
 * }} deps
 * @returns {Promise<{attachments: Array, failures: Array<{name: string, why: string}>, notes: string[]}>}
 */
export async function attachMedia(what, deps) {
  const {
    store, download, sample,
    videoFrames = VIDEO_FRAMES_DEFAULT,
    videoEnabled = true,
    maxAttachedBytes = MAX_ATTACHED_BYTES,
    maxFrames = MAX_FRAMES_PER_MESSAGE,
  } = deps;
  const log = deps.log ?? { warn() {}, info() {}, debug() {}, error() {} };

  const attachments = [];
  const failures = [];
  const notes = [];
  const photos = what?.photos ?? [];
  const videos = what?.videos ?? [];

  if (!store?.saveImage) {
    const n = photos.length + videos.length;
    if (n) failures.push({ name: `${n} attachment(s)`, why: 'no attachment service is composed on this agent' });
    return { attachments, failures, notes };
  }

  // One budget for the whole message, spent by photos and frames alike: twelve photos and
  // four clips are the same demand on a turn whichever way they are packaged.
  let budget = maxAttachedBytes;
  const budgetMB = Math.round(maxAttachedBytes / 1048576);

  // Photos first, clips after, so the order a person sent things in survives well enough
  // to talk about: "the two pictures, then the video".
  for (const p of photos) {
    try {
      const { bytes } = await download(p.fileId);
      if (bytes.length > MAX_IMAGE_BYTES) {
        const why = `${formatBytes(bytes.length)}, over the ${Math.round(MAX_IMAGE_BYTES / 1048576)} MB per-image limit`;
        log.warn(`skipping ${p.name}: ${why}`);
        failures.push({ name: p.name, why });
        continue;
      }
      if (bytes.length > budget) {
        failures.push({ name: p.name, why: `the ${budgetMB} MB attachment budget for one message was already spent` });
        continue;
      }
      budget -= bytes.length;
      attachments.push(await store.saveImage({ data: new Uint8Array(bytes), mediaType: p.mediaType, name: p.name }));
    } catch (e) {
      const why = e?.message ?? String(e);
      log.warn(`could not attach ${p.name}: ${why}`);
      failures.push({ name: p.name, why });
    }
  }

  let framesLeft = maxFrames;
  for (const v of videos) {
    if (!videoEnabled) {
      failures.push({ name: v.name, why: "video reading is switched off in this bot's configuration" });
      continue;
    }
    if (tooLargeToFetch(v)) {
      // Checked BEFORE any network call: getFile refuses this server-side, so attempting the
      // download is a slower way of learning the same thing and a retry can never help.
      const why = `${formatBytes(v.fileSize)}, over Telegram's ${TELEGRAM_FILE_LIMIT_MB} MB Bot API limit: `
                + 'the API will not serve a file that size to a bot at all, so retrying cannot help';
      log.warn(`refusing ${v.name}: ${why}`);
      failures.push({ name: v.name, why });
      continue;
    }
    if (framesLeft <= 0) {
      failures.push({ name: v.name, why: `the ${maxFrames}-frame limit for one message was already reached` });
      continue;
    }
    try {
      const { frames, duration } = await sample(v, { frames: Math.min(videoFrames, framesLeft) });
      let taken = 0;
      for (const f of frames) {
        if (f.bytes.length > budget) break;
        budget -= f.bytes.length;
        framesLeft -= 1;
        attachments.push({
          attachment: await store.saveImage({ data: new Uint8Array(f.bytes), mediaType: f.mediaType, name: f.name }),
          label: f.label,
        });
        taken += 1;
      }
      if (!taken) {
        failures.push({ name: v.name, why: `frames were extracted but none fitted in the remaining ${budgetMB} MB attachment budget` });
      } else {
        const span = duration ? ` spanning its ${formatPosition(duration)}` : '';
        notes.push(`[${v.name}: ${taken} frame(s) sampled evenly${span}. Each frame is labelled with its position in `
                 + 'the clip; nothing between the frames was seen.]');
        if (taken < frames.length) {
          failures.push({ name: v.name, why: `only ${taken} of ${frames.length} sampled frames fitted in the attachment budget` });
        }
      }
    } catch (e) {
      const raw = e?.message ?? String(e);
      // Telegram phrases the oversize refusal as "Bad Request: file is too big", which on its
      // own reads like a transient server complaint. Say what it actually means.
      const why = /file is too big/i.test(raw)
        ? `Telegram refused to serve it: over the ${TELEGRAM_FILE_LIMIT_MB} MB Bot API limit for bots`
        : raw;
      log.warn(`could not read ${v.name}: ${raw}`);
      failures.push({ name: v.name, why });
    }
  }

  return { attachments, failures, notes };
}
