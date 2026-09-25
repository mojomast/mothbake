import { tileFbmXY } from './noise.mjs';

const clamp = (v) => Math.max(0, Math.min(1, v));
const byte = (v) => Math.round(clamp(v) * 255);
const srgbToLinear = (v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const linearToSrgb = (v) => v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };

function dimensions(width, height) {
  if (!Number.isSafeInteger(width) || width < 3 || width > 2048 || !Number.isSafeInteger(height) || height < 3 || height > 2048) {
    throw new RangeError('material-family: width and height must be integers from 3 to 2048');
  }
}

function grid(input, label) {
  if (!Array.isArray(input) || !input.length || !Array.isArray(input[0]) || !input[0].length) throw new TypeError(`material-family: ${label} must be a nonempty 2D grid`);
  const width = input[0].length;
  for (const row of input) {
    if (!Array.isArray(row) || row.length !== width || row.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) {
      throw new TypeError(`material-family: ${label} must be rectangular with values in [0, 1]`);
    }
  }
  return { width, height: input.length, values: input.flat() };
}

function seamReport(map) {
  const { width, height, data } = map;
  let xSum = 0, ySum = 0, xMax = 0, yMax = 0;
  const diff = (a, b) => {
    let total = 0;
    for (let c = 0; c < 3; c++) total += Math.abs(data[a + c] - data[b + c]) / (3 * 255);
    return total;
  };
  for (let y = 0; y < height; y++) {
    const d = diff(y * width * 4, (y * width + width - 1) * 4);
    xSum += d; xMax = Math.max(xMax, d);
  }
  for (let x = 0; x < width; x++) {
    const d = diff(x * 4, ((height - 1) * width + x) * 4);
    ySum += d; yMax = Math.max(yMax, d);
  }
  const corners = [0, (width - 1) * 4, (height - 1) * width * 4, (height * width - 1) * 4];
  const cornerMax = Math.max(...corners.slice(1).map((i) => diff(corners[0], i)));
  return { horizontal: { mean: xSum / height, max: xMax }, vertical: { mean: ySum / width, max: yMax }, corners: { max: cornerMax }, seamless: Math.max(xMax, yMax, cornerMax) <= 1 / 255 };
}

function assemble(fields, width, height, reliefStrength, periodic) {
  const maps = Object.fromEntries(['color', 'height', 'normal', 'roughness', 'wear'].map((name) => [name, { width, height, data: new Uint8Array(width * height * 4), format: 'rgba8', colorSpace: name === 'color' ? 'srgb' : 'linear' }]));
  const h = fields.height;
  const at = (x, y) => h[((y + (periodic ? height - 1 : height)) % (periodic ? height - 1 : height)) * width + ((x + (periodic ? width - 1 : width)) % (periodic ? width - 1 : width))];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x, i = p * 4;
    const dx = (at(x + 1, y) - at(x - 1, y)) * reliefStrength;
    const dy = (at(x, y + 1) - at(x, y - 1)) * reliefStrength;
    const length = Math.hypot(dx, dy, 1);
    const channels = {
      color: fields.color[p].map((v) => byte(linearToSrgb(clamp(v)))),
      height: Array(3).fill(byte(h[p])),
      normal: [byte((1 - dx / length) / 2), byte((1 - dy / length) / 2), byte((1 + 1 / length) / 2)],
      roughness: Array(3).fill(byte(fields.roughness[p])),
      wear: Array(3).fill(byte(fields.wear[p])),
    };
    for (const [name, rgb] of Object.entries(channels)) {
      maps[name].data.set(rgb, i);
      maps[name].data[i + 3] = 255;
    }
  }
  maps.normal.normalConvention = 'OpenGL +Y';
  return maps;
}

/**
 * Produce aligned RGBA8 PBR maps from source RGBA pixels, a normalized height or
 * structure grid, or a procedural metal panel. No network calls or image resizing.
 * Input dimensions must match output dimensions. All map alpha channels are opaque.
 */
export function createMaterialFamily(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('material-family: options must be an object');
  const { source, heightGrid, structureGrid, panelDensity = 4, grainDirection = 'horizontal', reliefStrength = 2,
    wearCoverage = 0.25, variationAmount = 0.5, seed = 1 } = options;
  if ([source, heightGrid, structureGrid].filter((v) => v !== undefined).length > 1) throw new TypeError('material-family: provide only one of source, heightGrid, structureGrid');
  if (!Number.isInteger(panelDensity) || panelDensity < 1 || panelDensity > 32) throw new RangeError('material-family: panelDensity must be an integer from 1 to 32');
  if (!['horizontal', 'vertical'].includes(grainDirection)) throw new RangeError('material-family: grainDirection must be horizontal or vertical');
  for (const [name, value, max] of [['reliefStrength', reliefStrength, 10], ['wearCoverage', wearCoverage, 1], ['variationAmount', variationAmount, 1]]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new RangeError(`material-family: ${name} must be in [0, ${max}]`);
  }
  if (!Number.isSafeInteger(seed)) throw new RangeError('material-family: seed must be a safe integer');
  const inputGrid = heightGrid !== undefined ? grid(heightGrid, 'heightGrid') : structureGrid !== undefined ? grid(structureGrid, 'structureGrid') : null;
  if (source !== undefined && (!source || typeof source !== 'object' || !(source.data instanceof Uint8Array))) throw new TypeError('material-family: source must contain Uint8Array RGBA data');
  const width = options.width ?? source?.width ?? inputGrid?.width ?? 64;
  const height = options.height ?? source?.height ?? inputGrid?.height ?? 64;
  dimensions(width, height);
  if (inputGrid && (width !== inputGrid.width || height !== inputGrid.height)) throw new RangeError('material-family: grid dimensions must match output');
  if (source && (width !== source.width || height !== source.height || source.data.length !== width * height * 4)) throw new RangeError('material-family: source dimensions/data must match output RGBA');
  const count = width * height;
  const fields = () => ({ height: new Float64Array(count), roughness: new Float64Array(count), wear: new Float64Array(count), color: new Array(count) });
  const candidate = fields(), baseline = fields();
  const input = (x, y) => {
    const p = y * width + x;
    if (inputGrid) return inputGrid.values[p];
    if (source) {
      const i = p * 4, a = source.data[i + 3] / 255;
      return a * (0.2126 * srgbToLinear(source.data[i] / 255) + 0.7152 * srgbToLinear(source.data[i + 1] / 255) + 0.0722 * srgbToLinear(source.data[i + 2] / 255));
    }
    return 0.5;
  };
  // Periodic coordinates include both boundary samples so generated edges and
  // corners agree exactly; supplied pixels are sampled without edge alteration.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x, u = x / (width - 1), v = y / (height - 1);
    const base = input(x, y);
    const n = tileFbmXY(u, v, seed, 4, 4, 3);
    const fine = tileFbmXY(u, v, seed + 23, grainDirection === 'horizontal' ? 2 : 16, grainDirection === 'horizontal' ? 16 : 2, 3);
    const line = grainDirection === 'horizontal' ? v : u;
    const grain = Math.sin(line * Math.PI * 2 * 16) * 0.5 + 0.5;
    const px = Math.abs(Math.sin(Math.PI * panelDensity * (u + 0.5 / panelDensity)));
    const py = Math.abs(Math.sin(Math.PI * panelDensity * (v + 0.5 / panelDensity)));
    const seam = 1 - smooth(0.025, 0.12, Math.min(px, py));
    const wear = wearCoverage === 0 ? 0 : smooth(0.7 - wearCoverage * 0.7, 0.85 - wearCoverage * 0.7, 0.65 * n + 0.25 * fine + 0.1 * (1 - Math.min(px, py)));
    const d = variationAmount * ((n - 0.5) * 0.3 + (fine - 0.5) * 0.18 + (grain - 0.5) * 0.08);
    candidate.height[p] = clamp(base * 0.65 + 0.2 + d - 0.24 * seam + 0.055 * wear);
    candidate.wear[p] = wear;
    candidate.roughness[p] = clamp(0.27 + 0.38 * wear + 0.18 * seam + d * 0.4);
    const metal = [0.31, 0.39, 0.46];
    candidate.color[p] = metal.map((c, channel) => {
      const sourceColor = source ? srgbToLinear(source.data[p * 4 + channel] / 255) : c;
      return clamp(sourceColor * (0.84 + d - seam * 0.45) + wear * 0.18);
    });
    // Conventional local baseline: direct grayscale height, uniform metallic
    // color and roughness, no panel seams or directional grain.
    baseline.height[p] = base;
    baseline.roughness[p] = 0.5;
    baseline.wear[p] = 0;
    baseline.color[p] = source ? [0, 1, 2].map((c) => srgbToLinear(source.data[p * 4 + c] / 255)) : [0.31, 0.39, 0.46];
  }
  const candidateMaps = assemble(candidate, width, height, reliefStrength, !source && !inputGrid);
  const baselineMaps = assemble(baseline, width, height, reliefStrength, !source && !inputGrid);
  const quality = (maps) => {
    const seams = Object.fromEntries(Object.entries(maps).map(([name, map]) => [name, seamReport(map)]));
    return { seams, seamless: Object.values(seams).every((report) => report.seamless) };
  };
  const metadata = { width, height, format: 'rgba8', maps: ['color', 'height', 'normal', 'roughness', 'wear'], colorSpace: { color: 'srgb', height: 'linear', normal: 'linear', roughness: 'linear', wear: 'linear' }, normalConvention: 'OpenGL +Y', tangentSpace: true, mapInterpretation: { roughness: 'synthesis heuristic; not recovered physical truth', wear: 'synthesis heuristic; not recovered physical truth' }, seed, controls: { panelDensity, grainDirection, reliefStrength, wearCoverage, variationAmount }, sourceType: source ? 'rgba' : inputGrid ? (heightGrid ? 'heightGrid' : 'structureGrid') : 'procedural' };
  return {
    candidate: { width, height, maps: candidateMaps, metadata: { ...metadata, variant: 'candidate' }, quality: quality(candidateMaps) },
    baseline: { width, height, maps: baselineMaps, metadata: { ...metadata, variant: 'baseline' }, quality: quality(baselineMaps) },
    metadata,
  };
}
