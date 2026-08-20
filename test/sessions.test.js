import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatSessions } from '../src/sessions.js';

const handle = (tag) => ({ tag, disposed: false, dispose() { this.disposed = true; } });
const make = (over = {}) => new ChatSessions({
  agents: {}, sessionId: (k) => `telegram-${k}`, now: () => 1000, ...over,
});

test('a session already on disk is resumed, never recreated', async () => {
  const seen = [];
  const s = make();
  await s.acquire('42', {
    persistence: { list: async () => [{ id: 'telegram-42' }] },
    resume: async (id) => { seen.push(['resume', id]); return handle('r'); },
    create: async (id) => { seen.push(['create', id]); return handle('c'); },
  });
  assert.deepEqual(seen, [['resume', 'telegram-42']]);
});

test('an unknown chat creates a session', async () => {
  const seen = [];
  const s = make();
  await s.acquire('9', {
    persistence: { list: async () => [] },
    resume: async () => { throw new Error('must not resume'); },
    create: async (id) => { seen.push(id); return handle('c'); },
  });
  assert.deepEqual(seen, ['telegram-9']);
});

test('a failed resume falls back to a fresh session so the bot keeps answering', async () => {
  const s = make();
  const got = await s.acquire('7', {
    persistence: { list: async () => [{ id: 'telegram-7' }] },
    resume: async () => { throw new Error('log unreadable'); },
    create: async () => handle('c'),
  });
  assert.equal(got.handle.tag, 'c');
});

test('an unreadable persistence listing does not stop the chat', async () => {
  const s = make();
  const got = await s.acquire('7', {
    persistence: { list: async () => { throw new Error('nope'); } },
    resume: async () => handle('r'),
    create: async () => handle('c'),
  });
  assert.equal(got.handle.tag, 'c');
});

test('the same chat reuses its live agent', async () => {
  let creates = 0;
  const s = make();
  const deps = { persistence: null, resume: async () => handle('r'), create: async () => { creates++; return handle('c'); } };
  await s.acquire('1', deps);
  await s.acquire('1', deps);
  assert.equal(creates, 1);
});

test('sessions map back to their chat, which is how replies find their way home', async () => {
  const s = make();
  await s.acquire('55', { persistence: null, resume: async () => handle('r'), create: async () => handle('c') });
  assert.equal(s.chatFor('telegram-55'), '55');
  assert.equal(s.chatFor('telegram-nope'), undefined);
});

test('idle chats are evicted and their agents disposed — the leak the original had', async () => {
  let now = 0;
  const s = make({ now: () => now, idleMs: 100 });
  const h = handle('c');
  await s.acquire('1', { persistence: null, resume: async () => h, create: async () => h });
  now = 1000;
  await s.evict();
  assert.equal(s.byChat.size, 0);
  assert.equal(h.disposed, true);
  assert.equal(s.chatFor('telegram-1'), undefined, 'the reverse index must be cleaned too');
});

test('the chat cap evicts the oldest first', async () => {
  let now = 0;
  const s = make({ now: () => now, max: 2, idleMs: 1e9 });
  for (const k of ['a', 'b', 'c']) {
    now += 10;
    await s.acquire(k, { persistence: null, resume: async () => handle(k), create: async () => handle(k) });
  }
  assert.equal(s.byChat.size, 2);
  assert.equal(s.byChat.has('a'), false, 'oldest goes first');
  assert.equal(s.byChat.has('c'), true);
});

test('forget disposes the agent and reports whether there was one', async () => {
  const s = make();
  const h = handle('c');
  await s.acquire('3', { persistence: null, resume: async () => h, create: async () => h });
  assert.equal(await s.forget('3'), true);
  assert.equal(h.disposed, true);
  assert.equal(await s.forget('3'), false);
});
