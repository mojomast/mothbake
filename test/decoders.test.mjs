import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeHdr, decodeMidi, decodePng, decodeWav, encodeMidi, encodePng, encodeWav, unzip, wavInfo, zip } from '../src/decoders/index.mjs';
import { readFixture } from './helpers.mjs';

test('decodePng reads a recorded truecolour PNG', () => {
  const image = decodePng(readFixture('tile.png'));
  assert.equal(image.width, 256);
  assert.equal(image.height, 256);
  assert.equal(image.data.length, 256 * 256 * 4);
  assert.equal(image.data[3], 255, 'opaque alpha for truecolour input');
  const shades = new Set();
  for (let i = 0; i < image.data.length; i += 4 * 97) shades.add(image.data[i]);
  assert.ok(shades.size > 8, `expected varied pixels, saw ${shades.size} shades`);
});

test('decodePng handles a second recorded PNG', () => {
  const image = decodePng(readFixture('sky.png'));
  assert.equal(image.width, 512);
  assert.equal(image.height, 256);
});

test('decodePng rejects non-PNG bytes', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/);
});

test('encodePng round-trips RGB pixels exactly', () => {
  const width = 5;
  const height = 3;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 37) % 256;
  const png = encodePng(width, height, rgb);
  const decoded = decodePng(png);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  for (let i = 0; i < width * height; i++) {
    assert.deepEqual(
      [decoded.data[i * 4], decoded.data[i * 4 + 1], decoded.data[i * 4 + 2], decoded.data[i * 4 + 3]],
      [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], 255],
    );
  }
});

test('encodePng round-trips RGBA pixels exactly', () => {
  const width = 4;
  const height = 4;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 11) % 256;
  const png = encodePng(width, height, rgba);
  const decoded = decodePng(png);
  assert.deepEqual(Buffer.from(decoded.data), Buffer.from(rgba));
});

test('encodePng validates the pixel buffer length', () => {
  assert.throws(() => encodePng(4, 4, new Uint8Array(10)), /expected 48 \(RGB\) or 64 \(RGBA\) bytes/);
});

test('unzip reads a recorded engine archive', () => {
  const entries = unzip(readFixture('lut-pack.zip'));
  assert.ok(entries.size >= 5, `expected several entries, got ${entries.size}`);
  for (const name of ['R_lut.hdr', 'T_lut.hdr']) {
    const data = entries.get(name);
    assert.ok(data && data.length > 0, `${name} should be present and non-empty`);
  }
  assert.ok([...entries.keys()].some((name) => name.endsWith('.glsl')));
});

test('unzip rejects data without a central directory', () => {
  assert.throws(() => unzip(Buffer.from('definitely not a zip archive')), /end-of-central-directory/);
});

test('decodeHdr reads a Radiance LUT from the archive', () => {
  const entries = unzip(readFixture('lut-pack.zip'));
  const hdr = decodeHdr(entries.get('R_lut.hdr'));
  assert.equal(hdr.width, 80);
  assert.equal(hdr.height, 80);
  assert.equal(hdr.data.length, 80 * 80 * 3);
  let max = -Infinity;
  let min = Infinity;
  for (const value of hdr.data) {
    assert.ok(Number.isFinite(value));
    if (value > max) max = value;
    if (value < min) min = value;
  }
  assert.ok(min >= 0);
  assert.ok(max > min, 'expected a non-flat LUT');
});

test('decodeHdr rejects non-HDR data', () => {
  assert.throws(() => decodeHdr(Buffer.from('#?RADIANCE\n\n')), /resolution line/);
});

test('wavInfo describes a recorded impulse response', () => {
  const info = wavInfo(readFixture('impulse.wav'));
  assert.equal(info.format, 'pcm');
  assert.equal(info.channels, 2);
  assert.equal(info.sampleRate, 22050);
  assert.equal(info.bits, 16);
  assert.equal(info.frames, 88200);
  assert.equal(info.seconds, 4);
});

test('wavInfo rejects non-WAV data', () => {
  assert.throws(() => wavInfo(Buffer.alloc(64)), /not a RIFF\/WAVE/);
});

test('decodeWav decodes 8/16/24-bit PCM and 32-bit float fixtures', () => {
  const cases = [
    ['clip-pcm8.wav', { format: 'pcm', bits: 8, channels: 1 }],
    ['clip-pcm16.wav', { format: 'pcm', bits: 16, channels: 1 }],
    ['clip-pcm24.wav', { format: 'pcm', bits: 24, channels: 2 }],
    ['clip-float32.wav', { format: 'float', bits: 32, channels: 2 }],
  ];
  for (const [name, expected] of cases) {
    const decoded = decodeWav(readFixture(name), { mixdown: true });
    assert.equal(decoded.format, expected.format, name);
    assert.equal(decoded.bits, expected.bits, name);
    assert.equal(decoded.channels, expected.channels, name);
    assert.equal(decoded.sampleRate, 8000, name);
    assert.equal(decoded.frames, 400, name);
    assert.equal(decoded.channelData.length, expected.channels, name);
    assert.equal(decoded.samples.length, 400, name);
    for (const sample of decoded.samples) {
      assert.ok(Number.isFinite(sample) && sample >= -1.0001 && sample <= 1.0001, `${name} sample out of range: ${sample}`);
    }
  }
});

test('decodeWav keeps channels separate unless a mixdown is asked for', () => {
  const stereo = decodeWav(readFixture('clip-float32.wav'));
  assert.equal(stereo.channelData.length, 2);
  assert.equal(stereo.samples, undefined);
  const mono = decodeWav(readFixture('clip-float32.wav'), { mixdown: true });
  for (let i = 0; i < mono.frames; i++) {
    assert.ok(Math.abs(mono.samples[i] - (stereo.channelData[0][i] + stereo.channelData[1][i]) / 2) < 1e-6);
  }
});

test('encodeWav round-trips PCM and float samples', () => {
  const source = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25, -0.75, 0.125]);
  for (const [format, tolerance] of [
    ['pcm8', 0.01],
    ['pcm16', 1e-4],
    ['pcm24', 1e-6],
    ['pcm32', 1e-8],
    ['float32', 1e-7],
  ]) {
    const decoded = decodeWav(encodeWav(source, { sampleRate: 8000, format }), { mixdown: true });
    assert.equal(decoded.sampleRate, 8000);
    assert.equal(decoded.frames, source.length);
    for (let i = 0; i < source.length; i++) {
      assert.ok(Math.abs(decoded.samples[i] - source[i]) <= tolerance, `${format}[${i}]: ${decoded.samples[i]} != ${source[i]}`);
    }
  }
});

test('encodeWav writes and decodeWav reads multiple channels', () => {
  const left = new Float32Array([0.25, -0.25, 0.5]);
  const right = new Float32Array([-0.5, 0.5, -0.125]);
  const decoded = decodeWav(encodeWav([left, right], { sampleRate: 16000, format: 'pcm16' }));
  assert.equal(decoded.channels, 2);
  assert.equal(decoded.sampleRate, 16000);
  assert.ok(Math.abs(decoded.channelData[0][2] - 0.5) < 1e-4);
  assert.ok(Math.abs(decoded.channelData[1][0] + 0.5) < 1e-4);
});

test('decodeWav rejects unsupported formats, bit depths and channel counts', () => {
  const base = encodeWav(new Float32Array([0, 0.5, -0.5, 0]), { sampleRate: 8000, format: 'pcm16' });
  const alaw = Buffer.from(base);
  alaw.writeUInt16LE(6, 20); // fmt chunk: A-law
  assert.throws(() => decodeWav(alaw), /not supported/);
  const weird = Buffer.from(base);
  weird.writeUInt16LE(12, 34); // 12-bit PCM
  assert.throws(() => decodeWav(weird), /12-bit PCM unsupported/);
  const surround = encodeWav([new Float32Array(2), new Float32Array(2), new Float32Array(2)], { sampleRate: 8000 });
  assert.throws(() => decodeWav(surround, { maxChannels: 2 }), /3 channels exceed maxChannels=2/);
  assert.throws(() => encodeWav(new Float32Array(2), { format: 'pcm12' }), /unknown encode format/);
});

test('zip writes archives that unzip reads back exactly', () => {
  const entries = new Map([
    ['hello.txt', 'hello world '.repeat(20)],
    ['payload/data.bin', Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 7) % 256))],
    ['nested/θ.txt', 'unicode'],
  ]);
  for (const method of ['store', 'deflate', 'auto']) {
    const archive = zip(entries, { method });
    const back = unzip(archive);
    assert.deepEqual([...back.keys()], [...entries.keys()], method);
    for (const [name, data] of entries) {
      assert.deepEqual(back.get(name), Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'), `${method}:${name}`);
    }
  }
});

test('zip output is deterministic and rejects malformed inputs', () => {
  const entries = [['a.txt', 'aaa'], ['b.txt', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']];
  assert.deepEqual(zip(entries), zip(entries));
  assert.throws(() => zip(new Map()), /no entries/);
  assert.throws(() => zip([42]), /pairs or \{ name, data \}/);
  assert.throws(() => zip(new Map([['x', 'y']]), { method: 'bzip2' }), /unknown method/);
  assert.throws(() => unzip(Buffer.from('definitely not a zip archive')), /end-of-central-directory/);
});

test('decodeMidi reads a recorded motif', () => {
  const midi = decodeMidi(readFixture('motif.mid'));
  assert.equal(midi.bpm, 60);
  assert.equal(midi.ppq, 480);
  assert.ok(midi.notes.length >= 8, `expected notes, got ${midi.notes.length}`);
  for (const note of midi.notes) {
    assert.ok(note.step >= 0);
    assert.ok(note.dur >= 1);
    assert.ok(note.midi >= 0 && note.midi <= 127);
    assert.ok(note.vel > 0 && note.vel <= 127);
  }
  const steps = midi.notes.map((note) => note.step);
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b));
});

test('encodeMidi round-trips notes through decodeMidi', () => {
  const notes = [
    { tick: 0, dur: 480, midi: 57, vel: 82 },
    { tick: 480, dur: 240, midi: 64, vel: 74 },
    { tick: 960, dur: 960, midi: 69, vel: 96 },
  ];
  const decoded = decodeMidi(encodeMidi(notes, { ppq: 480, bpm: 90 }));
  assert.equal(decoded.bpm, 90);
  assert.equal(decoded.ppq, 480);
  assert.equal(decoded.notes.length, 3);
  assert.deepEqual(
    decoded.notes.map((note) => [note.step, note.dur, note.midi, note.vel]),
    [
      [0, 480, 57, 82],
      [480, 240, 64, 74],
      [960, 960, 69, 96],
    ],
  );
});
