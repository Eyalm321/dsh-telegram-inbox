import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probeVideo, frameCountFor, planTimestamps, formatPosition, scaleFilter, parseRate, sampleVideo,
} from '../src/video.js';

const run = promisify(execFile);

// Six two-second blocks of a flat colour, in a known order. A clip like this makes even
// spacing OBSERVABLE: sample six frames evenly and you get the six colours in order, while
// anything that sampled the head of the clip gets red six times. That is exactly the bug:
// the opening seconds of a real video are the sky, not the fish.
const SEGMENTS = [
  { name: 'red',     hex: '0xFF0000', rgb: [255, 0, 0] },
  { name: 'green',   hex: '0x00FF00', rgb: [0, 255, 0] },
  { name: 'blue',    hex: '0x0000FF', rgb: [0, 0, 255] },
  { name: 'yellow',  hex: '0xFFFF00', rgb: [255, 255, 0] },
  { name: 'magenta', hex: '0xFF00FF', rgb: [255, 0, 255] },
  { name: 'cyan',    hex: '0x00FFFF', rgb: [0, 255, 255] },
];
const SEGMENT_SECONDS = 2;
const CLIP_SECONDS = SEGMENTS.length * SEGMENT_SECONDS;

let dir;
let clip;
let short;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-tg-videotest-'));
  clip = join(dir, 'clip.mp4');
  short = join(dir, 'short.mp4');

  const inputs = SEGMENTS.flatMap((s) => [
    '-f', 'lavfi', '-i', `color=c=${s.hex}:s=160x120:r=10:d=${SEGMENT_SECONDS}`,
  ]);
  const chain = SEGMENTS.map((_, i) => `[${i}:v]`).join('') + `concat=n=${SEGMENTS.length}:v=1:a=0[v]`;
  // -g 1 makes every frame a keyframe, so a seek lands where it was asked to and the test
  // is measuring the sampler rather than the codec's GOP layout.
  await run('ffmpeg', ['-v', 'error', ...inputs, '-filter_complex', chain, '-map', '[v]',
    '-c:v', 'libx264', '-g', '1', '-pix_fmt', 'yuv420p', '-y', clip], { maxBuffer: 8 << 20 });

  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=160x120:r=10:d=2',
    '-c:v', 'libx264', '-g', '1', '-pix_fmt', 'yuv420p', '-y', short], { maxBuffer: 8 << 20 });
});

after(async () => { await rm(dir, { recursive: true, force: true }); });

/** The average colour of an image, as [r, g, b]: the whole frame squeezed to one pixel. */
async function averageColour(bytes) {
  const path = join(dir, `probe-${Math.abs(hash(bytes)).toString(36)}.jpg`);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, bytes);
  const { stdout } = await run('ffmpeg',
    ['-v', 'error', '-i', path, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 20 });
  return [stdout[0], stdout[1], stdout[2]];
}

function hash(buf) {
  let h = 0;
  for (let i = 0; i < buf.length; i += 997) h = (h * 31 + buf[i]) | 0;
  return h;
}

/** Which of the six segment colours a frame is closest to. */
function nearestSegment([r, g, b]) {
  let best = null;
  let bestD = Infinity;
  for (const s of SEGMENTS) {
    const d = (s.rgb[0] - r) ** 2 + (s.rgb[1] - g) ** 2 + (s.rgb[2] - b) ** 2;
    if (d < bestD) { bestD = d; best = s.name; }
  }
  return best;
}

/** A client stub that serves a local file. sampleVideo never needs a real network. */
function fileClient(path, filePath = 'clip.mp4') {
  return { downloadFile: async () => ({ bytes: await readFile(path), filePath }) };
}

// ── the pure parts ───────────────────────────────────────────────────────────

test('sample points are evenly spaced and avoid both edges of the clip', () => {
  const stamps = planTimestamps(12, 6);
  assert.deepEqual(stamps, [1, 3, 5, 7, 9, 11]);
  const gaps = stamps.slice(1).map((t, i) => +(t - stamps[i]).toFixed(6));
  assert.deepEqual(new Set(gaps), new Set([2]), 'one constant gap, not a bunch at the start');
  assert.ok(stamps[0] > 0, 't=0 is often a black or half-exposed frame');
  assert.ok(stamps.at(-1) < 12, 't=duration is past the last frame');
});

test('a single frame is taken from the middle, not from the beginning', () => {
  assert.deepEqual(planTimestamps(10, 1), [5]);
});

test('an unknown duration degrades to the first frame rather than to NaN', () => {
  assert.deepEqual(planTimestamps(null, 3), [0, 0, 0]);
});

test('never more frames than the clip has', () => {
  assert.equal(frameCountFor({ duration: 30, frames: 3 }, 6), 3, 'a 3-frame gif cannot give 6');
  assert.equal(frameCountFor({ duration: 30, frames: 900 }, 6), 6);
});

test('a very short clip gets fewer frames, never fewer than one', () => {
  assert.equal(frameCountFor({ duration: 2, frames: 60 }, 6), 2, 'no more than one a second');
  assert.equal(frameCountFor({ duration: 0.4, frames: 12 }, 6), 1);
  assert.equal(frameCountFor({ duration: 60, frames: 1800 }, 0), 6, 'a nonsense request falls back');
});

test('positions are written the way a person says them', () => {
  assert.equal(formatPosition(0), '0:00');
  assert.equal(formatPosition(7.4), '0:07');
  assert.equal(formatPosition(65), '1:05');
  assert.equal(formatPosition(3723), '1:02:03');
});

test('the scale filter can shrink but never stretch', () => {
  assert.match(scaleFilter(768), /min\(768,iw\)/);
  assert.match(scaleFilter(768), /force_original_aspect_ratio=decrease/);
});

test('frame rates arrive as fractions, and a zero denominator means unknown', () => {
  assert.ok(Math.abs(parseRate('30000/1001') - 29.97) < 0.01);
  assert.equal(parseRate('25'), 25);
  assert.equal(parseRate('0/0'), null);
  assert.equal(parseRate(undefined), null);
});

// ── against a real clip ──────────────────────────────────────────────────────

test('ffprobe reports the duration and frame count of a real clip', async () => {
  const probed = await probeVideo(clip);
  assert.ok(Math.abs(probed.duration - CLIP_SECONDS) < 0.3, `duration was ${probed.duration}`);
  assert.ok(probed.frames >= CLIP_SECONDS * 10 - 2, `frames was ${probed.frames}`);
});

test('a file with no video stream is an error, not an empty video', async () => {
  const audio = join(dir, 'audio.m4a');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-y', audio]);
  await assert.rejects(() => probeVideo(audio), /no video stream/);
});

test('six frames are sampled EVENLY ACROSS the clip, not from its first seconds', async () => {
  const { frames, duration } = await sampleVideo(fileClient(clip), { fileId: 'v', name: 'fishing.mp4' }, { tmpRoot: dir });
  assert.equal(frames.length, 6);
  assert.ok(Math.abs(duration - CLIP_SECONDS) < 0.3);

  const seen = [];
  for (const f of frames) seen.push(nearestSegment(await averageColour(f.bytes)));
  assert.deepEqual(seen, SEGMENTS.map((s) => s.name),
    'one frame from the middle of each two-second block, in order');
  assert.notEqual(seen[1], seen[0], 'sampling the head of the clip would repeat the first colour');
});

test('every frame is labelled with where in the clip it came from', async () => {
  const { frames } = await sampleVideo(fileClient(clip), { fileId: 'v', name: 'fishing.mp4' }, { tmpRoot: dir });
  assert.match(frames[0].label, /^frame 1\/6 at 0:01 of fishing\.mp4 \(0:12 long\)$/);
  assert.match(frames[2].label, /^frame 3\/6 at 0:05 /);
  assert.match(frames[5].label, /^frame 6\/6 at 0:11 /);
  assert.deepEqual(frames.map((f) => f.name),
    [1, 2, 3, 4, 5, 6].map((n) => `fishing-frame-${n}.jpg`));
  assert.ok(frames.every((f) => f.mediaType === 'image/jpeg' && f.bytes.length > 0));
});

test('frames are scaled down to the requested longest side, and small clips are not blown up', async () => {
  const big = join(dir, 'big.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=1920x1080:r=10:d=2',
    '-c:v', 'libx264', '-g', '1', '-pix_fmt', 'yuv420p', '-y', big], { maxBuffer: 8 << 20 });

  const shrunk = await sampleVideo(fileClient(big), { fileId: 'v', name: 'big.mp4' }, { tmpRoot: dir, frames: 1 });
  assert.deepEqual(await dimensions(shrunk.frames[0].bytes), [768, 432], '1920x1080 fits inside 768');

  const kept = await sampleVideo(fileClient(clip), { fileId: 'v', name: 'small.mp4' }, { tmpRoot: dir, frames: 1 });
  assert.deepEqual(await dimensions(kept.frames[0].bytes), [160, 120], '160x120 is left alone, not upscaled');
});

test('a two-second clip yields two frames, not six', async () => {
  const { frames } = await sampleVideo(fileClient(short), { fileId: 'v', name: 'short.mp4' }, { tmpRoot: dir });
  assert.equal(frames.length, 2);
  assert.match(frames[0].label, /frame 1\/2 at 0:00/);
});

test('a smaller frame budget is honoured', async () => {
  const { frames } = await sampleVideo(fileClient(clip), { fileId: 'v', name: 'c.mp4' }, { tmpRoot: dir, frames: 3 });
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map((f) => f.at), [2, 6, 10]);
});

async function dimensions(bytes) {
  const path = join(dir, `dim-${Math.abs(hash(bytes)).toString(36)}.jpg`);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, bytes);
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path]);
  return stdout.trim().split(',').map(Number);
}

// ── cleanup, on every path ───────────────────────────────────────────────────

/** Temp directories sampleVideo made under `root`, which must be none once it returns. */
async function leftBehind(root) {
  return (await readdir(root)).filter((n) => n.startsWith('dsh-tg-video-'));
}

test('a failing ffmpeg leaves no temp file behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tg-leak-'));
  try {
    const execFileImpl = (cmd, args, opts, cb) => {
      if (cmd.includes('ffprobe')) return execFile(cmd, args, opts, cb);
      cb(Object.assign(new Error('Conversion failed!'), { code: 1 }), '', 'frame extraction blew up');
      return null;
    };
    await assert.rejects(
      () => sampleVideo(fileClient(clip), { fileId: 'v', name: 'c.mp4' }, { tmpRoot: root, execFileImpl }),
      /ffmpeg failed/);
    assert.deepEqual(await leftBehind(root), [], 'the clip and any half-written frames are gone');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failing ffprobe leaves no temp file behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tg-leak-'));
  try {
    const execFileImpl = (cmd, args, opts, cb) => {
      cb(Object.assign(new Error('exit 1'), { code: 1 }), '', 'Invalid data found when processing input');
      return null;
    };
    await assert.rejects(
      () => sampleVideo(fileClient(clip), { fileId: 'v', name: 'c.mp4' }, { tmpRoot: root, execFileImpl }),
      /ffprobe failed/);
    assert.deepEqual(await leftBehind(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failing download leaves no temp directory behind either', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tg-leak-'));
  try {
    const client = { downloadFile: async () => { throw new Error('getFile: Bad Request: file is too big'); } };
    await assert.rejects(
      () => sampleVideo(client, { fileId: 'v', name: 'c.mp4' }, { tmpRoot: root }),
      /file is too big/);
    assert.deepEqual(await leftBehind(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a successful sample leaves nothing behind either', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tg-leak-'));
  try {
    await sampleVideo(fileClient(clip), { fileId: 'v', name: 'c.mp4' }, { tmpRoot: root, frames: 2 });
    assert.deepEqual(await leftBehind(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the stderr of a broken ffmpeg reaches the error message, so the log says why', async () => {
  const execFileImpl = (cmd, args, opts, cb) => {
    cb(new Error('Command failed'), '', 'moov atom not found\nInvalid data found when processing input');
    return null;
  };
  await assert.rejects(
    () => sampleVideo(fileClient(clip), { fileId: 'v', name: 'c.mp4' }, { tmpRoot: dir, execFileImpl }),
    /Invalid data found/);
});
