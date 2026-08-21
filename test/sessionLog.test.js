import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionLog, readTailText, readTailEvents, rowSeq, rowTime } from '../src/sessionLog.js';

const row = (o) => JSON.stringify(o);
const log = (...rows) => rows.map(row).join('\n') + '\n';

const HEADER = { type: 'session', version: 1, id: 'telegram-1', createdAt: 0 };

test('a turn with no end after it is open', () => {
  const tail = readTailText(log(
    HEADER,
    { type: 'turn/start', seq: 1, time: 100, data: {} },
    { type: 'assistant/chunk', seq: 2, time: 150, data: {} },
  ));
  assert.deepEqual(tail, { seq: 2, time: 150, turnOpen: true });
});

test('the last row mid-turn is a chunk, not a boundary, so reading one line would answer wrong', () => {
  const text = log(
    HEADER,
    { type: 'turn/start', seq: 1, time: 100, data: {} },
    { type: 'assistant/chunk', seq: 2, time: 110, data: {} },
    { type: 'assistant/chunk', seq: 3, time: 120, data: {} },
  );
  assert.equal(readTailText(text).turnOpen, true);
  assert.equal(JSON.parse(text.trim().split('\n').at(-1)).type, 'assistant/chunk');
});

test('a closed turn is closed, whatever was written after it', () => {
  const tail = readTailText(log(
    HEADER,
    { type: 'turn/start', seq: 1, time: 100, data: {} },
    { type: 'turn/end', seq: 2, time: 200, data: {} },
    { type: 'agent/inbox/spliced', seq: 3, time: 300, data: {} },
  ));
  assert.deepEqual(tail, { seq: 3, time: 300, turnOpen: false });
});

test('a log that has never run a turn is not mid-turn', () => {
  const tail = readTailText(log(HEADER, { type: 'sandbox/mode', seq: 1, time: 10, data: {} }));
  assert.deepEqual(tail, { seq: 1, time: 10, turnOpen: false });
});

test('a header on its own says nothing has been written', () => {
  assert.equal(readTailText(log(HEADER)), null);
  assert.equal(readTailText(''), null);
  assert.equal(readTailText(undefined), null);
});

test('a packed run of chunks stands for its last member, not its first', () => {
  // seq0 3 with three inter-arrival gaps is four events: 3, 4, 5, 6.
  const packed = { type: 'text-chunks', seq0: 3, time0: 100, data: { turn: 1, step: 1, index: 0, text: ['a', 'b', 'c', 'd'], dt: [5, 5, 10] } };
  assert.equal(rowSeq(packed), 6);
  assert.equal(rowTime(packed), 120);

  const tail = readTailText(log(HEADER, { type: 'turn/start', seq: 2, time: 90, data: {} }, packed));
  assert.deepEqual(tail, { seq: 6, time: 120, turnOpen: true });
});

test('a torn final line does not derail the read', () => {
  const text = log(HEADER, { type: 'turn/end', seq: 1, time: 50, data: {} }) + '{"type":"assistant/ch';
  assert.deepEqual(readTailText(text), { seq: 1, time: 50, turnOpen: false });
});

test('the same walk works over decoded events, for a backend with no raw artifact', () => {
  assert.deepEqual(
    readTailEvents([
      { type: 'turn/start', seq: 1, time: 100 },
      { type: 'assistant/chunk', seq: 2, time: 110 },
    ]),
    { seq: 2, time: 110, turnOpen: true },
  );
  assert.equal(readTailEvents([]), null);
});

test('the cheap signal is one revision read, and it is null when nothing is stored', async () => {
  const calls = [];
  const logs = new SessionLog({
    persistence: {
      readStoredRevision: async (id) => { calls.push(id); return id === 'telegram-1' ? 'dev:ino:size:mtime' : undefined; },
    },
  });
  assert.equal(await logs.revision('telegram-1'), 'dev:ino:size:mtime');
  assert.equal(await logs.revision('telegram-2'), null);
  assert.deepEqual(calls, ['telegram-1', 'telegram-2']);
});

test('a log that cannot be read leaves the daemon where it is rather than handing the chat to nobody', async () => {
  const warned = [];
  const logs = new SessionLog({
    persistence: {
      readStoredRevision: async () => { throw new Error('permission denied'); },
      supportsRawArtifacts: true,
      readRaw: async () => { throw new Error('permission denied'); },
    },
    log: { warn: (m) => warned.push(m), debug() {} },
  });
  assert.equal(await logs.revision('telegram-1'), null);
  assert.equal(await logs.tail('telegram-1'), null);
  assert.equal(warned.length, 2, 'and it says so, because a silent no is indistinguishable from a real one');
});

test('a backend without raw artifacts falls back to its decoded events', async () => {
  const logs = new SessionLog({
    persistence: {
      supportsRawArtifacts: false,
      inspect: async () => ({ meta: {}, events: [{ type: 'turn/start', seq: 7, time: 70 }] }),
    },
  });
  assert.deepEqual(await logs.tail('telegram-1'), { seq: 7, time: 70, turnOpen: true });
});

test('with no persistence service composed there is nothing to read', async () => {
  const logs = new SessionLog({ persistence: () => undefined });
  assert.equal(await logs.revision('telegram-1'), null);
  assert.equal(await logs.tail('telegram-1'), null);
});
