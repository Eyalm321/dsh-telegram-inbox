import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTranscriber, transcribeVoice } from '../src/voice.js';

test('the transcriber contract is `<cmd> <audio> auto` on stdout', async () => {
  let args;
  const out = await runTranscriber('t', '/tmp/a.oga', {
    execFileImpl: (cmd, a, _o, cb) => { args = [cmd, ...a]; cb(null, '  hello there \n', ''); },
  });
  assert.deepEqual(args, ['t', '/tmp/a.oga', 'auto']);
  assert.equal(out, 'hello there');
});

test('a failing transcriber rejects with stderr context, not a silent empty string', async () => {
  await assert.rejects(
    () => runTranscriber('t', '/tmp/a', { execFileImpl: (_c, _a, _o, cb) => cb(new Error('exit 1'), '', 'model missing') }),
    /transcriber failed: exit 1 — model missing/);
});

test('no configured transcriber returns null — "not set up" differs from "broken"', async () => {
  assert.equal(await transcribeVoice({}, 'file', undefined), null);
});

test('voice audio is downloaded through the client, never a subprocess', async () => {
  let asked;
  const client = { downloadFile: async (id) => { asked = id; return { bytes: Buffer.from('x'), filePath: 'v/a.oga' }; } };
  const out = await transcribeVoice(client, 'file-1', 'cmd', {
    execFileImpl: (_c, a, _o, cb) => cb(null, `transcribed ${a[0].endsWith('.oga')}`, ''),
  });
  assert.equal(asked, 'file-1');
  assert.equal(out, 'transcribed true', 'the audio keeps its extension for the transcriber');
});

test('the temp audio file is removed even when transcription throws', async () => {
  const client = { downloadFile: async () => ({ bytes: Buffer.from('x'), filePath: 'v/a.oga' }) };
  let path;
  await assert.rejects(() => transcribeVoice(client, 'f', 'cmd', {
    execFileImpl: (_c, a, _o, cb) => { path = a[0]; cb(new Error('boom'), '', ''); },
  }));
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(path), false, 'a voice note must not be left on disk');
});

test('an empty transcript reads as nothing said, not as text', async () => {
  const client = { downloadFile: async () => ({ bytes: Buffer.from('x'), filePath: 'a.oga' }) };
  assert.equal(await transcribeVoice(client, 'f', 'cmd',
    { execFileImpl: (_c, _a, _o, cb) => cb(null, '   ', '') }), null);
});
