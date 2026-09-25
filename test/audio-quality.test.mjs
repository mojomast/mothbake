import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeAudioQuality } from '../src/audio-quality.mjs';

test('reports measurements without changing samples', () => {
  const samples = Float32Array.from([0, 0.25, -0.5, 1]);
  const before = Float32Array.from(samples);
  const report = analyzeAudioQuality([samples], 4, { category: 'impact' });
  assert.deepEqual(samples, before);
  assert.equal(report.peak, 1);
  assert.equal(report.frames, 4);
  assert.equal(report.seconds, 1);
  assert.equal(report.clippedSamples, 1);
  assert.match(report.warnings.join(' '), /clipping/);
  assert.equal(report.previewProcessing, 'none');
});

test('loop diagnostics and category-specific warnings are explicit', () => {
  const samples = Float32Array.from([1, 0, 0, -1]);
  const report = analyzeAudioQuality([samples], 4, { category: 'loop', loopStart: 0, loopEnd: 1 });
  assert.equal(report.loopSeam, 2);
  assert.match(report.warnings.join(' '), /Loop boundary/);
  const ir = analyzeAudioQuality([samples], 4, { category: 'impulse-response', normalized: true });
  assert.match(ir.warnings.join(' '), /not universally/);
  assert.throws(() => analyzeAudioQuality([samples], 4, { category: 'music' }), /unknown audio category/);
});
