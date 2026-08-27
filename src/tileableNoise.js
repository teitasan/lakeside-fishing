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
 * タイル可能なコースティクス（0..1 の RGBA を返す）。
 *
 * 実際のコースティクスは「屈折写像 p → p + k·∇h の折り目」である。
 * ヤコビアンの行列式が 0 になる線がそれで、長く伸びた曲線とカスプ（尖点）に
 * なる。ボロノイの稜線や帯域制限したノイズの等高線を使うと、閉じたセルや
 * 輪が並んだ「幾何学模様」になってしまい、水中に六角格子が見える。
 *
 * 高さ場は単一帯域（+ 弱い第2帯域）にする。多オクターブにするとヘッシアンが
 * 最高オクターブに支配され、折り目がテクセル大の砂目に潰れる。
 * ヘッシアンの差分幅（stencil）も 1 テクセルより広く取って高域を抑える。
 *
 * RGB には焦点距離 k をわずかにずらした同じ模様を入れてあるので、
 * そのまま色収差（波長ごとに焦点が違うために出る虹色の縁）になる。
 *
 * @param {number} size texel 数（一辺）
 * @param {number} seed
 * @returns {{data: Uint8Array, mean: number, max: number}}
 */
export function makeTileableFoldCaustics(size, seed, {
  frequency = 14,      // 1 タイルあたりの波の数（＝リップルの波長）
  second = 0.35,       // 第2帯域の混ぜ量（折り目に有機的なうねりを与える）
  focus = 0.75,        // 折り目の密度。上げると caustic 線が増える
  softness = 0.34,     // 明線の太さ（|det| がこの値以内で光る）
  sharpen = 1.5,       // 明線の立ち上がり
  dispersion = 0.05,   // RGB 間の焦点差（色収差）
  modulation = 0.45,   // 線に沿った明るさのむら
  modFrequency = 2,
  stencil = 4,         // ヘッシアンの差分幅（texel）
} = {}) {
  positiveInt(size, 'size');
  positiveInt(Math.round(frequency), 'frequency');
  if (!(softness > 0)) throw new RangeError('softness must be positive');

  const f1 = Math.max(2, Math.round(frequency));
  const f2 = Math.max(2, Math.round(frequency * 2.13));
  const n1 = makeTileableNoise2D(f1, mixSeed(seed >>> 0, 0xf01d, 0)).noise;
  const n2 = makeTileableNoise2D(f2, mixSeed(seed >>> 0, 0xf01d, 1)).noise;

  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      h[y * size + x] = n1((x / size) * f1, (y / size) * f1)
        + second * n2((x / size) * f2, (y / size) * f2);
    }
  }
  const at = (x, y) => h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];

  const st = Math.max(1, Math.round(stencil));
  const hxx = new Float32Array(size * size);
  const hzz = new Float32Array(size * size);
  const hxz = new Float32Array(size * size);
  let sq = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const c = at(x, y);
      hxx[i] = at(x + st, y) - 2 * c + at(x - st, y);
      hzz[i] = at(x, y + st) - 2 * c + at(x, y - st);
      hxz[i] = (at(x + st, y + st) - at(x + st, y - st)
        - at(x - st, y + st) + at(x - st, y - st)) * 0.25;
      sq += hxx[i] * hxx[i] + hzz[i] * hzz[i];
    }
  }
  const rms = Math.sqrt(sq / (2 * size * size));
  const k0 = focus / Math.max(rms, 1e-12);

  const md = makeTileableNoise2D(
    Math.max(2, Math.round(modFrequency)),
    mixSeed(seed >>> 0, 0xf01d, 2)
  ).noise;

  const data = new Uint8Array(size * size * 4);
  let sum = 0, max = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const mf = Math.max(2, Math.round(modFrequency));
      const bright = 1 - modulation * 0.5
        + modulation * 0.5 * md((x / size) * mf, (y / size) * mf);
      for (let c = 0; c < 3; c++) {
        const k = k0 * (1 + (c - 1) * dispersion);
        const det = (1 + k * hxx[i]) * (1 + k * hzz[i]) - (k * hxz[i]) * (k * hxz[i]);
        const v = Math.pow(softness / (Math.abs(det) + softness), sharpen) * bright;
        data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(v * 255)));
        if (c === 1) { sum += v; max = Math.max(max, v); }
      }
      data[i * 4 + 3] = 255;
    }
  }
  return { data, mean: sum / (size * size), max };
}
