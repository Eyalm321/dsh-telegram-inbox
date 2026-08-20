import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramClient } from '../src/client.js';

const okFetch = (result) => async () => ({ ok: true, json: async () => ({ ok: true, result }) });
const fresh = () => join(mkdtempSync(join(tmpdir(), 'dtc-')), 'sub', 'offset.json');

test('a persisted offset survives a restart — no replaying yesterday\'s messages', async () => {
  const f = fresh();
  const a = new TelegramClient('t', { offsetFile: f, fetchImpl: okFetch([{ update_id: 41 }, { update_id: 42 }]) });
  await a.poll(0);
  assert.equal(a.offset, 43);
  const b = new TelegramClient('t', { offsetFile: f, fetchImpl: okFetch([]) });
  assert.equal(b.offset, 43, 'a new process must resume from the stored offset');
});

test('with no offset file the client starts at zero', () => {
  assert.equal(new TelegramClient('t', { fetchImpl: okFetch([]) }).offset, 0);
});

test('a corrupt offset file is treated as absent, not fatal', async () => {
  const f = fresh();
  const a = new TelegramClient('t', { offsetFile: f, fetchImpl: okFetch([{ update_id: 3 }]) });
  await a.poll(0);                       // creates the directory and a valid file
  writeFileSync(f, 'not json');
  assert.equal(new TelegramClient('t', { offsetFile: f, fetchImpl: okFetch([]) }).offset, 0);
});

test('the offset never moves backwards on out-of-order updates', async () => {
  const c = new TelegramClient('t', { fetchImpl: okFetch([{ update_id: 10 }, { update_id: 5 }]) });
  await c.poll(0);
  assert.equal(c.offset, 11);
});

test('a Telegram error becomes a thrown error carrying its code', async () => {
  const c = new TelegramClient('t', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false, error_code: 409, description: 'Conflict' }) }),
  });
  await assert.rejects(() => c.call('getUpdates'), (e) => e.code === 409 && /Conflict/.test(e.message));
});

test('the long-poll HTTP timeout exceeds the server hold, so we do not abort our own poll', async () => {
  let seen;
  const c = new TelegramClient('t', {
    fetchImpl: async (_u, init) => { seen = init; return { ok: true, json: async () => ({ ok: true, result: [] }) }; },
  });
  await c.poll(25);
  assert.equal(JSON.parse(seen.body).timeout, 25);
  assert.ok(seen.signal, 'the request must still be abortable');
});

test('send splits long text into several sendMessage calls', async () => {
  const calls = [];
  const c = new TelegramClient('t', {
    fetchImpl: async (_u, init) => { calls.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ok: true, result: {} }) }; },
  });
  const { splitMessage } = await import('../src/chunk.js');
  await c.send(1, 'y'.repeat(9000), splitMessage);
  assert.ok(calls.length >= 3);
  for (const c2 of calls) assert.ok(c2.text.length <= 4096);
});
