import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyJpeg, verifyMediaStructure, verifyWebp, verifyMp3, verifyOgg } from '../src/media-structure.mjs';

const jpeg = Buffer.from('ffd8ffc0000b080001000101011100ffda0008010100003f001234ffd9', 'hex');
const vp8 = Buffer.from('0000009d012a0100010000', 'hex');
function webp(payload = vp8) {
  const chunk = Buffer.alloc(8);
  chunk.write('VP8 ');
  chunk.writeUInt32LE(payload.length, 4);
  const body = Buffer.concat([Buffer.from('WEBP'), chunk, payload, Buffer.alloc(payload.length & 1)]);
  const header = Buffer.alloc(8);
  header.write('RIFF'); header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
const mp3 = (() => {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  return frame;
})();
function ogg(payload = Buffer.from('OpusHead\x01\x02\x00\x00\x80\xbb\x00\x00\x00\x00\x00')) {
  const page = Buffer.alloc(28 + payload.length);
  page.write('OggS'); page[5] = 6; page[26] = 1; page[27] = payload.length;
  payload.copy(page, 28);
  let crc = 0;
  for (const byte of page) {
    crc ^= byte << 24;
    for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0)) >>> 0;
  }
  page.writeUInt32LE(crc, 22);
  return page;
}

test('JPEG segment and entropy framing rejects missing image structure, truncation and trailing bytes', () => {
  assert.equal(verifyJpeg(jpeg), true);
  for (const b of [Buffer.from('ffd8ffd9', 'hex'), jpeg.subarray(0, -2), Buffer.concat([jpeg, Buffer.from('x')]),
    Buffer.from(jpeg).fill(0xff, 4, 6), Buffer.from(jpeg).fill(0, 15, 17)]) assert.equal(verifyJpeg(b), false);
});

test('WebP requires full RIFF chunk framing and image payload', () => {
  const valid = webp();
  assert.equal(verifyWebp(valid), true);
  for (const b of [Buffer.from('RIFFxxxxWEBP'), valid.subarray(0, -1),
    Buffer.concat([valid, Buffer.from('x')]), webp(Buffer.from('fake'))]) assert.equal(verifyWebp(b), false);
});

test('MP3 requires complete valid audio frames after optional ID3', () => {
  assert.equal(verifyMp3(mp3), true);
  assert.equal(verifyMp3(Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00'), mp3])), true);
  for (const b of [Buffer.from('ID3'), mp3.subarray(0, -1), Buffer.concat([mp3, Buffer.from('x')]),
    Buffer.from(mp3).fill(0, 2, 3)]) assert.equal(verifyMp3(b), false);
});

test('Ogg validates page length, codec identification and CRC', () => {
  const valid = ogg();
  assert.equal(verifyOgg(valid), true);
  for (const b of [Buffer.from('OggS'), valid.subarray(0, -1), Buffer.from(valid).fill(0, 28, 29),
    ogg(Buffer.from('not-a-codec'))]) assert.equal(verifyOgg(b), false);
});

test('generic structural verifier dispatches supported extensions', () => {
  assert.equal(verifyMediaStructure(jpeg, '.jpg'), true);
  assert.throws(() => verifyMediaStructure(Buffer.alloc(1), '.mov'), /unsupported/);
});

export { jpeg, webp, mp3, ogg };
