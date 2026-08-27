/* ===========================================================
   タイル可能な多スケールノイズ（CPU 起動時テクスチャ生成用）
   period 周期のトーラス上で勾配ノイズ + fBm を評価する。
   =========================================================== */
import { makeRng, lerp, TAU } from './util.js';

function positiveInt(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function mixSeed(seed, stream, octave) {
  let x = (seed ^ stream ^ Math.imul(octave + 1, 0x9e3779b9)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * @param {number} period 勾配格子の整数セル周期
 * @param {number} seed
 */
export function makeTileableNoise2D(period, seed = 1) {
  positiveInt(period, 'period');
  const rng = makeRng(seed >>> 0);
  const grad = new Float32Array(period * period * 2);
  for (let i = 0; i < period * period; i++) {
    const a = rng() * TAU;
    grad[i * 2] = Math.cos(a);
    grad[i * 2 + 1] = Math.sin(a);
  }

  const wrap = (v) => {
    v %= period;
    return v < 0 ? v + period : v;
  };

  function dotGrid(gx, gy, dx, dy) {
    const idx = (gy * period + gx) * 2;
    return grad[idx] * dx + grad[idx + 1] * dy;
  }

  /** 勾配ノイズ: おおよそ -1..1 */
  function noise(x, y) {
    let x0 = Math.floor(x);
    let y0 = Math.floor(y);
    const xf = x - x0;
    const yf = y - y0;
    // Quintic fade keeps the first and second derivatives continuous at cells.
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);

    const x1 = wrap(x0 + 1);
    const y1 = wrap(y0 + 1);
    x0 = wrap(x0);
    y0 = wrap(y0);

    const n00 = dotGrid(x0, y0, xf, yf);
    const n10 = dotGrid(x1, y0, xf - 1, yf);
    const n01 = dotGrid(x0, y1, xf, yf - 1);
    const n11 = dotGrid(x1, y1, xf - 1, yf - 1);

    return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
  }

  return { noise };
}

/**
 * 128x128 等の詳細テクスチャ向け高さ場。
 * x/y は texel 座標で、各 octave が自然に size 周期を満たす。
 * したがって有限差分勾配もテクスチャ端で連続する。
 */
export function makeTileableHeightField(size, seed, {
  octaves = 5,
  lacunarity = 2,
  gain = 0.5,
  baseFrequency = 4,
  amplitude = 1,
  secondaryFrequency = 3,
  secondaryMix = 0.38,
} = {}) {
  positiveInt(size, 'size');
  positiveInt(octaves, 'octaves');
  positiveInt(baseFrequency, 'baseFrequency');
  positiveInt(secondaryFrequency, 'secondaryFrequency');
  positiveInt(lacunarity, 'lacunarity');
  if (!(gain > 0 && gain < 1)) throw new RangeError('gain must be between 0 and 1');
  if (!(secondaryMix >= 0 && secondaryMix <= 1)) throw new RangeError('secondaryMix must be in [0, 1]');

  const maxCells = Math.max(1, Math.floor(size / 2));
  const buildBand = (startCells, stream, octaveCount = octaves, cellLimit = maxCells) => {
    const layers = [];
    let cells = startCells;
    let amp = 1;
    let norm = 0;
    for (let octave = 0; octave < octaveCount && cells <= cellLimit; octave++) {
      layers.push({
        cells,
        amp,
        noise: makeTileableNoise2D(cells, mixSeed(seed >>> 0, stream, octave)).noise,
      });
      norm += amp;
      amp *= gain;
      cells *= lacunarity;
    }
    if (!layers.length) throw new RangeError('base frequency exceeds the texture Nyquist limit');
    return { layers, norm };
  };

  // Each octave owns an independent gradient torus whose period equals its
  // integer cell count. Advancing x/y by `size` therefore advances every
  // octave by exactly one whole period without an endpoint jump.
  const primary = buildBand(baseFrequency, 0x51f15e5d);
  // The integer 45-degree transform below increases the maximum spatial
  // frequency by sqrt(2), so cap this band before that transform.
  const rotatedCellLimit = Math.max(1, Math.floor(maxCells / Math.SQRT2));
  const secondary = buildBand(
    secondaryFrequency,
    0xa2aa033b,
    Math.max(2, octaves - 1),
    rotatedCellLimit,
  );

  const sampleBand = (band, x, y) => {
    let sum = 0;
    for (const layer of band.layers) {
      const nx = (x / size) * layer.cells;
      const ny = (y / size) * layer.cells;
      sum += layer.amp * layer.noise(nx, ny);
    }
    return sum / band.norm;
  };

  return (x, y) => {
    const h0 = sampleBand(primary, x, y);
    // Integer torus transform rotates/shears the secondary band while keeping
    // x/y + size periodic for every integer-cell octave.
    const h1 = sampleBand(
      secondary,
      x + y + size * 0.371,
      -x + y - size * 0.219,
    );
    return ((1 - secondaryMix) * h0 + secondaryMix * h1) * amplitude;
  };
}

/**
 * タイル可能なコースティクス網目（0..1）。
 *
 * 水面で屈折した光が集まる線は、実際には波面の曲率が焦点を結ぶ場所で、
 * 見た目は「セル境界に沿った細い明線」になる。ボロノイの F2-F1 を細く
 * 立てるとその網目が素直に出る。fbm の掛け算では「にじみ」しか作れない。
 *
 * @param {number} size texel 数（一辺）
 * @param {number} seed
 */
export function makeTileableCausticField(size, seed, {
  cells = 7,
  ridge = 0.34,
  sharpness = 1.5,
  jitter = 0.92,
  layers = 2,
} = {}) {
  positiveInt(size, 'size');
  positiveInt(cells, 'cells');
  positiveInt(layers, 'layers');
  if (!(ridge > 0)) throw new RangeError('ridge must be positive');

  const bands = [];
  let bandCells = cells;
  let weight = 1;
  let norm = 0;
  for (let l = 0; l < layers; l++) {
    const n = bandCells;
    const pts = new Float32Array(n * n * 2);
    const rng = makeRng(mixSeed(seed >>> 0, 0xc0ffee01, l));
    for (let i = 0; i < n * n; i++) {
      pts[i * 2] = 0.5 + (rng() - 0.5) * jitter;
      pts[i * 2 + 1] = 0.5 + (rng() - 0.5) * jitter;
    }
    bands.push({ n, pts, weight, spin: l * 0.7853981634 });
    norm += weight;
    weight *= 0.55;
    bandCells *= 2;
  }

  const bandValue = (band, x, y) => {
    const { n, pts } = band;
    const cx = (x / size) * n;
    const cy = (y / size) * n;
    const ix = Math.floor(cx);
    const iy = Math.floor(cy);
    let f1 = 1e9, f2 = 1e9;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const gx = ix + ox;
        const gy = iy + oy;
        const wx = ((gx % n) + n) % n;
        const wy = ((gy % n) + n) % n;
        const idx = (wy * n + wx) * 2;
        const dx = gx + pts[idx] - cx;
        const dy = gy + pts[idx + 1] - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
      }
    }
    // セル境界（F2 ≈ F1）で 1、内部で 0 になる細い明線
    const edge = 1 - Math.min(1, (f2 - f1) / ridge);
    return edge > 0 ? Math.pow(edge, sharpness) : 0;
  };

  return (x, y) => {
    let s = 0;
    for (const band of bands) {
      // 帯ごとに整数トーラス変換で回して、格子の重なりを避ける
      const rx = band.spin === 0 ? x : x + y + size * 0.283;
      const ry = band.spin === 0 ? y : -x + y - size * 0.157;
      s += band.weight * bandValue(band, rx, ry);
    }
    return Math.min(1, s / norm);
  };
}
