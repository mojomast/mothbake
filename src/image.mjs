// Pixel and grid helpers shared by bakers, emitters and the value generators.
// All of these are pure: same inputs, same bytes out.

/** Nearest-neighbour resample of interleaved pixel data. */
export function resizeNearest(data, sourceWidth, sourceHeight, targetWidth, targetHeight, channels = 4) {
  const out = new Uint8Array(targetWidth * targetHeight * channels);
  for (let y = 0; y < targetHeight; y++) {
    const sy = Math.min(sourceHeight - 1, Math.floor((y * sourceHeight) / targetHeight));
    for (let x = 0; x < targetWidth; x++) {
      const sx = Math.min(sourceWidth - 1, Math.floor((x * sourceWidth) / targetWidth));
      for (let c = 0; c < channels; c++) {
        out[(y * targetWidth + x) * channels + c] = data[(sy * sourceWidth + sx) * channels + c];
      }
    }
  }
  return out;
}

/** Bilinear resample for continuous-tone images; nearest remains explicit for pixel art. */
export function resizeBilinear(data, sourceWidth, sourceHeight, targetWidth, targetHeight, channels = 4) {
  const out = new Uint8Array(targetWidth * targetHeight * channels);
  for (let y = 0; y < targetHeight; y++) {
    const sy = targetHeight === 1 ? 0 : (y * (sourceHeight - 1)) / (targetHeight - 1);
    const y0 = Math.floor(sy), y1 = Math.min(sourceHeight - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < targetWidth; x++) {
      const sx = targetWidth === 1 ? 0 : (x * (sourceWidth - 1)) / (targetWidth - 1);
      const x0 = Math.floor(sx), x1 = Math.min(sourceWidth - 1, x0 + 1), fx = sx - x0;
      for (let channel = 0; channel < channels; channel++) {
        const at = (px, py) => data[(py * sourceWidth + px) * channels + channel];
        const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
        const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
        out[(y * targetWidth + x) * channels + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return out;
}

/** Measure opposite-edge and corner discontinuity; this diagnoses, not repairs, seams. */
export function boundaryContinuity(data, width, height, channels = 4) {
  const differences = [];
  const compare = (a, b) => {
    for (let channel = 0; channel < Math.min(3, channels); channel++) differences.push(Math.abs(data[a + channel] - data[b + channel]) / 255);
  };
  for (let y = 0; y < height; y++) compare((y * width) * channels, (y * width + width - 1) * channels);
  for (let x = 0; x < width; x++) compare(x * channels, ((height - 1) * width + x) * channels);
  const corners = [
    0,
    (width - 1) * channels,
    ((height - 1) * width) * channels,
    ((height * width) - 1) * channels,
  ];
  for (let index = 1; index < corners.length; index++) compare(corners[0], corners[index]);
  const mean = differences.reduce((sum, value) => sum + value, 0) / (differences.length || 1);
  const max = differences.reduce((value, item) => Math.max(value, item), 0);
  return { mean: Math.round(mean * 1e6) / 1e6, max: Math.round(max * 1e6) / 1e6, exact: max === 0 };
}

/** Tone-map a decoded HDR image down to `size` x `size` 8-bit RGB. */
export function hdrToRgb8(hdr, size) {
  const small = resizeNearest(hdr.data, hdr.width, hdr.height, size, size, 3);
  const out = new Uint8Array(size * size * 3);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(small[i] * 255)));
  return out;
}

/** Normalize a 2D numeric grid to [0, 1] and resample it to width x height. */
export function resampleGrid(grid, width, height) {
  const rows = grid.length;
  const cols = grid[0]?.length || 0;
  if (!rows || !cols) throw new Error('grid: empty or ragged grid');
  let min = Infinity;
  let max = -Infinity;
  for (const row of grid) {
    for (const value of row) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('grid: non-numeric value');
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  const span = max - min || 1;
  const out = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(rows - 1, Math.floor((y * rows) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(cols - 1, Math.floor((x * cols) / width));
      out[y * width + x] = (grid[sy][sx] - min) / span;
    }
  }
  return out;
}

/** Derive a tangent-space normal map from a height field (wrapping edges). */
export function gridToNormal(field, width, height, strength = 1.6) {
  const rgb = new Uint8Array(width * height * 4);
  const at = (x, y) => field[((y + height) % height) * width + ((x + width) % width)];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const length = Math.hypot(-dx, -dy, 1) || 1;
      const i = (y * width + x) * 4;
      rgb[i] = Math.round(((-dx / length) * 0.5 + 0.5) * 255);
      rgb[i + 1] = Math.round(((-dy / length) * 0.5 + 0.5) * 255);
      rgb[i + 2] = Math.round(((1 / length) * 0.5 + 0.5) * 255);
      rgb[i + 3] = 255;
    }
  }
  return rgb;
}

/** Built-in colour ramps used when baking scalar fields into RGBA frames. */
export const RAMPS = {
  quantum: [[10, 30, 40], [40, 210, 200], [180, 120, 255], [240, 250, 255]],
  ember: [[26, 8, 6], [180, 40, 20], [255, 150, 40], [255, 240, 200]],
  plasma: [[10, 4, 30], [110, 30, 190], [255, 90, 160], [255, 240, 255]],
  ice: [[4, 10, 26], [40, 120, 220], [150, 220, 255], [250, 255, 255]],
  toxic: [[8, 20, 4], [70, 170, 40], [200, 240, 60], [255, 255, 220]],
};

/**
 * Map a normalized field through a colour ramp into RGBA bytes.
 *
 * @param {Float64Array|Float32Array} field Values in [0, 1].
 * @param {string|Array<[number, number, number]>} tint Ramp name or explicit stops.
 * @param {Record<string, Array<[number, number, number]>>} [ramps]
 */
export function gridToRamp(field, width, height, tint = 'quantum', ramps = RAMPS) {
  const ramp = Array.isArray(tint) ? tint : ramps[tint];
  if (!Array.isArray(ramp) || ramp.length < 2) {
    throw new Error(`ramp "${Array.isArray(tint) ? '(inline)' : tint}" is not a list of colour stops (available: ${Object.keys(ramps).join(', ')})`);
  }
  const rgb = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const t = Math.max(0, Math.min(0.9999, field[i])) * (ramp.length - 1);
    const a = ramp[Math.floor(t)];
    const b = ramp[Math.min(ramp.length - 1, Math.floor(t) + 1)];
    const f = t - Math.floor(t);
    rgb[i * 4] = Math.round(a[0] + (b[0] - a[0]) * f);
    rgb[i * 4 + 1] = Math.round(a[1] + (b[1] - a[1]) * f);
    rgb[i * 4 + 2] = Math.round(a[2] + (b[2] - a[2]) * f);
    rgb[i * 4 + 3] = 255;
  }
  return rgb;
}

export function toBase64(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export function fromBase64(text) {
  return Buffer.from(String(text), 'base64');
}
