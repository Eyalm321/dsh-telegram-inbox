import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignSandboxMode, foldSessionMode } from '../src/sandboxMode.js';

const session = (modes) => {
  const appended = [];
  return {
    events: modes.map((m, i) => ({ seq: i, type: 'sandbox/mode', data: { mode: m } })),
    append: (type, data) => { appended.push({ type, data }); },
    appended,
  };
};

test('the folded mode is the last one recorded', () => {
  assert.equal(foldSessionMode(session(['read-only', 'workspace-write'])), 'workspace-write');
  assert.equal(foldSessionMode({ events: [] }), undefined);
  assert.equal(foldSessionMode(undefined), undefined);
});

test('a disagreeing session is switched, preset and mode together', () => {
  const s = session(['workspace-write']);
  const out = alignSandboxMode(s, 'danger-full-access');
  assert.deepEqual(out, { changed: true, from: 'workspace-write', to: 'danger-full-access' });
  assert.deepEqual(s.appended, [
    { type: 'permission/preset', data: { preset: 'danger-full-access' } },
    { type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
  ]);
});

test('an already-matching session is left completely alone', () => {
  const s = session(['danger-full-access']);
  assert.deepEqual(alignSandboxMode(s, 'danger-full-access'), { changed: false });
  assert.equal(s.appended.length, 0);
});

test('without an explicit deployment mode nothing is touched — no ambient re-privileging', () => {
  const s = session(['workspace-write']);
  assert.equal(alignSandboxMode(s, undefined).skipped, 'no explicit deployment mode');
  assert.equal(alignSandboxMode(s, '').changed, false);
  assert.equal(s.appended.length, 0);
});

test('an unknown mode is refused rather than written', () => {
  const s = session(['workspace-write']);
  assert.match(alignSandboxMode(s, 'yolo').skipped, /unknown mode/);
  assert.equal(s.appended.length, 0);
});

test('it can also downgrade — alignment is to the operator default, not to more power', () => {
  const s = session(['danger-full-access']);
  const out = alignSandboxMode(s, 'read-only');
  assert.equal(out.changed, true);
  assert.equal(out.to, 'read-only');
});

test('a session recording no mode is left alone', () => {
  const s = { events: [{ seq: 0, type: 'user/message', data: {} }], append: () => { throw new Error('no'); } };
  assert.equal(alignSandboxMode(s, 'danger-full-access').skipped, 'session records no mode');
});

test('an append failure is reported, not thrown', () => {
  const s = session(['workspace-write']);
  s.append = () => { throw new Error('log closed'); };
  const warned = [];
  const out = alignSandboxMode(s, 'danger-full-access', { log: { warn: (m) => warned.push(m), info() {} } });
  assert.equal(out.changed, false);
  assert.match(warned[0], /log closed/);
});
