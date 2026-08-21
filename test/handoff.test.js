import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Handoff } from '../src/handoff.js';

const dir = () => mkdtempSync(join(tmpdir(), 'handoff-'));

test('an unclaimed session belongs to the daemon', () => {
  assert.equal(new Handoff(dir()).isClaimed('telegram-1'), false);
});

test('claiming makes the holder visible, so the daemon can say who has it', () => {
  const h = new Handoff(dir());
  h.claim('telegram-1', 'the web UI');
  assert.equal(h.claimOf('telegram-1').owner, 'the web UI');
});

test('releasing hands it back', () => {
  const h = new Handoff(dir());
  h.claim('telegram-1', 'x');
  assert.equal(h.release('telegram-1'), true);
  assert.equal(h.isClaimed('telegram-1'), false);
  assert.equal(h.release('telegram-1'), false, 'releasing twice is not an error');
});

test('a stale claim expires — a crashed client must not lock a chat forever', () => {
  let t = 0;
  const h = new Handoff(dir(), { ttlMs: 1000, now: () => t });
  h.claim('telegram-1', 'gone');
  t = 5000;
  assert.equal(h.isClaimed('telegram-1'), false, 'the safe failure is the daemon taking over');
});

test('an unreadable claim file blocks nothing', async () => {
  const d = dir();
  const h = new Handoff(d);
  h.claim('telegram-1', 'x');
  (await import('node:fs')).writeFileSync(join(d, 'telegram-1.claim.json'), 'not json');
  assert.equal(h.isClaimed('telegram-1'), false);
});

test('messages arriving while claimed are parked in order, not dropped', () => {
  const h = new Handoff(dir());
  h.claim('telegram-1', 'x');
  h.park('telegram-1', { content: [{ type: 'text', text: 'first' }] });
  h.park('telegram-1', { content: [{ type: 'text', text: 'second' }] });
  assert.deepEqual(h.parked('telegram-1').map((m) => m.content[0].text), ['first', 'second']);
});

test('draining returns the queue once and clears it', () => {
  const h = new Handoff(dir());
  h.park('telegram-1', { content: [] });
  assert.equal(h.drain('telegram-1').length, 1);
  assert.deepEqual(h.drain('telegram-1'), [], 'a replayed message must not replay twice');
});

test('a released session with parked messages is reported for replay', () => {
  const h = new Handoff(dir());
  h.claim('telegram-1', 'x');
  h.park('telegram-1', { content: [] });
  assert.deepEqual(h.releasedWithPending(), [], 'still claimed: not ready');
  h.release('telegram-1');
  assert.deepEqual(h.releasedWithPending(), ['telegram-1']);
});

test('sessions are independent — claiming one does not hold another', () => {
  const h = new Handoff(dir());
  h.claim('telegram-1', 'x');
  assert.equal(h.isClaimed('telegram-2'), false);
});

test('with no directory configured the feature is simply off', () => {
  const h = new Handoff(null);
  assert.equal(h.isClaimed('telegram-1'), false);
  assert.deepEqual(h.releasedWithPending(), []);
  assert.doesNotThrow(() => h.park('telegram-1', {}));
});
