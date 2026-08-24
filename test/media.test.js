import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, buildContent, describeUnreadable } from '../src/media.js';

test('a photo batch with a caption is recognised, largest size chosen', () => {
  const w = classify({ chat: { id: 1 }, caption: 'why does this fail?', photo: [
    { file_id: 'small', width: 90 }, { file_id: 'big', width: 1280 },
  ] });
  assert.equal(w.kind, 'photo');
  assert.equal(w.text, 'why does this fail?');
  assert.equal(w.photos[0].fileId, 'big', 'telegram lists sizes ascending; take the last');
});

test('a caption-less photo still counts as a photo, not as nothing', () => {
  const w = classify({ chat: { id: 1 }, photo: [{ file_id: 'a' }] });
  assert.equal(w.kind, 'photo');
  assert.equal(w.text, '');
});

test('an image sent as a document keeps its real media type', () => {
  const w = classify({ chat: { id: 1 }, document: { file_id: 'd', mime_type: 'image/png', file_name: 'shot.png' } });
  assert.equal(w.kind, 'photo');
  assert.deepEqual(w.photos[0], { fileId: 'd', mediaType: 'image/png', name: 'shot.png' });
});

test('a non-image document is unsupported, not silently dropped', () => {
  const w = classify({ chat: { id: 1 }, document: { file_id: 'd', mime_type: 'application/pdf' } });
  assert.equal(w.kind, 'unsupported');
  assert.equal(w.unsupported, 'document');
});

test('stickers, locations and polls are named so the reply can say what was ignored', () => {
  for (const [key, want] of [['sticker', 'sticker'], ['location', 'location'], ['poll', 'poll']]) {
    assert.equal(classify({ chat: { id: 1 }, [key]: {} }).unsupported, want);
  }
});

test('a video is no longer unsupported, it is read', () => {
  const w = classify({ chat: { id: 1 }, video: { file_id: 'v', duration: 30, file_size: 1000 } });
  assert.equal(w.kind, 'video');
  assert.equal(w.videos.length, 1);
});

test('text and voice still classify as before', () => {
  assert.equal(classify({ chat: { id: 1 }, text: 'hi' }).kind, 'text');
  assert.equal(classify({ chat: { id: 1 }, voice: { file_id: 'v' } }).kind, 'voice');
});

test('content puts the caption first, then one block per image', () => {
  const blocks = buildContent({ text: 'look', attachments: [{ attachmentId: 'a' }, { attachmentId: 'b' }] });
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[0].text, 'look');
  assert.deepEqual(blocks.slice(1).map((b) => b.type), ['image', 'image']);
  assert.equal(blocks[1].attachment.attachmentId, 'a');
});

test('a caption survives even when no image could be attached', () => {
  const note = describeUnreadable([
    { name: 'photo-1.jpg', why: 'no attachment service is composed' },
    { name: 'photo-2.jpg', why: 'no attachment service is composed' },
  ]);
  const blocks = buildContent({ text: 'why does this fail?', attachments: [], note });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /why does this fail\?/);
  assert.match(blocks[0].text, /2 things sent with this message could not be read/);
  assert.match(blocks[0].text, /photo-2\.jpg: no attachment service is composed/);
});

test('an empty message never produces empty content', () => {
  assert.deepEqual(buildContent({ text: '', attachments: [] }), [{ type: 'text', text: '[empty message]' }]);
});

test('describeUnreadable says nothing when nothing was skipped', () => {
  assert.equal(describeUnreadable([]), '');
  assert.match(describeUnreadable([{ name: 'clip.mp4', why: 'download failed' }]),
    /^\[One thing sent with this message could not be read and is NOT included below:\n- clip\.mp4: download failed\]$/);
});

test('an album beyond the cap is truncated, not refused', async () => {
  const { MAX_IMAGES_PER_MESSAGE } = await import('../src/media.js');
  const many = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 3 }, (_, i) => ({ file_id: `f${i}` }));
  const w = classify({ chat: { id: 1 }, album: many.length, caption: 'lots', photo: many });
  assert.equal(w.photos.length, MAX_IMAGES_PER_MESSAGE);
  assert.equal(w.dropped, 3, 'the caller must be able to say what was left out');
  assert.equal(w.text, 'lots', 'the caption survives regardless');
});

test('an album within the cap drops nothing', () => {
  const w = classify({ chat: { id: 1 }, album: 8, photo: Array.from({ length: 8 }, (_, i) => ({ file_id: `f${i}` })) });
  assert.equal(w.photos.length, 8);
  assert.equal(w.dropped, 0);
});

// ── video ────────────────────────────────────────────────────────────────────
// Every shape below is an ordinary thing a phone sends, and every one of them used to
// land on the unsupported list, which meant it vanished with a one-line apology and no
// trace in the turn at all.

test('a plain video is classified, with its caption kept exactly as a photo\'s is', () => {
  const w = classify({ chat: { id: 1 }, caption: 'is this a bass?',
    video: { file_id: 'v1', duration: 34, file_size: 4_000_000, mime_type: 'video/mp4' } });
  assert.equal(w.kind, 'video');
  assert.equal(w.text, 'is this a bass?', 'the caption is usually the actual request');
  assert.equal(w.videos.length, 1);
  assert.equal(w.videos[0].fileId, 'v1');
  assert.equal(w.videos[0].duration, 34);
  assert.equal(w.videos[0].fileSize, 4_000_000);
  assert.equal(w.videos[0].source, 'video');
});

test("an animation, Telegram's word for a gif, is a video and not an unsupported type", () => {
  const w = classify({ chat: { id: 1 }, animation: { file_id: 'a1', duration: 3, mime_type: 'video/mp4' } });
  assert.equal(w.kind, 'video');
  assert.equal(w.videos[0].source, 'animation');
  assert.equal(w.videos[0].name, 'animation.mp4');
});

test('a round video note is a video too', () => {
  const w = classify({ chat: { id: 1 }, video_note: { file_id: 'n1', duration: 8, file_size: 900_000 } });
  assert.equal(w.kind, 'video');
  assert.equal(w.videos[0].source, 'video_note');
  assert.equal(w.videos[0].mediaType, 'video/mp4', 'a video note states no mime type of its own');
});

test('a clip sent "as a file" is recognised by its mime type and keeps its filename', () => {
  for (const mime of ['video/mp4', 'video/quicktime', 'video/x-matroska']) {
    const w = classify({ chat: { id: 1 }, caption: 'the trip',
      document: { file_id: 'd', mime_type: mime, file_name: 'IMG_4021.MOV', file_size: 8_000_000 } });
    assert.equal(w.kind, 'video', `${mime} should read as a video`);
    assert.equal(w.videos[0].name, 'IMG_4021.MOV');
    assert.equal(w.videos[0].mediaType, mime);
    assert.equal(w.text, 'the trip');
  }
});

test('a document that is neither image nor video is still unsupported', () => {
  const w = classify({ chat: { id: 1 }, document: { file_id: 'd', mime_type: 'application/pdf' } });
  assert.equal(w.kind, 'unsupported');
  assert.equal(w.unsupported, 'document');
});

test('videoOf ignores an image document, so a png does not become a broken clip', async () => {
  const { videoOf } = await import('../src/media.js');
  assert.equal(videoOf({ document: { file_id: 'd', mime_type: 'image/png' } }), null);
  assert.equal(videoOf({ text: 'hi' }), null);
  assert.equal(videoOf({ document: { file_id: 'd' } }), null, 'a document with no mime type is not a video');
});

test('a message with pictures AND clips is classified as carrying both', () => {
  const w = classify({
    chat: { id: 1 }, caption: 'caught it', album: 2,
    photo: [{ file_id: 'p1' }, { file_id: 'p2' }],
    videos: [{ media: { file_id: 'v1', duration: 12 }, source: 'video' }],
  });
  assert.equal(w.kind, 'media', 'not "photo": that is how half the message used to vanish');
  assert.equal(w.photos.length, 2);
  assert.equal(w.videos.length, 1);
  assert.equal(w.text, 'caught it', 'one caption for the whole message');
});

test('clips beyond the per-message cap are truncated and counted, never silently dropped', async () => {
  const { MAX_VIDEOS_PER_MESSAGE } = await import('../src/media.js');
  const videos = Array.from({ length: MAX_VIDEOS_PER_MESSAGE + 2 },
    (_, i) => ({ media: { file_id: `v${i}`, duration: 5 }, source: 'video' }));
  const w = classify({ chat: { id: 1 }, caption: 'lots', videos });
  assert.equal(w.videos.length, MAX_VIDEOS_PER_MESSAGE);
  assert.equal(w.droppedVideos, 2, 'the caller must be able to say what was left out');
  assert.equal(w.text, 'lots');
});

test('unnamed clips in one message get distinct names, so a refusal can say which', async () => {
  const { describeVideo } = await import('../src/media.js');
  assert.equal(describeVideo({ file_id: 'a' }, 'video', 0).name, 'video.mp4');
  assert.equal(describeVideo({ file_id: 'b' }, 'video', 1).name, 'video-2.mp4');
  assert.equal(describeVideo({ file_id: 'c', file_name: 'boat.mov' }, 'document', 1).name, 'boat.mov');
});

test('a size Telegram will not serve is known before any download is attempted', async () => {
  const { tooLargeToFetch, TELEGRAM_FILE_LIMIT_BYTES } = await import('../src/media.js');
  assert.equal(tooLargeToFetch({ fileSize: TELEGRAM_FILE_LIMIT_BYTES + 1 }), true);
  assert.equal(tooLargeToFetch({ fileSize: TELEGRAM_FILE_LIMIT_BYTES }), false, 'exactly at the limit is servable');
  assert.equal(tooLargeToFetch({ fileSize: null }), false, 'unknown size is attempted, not refused in advance');
});

test('sizes are written so "too big" is checkable rather than a claim', async () => {
  const { formatBytes } = await import('../src/media.js');
  assert.equal(formatBytes(25 * 1048576), '25.0 MB');
  assert.equal(formatBytes(4096), '4 KB');
  assert.equal(formatBytes(12), '12 bytes');
  assert.equal(formatBytes(null), 'unknown size');
});

test('a labelled attachment gets its label as a text block immediately before it', () => {
  const blocks = buildContent({
    text: 'caught it',
    attachments: [
      { attachmentId: 'photo' },
      { attachment: { attachmentId: 'f1' }, label: 'frame 1/2 at 0:01' },
      { attachment: { attachmentId: 'f2' }, label: 'frame 2/2 at 0:03' },
    ],
  });
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'image', 'text', 'image', 'text', 'image']);
  assert.equal(blocks[2].text, '[frame 1/2 at 0:01]');
  assert.equal(blocks[3].attachment.attachmentId, 'f1');
});

test('an attachment that failed to save is not turned into an empty image block', () => {
  const blocks = buildContent({ text: 'x', attachments: [null, { attachment: null, label: 'frame 1/1' }] });
  assert.deepEqual(blocks, [{ type: 'text', text: 'x' }]);
});

test('the refusal reply names each thing and how many there were', async () => {
  const { refusalReply } = await import('../src/media.js');
  assert.equal(refusalReply([]), '');
  const two = refusalReply([{ name: 'a.mp4', why: 'too big' }, { name: 'b.mp4', why: 'too big' }]);
  assert.match(two, /^2 parts of that message did not reach me:/);
  assert.match(two, /• a\.mp4: too big/);
  assert.match(refusalReply([{ name: 'a.mp4', why: 'too big' }]), /^One part of that message did not reach me:/);
});
