/* ===========================================================
   汎用ユーティリティ
   =========================================================== */

import { t } from './i18n.js';

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));

export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** フレームレート非依存の指数補間（lambda が大きいほど速く追従） */
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/**
 * 糸のたるみの形（t: 0=竿先 1=終点 → 0〜1 の倍率。最大 1）。
 * sin(πt) は t=0 での傾きが π もあり、竿先の時点で糸が垂れ始めてしまう。
 * 実際の竿先はガイドで糸が折れ返る＝竿と糸は鋭角に交わり、糸自体は
 * ピンと張って出ていくので、t=0 で値も傾きも 0 になる形にする。
 * 6.75·t²(1−t) は最大が t=2/3（ウキ寄り）で、6.75 = 1 / ((2/3)²·(1/3)) は
 * 最大値を 1 に正規化する係数。
 * 描画（angler）・ウキの位置（game）・地形との当たり（terrain）で共有する
 */
export const lineSagProfile = (t) => 6.75 * t * t * (1 - t);

export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
export const randSign = () => (Math.random() < 0.5 ? -1 : 1);
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];

/** 正規分布っぽい乱数（-1..1 中央寄り） */
export function randBell() {
  return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
}

/** [{...}] から weightFn の重み付き抽選 */
export function weightedPick(items, weightFn) {
  let total = 0;
  const weights = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const w = Math.max(0, weightFn(items[i], i));
    weights[i] = w;
    total += w;
  }
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** mulberry32: 決定論的な擬似乱数 */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- 値ノイズ（地形生成用・決定論的） ---------- */
export function makeNoise2D(seed = 1337) {
  const rng = makeRng(seed);
  const SIZE = 256;
  const perm = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i++) perm[i] = i;
  for (let i = SIZE - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  const grad = new Float32Array(SIZE * 2);
  for (let i = 0; i < SIZE; i++) {
    const a = rng() * TAU;
    grad[i * 2] = Math.cos(a);
    grad[i * 2 + 1] = Math.sin(a);
  }
  const hash = (x, y) => perm[(perm[x & 255] + (y & 255)) & 255];

  /** 勾配ノイズ: -1..1 */
  function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const n00 = dotAt(xi, yi, xf, yf);
    const n10 = dotAt(xi + 1, yi, xf - 1, yf);
    const n01 = dotAt(xi, yi + 1, xf, yf - 1);
    const n11 = dotAt(xi + 1, yi + 1, xf - 1, yf - 1);
    return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 1.4;

    function dotAt(ix, iy, dx, dy) {
      const h = hash(ix, iy);
      return grad[h * 2] * dx + grad[h * 2 + 1] * dy;
    }
  }

  /** フラクタルノイズ */
  function fbm(x, y, octaves = 4, lacunarity = 2.03, gain = 0.5) {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** リッジノイズ（山脈用） */
  function ridge(x, y, octaves = 4) {
    let sum = 0, amp = 0.5, freq = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(noise(x * freq, y * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= 0.5;
      freq *= 2.07;
    }
    return sum / norm;
  }

  return { noise, fbm, ridge };
}

/* ---------- 表示整形 ---------- */
export const fmtInt = (n) => Math.round(n).toLocaleString('ja-JP');
export const fmt1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
export const fmt2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
/** 重さ：小物（100g 未満）は g 表示にする（0.00 kg にならないように） */
export const fmtWeight = (kg) => (kg < 0.1 ? `${Math.max(1, Math.round(kg * 1000))} g` : `${fmt2(kg)} kg`);

export function fmtClock(hour) {
  const h = Math.floor(hour) % 24;
  const m = Math.floor((hour % 1) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 0..24 の時刻から時間帯ラベル */
export function timeBandLabel(hour) {
  if (hour < 4) return t('timeBand.lateNight');
  if (hour < 6.5) return t('timeBand.dawn');
  if (hour < 10) return t('timeBand.morning');
  if (hour < 15) return t('timeBand.day');
  if (hour < 17.5) return t('timeBand.evening');
  if (hour < 19.5) return t('timeBand.dusk');
  return t('timeBand.night');
}

/** 魚の活性判定に使う時間帯タグ */
export function timeBand(hour) {
  if (hour >= 4.5 && hour < 7.5) return 'dawn';
  if (hour >= 7.5 && hour < 16.5) return 'day';
  if (hour >= 16.5 && hour < 19.5) return 'dusk';
  return 'night';
}
