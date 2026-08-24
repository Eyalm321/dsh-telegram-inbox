import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachMedia } from '../src/attach.js';
import { classify, buildContent, describeUnreadable, refusalReply, TELEGRAM_FILE_LIMIT_BYTES } from '../src/media.js';

/** An attachment service that records what it was given. */
function store() {
  const saved = [];
  return {
    saved,
    saveImage: async ({ name, mediaType, data }) => {
      saved.push({ name, mediaType, bytes: data.length });
      return { attachmentId: `att-${saved.length}`, name };
    },
  };
}

const bytes = (n) => Buffer.alloc(n, 7);

/** Frames as sampleVideo would return them, without going anywhere near ffmpeg. */
function fakeFrames(count, size = 1000, duration = 12) {
  return Array.from({ length: count }, (_, i) => ({
    bytes: bytes(size),
    mediaType: 'image/jpeg',
    name: `clip-frame-${i + 1}.jpg`,
    label: `frame ${i + 1}/${count} at 0:0${i * 2 + 1} of clip.mp4 (0:12 long)`,
    at: i * 2 + 1,
  }));
}

const never = (what) => async () => { throw new Error(`${what} must not be called`); };

test('a video over the Bot API limit is refused WITHOUT touching the network', async () => {
  const s = store();
  const what = classify({ chat: { id: 1 }, caption: 'look at this',
    video: { file_id: 'v', duration: 40, file_size: 25 * 1024 * 1024 } });
  const out = await attachMedia(what, {
    store: s,
    download: never('download'),   // getFile cannot serve this, so it must not be attempted
    sample: never('sample'),
  });
  assert.equal(out.attachments.length, 0);
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0].name, 'video.mp4');
  assert.match(out.failures[0].why, /25\.0 MB/);
  assert.match(out.failures[0].why, /20 MB Bot API limit/);
  assert.match(out.failures[0].why, /retrying cannot help/);
});

test('the refusal reaches the TURN, not only the chat', async () => {
  const what = classify({ chat: { id: 1 }, caption: 'is this a bass?',
    video: { file_id: 'v', file_size: TELEGRAM_FILE_LIMIT_BYTES + 1 } });
  const out = await attachMedia(what, { store: store(), download: never('d'), sample: never('s') });

  const content = buildContent({ text: what.text, attachments: out.attachments, note: describeUnreadable(out.failures) });
  assert.equal(content.length, 1, 'no image blocks, because no image arrived');
  assert.match(content[0].text, /is this a bass\?/, 'the caption is the actual request and survives');
  assert.match(content[0].text, /could not be read and is NOT included below/,
    'the model must be told, or it will answer as though it saw the video');
  assert.match(content[0].text, /20 MB Bot API limit/);

  const reply = refusalReply(out.failures);
  assert.match(reply, /did not reach me/);
  assert.match(reply, /video\.mp4/);
});

test('two oversize videos are both named, so "both of them" is checkable', async () => {
  const what = classify({ chat: { id: 1 }, caption: 'the trip', videos: [
    { media: { file_id: 'a', file_size: 30 * 1048576, file_name: 'boat.mp4' }, source: 'document' },
    { media: { file_id: 'b', file_size: 48 * 1048576 }, source: 'video' },
  ] });
  const out = await attachMedia(what, { store: store(), download: never('d'), sample: never('s') });
  assert.equal(out.failures.length, 2);
  assert.deepEqual(out.failures.map((f) => f.name), ['boat.mp4', 'video-2.mp4'],
    'the second unnamed clip gets a distinct name, so the refusal says WHICH one');
  assert.match(describeUnreadable(out.failures), /^\[2 things sent with this message could not be read/);
});

test('a video whose size Telegram did not state is attempted, not refused in advance', async () => {
  const s = store();
  let asked = 0;
  const what = classify({ chat: { id: 1 }, video: { file_id: 'v', duration: 12 } });
  const out = await attachMedia(what, {
    store: s,
    download: never('d'),
    sample: async () => { asked += 1; return { frames: fakeFrames(6), duration: 12 }; },
  });
  assert.equal(asked, 1, 'unknown size is not a reason to give up before trying');
  assert.equal(out.attachments.length, 6);
  assert.equal(out.failures.length, 0);
});

test("Telegram's own oversize wording is translated into what it means", async () => {
  const what = classify({ chat: { id: 1 }, video: { file_id: 'v', duration: 900 } });
  const out = await attachMedia(what, {
    store: store(),
    download: never('d'),
    sample: async () => { throw new Error('getFile: Bad Request: file is too big'); },
  });
  assert.equal(out.failures.length, 1);
  assert.match(out.failures[0].why, /Telegram refused to serve it: over the 20 MB Bot API limit/);
});

test('an ffmpeg failure is reported, never swallowed', async () => {
  const what = classify({ chat: { id: 1 }, caption: 'why is it dark?', video: { file_id: 'v', duration: 5 } });
  const out = await attachMedia(what, {
    store: store(),
    download: never('d'),
    sample: async () => { throw new Error('ffmpeg failed: Command failed: moov atom not found'); },
  });
  assert.equal(out.attachments.length, 0);
  assert.equal(out.failures.length, 1);
  assert.match(out.failures[0].why, /moov atom not found/);
  const content = buildContent({ text: what.text, attachments: [], note: describeUnreadable(out.failures) });
  assert.match(content[0].text, /moov atom not found/);
});

test('one broken clip does not cost the other one', async () => {
  const s = store();
  const what = classify({ chat: { id: 1 }, videos: [
    { media: { file_id: 'a', file_name: 'broken.mp4', mime_type: 'video/mp4' }, source: 'document' },
    { media: { file_id: 'b', duration: 12 }, source: 'video' },
  ] });
  let call = 0;
  const out = await attachMedia(what, {
    store: s,
    download: never('d'),
    sample: async () => {
      call += 1;
      if (call === 1) throw new Error('ffmpeg failed: Invalid data found when processing input');
      return { frames: fakeFrames(4), duration: 12 };
    },
  });
  assert.equal(out.attachments.length, 4, 'the readable clip still arrives');
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0].name, 'broken.mp4');
});

test('a mixed album yields the photos AND the frames, in that order, under one caption', async () => {
  const s = store();
  const what = classify({
    chat: { id: 1 }, caption: 'caught it', album: 2,
    photo: [{ file_id: 'p1' }, { file_id: 'p2' }],
    videos: [{ media: { file_id: 'v1', duration: 12 }, source: 'video' }],
  });
  assert.equal(what.kind, 'media');

  const out = await attachMedia(what, {
    store: s,
    download: async () => ({ bytes: bytes(2048) }),
    sample: async () => ({ frames: fakeFrames(3), duration: 12 }),
  });
  assert.equal(out.attachments.length, 5, '2 photos + 3 frames');
  assert.deepEqual(s.saved.map((x) => x.name),
    ['photo-1.jpg', 'photo-2.jpg', 'clip-frame-1.jpg', 'clip-frame-2.jpg', 'clip-frame-3.jpg']);

  const content = buildContent({ text: what.text, attachments: out.attachments, note: out.notes.join('\n') });
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].text.split('\n\n')[0], 'caught it', 'one caption, once');
  assert.deepEqual(content.slice(1).map((b) => b.type),
    ['image', 'image', 'text', 'image', 'text', 'image', 'text', 'image'],
    'photos plain, then each frame preceded by its position');
  assert.match(content[3].text, /^\[frame 1\/3 at 0:01 of clip\.mp4/);
  assert.match(content[0].text, /3 frame\(s\) sampled evenly spanning its 0:12/);
});

test('frames are capped across the whole message, and the cap is stated', async () => {
  const s = store();
  const videos = Array.from({ length: 4 }, (_, i) => ({ media: { file_id: `v${i}`, duration: 60 }, source: 'video' }));
  const what = classify({ chat: { id: 1 }, videos });
  const out = await attachMedia(what, {
    store: s,
    download: never('d'),
    sample: async (_v, opts) => ({ frames: fakeFrames(opts.frames), duration: 60 }),
    videoFrames: 6,
    maxFrames: 12,
  });
  assert.equal(out.attachments.length, 12, 'six, six, and then the cap');
  assert.equal(out.failures.length, 2, 'both clips that got nothing are named');
  assert.ok(out.failures.every((f) => /12-frame limit for one message was already reached/.test(f.why)));
});

test('the total attached bytes of one message are bounded, and what fell off is named', async () => {
  const s = store();
  const what = classify({ chat: { id: 1 }, album: 2, photo: [{ file_id: 'p1' }, { file_id: 'p2' }] });
  const out = await attachMedia(what, {
    store: s,
    download: async () => ({ bytes: bytes(700 * 1024) }),
    sample: never('s'),
    maxAttachedBytes: 1024 * 1024,
  });
  assert.equal(out.attachments.length, 1);
  assert.equal(out.failures.length, 1);
  assert.match(out.failures[0].why, /attachment budget for one message was already spent/);
});

test('frames that do not fit the budget are dropped loudly, not quietly', async () => {
  const s = store();
  const what = classify({ chat: { id: 1 }, video: { file_id: 'v', duration: 12 } });
  const out = await attachMedia(what, {
    store: s,
    download: never('d'),
    sample: async () => ({ frames: fakeFrames(6, 400 * 1024), duration: 12 }),
    maxAttachedBytes: 1024 * 1024,
  });
  assert.equal(out.attachments.length, 2);
  assert.equal(out.failures.length, 1);
  assert.match(out.failures[0].why, /only 2 of 6 sampled frames fitted/);
});

test('an oversize photo is named with its size rather than dropped', async () => {
  const s = store();
  const what = classify({ chat: { id: 1 }, photo: [{ file_id: 'p' }] });
  const out = await attachMedia(what, {
    store: s,
    download: async () => ({ bytes: bytes(13 * 1048576) }),
    sample: never('s'),
  });
  assert.equal(out.attachments.length, 0);
  assert.match(out.failures[0].why, /13\.0 MB, over the 12 MB per-image limit/);
});

test('with no attachment service the caption still travels, and says what it lost', async () => {
  const what = classify({ chat: { id: 1 }, caption: 'what is this?', video: { file_id: 'v', duration: 3 } });
  const out = await attachMedia(what, { store: undefined, download: never('d'), sample: never('s') });
  assert.equal(out.failures.length, 1);
  assert.match(out.failures[0].why, /no attachment service is composed/);
  const content = buildContent({ text: what.text, attachments: [], note: describeUnreadable(out.failures) });
  assert.match(content[0].text, /what is this\?/);
});

test('video reading can be switched off, and then says so instead of going quiet', async () => {
  const what = classify({ chat: { id: 1 }, video: { file_id: 'v', duration: 3 } });
  const out = await attachMedia(what, {
    store: store(), download: never('d'), sample: never('s'), videoEnabled: false,
  });
  assert.equal(out.attachments.length, 0);
  assert.match(out.failures[0].why, /switched off/);
});

test('a photo that fails to download does not stop the ones after it', async () => {
  const s = store();
  const what = classify({ chat: { id: 1 }, album: 3, photo: [{ file_id: 'a' }, { file_id: 'b' }, { file_id: 'c' }] });
  const out = await attachMedia(what, {
    store: s,
    download: async (id) => {
      if (id === 'b') throw new Error('file download failed: HTTP 502');
      return { bytes: bytes(100) };
    },
    sample: never('s'),
  });
  assert.equal(out.attachments.length, 2);
  assert.equal(out.failures[0].name, 'photo-2.jpg');
  assert.match(out.failures[0].why, /HTTP 502/);
});
