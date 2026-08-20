import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitMessage, openFence, TELEGRAM_LIMIT } from '../src/chunk.js';

test('short text is one chunk', () => {
  assert.deepEqual(splitMessage('hello'), ['hello']);
});

test('empty or blank text produces nothing to send', () => {
  assert.deepEqual(splitMessage(''), []);
  assert.deepEqual(splitMessage('   \n '), []);
  assert.deepEqual(splitMessage(null), []);
});

test('every chunk fits inside Telegram\'s hard limit', () => {
  const text = 'word '.repeat(5000);
  for (const c of splitMessage(text)) assert.ok(c.length <= TELEGRAM_LIMIT, `chunk was ${c.length}`);
});

test('splits on a paragraph break when one is available', () => {
  const a = 'a'.repeat(3000), b = 'b'.repeat(3000);
  const [first] = splitMessage(`${a}\n\n${b}`);
  assert.equal(first, a);
});

test('no content is lost across a split', () => {
  const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
  const joined = splitMessage(text, 500).join('\n');
  for (const probe of ['line 0', 'line 137', 'line 399']) assert.ok(joined.includes(probe));
});

test('a code fence left open is reopened in the next chunk', () => {
  const code = 'x = 1\n'.repeat(400);
  const chunks = splitMessage('intro\n\n```python\n' + code + '```\n', 500);
  assert.ok(chunks.length > 1);
  for (const c of chunks.slice(1)) {
    if (c.includes('x = 1')) assert.ok(c.startsWith('```'), 'continuation must reopen the fence');
  }
  for (const c of chunks) {
    assert.equal((c.match(/^```/gm) ?? []).length % 2, 0, 'each chunk balances its fences');
  }
});

test('openFence reports the language of an unclosed fence', () => {
  assert.equal(openFence('```js\ncode'), 'js');
  assert.equal(openFence('```js\ncode\n```'), null);
  assert.equal(openFence('no fences here'), null);
});
