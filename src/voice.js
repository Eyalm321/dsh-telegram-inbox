/**
 * Voice notes → text, without blocking the process.
 *
 * The plugin this replaces called `execFileSync` with a 120-second timeout, on the
 * same thread as the poll loop. One voice note therefore froze every chat, stopped
 * Telegram polling, and stalled every running agent turn for up to two minutes.
 * Here the transcriber is spawned asynchronously and the loop keeps running.
 *
 * @module dsh-telegram-inbox/voice
 */
import { execFile } from 'node:child_process';
import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

/**
 * Run the configured transcriber. Contract is `<command> <audio-file> auto`, with
 * the transcript on stdout — the same contract the previous plugin used, so an
 * existing local transcriber keeps working unchanged.
 */
export function runTranscriber(command, audioPath, { timeoutMs = 120000, execFileImpl = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, [audioPath, 'auto'], { timeout: timeoutMs, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => {
        if (err) {
          err.message = `transcriber failed: ${err.message}${stderr ? ` — ${String(stderr).trim().slice(0, 200)}` : ''}`;
          reject(err);
          return;
        }
        resolve(String(stdout).trim());
      });
  });
}

/**
 * Download a voice message and transcribe it. Returns the transcript, or null when
 * no transcriber is configured. Throws when transcription was attempted and failed —
 * "not configured" and "broken" are different answers and the caller says so.
 *
 * The audio is written into a private per-call directory rather than a predictable
 * path in the shared temp dir: voice notes are the user's speech, and a guessable
 * name in a world-readable directory is an avoidable disclosure.
 */
export async function transcribeVoice(client, fileId, command, opts = {}) {
  if (!command) return null;
  const { bytes, filePath } = await client.downloadFile(fileId);
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tg-voice-'));
  const audio = join(dir, `audio${extname(filePath) || '.oga'}`);
  try {
    await writeFile(audio, bytes, { mode: 0o600 });
    const transcript = await runTranscriber(command, audio, opts);
    return transcript || null;
  } finally {
    await unlink(audio).catch(() => {});
  }
}
