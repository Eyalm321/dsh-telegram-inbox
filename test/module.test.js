import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/log.js';

// The other tests exercise harness-free modules. This one imports the entrypoint so a
// syntax or bad-import error in index.js cannot ship green.
test('the plugin exports the Cordis surface', async () => {
  const mod = await import('../src/index.js');
  assert.equal(mod.name, 'dsh-telegram-inbox');
  assert.equal(typeof mod.apply, 'function');
  assert.deepEqual(mod.inject, ['agents']);
});

test('a missing token is reported, and apply gives up rather than half-starting', async () => {
  const { apply } = await import('../src/index.js');
  const lines = [];
  const ctx = { agents: {}, get: () => undefined, on: () => {}, effect: () => { throw new Error('must not mount'); } };
  const orig = console.error;
  console.error = (m) => lines.push(String(m));
  try { apply(ctx, { agentName: 't', tokenFile: '/nonexistent/token' }); }
  finally { console.error = orig; }
  assert.ok(lines.some((l) => /could not read token file/.test(l)));
});

test('visibleText keeps text blocks and drops everything else', async () => {
  const { visibleText } = await import('../src/index.js');
  assert.equal(visibleText({ content: [{ type: 'text', text: 'a' }, { type: 'thinking' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(visibleText(undefined), '');
});

test('log levels filter as expected and debug is off by default', () => {
  const seen = [];
  const log = createLogger('x', 'info', (m) => seen.push(m));
  log.debug('noisy'); log.info('kept'); log.error('bad');
  assert.equal(seen.length, 2);
  assert.match(seen[1], /error: bad/);
});
