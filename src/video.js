/**
 * Reading a video by looking at it.
 *
 * A model cannot watch a clip, so the only honest way to "read" one is to look at
 * still frames from it. The frames are sampled EVENLY ACROSS THE WHOLE CLIP rather
 * than from the first few seconds, because the opening seconds of a real video are
 * almost never the subject: a fishing video starts on the sky, a screen recording
 * starts on a desktop, a hand-held clip starts on the ground while the phone comes up.
 * Sampling the head reliably produces a confident description of nothing.
 *
 * Each frame is labelled with its position in the clip, so the model can say WHERE it
 * saw something ("the fish appears at 0:34") instead of just that it saw it.
 *
 * ffmpeg and ffprobe are run as subprocesses, asynchronously, never `execFileSync`,
 * for the same reason `voice.js` says: this runs on the poll loop's thread and a
 * synchronous decode would freeze every chat in the process.
 *
 * @module dsh-telegram-inbox/video
 */
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

/**
 * Bounds on frame sampling.
 *
 * 768 on the longest side is the size at which a frame still shows what is in the shot
 * while costing roughly a tenth of the tokens of a full-resolution phone frame, and six
 * of those is a cheaper turn than one unscaled 4K still that says less.
 */
export const FRAME_LONG_SIDE = 768;
export const VIDEO_FRAMES_DEFAULT = 6;

/**
 * Never sample faster than one frame per second of clip. Six frames out of a two-second
 * clip are six near-identical pictures at six times the cost; a short clip genuinely
 * contains less to see.
 */
export const MIN_SECONDS_PER_FRAME = 1;

/** ffmpeg is given its own deadline: a corrupt file can otherwise sit there for ever. */
export const FFMPEG_TIMEOUT_MS = 60000;

/** Promise wrapper over execFile, so callers can inject a fake in tests. */
export function run(command, args, { timeoutMs = FFMPEG_TIMEOUT_MS, execFileImpl = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr ?? '').trim().split('\n').slice(-2).join(' ').slice(0, 200);
        err.message = `${command} failed: ${err.message}${tail ? `: ${tail}` : ''}`;
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr ?? '') });
    });
  });
}

/** `avg_frame_rate` arrives as the string "30000/1001". Zero denominator means unknown. */
export function parseRate(rate) {
  const [num, den] = String(rate ?? '').split('/');
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0 || n <= 0) return null;
  return n / d;
}

/**
 * Duration and frame count of a clip.
 *
 * Both are best-effort: a stream copied out of a container can be missing either, so the
 * duration falls back to the container's and the frame count is derived from the frame
 * rate when it is not stated. A file with no video stream at all is an error, not a video
 * of zero frames: an audio-only .mp4 sent as a document lands here.
 */
export async function probeVideo(path, opts = {}) {
  const ffprobePath = opts.ffprobePath ?? 'ffprobe';
  const { stdout } = await run(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=duration,nb_frames,avg_frame_rate:format=duration',
    '-of', 'json',
    path,
  ], opts);

  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch { throw new Error(`ffprobe returned output that is not JSON: ${stdout.slice(0, 120)}`); }

  const stream = parsed?.streams?.[0];
  if (!stream) throw new Error('no video stream in this file');

  const duration = [Number(stream.duration), Number(parsed?.format?.duration)]
    .find((d) => Number.isFinite(d) && d > 0) ?? null;

  const stated = Number(stream.nb_frames);
  const rate = parseRate(stream.avg_frame_rate);
  const frames = Number.isFinite(stated) && stated > 0
    ? stated
    : (rate && duration ? Math.floor(rate * duration) : null);

  return { duration, frames, rate };
}

/**
 * How many frames to actually take.
 *
 * Three ceilings, all of them real: what was asked for, how many frames the clip has (a
 * 4-frame gif cannot yield 6), and how long the clip is.
 */
export function frameCountFor({ duration, frames } = {}, requested = VIDEO_FRAMES_DEFAULT) {
  const wanted = Math.floor(Number(requested));
  let n = Number.isFinite(wanted) && wanted > 0 ? wanted : VIDEO_FRAMES_DEFAULT;
  if (Number.isFinite(frames) && frames > 0) n = Math.min(n, Math.floor(frames));
  if (Number.isFinite(duration) && duration > 0) {
    n = Math.min(n, Math.max(1, Math.ceil(duration / MIN_SECONDS_PER_FRAME)));
  }
  return Math.max(1, n);
}

/**
 * Evenly spaced sample points across the clip.
 *
 * Midpoints of n equal slices, so the gap between consecutive frames is constant AND
 * neither end lands on an edge frame: t=0 is often a black or half-exposed frame, and
 * t=duration is past the last frame entirely.
 */
export function planTimestamps(duration, count) {
  const span = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const n = Math.max(1, Math.floor(count));
  if (!span) return Array.from({ length: n }, () => 0);
  return Array.from({ length: n }, (_, i) => (span * (i + 0.5)) / n);
}

/** "0:07", "1:05", "1:02:03": how a person says where they are in a clip. */
export function formatPosition(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * The scale filter, written so it can only ever shrink.
 *
 * `force_original_aspect_ratio=decrease` on its own upscales a small input to fill the
 * box; capping each side at the input's own size first means a 320x240 gif stays
 * 320x240 instead of being blown up into a blurry 768-wide frame that costs more tokens
 * and carries no more information.
 */
export function scaleFilter(longSide = FRAME_LONG_SIDE) {
  const n = Math.max(16, Math.floor(longSide));
  return `scale='min(${n},iw)':'min(${n},ih)':force_original_aspect_ratio=decrease`;
}

/** Pull one frame at `at` seconds into `outPath` as a JPEG. */
export async function extractFrame(src, at, outPath, opts = {}) {
  const ffmpegPath = opts.ffmpegPath ?? 'ffmpeg';
  await run(ffmpegPath, [
    '-v', 'error',
    '-nostdin',
    '-ss', Number(at).toFixed(3),
    '-i', src,
    '-frames:v', '1',
    '-vf', scaleFilter(opts.maxLongSide ?? FRAME_LONG_SIDE),
    '-q:v', '4',
    '-y', outPath,
  ], opts);
}

/**
 * Download a video and return labelled frames from across it.
 *
 * Everything happens inside one private temp directory which is removed in a `finally`,
 * so a failed probe, a failed extract and a failed download all leave the same thing
 * behind: nothing. Videos are the largest files this plugin touches and the daemon is
 * long-lived, so leaking one 20 MB temp file per failure would be a real disk leak
 * rather than a tidiness complaint.
 *
 * @returns {Promise<{frames: Array<{bytes: Buffer, mediaType: string, name: string, label: string, at: number}>, duration: number|null, planned: number}>}
 */
export async function sampleVideo(client, video, opts = {}) {
  const requested = opts.frames ?? VIDEO_FRAMES_DEFAULT;
  const root = opts.tmpRoot ?? tmpdir();
  const dir = await mkdtemp(join(root, 'dsh-tg-video-'));
  try {
    const { bytes, filePath } = await client.downloadFile(video.fileId, opts.downloadTimeoutMs ?? 120000);
    const src = join(dir, `clip${extname(filePath ?? '') || extname(video.name ?? '') || '.mp4'}`);
    await writeFile(src, bytes, { mode: 0o600 });

    const probed = await probeVideo(src, opts);
    const count = frameCountFor(probed, requested);
    const stamps = planTimestamps(probed.duration, count);

    const frames = [];
    for (let i = 0; i < stamps.length; i++) {
      const out = join(dir, `frame-${i + 1}.jpg`);
      await extractFrame(src, stamps[i], out, opts);
      frames.push({
        bytes: await readFile(out),
        mediaType: 'image/jpeg',
        name: `${stripExt(video.name ?? 'video')}-frame-${i + 1}.jpg`,
        label: probed.duration
          ? `frame ${i + 1}/${count} at ${formatPosition(stamps[i])} of ${video.name ?? 'video'} (${formatPosition(probed.duration)} long)`
          : `frame ${i + 1}/${count} of ${video.name ?? 'video'}`,
        at: stamps[i],
      });
    }
    return { frames, duration: probed.duration, planned: count };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function stripExt(name) {
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}
