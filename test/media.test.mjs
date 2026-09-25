import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bakers } from '../src/bakers/index.mjs';
import { decodeGif } from '../src/decoders/gif.mjs';
import { decodePng } from '../src/decoders/png.mjs';
import { decodeWav } from '../src/decoders/wav.mjs';
import { runEmitters } from '../src/emitters/index.mjs';
import { fromBase64 } from '../src/image.mjs';
import { makeTmpDir, readFixture } from './helpers.mjs';
import { buildGif } from './gif-builder.mjs';

const ctx = (options = {}) => ({
  files: new Map(Object.entries(options.files || {})),
  saved: new Map(Object.entries(options.saved || {})),
  result: options.result ?? null,
  bake: options.bake || {},
  job: options.job || { id: 'job-1' },
  rawName: options.rawName || 'job-1',
  outDir: options.outDir || '/tmp/out',
  configDir: options.configDir || '/tmp/config',
  log: () => {},
});

const gifRecord = (overrides = {}) =>
  bakers['sprite-sheet'](
    { id: 'walk-sheet' },
    ctx({ files: { result: readFixture('anim.gif') }, bake: { type: 'sprite-sheet', name: 'walk' }, ...overrides }),
  );

/** Copy a frame rectangle out of a packed sheet (sheets may hold several columns). */
function extractRect(sheet, sheetWidth, frame) {
  const out = Buffer.alloc(frame.w * frame.h * 4);
  for (let y = 0; y < frame.h; y++) {
    const start = ((frame.y + y) * sheetWidth + frame.x) * 4;
    sheet.copy(out, y * frame.w * 4, start, start + frame.w * 4);
  }
  return out;
}

test('sprite-sheet packs GIF frames pixel-exactly', () => {
  const record = gifRecord();
  assert.equal(record.bucket, 'sprites');
  assert.equal(record.key, 'walk');
  assert.equal(record.value.sheet.width, 24);
  assert.equal(record.value.sheet.height, 8);
  assert.equal(record.value.sheet.format, 'rgba8');
  assert.equal(record.value.loops, 0);
  assert.equal(record.value.fps, 10);
  assert.deepEqual(
    record.value.frames.map((frame) => [frame.x, frame.y, frame.w, frame.h]),
    [
      [0, 0, 8, 8],
      [8, 0, 8, 8],
      [16, 0, 8, 8],
    ],
  );
  const sheet = fromBase64(record.value.sheet.data);
  const gif = decodeGif(readFixture('anim.gif'));
  for (const frame of record.value.frames) {
    assert.deepEqual(extractRect(sheet, record.value.sheet.width, frame), Buffer.from(gif.frames[frame.index].data), `frame ${frame.index} pixels`);
  }
});

test('sprite-sheet wraps to a new row at maxWidth', () => {
  const gif = buildGif({
    width: 2,
    height: 2,
    palette: [
      [0, 0, 0],
      [255, 255, 255],
    ],
    frames: [
      { pixels: [0, 0, 0, 0] },
      { pixels: [1, 1, 1, 1] },
      { pixels: [0, 1, 0, 1] },
    ],
  });
  const record = bakers['sprite-sheet']({ id: 'x' }, ctx({ files: { result: gif }, bake: { type: 'sprite-sheet', maxWidth: 4 } }));
  assert.equal(record.value.sheet.width, 4);
  assert.equal(record.value.sheet.height, 4);
  assert.deepEqual(
    record.value.frames.map((frame) => [frame.x, frame.y]),
    [
      [0, 0],
      [2, 0],
      [0, 2],
    ],
  );
});

test('sprite-sheet dedupes consecutive identical frames', () => {
  const gif = buildGif({
    width: 2,
    height: 2,
    palette: [
      [0, 0, 0],
      [255, 255, 255],
    ],
    frames: [
      { pixels: [0, 0, 0, 0], delay: 3 },
      { pixels: [1, 1, 1, 1], delay: 5 },
      { pixels: [1, 1, 1, 1], delay: 7 },
    ],
  });
  const deduped = bakers['sprite-sheet']({ id: 'x' }, ctx({ files: { result: gif }, bake: { type: 'sprite-sheet' } }));
  assert.equal(deduped.value.sheet.width, 4, 'duplicate should not allocate a rectangle');
  assert.equal(deduped.value.frames[2].duplicate, true);
  assert.deepEqual([deduped.value.frames[2].x, deduped.value.frames[2].y], [deduped.value.frames[1].x, deduped.value.frames[1].y]);
  assert.equal(deduped.value.frames[2].delay, 0.07, 'a duplicate keeps its own delay');

  const full = bakers['sprite-sheet']({ id: 'x' }, ctx({ files: { result: gif }, bake: { type: 'sprite-sheet', dedupe: false } }));
  assert.equal(full.value.sheet.width, 6);
  assert.equal(full.value.frames.every((frame) => frame.duplicate === false), true);
});

test('sprite-sheet pads to a power of two when asked', () => {
  const gif = buildGif({
    width: 2,
    height: 2,
    palette: [
      [0, 0, 0],
      [255, 255, 255],
    ],
    frames: [{ pixels: [0, 0, 0, 0] }, { pixels: [1, 1, 1, 1] }, { pixels: [0, 1, 0, 1] }],
  });
  const record = bakers['sprite-sheet'](
    { id: 'x' },
    ctx({ files: { result: gif }, bake: { type: 'sprite-sheet', maxWidth: 256, powerOfTwo: true } }),
  );
  assert.equal(record.value.sheet.width, 8, '6 rounded up to 8');
  assert.equal(record.value.sheet.height, 2);
  const sheet = fromBase64(record.value.sheet.data);
  // The padded column is fully transparent.
  for (let y = 0; y < 2; y++) {
    for (let x = 6; x < 8; x++) {
      assert.equal(sheet[(y * 8 + x) * 4 + 3], 0);
    }
  }
});

test('sprite-sheet rejects missing slots and oversized frames', () => {
  assert.throws(() => bakers['sprite-sheet']({ id: 'x' }, ctx({ bake: { type: 'sprite-sheet' } })), /output slot "result" missing/);
  const wide = buildGif({
    width: 4,
    height: 1,
    palette: [
      [0, 0, 0],
      [255, 255, 255],
    ],
    frames: [{ pixels: [0, 1, 0, 1] }],
  });
  assert.throws(
    () => bakers['sprite-sheet']({ id: 'x' }, ctx({ files: { result: wide }, bake: { type: 'sprite-sheet', maxWidth: 2 } })),
    /frame width 4 exceeds maxWidth 2/,
  );
});

test('audio-clip trims silence and peak-normalises the clip', () => {
  const record = bakers['audio-clip'](
    { id: 'sfx-clip' },
    ctx({
      files: { result: readFixture('clip-padded.wav') },
      bake: { type: 'audio-clip', name: 'footstep', loopStart: 0, loopEnd: 0.02 },
    }),
  );
  assert.equal(record.bucket, 'audio');
  assert.equal(record.key, 'footstep');
  assert.equal(record.value.container, 'wav');
  assert.equal(record.value.format, 'pcm');
  assert.equal(record.value.sampleFormat, 'pcm16');
  assert.equal(record.value.sampleRate, 8000);
  assert.equal(record.value.frames, 481);
  assert.equal(record.value.trimStart, 0.02);
  assert.equal(record.value.trimEnd, 0.080125);
  assert.equal(record.value.seconds, 0.060125);
  assert.equal(record.value.loopStart, 0);
  assert.equal(record.value.loopEnd, 0.02);
  assert.ok(Math.abs(record.value.peak - 0.600006) < 1e-6);
  assert.ok(record.value.gain > 1.6 && record.value.gain < 1.7);
  assert.equal(record.value.source.frames, 800);

  const decoded = decodeWav(Buffer.from(record.value.data, 'base64'), { mixdown: true });
  assert.equal(decoded.frames, 481);
  assert.equal(decoded.sampleRate, 8000);
  let peak = 0;
  for (const sample of decoded.samples) peak = Math.max(peak, Math.abs(sample));
  assert.ok(peak > 0.999, `expected a normalised peak, got ${peak}`);
});

test('audio-clip honours explicit trims, formats and channel mixdown', () => {
  const untrimmed = bakers['audio-clip'](
    { id: 'x' },
    ctx({ files: { result: readFixture('clip-padded.wav') }, bake: { type: 'audio-clip', trim: false, normalize: false } }),
  );
  assert.equal(untrimmed.value.frames, 800);
  assert.equal(untrimmed.value.trimStart, 0);
  assert.equal(untrimmed.value.trimEnd, 0.1);
  assert.equal(untrimmed.value.gain, 1);

  const float = bakers['audio-clip'](
    { id: 'x' },
    ctx({ files: { result: readFixture('clip-padded.wav') }, bake: { type: 'audio-clip', trim: false, sampleFormat: 'float32' } }),
  );
  assert.equal(float.value.format, 'float');
  assert.equal(decodeWav(Buffer.from(float.value.data, 'base64'), { mixdown: true }).bits, 32);

  const mixdown = bakers['audio-clip'](
    { id: 'x' },
    ctx({ files: { result: readFixture('clip-float32.wav') }, bake: { type: 'audio-clip', mixdown: true, trim: false } }),
  );
  assert.equal(mixdown.value.channels, 1);
  assert.equal(mixdown.value.source.channels, 2);

  const stereo = bakers['audio-clip'](
    { id: 'x' },
    ctx({ files: { result: readFixture('clip-float32.wav') }, bake: { type: 'audio-clip', trim: false } }),
  );
  assert.equal(stereo.value.channels, 2);
});

test('audio-clip validates its options', () => {
  const files = { result: readFixture('clip-padded.wav') };
  const bake = (extra) => ({ type: 'audio-clip', ...extra });
  assert.throws(() => bakers['audio-clip']({ id: 'x' }, ctx({ files, bake: bake({ loopStart: 0.05, loopEnd: 0.01 }) })), /loopStart 0\.05 must be less than loopEnd 0\.01/);
  assert.throws(() => bakers['audio-clip']({ id: 'x' }, ctx({ files, bake: bake({ loopEnd: 5 }) })), /loopEnd 5 is outside the clip/);
  assert.throws(() => bakers['audio-clip']({ id: 'x' }, ctx({ files, bake: bake({ sampleFormat: 'pcm12' }) })), /sampleFormat "pcm12" unsupported/);
  assert.throws(() => bakers['audio-clip']({ id: 'x' }, ctx({ files, bake: bake({ threshold: -1 }) })), /threshold must be a non-negative number/);
  assert.throws(() => bakers['audio-clip']({ id: 'x' }, ctx({ bake: { type: 'audio-clip' } })), /output slot "result" missing/);
});

const spriteRecord = () => {
  const record = gifRecord();
  return { job: 'walk-sheet', type: 'sprite-sheet', ...record };
};

test('atlas emitter writes a pixel-exact PNG and a JSON sidecar', async (t) => {
  const outDir = makeTmpDir(t, 'atlas-emitter');
  const record = spriteRecord();
  const written = await runEmitters({ config: { emitters: [{ type: 'atlas' }] }, records: [record], outDir, log: () => {} });
  const pngPath = path.join(outDir, 'sprites', 'walk.png');
  const jsonPath = path.join(outDir, 'sprites', 'walk.json');
  assert.deepEqual(written, [pngPath, jsonPath]);

  const png = decodePng(fs.readFileSync(pngPath));
  assert.equal(png.width, 24);
  assert.equal(png.height, 8);
  assert.deepEqual(Buffer.from(png.data), Buffer.from(fromBase64(record.value.sheet.data)));

  const sidecar = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(sidecar.key, 'walk');
  assert.equal(sidecar.width, 24);
  assert.equal(sidecar.height, 8);
  assert.equal(sidecar.format, 'rgba8');
  assert.equal(sidecar.sheet, 'sprites/walk.png');
  assert.equal(sidecar.loops, 0);
  assert.equal(sidecar.fps, 10);
  assert.equal(sidecar.frames.length, 3);
  assert.deepEqual(sidecar.frames[1], { index: 1, x: 8, y: 0, w: 8, h: 8, delay: 0.1, delayCs: 10, duplicate: false });
});

test('atlas emitter is deterministic and idempotent', async (t) => {
  const first = makeTmpDir(t, 'atlas-det-a');
  const second = makeTmpDir(t, 'atlas-det-b');
  const record = spriteRecord();
  await runEmitters({ config: { emitters: [{ type: 'atlas' }] }, records: [record], outDir: first, log: () => {} });
  await runEmitters({ config: { emitters: [{ type: 'atlas' }] }, records: [record], outDir: second, log: () => {} });
  assert.deepEqual(fs.readFileSync(path.join(first, 'sprites', 'walk.png')), fs.readFileSync(path.join(second, 'sprites', 'walk.png')));
  assert.deepEqual(fs.readFileSync(path.join(first, 'sprites', 'walk.json')), fs.readFileSync(path.join(second, 'sprites', 'walk.json')));
  const before = fs.readFileSync(path.join(first, 'sprites', 'walk.png'));
  await runEmitters({ config: { emitters: [{ type: 'atlas' }] }, records: [record], outDir: first, log: () => {} });
  assert.deepEqual(fs.readFileSync(path.join(first, 'sprites', 'walk.png')), before, 're-running must rewrite identical bytes');
});

test('atlas emitter supports sidecar:false and ignores other records', async (t) => {
  const outDir = makeTmpDir(t, 'atlas-options');
  const written = await runEmitters({
    config: { emitters: [{ type: 'atlas', sidecar: false }] },
    records: [spriteRecord(), { job: 'tile', type: 'texture-tile', bucket: 'textures', key: 'rock', value: {} }],
    outDir,
    log: () => {},
  });
  assert.deepEqual(written, [path.join(outDir, 'sprites', 'walk.png')]);
  assert.ok(!fs.existsSync(path.join(outDir, 'sprites', 'walk.json')));
  assert.ok(!fs.existsSync(path.join(outDir, 'textures')));
});

test('files emitter writes sprite-sheet atlases and audio clips', async (t) => {
  const outDir = makeTmpDir(t, 'files-media');
  const audio = bakers['audio-clip'](
    { id: 'sfx-clip' },
    ctx({ files: { result: readFixture('clip-padded.wav') }, bake: { type: 'audio-clip', name: 'footstep', trim: false } }),
  );
  const records = [spriteRecord(), { job: 'sfx-clip', type: 'audio-clip', bucket: 'audio', key: 'footstep', ...audio }];
  await runEmitters({ config: { emitters: [{ type: 'files' }] }, records, outDir, log: () => {} });
  assert.ok(fs.existsSync(path.join(outDir, 'sprites', 'walk.png')));
  assert.ok(fs.existsSync(path.join(outDir, 'audio', 'footstep.wav')));
  const wav = decodeWav(fs.readFileSync(path.join(outDir, 'audio', 'footstep.wav')), { mixdown: true });
  assert.equal(wav.frames, 800);
  const index = JSON.parse(fs.readFileSync(path.join(outDir, 'index.json'), 'utf8'));
  assert.deepEqual(index.files.map((file) => file.file), ['sprites/walk.png', 'audio/footstep.wav']);
});

test('external processed clips survive both file and audio-pack emission unchanged', async (t) => {
  const source = readFixture('clip-padded.wav');
  const bake = { type: 'audio-clip', name: 'processed', trim: false, targetSampleRate: 4000, maxSeconds: 0.05, normalize: true };
  for (const emitter of ['files', 'audio-pack']) {
    const outDir = makeTmpDir(t, `external-${emitter}`);
    const raw = path.join(outDir, 'raw', 'clip', 'result.wav');
    fs.mkdirSync(path.dirname(raw), { recursive: true });
    fs.writeFileSync(raw, source);
    const input = { files: { result: source }, saved: { result: { relative: 'raw/clip/result.wav', file: raw } }, outDir };
    const embedded = bakers['audio-clip']({ id: 'clip' }, ctx({ ...input, bake }));
    const external = bakers['audio-clip']({ id: 'clip' }, ctx({ ...input, bake: { ...bake, embed: false } }));
    const expected = fromBase64(embedded.value.data);
    assert.deepEqual(fs.readFileSync(path.join(outDir, external.value.file)), expected);
    assert.deepEqual(fs.readFileSync(raw), source, 'the provider archive must remain unchanged');
    await runEmitters({
      config: { emitters: [{ type: emitter, dir: 'published' }] },
      records: [{ job: 'clip', type: 'audio-clip', bucket: external.bucket, key: external.key, value: external.value }],
      outDir,
      log: () => {},
    });
    const published = fs.readFileSync(path.join(outDir, 'published', 'audio', 'processed.wav'));
    assert.deepEqual(published, expected, `${emitter} must publish the transformed signal`);
    const decoded = decodeWav(published, { mixdown: true });
    assert.equal(decoded.sampleRate, external.value.sampleRate);
    assert.equal(decoded.frames, external.value.frames);
  }
});
