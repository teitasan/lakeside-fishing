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

/**
 * 距離から LOD 段を選ぶ（境界にヒステリシスを付ける）。
 * @param {number} dist カメラからの距離
 * @param {number[]} dists 昇順のしきい値（[近→中, 中→遠, ...]）
 * @param {number} cur いま割り当てられている段（初回は -1）
 * @param {number} hyst 境界の遊び幅（m）
 *
 * すでに粗い側にいるなら内側の境界まで戻らないと細かい側へ復帰しない。
 * これが無いと境界上を往復するだけで毎フレーム行列を作り直す羽目になる。
 */
export function lodForList(dist, dists, cur = -1, hyst = 8) {
  let lod = 0;
  for (let i = 0; i < dists.length; i++) {
    const edge = cur > i ? dists[i] - hyst : dists[i] + hyst;
    if (dist > edge) lod = i + 1;
  }
  return lod;
}

/**
 * 位置から決める株ごとの色ムラ。
 * 同じ緑が何百株も並ぶと、形をいくら作り込んでも «同じ物を並べた» と分かる。
 * seed ではなく座標から決めるので、ワールドは再現できる。
 * @param {number} x
 * @param {number} z
 * @param {number} valSpan 明るさの振れ幅
 * @param {number} warmSpan 色温度の振れ幅（+ で黄寄り, - で青寄り）
 */
export function tintAt(x, z, valSpan = 0.30, warmSpan = 0.16) {
  const hp = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  const hb = Math.sin(x * 39.3468 - z * 11.135) * 24634.6345;
  const a = hp - Math.floor(hp), b = hb - Math.floor(hb);
  /* どのチャンネルも 1 を超えさせない。テクスチャのアルベドに 1 より
     大きい値を掛けると物理的にありえない反射率になり、日向で
     トーンマップに飛ばされて葉や岩が白っぽく抜ける */
  const val = 1 - valSpan + a * valSpan;        // (1 - valSpan) 〜 1
  const warm = (b - 0.5) * warmSpan;            // + で黄寄り、- で青寄り
  const k = 1 / (1 + Math.abs(warm));
  return { r: val * (1 + warm) * k, g: val * k, b: val * (1 - warm) * k };
}
