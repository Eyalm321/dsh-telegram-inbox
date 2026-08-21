import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Handoff } from '../src/handoff.js';
import { AutoHandoff, AUTO_OWNER, isAutoClaim } from '../src/autoHandoff.js';

/**
 * A stand-in for the stored session log. Nothing here touches a real log: the point of
 * the module under test is that it never has to, and a test that decompressed a fixture
 * would be testing the wrong thing.
 *
 * `revision` is the cheap signal (one stat in production); `tail` is the expensive one,
 * and it counts its calls so a test can assert the poll is not paying for it.
 */
function fakeLog() {
  const rows = new Map();
  let decodes = 0;
  return {
    decodes: () => decodes,
    /** The state the log is already in when the daemon first sees it. */
    seed(id, v) { rows.set(id, { rev: 1, seq: -1, time: 0, turnOpen: false, ...v }); },
    /** Somebody appended: the revision moves, whoever it was. */
    write(id, v) {
      const cur = rows.get(id) ?? { rev: 0, seq: -1, time: 0, turnOpen: false };
      rows.set(id, { ...cur, ...v, rev: cur.rev + 1 });
    },
    async revision(id) { const r = rows.get(id); return r ? `rev-${r.rev}` : null; },
    async tail(id) {
      decodes += 1;
      const r = rows.get(id);
      return r && r.seq >= 0 ? { seq: r.seq, time: r.time, turnOpen: r.turnOpen } : null;
    },
  };
}

/**
 * The daemon, reduced to the three things it actually does with a session: hold a live
 * agent for it, drop that agent, and deliver a message into it. Every assertion below is
 * on one of those, never on a flag inside the decision.
 */
function daemon(opts = {}) {
  const clock = { t: 1_000_000 };
  const logs = opts.logs ?? fakeLog();
  const handoff = new Handoff(mkdtempSync(join(tmpdir(), 'auto-handoff-')), { now: () => clock.t });
  const live = new Set(opts.live ?? []);
  const dropped = [];
  const delivered = [];
  const auto = new AutoHandoff({
    handoff,
    logs,
    enabled: opts.enabled,
    quietMs: opts.quietMs,
    staleTurnMs: opts.staleTurnMs,
    now: () => clock.t,
    liveSessions: () => [...live],
    dropAgent: async (id) => {
      if (!live.delete(id)) return false;
      dropped.push(id);
      return true;
    },
    deliver: async (id, message) => { delivered.push(text(message)); live.add(id); },
  });
  return { auto, handoff, logs, clock, live, dropped, delivered };
}

const text = (message) => message.content.map((b) => b.text).join('');
const say = (words) => ({ chatKey: '1', content: [{ type: 'text', text: words }], at: 0 });

// ── rule 1 + rule 2: last speaker wins ───────────────────────────────────────

test('a write from somewhere else takes the chat away, and the next Telegram message takes it back', async () => {
  const d = daemon({ live: ['telegram-1'] });
  d.logs.seed('telegram-1', { seq: 10 });
  await d.auto.watch('telegram-1');

  d.logs.write('telegram-1', { seq: 12, time: d.clock.t });   // Eyal typed in the web UI
  await d.auto.service();

  assert.deepEqual(d.dropped, ['telegram-1'], 'the daemon dropped its agent rather than write alongside');
  assert.equal(d.handoff.claimOf('telegram-1').owner, AUTO_OWNER);
  assert.equal(d.handoff.isAcked('telegram-1'), true, 'and stamped it, so a waiting client knows');

  const out = await d.auto.admit('telegram-1', say('and now here'));

  assert.equal(out.delivered, true);
  assert.deepEqual(d.delivered, ['and now here'], 'his message is the signal to switch, not something to queue');
  assert.equal(d.handoff.isClaimed('telegram-1'), false, 'ownership followed the last speaker');
});

test('the auto claim is the ordinary claim machinery, so status and parking still work', async () => {
  const d = daemon({ live: ['telegram-1'] });
  d.logs.seed('telegram-1', { seq: 1 });
  await d.auto.watch('telegram-1');
  d.logs.write('telegram-1', { seq: 2, time: d.clock.t });
  await d.auto.service();

  const claim = d.handoff.claimOf('telegram-1');
  assert.equal(isAutoClaim(claim), true);
  assert.match(claim.owner, /web UI/, 'a person reading `dsh-handoff.sh status` gets a sentence, not a flag');
});

test('an auto claim with nothing waiting is left alone: the daemon stays off while the other side is active', async () => {
  const d = daemon({ live: ['telegram-1'] });
  d.logs.seed('telegram-1', { seq: 10 });
  await d.auto.watch('telegram-1');
  d.logs.write('telegram-1', { seq: 12, time: d.clock.t });
  await d.auto.service();

  d.clock.t += 60_000;
  await d.auto.service();
  await d.auto.service();

  assert.equal(d.handoff.claimOf('telegram-1').owner, AUTO_OWNER, 'nothing asked for it back');
  assert.deepEqual(d.delivered, []);
});

// ── rule 3: never interrupt a running turn ───────────────────────────────────

test('a message arriving while another client is mid-turn is queued, and replayed when that turn ends', async () => {
  const d = daemon({ live: ['telegram-1'] });
  d.logs.seed('telegram-1', { seq: 10 });
  await d.auto.watch('telegram-1');

  d.logs.write('telegram-1', { seq: 12, time: d.clock.t, turnOpen: true });
  await d.auto.service();
  assert.deepEqual(d.dropped, ['telegram-1']);

  const out = await d.auto.admit('telegram-1', say('quick question'));
  assert.equal(out.parked, true);
  assert.equal(out.reason, 'turn', 'and he is told which kind of waiting this is');
  assert.deepEqual(d.delivered, [], 'the running turn was not interrupted');
  assert.deepEqual(d.handoff.parked('telegram-1').map(text), ['quick question']);
  assert.equal(d.handoff.isClaimed('telegram-1'), true, 'the other side keeps it while it works');

  d.clock.t += 5_000;
  d.logs.write('telegram-1', { seq: 20, time: d.clock.t, turnOpen: false });
  await d.auto.service();

  assert.deepEqual(d.delivered, ['quick question'], 'replayed the moment the turn ended');
  assert.equal(d.handoff.isClaimed('telegram-1'), false);
});

test('a message arriving during the daemon own turn is handed straight to the agent', async () => {
  const d = daemon({ live: ['telegram-1'] });
  d.logs.seed('telegram-1', { seq: 10, turnOpen: true, time: 1_000_000 });
  await d.auto.watch('telegram-1');
  d.auto.noteEvent('telegram-1', { type: 'turn/start', seq: 11, time: d.clock.t });

  const out = await d.auto.admit('telegram-1', say('one more thing'));

  assert.equal(out.delivered, true, 'one writer already, so the harness queues it for the next turn');
  assert.deepEqual(d.delivered, ['one more thing']);
});

test('a message parked for a running turn is not walked back into that turn a moment later', async () => {
  const d = daemon();                       // chat evicted hours ago: no agent, no claim yet
  d.logs.seed('telegram-1', { seq: 5, time: 1_000_000, turnOpen: true });

  const out = await d.auto.admit('telegram-1', say('hello'));
  assert.equal(out.parked, true);
  assert.equal(out.reason, 'turn');

  await d.auto.service();
  assert.deepEqual(d.delivered, [], 'the released-with-pending path must not pick this up');

  d.clock.t += 5_000;
  d.logs.write('telegram-1', { seq: 9, time: d.clock.t, turnOpen: false });
  await d.auto.service();

  assert.deepEqual(d.delivered, ['hello'], 'and it is answered once that turn is over');
});

test('a turn that started long ago and never ended is a crashed process, not a reason to wait', async () => {
  const d = daemon({ live: ['telegram-1'], staleTurnMs: 900_000 });
  d.logs.seed('telegram-1', { seq: 10 });
  await d.auto.watch('telegram-1');
  d.logs.write('telegram-1', { seq: 12, time: d.clock.t, turnOpen: true });
  await d.auto.service();
  assert.equal(d.handoff.claimOf('telegram-1').owner, AUTO_OWNER);

  d.clock.t += 900_001;                       // nothing has touched that log since
  const out = await d.auto.admit('telegram-1', say('still there?'));

  assert.equal(out.delivered, true, 'a dead turn must not park his messages forever');
  assert.deepEqual(d.delivered, ['still there?']);
  assert.equal(d.handoff.isClaimed('telegram-1'), false);
});

test('an open turn still being written to is honoured right up to the staleness edge', async () => {
  const d = daemon({ live: ['telegram-1'], staleTurnMs: 900_000 });
  d.logs.seed('telegram-1', { seq: 10 });
  await d.auto.watch('telegram-1');
  d.logs.write('telegram-1', { seq: 12, time: d.clock.t, turnOpen: true });
  await d.auto.service();

  d.clock.t += 900_000;
  const out = await d.auto.admit('telegram-1', say('hello'));

  assert.equal(out.parked, true, 'exactly at the limit the turn is still alive');
});

// ── rule 4: explicit beats inferred ──────────────────────────────────────────

test('a claim a person made is never released by inference', async () => {
  const d = daemon({ live: ['telegram-1'] });
  d.logs.seed('telegram-1', { seq: 10 });
  await d.auto.watch('telegram-1');

  d.handoff.claim('telegram-1', 'the web UI');
  await d.auto.service();
  assert.deepEqual(d.dropped, ['telegram-1']);

  const out = await d.auto.admit('telegram-1', say('hi'));
  assert.equal(out.parked, true);
  assert.equal(out.owner, 'the web UI');
  assert.equal(d.handoff.isClaimed('telegram-1'), true);

  // ...and it survives the log going quiet with something waiting, which is exactly the
  // condition that would take an inferred claim back.
  d.logs.write('telegram-1', { seq: 30, time: d.clock.t, turnOpen: false });
  await d.auto.service();

  assert.equal(d.handoff.isClaimed('telegram-1'), true, 'only a person can undo a person');
  assert.deepEqual(d.delivered, []);

  d.handoff.release('telegram-1');
  await d.auto.service();
  assert.deepEqual(d.delivered, ['hi'], 'and releasing by hand still replays what was parked');
});

test('a manual claim is not overwritten by detection', async () => {
  const d = daemon({ live: ['telegram-1'] });
  d.logs.seed('telegram-1', { seq: 10 });
  await d.auto.watch('telegram-1');
  d.handoff.claim('telegram-1', 'the CLI');
  d.logs.write('telegram-1', { seq: 40, time: d.clock.t });

  await d.auto.service();

  assert.equal(d.handoff.claimOf('telegram-1').owner, 'the CLI');
});

// ── telling our own writing from somebody else's ─────────────────────────────

test('the daemon own writing does not make it hand the chat to nobody', async () => {
  const d = daemon({ live: ['telegram-1'] });
  d.logs.seed('telegram-1', { seq: 10 });
  await d.auto.watch('telegram-1');

  // A turn here: events are seen as they are written, and reach the log a moment later.
  d.auto.noteEvent('telegram-1', { type: 'turn/start', seq: 11, time: d.clock.t });
  d.auto.noteEvent('telegram-1', { type: 'assistant/message', seq: 13, time: d.clock.t });
  d.logs.write('telegram-1', { seq: 13, time: d.clock.t, turnOpen: true });
  await d.auto.service();

  assert.deepEqual(d.dropped, [], 'that was us');
  assert.equal(d.handoff.isClaimed('telegram-1'), false);

  d.auto.noteEvent('telegram-1', { type: 'turn/end', seq: 14, time: d.clock.t });
  d.logs.write('telegram-1', { seq: 14, time: d.clock.t, turnOpen: false });
  await d.auto.service();

  assert.deepEqual(d.dropped, []);
  assert.equal(d.handoff.isClaimed('telegram-1'), false, 'still ours at the end of the turn');
});

test('a sequence beyond anything the daemon wrote is somebody else, even mid-turn', async () => {
  const d = daemon({ live: ['telegram-1'] });
  d.logs.seed('telegram-1', { seq: 10 });
  await d.auto.watch('telegram-1');
  d.auto.noteEvent('telegram-1', { type: 'turn/end', seq: 11, time: d.clock.t });
  d.logs.write('telegram-1', { seq: 12, time: d.clock.t });

  await d.auto.service();

  assert.deepEqual(d.dropped, ['telegram-1']);
  assert.equal(d.handoff.claimOf('telegram-1').owner, AUTO_OWNER);
});

test('the state a resume leaves on disk is absorbed as ours, not read as a stranger', async () => {
  const d = daemon({ live: ['telegram-1'] });
  // The log already holds 200 events the daemon never saw as events: it just resumed it.
  d.logs.seed('telegram-1', { seq: 200 });
  await d.auto.watch('telegram-1');
  d.logs.write('telegram-1', { seq: 200, time: d.clock.t });   // an append that changes nothing logical

  await d.auto.service();

  assert.deepEqual(d.dropped, [], 'a baseline taken at acquire time is what makes this safe');
});

// ── cost ─────────────────────────────────────────────────────────────────────

test('a log that has not changed is never decoded: the poll costs one stat', async () => {
  const d = daemon({ live: ['telegram-1'] });
  d.logs.seed('telegram-1', { seq: 10 });
  await d.auto.watch('telegram-1');
  const baseline = d.logs.decodes();

  await d.auto.service();
  await d.auto.service();
  await d.auto.service();

  assert.equal(d.logs.decodes(), baseline, 'nothing wrote, so nothing was decompressed');
});

test('waiting on somebody else\'s turn does not decode the log once per poll', async () => {
  const d = daemon({ live: ['telegram-1'] });
  d.logs.seed('telegram-1', { seq: 10 });
  await d.auto.watch('telegram-1');
  d.logs.write('telegram-1', { seq: 12, time: d.clock.t, turnOpen: true });
  await d.auto.service();
  await d.auto.admit('telegram-1', say('waiting'));

  const baseline = d.logs.decodes();
  for (let i = 0; i < 10; i++) { d.clock.t += 25_000; await d.auto.service(); }

  assert.equal(d.logs.decodes(), baseline, 'the tail cannot change while the revision does not');
  assert.deepEqual(d.delivered, [], 'and the turn is still held to be running');
});

test('once the log does change, the tail is read again', async () => {
  const d = daemon({ live: ['telegram-1'] });
  d.logs.seed('telegram-1', { seq: 10 });
  await d.auto.watch('telegram-1');
  d.logs.write('telegram-1', { seq: 12, time: d.clock.t, turnOpen: true });
  await d.auto.service();
  await d.auto.admit('telegram-1', say('waiting'));
  const baseline = d.logs.decodes();

  d.clock.t += 25_000;
  d.logs.write('telegram-1', { seq: 18, time: d.clock.t, turnOpen: false });
  await d.auto.service();

  assert.ok(d.logs.decodes() > baseline, 'a changed revision is the only thing that pays for a decode');
  assert.deepEqual(d.delivered, ['waiting']);
});

// ── ordering ─────────────────────────────────────────────────────────────────

test('taking the chat back answers what was already waiting before the message that asked for it', async () => {
  const d = daemon({ live: ['telegram-1'] });
  d.logs.seed('telegram-1', { seq: 10 });
  await d.auto.watch('telegram-1');
  d.logs.write('telegram-1', { seq: 12, time: d.clock.t, turnOpen: true });
  await d.auto.service();

  await d.auto.admit('telegram-1', say('first'));
  await d.auto.admit('telegram-1', say('second'));
  assert.deepEqual(d.delivered, []);

  d.logs.write('telegram-1', { seq: 20, time: d.clock.t, turnOpen: false });
  const out = await d.auto.admit('telegram-1', say('third'));

  assert.equal(out.tookBack, true);
  assert.deepEqual(d.delivered, ['first', 'second', 'third'], 'in the order he sent them');
  assert.deepEqual(d.handoff.parked('telegram-1'), []);
});

// ── quietMs ──────────────────────────────────────────────────────────────────

test('quietMs makes Telegram wait for the other side to go quiet before taking over', async () => {
  const d = daemon({ live: ['telegram-1'], quietMs: 60_000 });
  d.logs.seed('telegram-1', { seq: 10 });
  await d.auto.watch('telegram-1');
  d.logs.write('telegram-1', { seq: 12, time: d.clock.t });
  await d.auto.service();                             // notices the write, records the moment

  d.clock.t += 30_000;
  const early = await d.auto.admit('telegram-1', say('mine now'));
  assert.equal(early.parked, true);
  assert.equal(early.reason, 'busy');
  assert.equal(d.handoff.isClaimed('telegram-1'), true);

  d.clock.t += 30_001;                                // 60s of silence on the other side
  await d.auto.service();

  assert.equal(d.handoff.isClaimed('telegram-1'), false);
  assert.deepEqual(d.delivered, ['mine now']);
});

test('with quietMs at zero the takeback is immediate: the default is not to make him wait', async () => {
  const d = daemon({ live: ['telegram-1'] });
  d.logs.seed('telegram-1', { seq: 10 });
  await d.auto.watch('telegram-1');
  d.logs.write('telegram-1', { seq: 12, time: d.clock.t });
  await d.auto.service();

  const out = await d.auto.admit('telegram-1', say('mine now'));

  assert.equal(out.delivered, true, 'no timer stands between him and an answer');
});

// ── autoHandoff: false ───────────────────────────────────────────────────────

test('with autoHandoff off nothing is inferred, and manual handoff behaves exactly as before', async () => {
  const d = daemon({ live: ['telegram-1'], enabled: false });
  d.logs.seed('telegram-1', { seq: 10 });
  await d.auto.watch('telegram-1');

  d.logs.write('telegram-1', { seq: 99, time: d.clock.t, turnOpen: true });
  await d.auto.service();
  assert.equal(d.handoff.isClaimed('telegram-1'), false, 'no claim is invented');
  assert.deepEqual(d.dropped, []);

  const first = await d.auto.admit('telegram-1', say('hi'));
  assert.equal(first.delivered, true, 'an open turn elsewhere is not this mode\'s concern');

  d.handoff.claim('telegram-1', 'the CLI');
  const second = await d.auto.admit('telegram-1', say('later'));
  assert.equal(second.parked, true);
  assert.equal(second.owner, 'the CLI');

  await d.auto.service();
  assert.deepEqual(d.dropped, ['telegram-1'], 'the claim is still honoured');
  assert.equal(d.handoff.isAcked('telegram-1'), true);

  d.handoff.release('telegram-1');
  await d.auto.service();

  assert.deepEqual(d.delivered, ['hi', 'later']);
  assert.equal(d.logs.decodes(), 0, 'and no session log is read at all in this mode');
});

// ── the feature switched off entirely ────────────────────────────────────────

test('with no handoff directory the daemon just answers', async () => {
  const logs = fakeLog();
  const delivered = [];
  const auto = new AutoHandoff({
    handoff: new Handoff(null),
    logs,
    deliver: async (_id, m) => { delivered.push(text(m)); },
  });

  await auto.service();
  const out = await auto.admit('telegram-1', say('hi'));

  assert.equal(out.delivered, true);
  assert.deepEqual(delivered, ['hi']);
  assert.equal(logs.decodes(), 0);
});
