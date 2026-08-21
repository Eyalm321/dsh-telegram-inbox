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
