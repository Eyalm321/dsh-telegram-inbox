import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneStaleContext, isContextSnapshot, CONTEXT_SOURCE, MARKER } from '../src/staleContext.js';

const snapshot = (seq, text) => ({
  seq, type: 'user/message',
  data: { role: 'user', id: `m${seq}`, content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: CONTEXT_SOURCE } },
});
const human = (seq, text) => ({
  seq, type: 'user/message',
  data: { role: 'user', id: `m${seq}`, content: [{ type: 'text', text }], source: { kind: 'user' } },
});

function fakeSession(events, surfaceSeqs) {
  const appended = [];
  return {
    events,
    surface: { nodes: surfaceSeqs ?? events.map((e) => e.seq) },
    append: (type, data, opts) => { appended.push({ type, data, opts }); return { seq: 900 + appended.length }; },
    appended,
  };
}

test('a system-prompt snapshot is recognised; a human message is not', () => {
  assert.equal(isContextSnapshot(snapshot(1, 'x')), true);
  assert.equal(isContextSnapshot(human(1, 'x')), false);
  assert.equal(isContextSnapshot({ type: 'assistant/message' }), false);
  assert.equal(isContextSnapshot(undefined), false);
});

test('every snapshot on the surface is replaced', () => {
  const s = fakeSession([snapshot(1, 'policy: workspace-write'), human(2, 'hi'), snapshot(3, 'policy: workspace-write')]);
  const out = pruneStaleContext(s);
  assert.deepEqual(out.replaced, [1, 3]);
  assert.equal(s.appended.length, 2);
});

test('the replacement uses the surface-replace op citing the original seq', () => {
  const s = fakeSession([snapshot(7, 'stale')]);
  pruneStaleContext(s);
  const { type, data, opts } = s.appended[0];
  assert.equal(type, 'user/message');
  assert.deepEqual(opts.surfaceOp, { op: 'replace', start: 7, end: 7 });
  assert.deepEqual(opts.sourceEventSeqs, [7]);
  assert.equal(data.content[0].text, MARKER);
});

test('the replacement keeps the original source, so the loop still owns it', () => {
  const s = fakeSession([snapshot(4, 'stale')]);
  pruneStaleContext(s);
  assert.deepEqual(s.appended[0].data.source, { kind: 'plugin', plugin: CONTEXT_SOURCE });
  assert.equal(s.appended[0].data.role, 'user', 'unrelated fields are preserved');
});

test('human messages and assistant turns are never touched', () => {
  const s = fakeSession([human(1, 'do the thing'), { seq: 2, type: 'assistant/message', data: {} }]);
  const out = pruneStaleContext(s);
  assert.deepEqual(out.replaced, []);
  assert.equal(s.appended.length, 0);
});

test('events shadowed off the surface are left alone', () => {
  const s = fakeSession([snapshot(1, 'already replaced'), snapshot(2, 'live')], [2]);
  const out = pruneStaleContext(s);
  assert.deepEqual(out.replaced, [2]);
});

test('an append failure is contained — one bad seq must not abort the resume', () => {
  const s = fakeSession([snapshot(1, 'a'), snapshot(2, 'b')]);
  let first = true;
  s.append = () => { if (first) { first = false; throw new Error('rejected'); } return { seq: 99 }; };
  const warned = [];
  const out = pruneStaleContext(s, { log: { warn: (m) => warned.push(m), info() {}, debug() {} } });
  assert.deepEqual(out.replaced, [2]);
  assert.match(warned[0], /seq 1/);
});

test('an unfamiliar session shape degrades to no pruning, never to a throw', () => {
  assert.deepEqual(pruneStaleContext({}).replaced, []);
  assert.equal(pruneStaleContext({}).skipped, 'session surface unavailable');
  assert.deepEqual(pruneStaleContext(undefined).replaced, []);
});

test('a session with nothing stale appends nothing', () => {
  const s = fakeSession([human(1, 'hello')]);
  assert.deepEqual(pruneStaleContext(s), { replaced: [], skipped: null });
});
