/* ===========================================================
   タイル可能な多スケールノイズ（CPU 起動時テクスチャ生成用）
   period 周期のトーラス上で勾配ノイズ + fBm を評価する。
   =========================================================== */
import { makeRng, lerp, TAU, clamp01, makeNoise2D } from './util.js';

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

/**
 * 敷き詰めた小石のハイトフィールド（タイル可能）。
 *
 * 砂利は «ノイズの凹凸» ではなく «丸い石が重なって敷き詰まったもの» なので、
 * fbm では出ない。石を 1 つずつドームとして置き、重なりは高いほうを採る。
 * 石の間には砂粒のノイズを敷く。
 *
 * 返す 3 枚はそれぞれ
 *   h     0..1 の高さ（法線の元）
 *   ao    窪みほど暗い遮蔽。石の «あいだ» が締まって見えるのはこれ
 *   rough 石は磨かれて滑らか、砂は粗い
 *
 * @param {number} size テクセル数（正方）
 * @param {number} seed
 * @param {{count?: number, rMin?: number, rMax?: number, flat?: number,
 *          grain?: number, grainFreq?: number, aoRadius?: number}} opts
 *   rMin/rMax/aoRadius はタイルの一辺に対する比
 */
export function makeTileablePebbleField(size, seed, {
  count = 240, rMin = 0.030, rMax = 0.10, flat = 0.60,
  grain = 0.12, grainFreq = 28, aoRadius = 0.055,
} = {}) {
  const rng = makeRng(seed >>> 0);
  const n = size * size;
  const h = new Float32Array(n);
  const isStone = new Uint8Array(n);
  const stoneR = new Float32Array(n);
  /* 石ごとの «色味»。砂は 0、石は 0.30〜1.00。
     全部が同じ明るさだと «型押しした砂» に見えてしまうので、
     1 個ずつ違う色を持たせる。粗さもここから引く */
  const tint = new Float32Array(n);

  /* 石を大きい順に置く。小さい石が大きい石の上に乗るほうが
     «あとから隙間に落ちた» 順序になって自然 */
  const stones = [];
  for (let i = 0; i < count; i++) {
    stones.push({
      cx: rng() * size, cy: rng() * size,
      r: (rMin + (rMax - rMin) * Math.pow(rng(), 1.7)) * size,
      // 少し潰す。真球だと «ビー玉» に見える
      k: flat * (0.75 + rng() * 0.5),
      t: 0.30 + rng() * 0.70,
    });
  }
  stones.sort((a, b) => b.r - a.r);

  const wrap = (v) => ((v % size) + size) % size;
  for (const st of stones) {
    const r = st.r, hh = r * st.k;
    const x0 = Math.floor(st.cx - r), x1 = Math.ceil(st.cx + r);
    const y0 = Math.floor(st.cy - r), y1 = Math.ceil(st.cy + r);
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - st.cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - st.cx;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r * r) continue;
        const v = hh * Math.sqrt(1 - d2 / (r * r));
        const idx = wrap(y) * size + wrap(x);
        if (v > h[idx]) { h[idx] = v; isStone[idx] = 1; stoneR[idx] = r; tint[idx] = st.t; }
      }
    }
  }

  // 砂粒。石の «あいだ» を埋める
  const noise = makeNoise2D(seed ^ 0x51ed);
  const gf = grainFreq / size;
  let hMax = 1e-6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      h[i] += (noise.fbm(x * gf, y * gf, 3) * 0.5 + 0.5) * grain * size * 0.02;
      hMax = Math.max(hMax, h[i]);
    }
  }
  for (let i = 0; i < n; i++) h[i] /= hMax;

  /* 遮蔽は «まわりの平均よりどれだけ低いか»。
     箱ぼかしを 1 回かけて差を取るだけで、石の間の溝が締まる */
  const rad = Math.max(1, Math.round(aoRadius * size));
  const blur = boxBlurWrap(h, size, rad);
  const ao = new Float32Array(n);
  for (let i = 0; i < n; i++) ao[i] = clamp01(0.5 + (h[i] - blur[i]) * 2.6);

  const rough = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // 石は磨かれて滑らか、砂は粗い。大きい石ほど滑らか
    const stone = isStone[i] ? clamp01(stoneR[i] / (rMax * size)) : 0;
    rough[i] = clamp01(0.92 - stone * 0.34 + (h[i] - 0.5) * 0.10);
  }
  return { h, ao, rough, tint, size };
}

/**
 * 陸アルベドの輝度から Height → Normal / AO / Roughness を焼く。
 * RG = 傾き, B = 遮蔽, A = 粗さ。タイル境界は boxBlurWrap でまたぐ。
 *
 * @param {Float32Array} luma  0〜1、行優先
 * @param {number} size
 */
export function bakeLandDetailMaps(luma, size, {
  aoRadius = 0.045,
  nScale = 2.4,
  roughLo = 0.72,
  roughHi = 0.94,
  heightBlur = 0.008,
} = {}) {
  positiveInt(size, 'size');
  if (luma.length !== size * size) {
    throw new RangeError(`luma length ${luma.length} != ${size * size}`);
  }
  const hRad = Math.max(1, Math.round(heightBlur * size));
  const height = boxBlurWrap(luma, size, hRad);
  const aoRad = Math.max(1, Math.round(aoRadius * size));
  const blur = boxBlurWrap(height, size, aoRad);
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const j = y * size + x;
      const i = j * 4;
      const sx = (at(x + 1, y) - at(x - 1, y)) * nScale;
      const sz = (at(x, y + 1) - at(x, y - 1)) * nScale;
      data[i] = Math.round(clamp01(sx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(clamp01(sz * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round(clamp01(0.5 + (height[j] - blur[j]) * 2.4) * 255);
      data[i + 3] = Math.round(clamp01(roughLo + luma[j] * (roughHi - roughLo)) * 255);
    }
  }
  return { data, height, size };
}

/** タイル境界をまたぐ箱ぼかし（横→縦の 2 パス） */
export function boxBlurWrap(src, size, rad) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const w = rad * 2 + 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let k = -rad; k <= rad; k++) s += src[y * size + (((x + k) % size) + size) % size];
      tmp[y * size + x] = s / w;
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      let s = 0;
      for (let k = -rad; k <= rad; k++) s += tmp[((((y + k) % size) + size) % size) * size + x];
      out[y * size + x] = s / w;
    }
  }
  return out;
}
