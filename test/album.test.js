import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Albums, merge } from '../src/album.js';
import { classify } from '../src/media.js';

const member = (gid, fid, caption) => ({
  media_group_id: gid, message_id: fid, chat: { id: 1 }, from: { id: 9 },
  photo: [{ file_id: `${fid}-small` }, { file_id: `${fid}-big` }],
  ...(caption ? { caption } : {}),
});

test('a plain message passes straight through, unbuffered', () => {
  const a = new Albums();
  const out = a.accept([{ chat: { id: 1 }, text: 'hi' }]);
  assert.equal(out.length, 1);
  assert.equal(a.pendingCount, 0);
});

test('album members are held, not emitted one by one', () => {
  let t = 0;
  const a = new Albums({ graceMs: 100, now: () => t });
  assert.deepEqual(a.accept([member('g', 1, 'caption'), member('g', 2)]), []);
  assert.equal(a.pendingCount, 1, 'one group pending, not two messages');
});

test('after the grace period the album emerges as ONE message with every photo', () => {
  let t = 0;
  const a = new Albums({ graceMs: 100, now: () => t });
  a.accept([member('g', 1, 'New hoodies in stock'), member('g', 2), member('g', 3)]);
  t = 200;
  const [msg] = a.accept([]);
  assert.equal(msg.album, 3);
  assert.equal(msg.caption, 'New hoodies in stock');
  assert.equal(msg.photo.length, 3, 'one entry per picture');
});

test('members split across two polls still merge into one message', () => {
  let t = 0;
  const a = new Albums({ graceMs: 100, now: () => t });
  a.accept([member('g', 1, 'cap')]);
  t = 50; a.accept([member('g', 2)]);          // arrives in a later poll, inside the grace
  t = 200;
  const out = a.accept([]);
  assert.equal(out.length, 1);
  assert.equal(out[0].album, 2);
});

test('the caption is found wherever in the album it sits', () => {
  const msg = merge([member('g', 1), member('g', 2, 'the caption'), member('g', 3)]);
  assert.equal(msg.caption, 'the caption');
});

test('the merged message keeps the sender and chat, so the allow-list still applies', () => {
  const msg = merge([member('g', 1, 'x'), member('g', 2)]);
  assert.equal(msg.chat.id, 1);
  assert.equal(msg.from.id, 9);
});

test('classify reads every picture of an album, not just the last', () => {
  let t = 0;
  const a = new Albums({ graceMs: 0, now: () => t });
  // With no grace the group is released by the same accept that completes it.
  const [msg] = a.accept([member('g', 1, 'cap'), member('g', 2), member('g', 3)]);
  const what = classify(msg);
  assert.equal(what.kind, 'photo');
  assert.equal(what.photos.length, 3, 'all three, not one');
  assert.equal(what.text, 'cap');
  assert.deepEqual(what.photos.map((p) => p.fileId), ['1-big', '2-big', '3-big'],
    'each member contributes its own largest size');
});

test('a single photo still takes the largest size, not every size', () => {
  const what = classify({ chat: { id: 1 }, photo: [{ file_id: 'small' }, { file_id: 'big' }] });
  assert.equal(what.photos.length, 1);
  assert.equal(what.photos[0].fileId, 'big');
});

test('a forced flush releases a group early, so a lost straggler cannot strand it', () => {
  const a = new Albums({ graceMs: 999999 });
  a.accept([member('g', 1, 'cap')]);
  assert.equal(a.flush(true).length, 1);
  assert.equal(a.pendingCount, 0);
});

const videoMember = (gid, fid, caption) => ({
  media_group_id: gid, message_id: fid, chat: { id: 1 }, from: { id: 9 },
  video: { file_id: `${fid}-video`, duration: 12, file_size: 3_000_000 },
  ...(caption ? { caption } : {}),
});

test('an album of photos and videos keeps BOTH, under the one caption', () => {
  let t = 0;
  const a = new Albums({ graceMs: 0, now: () => t });
  const [msg] = a.accept([member('g', 1, 'caught it'), videoMember('g', 2), member('g', 3)]);
  const what = classify(msg);
  assert.equal(what.kind, 'media', 'a mixed album is not a photo album with the videos thrown away');
  assert.deepEqual(what.photos.map((p) => p.fileId), ['1-big', '3-big']);
  assert.deepEqual(what.videos.map((v) => v.fileId), ['2-video']);
  assert.equal(what.text, 'caught it', 'one caption, wherever in the group it was written');
});

test('an album of videos only is a video message, not an empty one', () => {
  const msg = merge([videoMember('g', 1, 'the trip'), videoMember('g', 2)]);
  const what = classify(msg);
  assert.equal(what.kind, 'video');
  assert.equal(what.videos.length, 2);
  assert.equal(what.text, 'the trip');
  assert.equal(what.photos.length, 0);
});

test('the caption is found even when only a video member carries it', () => {
  const msg = merge([member('g', 1), videoMember('g', 2, 'this bit'), member('g', 3)]);
  assert.equal(msg.caption, 'this bit');
});

test('a clip sent as a document inside an album keeps its filename', () => {
  const doc = {
    media_group_id: 'g', message_id: 5, chat: { id: 1 }, from: { id: 9 },
    document: { file_id: 'd', mime_type: 'video/quicktime', file_name: 'IMG_4021.MOV' },
  };
  const what = classify(merge([member('g', 1, 'cap'), doc]));
  assert.equal(what.kind, 'media');
  assert.equal(what.videos[0].name, 'IMG_4021.MOV');
});

test('a photo-only album still carries no videos key, so nothing changed for it', () => {
  const msg = merge([member('g', 1, 'cap'), member('g', 2)]);
  assert.equal(msg.videos, undefined);
  assert.equal(classify(msg).kind, 'photo');
});
