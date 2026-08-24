/**
 * Reassembling Telegram albums.
 *
 * Telegram sends a multi-image album as SEPARATE updates that share a `media_group_id`, and
 * only one of them carries the caption. Handled naively, eight photos become eight agent
 * turns: one with the caption and seven with no context at all, at eight times the cost. The
 * user sent one message and should get one turn.
 *
 * Members usually arrive in a single poll but can split across two, so a group is held for a
 * short grace period before it is released. The grace is bounded and the buffer is flushed on
 * every tick, so a lost straggler delays a message by a second or two rather than stranding it.
 *
 * @module dsh-telegram-inbox/album
 */
import { videoOf } from './media.js';

export class Albums {
  /** @param {{graceMs?: number, now?: () => number}} [opts] */
  constructor(opts = {}) {
    this.graceMs = opts.graceMs ?? 2500;
    this.now = opts.now ?? (() => Date.now());
    this.pending = new Map();   // media_group_id -> { messages, firstSeen }
  }

  /**
   * Feed one poll's messages in; get back the ones ready to handle.
   * Album members are buffered; everything else passes straight through.
   */
  accept(messages) {
    const ready = [];
    for (const msg of messages) {
      const gid = msg?.media_group_id;
      if (!gid) { ready.push(msg); continue; }
      const entry = this.pending.get(gid) ?? { messages: [], firstSeen: this.now() };
      entry.messages.push(msg);
      this.pending.set(gid, entry);
    }
    return ready.concat(this.flush());
  }

  /** Release groups whose grace period has elapsed, merged into one message each. */
  flush(force = false) {
    const out = [];
    for (const [gid, entry] of [...this.pending]) {
      if (!force && this.now() - entry.firstSeen < this.graceMs) continue;
      this.pending.delete(gid);
      out.push(merge(entry.messages));
    }
    return out;
  }

  get pendingCount() { return this.pending.size; }
}

/**
 * Merge album members into a single message carrying every photo, every clip and the one
 * caption. The merged message keeps the first member's identity — chat, sender, id — so
 * allow-list and session routing behave exactly as for any other message.
 *
 * An album is not photos-only: Telegram lets one media group hold pictures and videos
 * together, and that is exactly how a phone sends "here is the boat and here is the fish".
 * Collecting only the photos is how half of such a message used to disappear, so both lists
 * are gathered and the merged message carries whichever of them are non-empty.
 */
export function merge(messages) {
  const [first] = messages;
  const caption = messages.map((m) => (m.caption ?? '').trim()).find(Boolean) ?? '';
  const photos = [];
  const videos = [];
  for (const m of messages) {
    if (Array.isArray(m.photo) && m.photo.length) photos.push(m.photo[m.photo.length - 1]);
    const clip = videoOf(m);
    if (clip) videos.push(clip);
  }
  return {
    ...first,
    caption,
    // classify() takes the last entry as the largest, so each member contributes its own
    // largest size and the array stays "ascending" from that function's point of view.
    photo: photos.length ? photos : first.photo,
    album: photos.length,
    // Tagged with the field each came from, because a clip's field decides its default name
    // and `document` clips are the ones with a real filename worth keeping.
    ...(videos.length ? { videos } : {}),
  };
}
