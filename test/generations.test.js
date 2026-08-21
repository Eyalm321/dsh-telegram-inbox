import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Generations } from '../src/generations.js';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'gen-')), 'nested', 'generations.json');

test('generation 0 keeps the historical id, so existing chats are not orphaned', () => {
  const g = new Generations(null);
  assert.equal(g.sessionId('telegram', '123'), 'telegram-123');
});

test('a reset changes the session id — the whole point of /new', () => {
  const g = new Generations(null);
  const before = g.sessionId('telegram', '123');
  g.bump('123');
  const after = g.sessionId('telegram', '123');
  assert.notEqual(before, after);
  assert.equal(after, 'telegram-123-g1');
});

test('resets accumulate rather than toggling between two ids', () => {
  const g = new Generations(null);
  g.bump('1'); g.bump('1'); g.bump('1');
  assert.equal(g.sessionId('telegram', '1'), 'telegram-1-g3');
});

test('generations survive a restart, or a reset would silently reuse an id', () => {
  const f = fresh();
  const a = new Generations(f); a.bump('123');
  assert.equal(new Generations(f).sessionId('telegram', '123'), 'telegram-123-g1');
});

test('chats are independent', () => {
  const g = new Generations(null);
  g.bump('1');
  assert.equal(g.sessionId('telegram', '1'), 'telegram-1-g1');
  assert.equal(g.sessionId('telegram', '2'), 'telegram-2');
});

test('a corrupt store is treated as absent rather than fatal', () => {
  const f = fresh();
  new Generations(f).bump('1');
  writeFileSync(f, 'not json');
  assert.equal(new Generations(f).get('1'), 0);
});

test('an unwritable path warns but does not throw — a lost counter is not data loss', () => {
  const warned = [];
  // /dev/null is not a directory, so mkdir fails immediately with ENOTDIR. (A /proc path
  // was tried first and mkdirSync HANGS there rather than erroring — worth not repeating.)
  const g = new Generations('/dev/null/nope/generations.json', { log: { warn: (m) => warned.push(m) } });
  assert.equal(g.bump('1'), 1);
  assert.equal(warned.length, 1);
});
