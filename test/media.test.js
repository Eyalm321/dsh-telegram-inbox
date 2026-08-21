import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, buildContent, describeSkipped } from '../src/media.js';

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

test('video, stickers and locations are named so the reply can say what was ignored', () => {
  for (const [key, want] of [['video', 'video'], ['sticker', 'sticker'], ['location', 'location']]) {
    assert.equal(classify({ chat: { id: 1 }, [key]: {} }).unsupported, want);
  }
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
  const blocks = buildContent({ text: 'why does this fail?', attachments: [], note: describeSkipped(2, 'no attachment service is composed') });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /why does this fail\?/);
  assert.match(blocks[0].text, /2 images .* could not be read/);
});

test('an empty message never produces empty content', () => {
  assert.deepEqual(buildContent({ text: '', attachments: [] }), [{ type: 'text', text: '[empty message]' }]);
});

test('describeSkipped says nothing when nothing was skipped', () => {
  assert.equal(describeSkipped(0, 'x'), '');
  assert.match(describeSkipped(1, 'download failed'), /^\[image .* download failed\]$/);
});
