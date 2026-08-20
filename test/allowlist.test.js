import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AllowList, describeIntruder } from '../src/allowlist.js';

test('an empty allow-list admits NOBODY — the security fix over the original', () => {
  const a = new AllowList([]);
  assert.equal(a.isEmpty, true);
  assert.equal(a.admits(100200300), false);
  assert.equal(a.admits(undefined), false);
});

test('listed users are admitted, others are not', () => {
  const a = new AllowList([100200300]);
  assert.equal(a.admits(100200300), true);
  assert.equal(a.admits('100200300'), true, 'telegram ids arrive as numbers or strings');
  assert.equal(a.admits(1), false);
});

test('junk entries are discarded rather than admitting anyone', () => {
  const a = new AllowList([null, 'abc', undefined, 42]);
  assert.equal(a.admits(42), true);
  assert.equal(a.admits(NaN), false);
});

test('a stranger raises one alert per window, not one per message', () => {
  let now = 0;
  const a = new AllowList([1], { alertWindowMs: 1000, now: () => now });
  assert.equal(a.shouldAlert(99), true);
  assert.equal(a.shouldAlert(99), false, 'second message inside the window is quiet');
  now = 1500;
  assert.equal(a.shouldAlert(99), true, 'window elapsed, alert again');
});

test('alert throttling is per stranger', () => {
  const a = new AllowList([1], { alertWindowMs: 10_000, now: () => 0 });
  assert.equal(a.shouldAlert(99), true);
  assert.equal(a.shouldAlert(100), true);
});

test('the intruder description carries who and what, and truncates the text', () => {
  const d = describeIntruder(
    { from: { id: 5, first_name: 'Ann', username: 'ann' }, chat: { id: 5 } },
    'x'.repeat(500));
  assert.match(d, /id: 5/);
  assert.match(d, /@ann/);
  assert.ok(d.length < 400, 'a long probe must not be relayed in full');
});
