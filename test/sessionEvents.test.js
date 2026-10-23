import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionEvents } from '../src/sessionEvents.js';

const log = [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'turn/end' }];

test('dsh 0.2.x: the log comes from snapshotEvents()', () => {
  assert.deepEqual(sessionEvents({ snapshotEvents: () => Object.freeze([...log]) }), log);
});

test('dsh 0.1.x: the log is the events array', () => {
  assert.equal(sessionEvents({ events: log }), log);
});

test('snapshotEvents() wins when a session offers both', () => {
  const fresh = [log[0]];
  assert.equal(sessionEvents({ events: log, snapshotEvents: () => fresh }), fresh);
});

test('a session with neither shape yields undefined, so callers degrade instead of throwing', () => {
  assert.equal(sessionEvents({}), undefined);
  assert.equal(sessionEvents(undefined), undefined);
  assert.equal(sessionEvents({ events: 'nope' }), undefined);
});
