import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unzip, zip } from '../src/decoders/zip.mjs';
import { readFixture } from './helpers.mjs';

const archive = (entries, method = 'store') => zip(entries, { method });
const central = (buf) => buf.readUInt32LE(buf.length - 6);

test('recorded archive and writer output remain readable', () => {
  assert.ok(unzip(readFixture('lut-pack.zip')).has('R_lut.hdr'));
  for (const method of ['store', 'deflate', 'auto']) {
    const buf = archive({ 'nested/θ.txt': 'hello', 'empty.txt': '' }, method);
    assert.equal(unzip(new Uint8Array(buf)).get('nested/θ.txt').toString(), 'hello');
    assert.equal(unzip(buf).get('empty.txt').length, 0);
  }
});

test('entry count, entry bytes, and aggregate bytes are independently bounded', () => {
  const buf = archive({ 'a.txt': '1234', 'b.txt': '5678' });
  assert.throws(() => unzip(buf, { maxEntries: 1 }), /maxEntries/);
  assert.throws(() => unzip(buf, { maxEntryUncompressedBytes: 3 }), /maxEntryUncompressedBytes/);
  assert.throws(() => unzip(buf, { maxTotalUncompressedBytes: 7 }), /maxTotalUncompressedBytes/);
  assert.equal(unzip(buf, { maxEntries: 2, maxEntryUncompressedBytes: 4, maxTotalUncompressedBytes: 8 }).size, 2);
  for (const value of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => unzip(buf, { maxEntries: value }), /maxEntries/);
  }
});

test('truncated payloads, forged ranges and local/central inconsistencies fail', () => {
  const source = archive({ 'a.txt': 'hello' });
  const mutate = (fn) => { const buf = Buffer.from(source); fn(buf, central(buf)); return buf; };
  assert.throws(() => unzip(mutate((buf, c) => {
    buf.writeUInt32LE(100, c + 20);
    buf.writeUInt32LE(100, 18);
  })), /truncated payload/);
  assert.throws(() => unzip(mutate((buf, c) => buf.writeUInt16LE(65535, c + 28))), /name or extra data/);
  assert.throws(() => unzip(mutate((buf, c) => buf.writeUInt16LE(65535, 26))), /local header mismatch/);
  assert.throws(() => unzip(mutate((buf, c) => buf.writeUInt16LE(8, c + 10))), /local header mismatch/);
  assert.throws(() => unzip(mutate((buf, c) => buf.writeUInt32LE(c, c + 42))), /invalid local header/);
  assert.throws(() => unzip(mutate((buf, c) => buf.writeUInt32LE(c + 100, buf.length - 6))), /central directory/);
});

test('stored and deflated entries check actual size and CRC', () => {
  const stored = archive({ 'a.txt': 'hello' });
  stored[30 + 5] ^= 1;
  assert.throws(() => unzip(stored), /CRC mismatch/);
  const deflated = archive({ 'a.txt': 'hello'.repeat(100) }, 'deflate');
  const c = central(deflated);
  deflated.writeUInt32LE(1, c + 24);
  deflated.writeUInt32LE(1, 22);
  assert.throws(() => unzip(deflated), /maxOutputLength|larger than|too large/i);
  const wrongSize = archive({ 'a.txt': 'hello' });
  const d = central(wrongSize);
  wrongSize.writeUInt32LE(6, d + 24);
  wrongSize.writeUInt32LE(6, 22);
  assert.throws(() => unzip(wrongSize), /decoded to 5 bytes, expected 6/);
  const wrongCrc = archive({ 'a.txt': 'hello' });
  wrongCrc.writeUInt32LE(0, 14);
  wrongCrc.writeUInt32LE(0, central(wrongCrc) + 16);
  assert.throws(() => unzip(wrongCrc), /CRC mismatch/);
});

test('data-descriptor-style local placeholders work; truncated deflate fails', () => {
  const buf = archive({ 'a.txt': 'hello'.repeat(100) }, 'deflate');
  const c = central(buf);
  buf.writeUInt16LE(8, 6);
  buf.writeUInt16LE(8, c + 8);
  buf.fill(0, 14, 26);
  assert.equal(unzip(buf).get('a.txt').length, 500);
  const truncated = Buffer.from(buf);
  truncated.writeUInt32LE(buf.readUInt32LE(c + 20) - 1, c + 20);
  assert.throws(() => unzip(truncated), /unexpected end|decoded to|CRC mismatch/i);
});

test('unsafe archive paths are rejected even when emitted by the writer', () => {
  for (const name of ['../escape', 'a/../escape', 'a\\..\\escape', '/root', '\\server\\share', 'C:/root', 'a\0b']) {
    assert.throws(() => unzip(archive({ [name]: 'x' })), /unsafe entry name/, name);
  }
  assert.equal(unzip(archive({ 'safe/nested.txt': 'x' })).get('safe/nested.txt').toString(), 'x');
});
