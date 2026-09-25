// Offline tests for the audio pipeline: the extended `audio-clip` baker, the
// `audio-stitch` and `echo-map` bakers, the `audio-pack` emitter, and the
// `makeSourceAudio`/`makeChunkZip` source builders. Every input is either a
// committed fixture or synthesized in-process with `encodeWav`, so nothing
// touches the network or an audio framework.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bakers } from '../src/bakers/index.mjs';
import { encodeWav, decodeWav, unzip } from '../src/decoders/index.mjs';
import { runEmitters } from '../src/emitters/index.mjs';
import { fromBase64 } from '../src/image.mjs';
import { makeChunkZip, makeSourceAudio, writeSources } from '../src/sources.mjs';
import { formatIssue, validateConfig } from '../src/config.mjs';
import { resampleFiltered, resampleLinear } from '../src/bakers/audio.mjs';
import { fixture, makeTmpDir, readFixture } from './helpers.mjs';

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

const savedEntry = (relative) => ({ relative, file: `/tmp/out/${relative}` });

/** Synthesize a mono/stereo WAV for loop and stitch cases. */
function tone(seconds, sampleRate, freq, { channels = 1, amplitude = 0.5 } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const data = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) data[c][i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return encodeWav(data, { sampleRate, format: 'pcm16' });
}

const audioData = (value) => fromBase64((value?.value ?? value).data);
const decode = (value) => decodeWav(audioData(value), { mixdown: true });

test('audio-clip embed:false persists exactly the processed embedded WAV, leaving raw untouched', (t) => {
  const outDir = makeTmpDir(t, 'clip-external');
  const raw = readFixture('clip-padded.wav');
  fs.mkdirSync(path.join(outDir, 'raw', 'bed'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'raw', 'bed', 'result.wav'), raw);
  const bake = { type: 'audio-clip', name: 'bed', embed: false, urlBase: '/moth/files', sampleFormat: 'pcm16', mixdown: true, targetSampleRate: 4000, maxSeconds: 0.06, loopStart: 0, loopEnd: 0.03, loopCrossfade: 0.005 };
  const record = bakers['audio-clip'](
    { id: 'bed' },
    ctx({
      outDir,
      files: { result: raw },
      saved: { result: savedEntry('raw/bed/result.wav') },
      bake,
    }),
  );
  assert.equal(record.value.data, undefined, 'embed:false must omit base64');
  assert.match(record.value.file, /^processed\/audio\/[a-f0-9]{64}\.wav$/);
  assert.equal(record.value.url, `/moth/files/job-1/${path.basename(record.value.file)}`);
  assert.equal(record.value.container, 'wav');

  const embedded = bakers['audio-clip'](
    { id: 'bed' },
    ctx({ files: { result: raw }, bake: { ...bake, embed: true } }),
  );
  assert.equal(typeof embedded.value.data, 'string', 'the default stays embedded');
  assert.equal(embedded.value.file, undefined);
  const externalBytes = fs.readFileSync(path.join(outDir, record.value.file));
  assert.deepEqual(externalBytes, audioData(embedded));
  assert.notDeepEqual(externalBytes, raw);
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'raw', 'bed', 'result.wav')), raw);
  assert.equal(record.value.bytes, externalBytes.length);
  assert.equal(record.value.sha256, createHash('sha256').update(externalBytes).digest('hex'));
  assert.deepEqual(decodeWav(externalBytes).channelData, decodeWav(audioData(embedded)).channelData);
  for (const key of ['sampleRate', 'channels', 'frames', 'seconds', 'loopStart', 'loopEnd', 'crossfade', 'gain', 'peak', 'trimStart', 'trimEnd', 'source']) {
    assert.deepEqual(record.value[key], embedded.value[key], key);
  }
  assert.equal(record.value.sampleRate, 4000);
  assert.equal(record.value.frames, 240);
});

test('audio-clip url placeholders reference the processed file', (t) => {
  const outDir = makeTmpDir(t, 'clip-url');
  const record = bakers['audio-clip'](
    { id: 'x' },
    ctx({
      files: { result: readFixture('clip-pcm16.wav') },
      saved: { result: savedEntry('raw/x/result.wav') },
      rawName: 'x',
      outDir,
      bake: { type: 'audio-clip', embed: false, url: '/a/{raw}/{slot}/{file}' },
    }),
  );
  assert.equal(record.value.url, `/a/x/result/${path.basename(record.value.file)}`);
  assert.ok(fs.existsSync(path.join(outDir, record.value.file)));
  const embedded = bakers['audio-clip']({ id: 'x' }, ctx({ files: { result: readFixture('clip-pcm16.wav') }, saved: { result: savedEntry('raw/x/result.wav') }, rawName: 'x', bake: { type: 'audio-clip', url: '/a/{raw}/{slot}/{file}' } }));
  assert.equal(embedded.value.url, '/a/x/result/result.wav');
});

test('audio-clip detectLoop is deterministic and stays inside the clip', () => {
  const wav = tone(0.3, 8000, 300);
  const bake = { type: 'audio-clip', name: 'loop', detectLoop: true, loopSearch: 0.2, normalize: false };
  const first = bakers['audio-clip']({ id: 'x' }, ctx({ files: { result: wav }, bake }));
  const second = bakers['audio-clip']({ id: 'x' }, ctx({ files: { result: wav }, bake }));
  assert.equal(first.value.loopStart, second.value.loopStart);
  assert.equal(first.value.loopEnd, second.value.loopEnd);
  assert.ok(first.value.loopStart >= 0);
  assert.ok(first.value.loopEnd <= first.value.seconds);
  assert.ok(first.value.loopEnd > first.value.loopStart);
  assert.ok(typeof first.value.loopScore === 'number');
});

test('audio-clip detectLoop places the seam where the tail matches the head', () => {
  // 0.1 s of A, 0.1 s of A, 0.1 s of B: the only long seamless join is at the
  // A/B boundary, so a real detector should not return the full clip.
  const frames = 2400;
  const data = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const freq = i < 1600 ? 300 : 1000;
    data[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / 8000);
  }
  const wav = encodeWav([data], { sampleRate: 8000, format: 'pcm16' });
  const record = bakers['audio-clip'](
    { id: 'x' },
    ctx({ files: { result: wav }, bake: { type: 'audio-clip', detectLoop: true, normalize: false } }),
  );
  assert.ok(record.value.loopEnd < record.value.seconds, `expected a seam before the end, got ${record.value.loopEnd}`);
  assert.ok(record.value.loopEnd > 0.15, `expected a long loop, got ${record.value.loopEnd}`);
});

test('audio-clip loopCrossfade blends the tail into the head deterministically', () => {
  const wav = tone(0.2, 8000, 440);
  const base = { type: 'audio-clip', name: 'x', trim: false, normalize: false, loopStart: 0, loopEnd: 0.1 };
  const plain = bakers['audio-clip']({ id: 'x' }, ctx({ files: { result: wav }, bake: base }));
  const bake = { ...base, loopCrossfade: 0.01 };
  const faded = bakers['audio-clip']({ id: 'x' }, ctx({ files: { result: wav }, bake }));
  assert.equal(faded.value.crossfade, 0.01);

  const plainSamples = decode(plain).samples;
  const fadedSamples = decode(faded).samples;
  let changed = 0;
  for (let i = 0; i < plainSamples.length; i++) {
    if (Math.abs(plainSamples[i] - fadedSamples[i]) > 1e-4) changed++;
  }
  assert.ok(changed > 0, 'the crossfade should change the head');
  assert.ok(changed <= Math.round(0.01 * 8000) + 1, `only the crossfade window should change (${changed})`);

  const again = bakers['audio-clip']({ id: 'x' }, ctx({ files: { result: wav }, bake }));
  assert.deepEqual(audioData(faded), audioData(again));
});

test('audio-clip targetSampleRate/maxSeconds shrink the clip and meta passes through', () => {
  const record = bakers['audio-clip'](
    { id: 'x' },
    ctx({
      files: { result: readFixture('clip-padded.wav') },
      bake: { type: 'audio-clip', name: 'x', trim: false, targetSampleRate: 4000, maxSeconds: 0.05, mixdown: true, meta: { bus: 'ambience' } },
    }),
  );
  assert.equal(record.value.sampleRate, 4000);
  assert.equal(record.value.frames, 200);
  assert.equal(record.value.seconds, 0.05);
  assert.equal(record.value.targetSampleRate, 4000);
  assert.deepEqual(record.value.meta, { bus: 'ambience' });
});

test('production resampling is filtered and explicitly recorded', () => {
  const fromRate = 48000;
  const toRate = 8000;
  const source = new Float32Array(fromRate / 10);
  // 10 kHz is above the 4 kHz target Nyquist and should be strongly attenuated.
  for (let i = 0; i < source.length; i++) source[i] = Math.sin((2 * Math.PI * 10000 * i) / fromRate);
  const linear = resampleLinear([source], fromRate, toRate)[0];
  const filtered = resampleFiltered([source], fromRate, toRate)[0];
  const rms = (values) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
  assert.ok(rms(filtered) < rms(linear) * 0.2, `filtered ${rms(filtered)} vs linear ${rms(linear)}`);

  const wav = encodeWav([source], { sampleRate: fromRate, format: 'float32' });
  const record = bakers['audio-clip']({ id: 'production' }, ctx({
    files: { result: wav },
    bake: { type: 'audio-clip', trim: false, normalize: false, targetSampleRate: toRate, resampleQuality: 'production' },
  }));
  assert.equal(record.value.resampleQuality, 'production');
  assert.equal(record.value.sampleRate, toRate);
  assert.throws(() => bakers['audio-clip']({ id: 'bad' }, ctx({ files: { result: wav }, bake: { type: 'audio-clip', trim: false, targetSampleRate: toRate, resampleQuality: 'magic' } })), /resampleQuality/);
});

test('audio-clip rejects invalid new options', () => {
  const files = { result: readFixture('clip-padded.wav') };
  const bake = (extra) => ({ type: 'audio-clip', ...extra });
  assert.throws(() => bakers['audio-clip']({ id: 'x' }, ctx({ files, bake: bake({ targetSampleRate: 0 }) })), /targetSampleRate must be a positive number/);
  assert.throws(() => bakers['audio-clip']({ id: 'x' }, ctx({ files, bake: bake({ maxSeconds: -1 }) })), /maxSeconds must be a positive number/);
  assert.throws(() => bakers['audio-clip']({ id: 'x' }, ctx({ files, bake: bake({ loopCrossfade: 0.01 }) })), /loopCrossfade needs a loop window/);
  assert.throws(
    () => bakers['audio-clip']({ id: 'x' }, ctx({ files, bake: bake({ loopStart: 0, loopEnd: 0.05, loopCrossfade: 0.2 }) })),
    /loopCrossfade/,
  );
});

test('audio-stitch concatenates slots in order and records its sources', () => {
  const record = bakers['audio-stitch'](
    { id: 'x' },
    ctx({
      files: { a: readFixture('clip-pcm16.wav'), b: readFixture('clip-padded.wav') },
      bake: { type: 'audio-stitch', name: 'joined', slots: [{ slot: 'a', gain: 0.5 }, 'b'], sampleFormat: 'pcm16', normalize: false },
    }),
  );
  assert.equal(record.bucket, 'audio');
  assert.equal(record.value.frames, 400 + 800);
  assert.equal(record.value.sampleRate, 8000);
  assert.deepEqual(record.value.source.clips.map((clip) => clip.slot), ['a', 'b']);
  assert.equal(record.value.source.clips[0].gain, 0.5);
  assert.equal(record.value.source.crossfadeMs, 0);
});

test('audio-stitch crossfade shortens the join and is deterministic', () => {
  const files = { a: readFixture('clip-pcm16.wav'), b: readFixture('clip-padded.wav') };
  const bake = { type: 'audio-stitch', name: 'x', slots: ['a', 'b'], crossfadeMs: 5, sampleFormat: 'pcm16', normalize: false };
  const first = bakers['audio-stitch']({ id: 'x' }, ctx({ files, bake }));
  const second = bakers['audio-stitch']({ id: 'x' }, ctx({ files, bake }));
  assert.equal(first.value.frames, 400 + 800 - Math.round(0.005 * 8000));
  assert.equal(first.value.source.crossfadeMs, 5);
  assert.deepEqual(audioData(first), audioData(second));
});

test('audio-stitch validates slots, channels and crossfade length', () => {
  const mono = { a: readFixture('clip-pcm16.wav') };
  assert.throws(() => bakers['audio-stitch']({ id: 'x' }, ctx({ files: mono, bake: { type: 'audio-stitch' } })), /slots must be a non-empty array/);
  assert.throws(
    () => bakers['audio-stitch']({ id: 'x' }, ctx({ files: mono, bake: { type: 'audio-stitch', slots: ['nope'] } })),
    /output slot "nope" missing/,
  );
  const mixed = { a: readFixture('clip-pcm16.wav'), b: readFixture('clip-float32.wav') };
  assert.throws(
    () => bakers['audio-stitch']({ id: 'x' }, ctx({ files: mixed, bake: { type: 'audio-stitch', slots: ['a', 'b'] } })),
    /channel count mismatch/,
  );
  assert.equal(bakers['audio-stitch']({ id: 'x' }, ctx({ files: mixed, bake: { type: 'audio-stitch', slots: ['a', 'b'], mixdown: true } })).value.channels, 1);
  const pair = { a: readFixture('clip-pcm16.wav'), b: readFixture('clip-padded.wav') };
  assert.throws(
    () => bakers['audio-stitch']({ id: 'x' }, ctx({ files: pair, bake: { type: 'audio-stitch', slots: ['a', 'b'], crossfadeMs: 500 } })),
    /too long/,
  );
});

test('audio-stitch embed:false writes a processed join without a pre-existing slot', (t) => {
  const outDir = makeTmpDir(t, 'stitch-external');
  const files = { a: readFixture('clip-pcm16.wav') };
  const automatic = bakers['audio-stitch']({ id: 'x' }, ctx({ outDir, files, bake: { type: 'audio-stitch', name: 'x', slots: ['a'], embed: false } }));
  assert.match(automatic.value.file, /^processed\/audio\/[a-f0-9]{64}\.wav$/);
  assert.ok(fs.existsSync(path.join(outDir, automatic.value.file)));
  const record = bakers['audio-stitch'](
    { id: 'x' },
    ctx({ outDir, files, bake: { type: 'audio-stitch', name: 'x', slots: ['a'], embed: false, file: 'processed/custom/stitched.wav', url: '/audio/{file}' } }),
  );
  assert.equal(record.value.file, 'processed/custom/stitched.wav');
  assert.equal(record.value.url, '/audio/stitched.wav');
  assert.equal(record.value.data, undefined);
  assert.deepEqual(fs.readFileSync(path.join(outDir, record.value.file)), fs.readFileSync(path.join(outDir, automatic.value.file)));
});

test('audio-stitch external crossfade, resample, mixdown and normalization match embedded bytes and metadata', (t) => {
  const outDir = makeTmpDir(t, 'stitch-transform');
  const a = tone(0.08, 8000, 300, { channels: 2 });
  const b = tone(0.08, 4000, 550, { channels: 1 });
  const options = { type: 'audio-stitch', slots: [{ slot: 'a', gain: 0.6 }, 'b'], crossfadeMs: 5, mixdown: true, targetSampleRate: 8000, maxSeconds: 0.1, loopStart: 0, loopEnd: 0.07, loopCrossfade: 0.004, peak: 0.8, sampleFormat: 'pcm24', urlBase: '/media' };
  const input = { a, b };
  const external = bakers['audio-stitch']({ id: 'joined' }, ctx({ outDir, files: input, rawName: 'joined', bake: { ...options, embed: false } })).value;
  const embedded = bakers['audio-stitch']({ id: 'joined' }, ctx({ files: input, rawName: 'joined', bake: options })).value;
  const bytes = fs.readFileSync(path.join(outDir, external.file));
  assert.deepEqual(bytes, audioData(embedded));
  assert.equal(external.url, `/media/joined/${path.basename(external.file)}`);
  assert.equal(external.bytes, bytes.length);
  assert.equal(external.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(external.frames, 800);
  assert.equal(external.sampleRate, 8000);
  assert.equal(external.channels, 1);
  assert.equal(decodeWav(bytes).bits, 24);
  assert.deepEqual(decodeWav(bytes).channelData, decodeWav(audioData(embedded)).channelData);
  for (const key of ['frames', 'seconds', 'channels', 'sampleRate', 'loopStart', 'loopEnd', 'gain', 'peak', 'source']) assert.deepEqual(external[key], embedded[key], key);
  assert.deepEqual(a, input.a);
  assert.deepEqual(b, input.b);
});

test('audio external file rejects traversal, absolute, raw and symlink paths without changing raw', (t) => {
  const outDir = makeTmpDir(t, 'audio-paths');
  const outside = makeTmpDir(t, 'audio-outside');
  const raw = readFixture('clip-padded.wav');
  fs.mkdirSync(path.join(outDir, 'raw', 'x'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'raw', 'x', 'result.wav'), raw);
  fs.symlinkSync(outside, path.join(outDir, 'linked'));
  fs.mkdirSync(path.join(outDir, 'processed'), { recursive: true });
  fs.symlinkSync(path.join(outDir, 'raw', 'x', 'result.wav'), path.join(outDir, 'processed', 'linked.wav'));
  for (const file of ['../escape.wav', 'processed/../../escape.wav', '/tmp/escape.wav', 'C:\\escape.wav', 'raw/x/result.wav', 'processed/./bad.wav', 'linked/escape.wav', 'processed/linked.wav']) {
    for (const type of ['audio-clip', 'audio-stitch']) {
      const bake = type === 'audio-clip' ? { type, embed: false, file } : { type, slots: ['result'], embed: false, file };
      assert.throws(() => bakers[type]({ id: 'x' }, ctx({ outDir, files: { result: raw }, bake })), /file|symlink/, `${type}: ${file}`);
    }
  }
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'raw', 'x', 'result.wav')), raw);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('echo-map reads extras.taps into a compact record', () => {
  const record = bakers['echo-map'](
    { id: 'echo' },
    ctx({
      files: { result: readFixture('echo-trajectory.json') },
      saved: { result: savedEntry('raw/echo/result.json') },
      bake: { type: 'echo-map', name: 'arena', urlBase: '/audio/spaces', maxTaps: 3 },
    }),
  );
  assert.equal(record.bucket, 'spaces');
  assert.equal(record.key, 'arena');
  assert.equal(record.value.lattice, 'square');
  assert.equal(record.value.sites, 4);
  assert.equal(record.value.depth, 3);
  assert.equal(record.value.seed, 12345);
  assert.equal(record.value.count, 5);
  assert.equal(record.value.taps.length, 3);
  assert.deepEqual(record.value.taps[0], { site: 0, depth: 1, level: 0.998, polarity: 1, fRe: 0.998, fIm: 0.0001, x: 0, y: 0, timeMs: 30 });
  assert.equal(record.value.irFile, 'raw/echo/result.json');
  assert.equal(record.value.irUrl, '/audio/spaces/job-1/result.json');
});

test('echo-map finds taps nested under data.extras and honours includeZ', () => {
  const nested = {
    provenance: { seed: 9 },
    data: { sites: 2, extras: { taps: [{ site: 0, depth: 1, level: 0.5, polarity: 1, F_re: 0.5, F_im: 0, z: 0.25 }] } },
  };
  const record = bakers['echo-map']({ id: 'x' }, ctx({ result: nested, bake: { type: 'echo-map', name: 'nested' } }));
  assert.equal(record.value.seed, 9);
  assert.equal(record.value.sites, 2);
  assert.equal(record.value.taps.length, 1);
  assert.equal(record.value.taps[0].z, undefined);

  const withZ = bakers['echo-map']({ id: 'x' }, ctx({ result: nested, bake: { type: 'echo-map', name: 'nested', includeZ: true } }));
  assert.equal(withZ.value.taps[0].z, 0.25);
});

test('echo-map errors clearly when there is no tap map', () => {
  assert.throws(
    () => bakers['echo-map']({ id: 'x' }, ctx({ files: { result: Buffer.from('{}') }, bake: { type: 'echo-map' } })),
    /no tap map found/,
  );
  assert.throws(
    () => bakers['echo-map']({ id: 'x' }, ctx({ bake: { type: 'echo-map', slot: 'result' } })),
    /output slot "result" missing/,
  );
});

test('audio-pack writes clip files, sidecars and a manifest', async (t) => {
  const outDir = makeTmpDir(t, 'audio-pack');
  fs.mkdirSync(path.join(outDir, 'raw', 'ir'), { recursive: true });
  fs.copyFileSync(fixture('impulse.wav'), path.join(outDir, 'raw', 'ir', 'result.wav'));

  const records = [
    { job: 'bed', type: 'audio-clip', ...bakers['audio-clip']({ id: 'bed' }, ctx({ files: { result: readFixture('clip-padded.wav') }, bake: { type: 'audio-clip', name: 'bed', loopStart: 0, loopEnd: 0.02, category: 'loop', meta: { group: 'beds', weight: 2, tags: ['ritual'] } } })) },
    { job: 'st', type: 'audio-stitch', ...bakers['audio-stitch']({ id: 'st' }, ctx({ files: { a: readFixture('clip-pcm16.wav'), b: readFixture('clip-padded.wav') }, bake: { type: 'audio-stitch', name: 'st', slots: ['a', 'b'] } })) },
    { job: 'e', type: 'echo-map', ...bakers['echo-map']({ id: 'e' }, ctx({ result: JSON.parse(readFixture('echo-trajectory.json')), bake: { type: 'echo-map', name: 'arena' } })) },
    { job: 'ir', type: 'ir', ...bakers.ir({ id: 'ir' }, ctx({ files: { result: readFixture('impulse.wav'), taps: readFixture('impulse-taps.json') }, saved: { result: savedEntry('raw/ir/result.wav') }, bake: { type: 'ir', name: 'cavern' } })) },
  ];

  const written = await runEmitters({ config: { emitters: [{ type: 'audio-pack', dir: 'pack' }] }, records, outDir, provenance: { bed: { engine: 'qrc-audio-v1' } }, log: () => {} });
  assert.ok(written.includes(path.join(outDir, 'pack', 'manifest.json')));
  assert.ok(fs.existsSync(path.join(outDir, 'pack', 'audio', 'bed.wav')));
  assert.ok(fs.existsSync(path.join(outDir, 'pack', 'audio', 'st.wav')));
  assert.ok(fs.existsSync(path.join(outDir, 'pack', 'spaces', 'arena.json')));
  assert.ok(fs.existsSync(path.join(outDir, 'pack', 'irs', 'cavern.wav')));
  assert.ok(fs.existsSync(path.join(outDir, 'pack', 'irs', 'cavern.json')));

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'pack', 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest), ['version', 'generator', 'provenance', 'clips', 'spaces', 'irs']);
  assert.deepEqual(Object.keys(manifest.clips), ['audio/bed', 'audio/st']);
  assert.equal(manifest.clips['audio/bed'].file, 'audio/bed.wav');
  assert.equal(manifest.clips['audio/bed'].url, 'audio/bed.wav');
  assert.equal(manifest.clips['audio/bed'].seconds, 0.060125);
  assert.equal(manifest.clips['audio/bed'].sampleRate, 8000);
  assert.equal(manifest.clips['audio/bed'].channels, 1);
  assert.equal(manifest.clips['audio/bed'].loopStart, 0);
  assert.equal(manifest.clips['audio/bed'].loopEnd, 0.02);
  assert.ok(manifest.clips['audio/bed'].gain > 1);
  assert.equal(manifest.clips['audio/bed'].group, 'beds');
  assert.equal(manifest.clips['audio/bed'].weight, 2);
  assert.deepEqual(manifest.clips['audio/bed'].tags, ['ritual']);
  assert.equal(manifest.clips['audio/bed'].qualityReport.category, 'loop');
  assert.equal(manifest.spaces['spaces/arena'].lattice, 'square');
  assert.equal(manifest.irs['irs/cavern'].file, 'irs/cavern.wav');
  assert.equal(manifest.irs['irs/cavern'].taps, 64);

  // Determinism: the same records in a second directory produce identical bytes.
  const second = makeTmpDir(t, 'audio-pack-2');
  fs.mkdirSync(path.join(second, 'raw', 'ir'), { recursive: true });
  fs.copyFileSync(fixture('impulse.wav'), path.join(second, 'raw', 'ir', 'result.wav'));
  await runEmitters({ config: { emitters: [{ type: 'audio-pack', dir: 'pack' }] }, records, outDir: second, provenance: { bed: { engine: 'qrc-audio-v1' } }, log: () => {} });
  assert.deepEqual(
    fs.readFileSync(path.join(outDir, 'pack', 'manifest.json')),
    fs.readFileSync(path.join(second, 'pack', 'manifest.json')),
  );
  assert.deepEqual(
    fs.readFileSync(path.join(outDir, 'pack', 'audio', 'bed.wav')),
    fs.readFileSync(path.join(second, 'pack', 'audio', 'bed.wav')),
  );
});

test('audio-pack copies an embed:false file reference and honours sidecar:false', async (t) => {
  const outDir = makeTmpDir(t, 'audio-pack-file');
  fs.mkdirSync(path.join(outDir, 'raw', 'x'), { recursive: true });
  fs.copyFileSync(fixture('clip-pcm16.wav'), path.join(outDir, 'raw', 'x', 'result.wav'));
  const record = {
    job: 'x',
    type: 'audio-clip',
    ...bakers['audio-clip']({ id: 'x' }, ctx({
      files: { result: readFixture('clip-pcm16.wav') },
      saved: { result: savedEntry('raw/x/result.wav') },
      outDir,
      bake: { type: 'audio-clip', name: 'x', embed: false, url: '/moth/files/x.wav' },
    })),
  };
  await runEmitters({ config: { emitters: [{ type: 'audio-pack', dir: 'pack', sidecar: false }] }, records: [record], outDir, log: () => {} });
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'pack', 'audio', 'x.wav')), fs.readFileSync(path.join(outDir, record.value.file)));
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'pack', 'manifest.json'), 'utf8'));
  assert.equal(manifest.clips['audio/x'].url, '/moth/files/x.wav');
  assert.equal(manifest.clips['audio/x'].file, 'audio/x.wav');

  const echo = { job: 'e', type: 'echo-map', ...bakers['echo-map']({ id: 'e' }, ctx({ result: JSON.parse(readFixture('echo-trajectory.json')), bake: { type: 'echo-map', name: 'arena' } })) };
  await runEmitters({ config: { emitters: [{ type: 'audio-pack', dir: 'pack', sidecar: false }] }, records: [echo], outDir, log: () => {} });
  assert.ok(!fs.existsSync(path.join(outDir, 'pack', 'spaces', 'arena.json')));
});

test('audio-pack rejects a record with neither data nor file', async (t) => {
  const outDir = makeTmpDir(t, 'audio-pack-error');
  await assert.rejects(
    () => runEmitters({ config: { emitters: [{ type: 'audio-pack' }] }, records: [{ job: 'x', type: 'audio-clip', bucket: 'audio', key: 'x', value: { container: 'wav' } }], outDir, log: () => {} }),
    /neither data nor file/,
  );
});

test('makeSourceAudio is deterministic, decodable and kind-sensitive', () => {
  const first = makeSourceAudio({ kind: 'drone', seconds: 0.2, sampleRate: 8000, seed: 5 });
  const second = makeSourceAudio({ kind: 'drone', seconds: 0.2, sampleRate: 8000, seed: 5 });
  assert.deepEqual(first, second);
  const decoded = decodeWav(first, { mixdown: true });
  assert.equal(decoded.sampleRate, 8000);
  assert.equal(decoded.frames, 1600);
  assert.ok(decoded.samples.some((value) => Math.abs(value) > 0.01));
  assert.notDeepEqual(makeSourceAudio({ kind: 'noise', seconds: 0.1, sampleRate: 8000, seed: 1 }), makeSourceAudio({ kind: 'noise', seconds: 0.1, sampleRate: 8000, seed: 2 }));
  assert.deepEqual(makeSourceAudio('bed-seed', { seconds: 0.1, sampleRate: 8000 }), makeSourceAudio({ kind: 'drone', seconds: 0.1, sampleRate: 8000, seed: 7, baseHz: 55 }));
  assert.throws(() => makeSourceAudio({ kind: 'nope' }), /unknown audio kind/);
});

test('makeChunkZip splits a WAV into deterministic chunks', () => {
  const wav = makeSourceAudio({ kind: 'drone', seconds: 0.04, sampleRate: 8000, seed: 3 });
  const first = makeChunkZip(wav, { chunkSeconds: 0.01 });
  const second = makeChunkZip(wav, { chunkSeconds: 0.01 });
  assert.deepEqual(first.zip, second.zip);
  assert.equal(first.entries.size, 4);
  const entries = unzip(first.zip);
  assert.deepEqual([...entries.keys()], ['chunk-000.wav', 'chunk-001.wav', 'chunk-002.wav', 'chunk-003.wav']);
  assert.equal(decodeWav(entries.get('chunk-000.wav')).frames, 80);
});

test('writeSources writes audio seeds and a chunks archive', (t) => {
  const dir = makeTmpDir(t, 'sources-audio');
  const written = writeSources({
    dir,
    patterns: {},
    audio: { seed: { kind: 'pulse', seconds: 0.02, sampleRate: 8000, seed: 1 } },
    chunks: { from: 'seed', chunkSeconds: 0.01 },
    motif: false,
    log: () => {},
  });
  assert.deepEqual(written.map((file) => path.basename(file)).sort(), ['seed-chunks.zip', 'seed.wav']);
  assert.equal(decodeWav(fs.readFileSync(path.join(dir, 'seed.wav'))).frames, 160);
  const entries = unzip(fs.readFileSync(path.join(dir, 'seed-chunks.zip')));
  assert.equal(entries.size, 2);
});

test('config validates inputFrom references and assetIds', () => {
  const issues = (job) => validateConfig({ jobs: [{ id: 'a', engine: 'e' }, job] }).errors.map(formatIssue);
  assert.deepEqual(issues({ id: 'b', engine: 'e', inputFrom: { model: { job: 'a' } } }), []);
  assert.ok(issues({ id: 'b', engine: 'e', inputFrom: { model: { job: 'missing' } } }).some((line) => line.includes('unknown job "missing"')));
  assert.ok(issues({ id: 'b', engine: 'e', inputFrom: 5 }).some((line) => line.includes('inputFrom must map')));
  assert.ok(issues({ id: 'b', engine: 'e', inputFrom: { m: { job: '' } } }).some((line) => line.includes('inputFrom.job')));
  assert.ok(issues({ id: 'b', engine: 'e', assetIds: { model: 5 } }).some((line) => line.includes('assetIds.model')));

  const forward = validateConfig({ jobs: [{ id: 'a', engine: 'e', inputFrom: { m: { job: 'b' } } }, { id: 'b', engine: 'e' }] });
  assert.deepEqual(forward.errors, []);
  assert.deepEqual(forward.warnings, [], 'forward dependencies are topologically planned, not warned as stale order');
});
