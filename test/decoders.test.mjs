import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeHdr, decodeMidi, decodePng, encodeMidi, encodePng, unzip, wavInfo } from '../src/decoders/index.mjs';
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
