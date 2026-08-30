/* ===========================================================
   波の場：CPU と GPU で同一の式を使う単一の定義元

   ここが唯一の真実になるので、ウキの浮き（CPU）・水面メッシュ（GPU）・
   渚の遡上（水面と地形の両方）・湖底コースティクスがすべて同じ波を見る。
   THREE を import しないので Node の回帰テストからも直接呼べる。
   =========================================================== */
import { TAU, smoothstep } from './util.js?v=20260830-zone5';

/** 波の定義（dir は正規化して使用） */
export const WAVES = [
  { dx: 1.00, dz: 0.20, len: 16.2, amp: 0.118, speed: 0.62 },
  { dx: 0.62, dz: -0.78, len: 9.40, amp: 0.070, speed: 0.78 },
  { dx: -0.34, dz: 0.94, len: 5.70, amp: 0.039, speed: 0.98 },
  { dx: 0.88, dz: 0.47, len: 3.35, amp: 0.020, speed: 1.28 },
  { dx: -0.72, dz: -0.69, len: 2.10, amp: 0.010, speed: 1.72 },
];

export const PHASE_W = [0.28, 0.42, 0.60, 0.78, 0.96];

/**
 * Gerstner の尖り具合。粒子は峰へ寄り、谷は広がるので峰が尖る。
 * Σ(CHOPPINESS · amp · k) < 1 を守らないと粒子が折り返してループになる。
 */
export const CHOPPINESS = 2.2;

/**
 * 渚の遡上量（m 単位のゲイン）。
 * ここは「湖」なので、砂浜のような数メートルの打ち上げ／引き波にはしない。
 * 0.85 だと汀線が 5m 近く往復して海になる。0.15 で往復 1m 弱の、
 * 岸をぺちゃぺちゃ舐める程度の動きになる（止めると汀線が凍って見える）。
 */
export const SWASH_GAIN = 0.15;

export const W = WAVES.map((w) => {
  const l = Math.hypot(w.dx, w.dz);
  const k = TAU / w.len;
  return { dx: w.dx / l, dz: w.dz / l, k, amp: w.amp, om: w.speed * k };
});

export const MAX_WAVE_AMP = W.reduce((a, w) => a + w.amp, 0);

/** Σ Q·A·k。1 未満でないと Gerstner がループする */
export const WAVE_STEEPNESS = W.reduce((a, w) => a + CHOPPINESS * w.amp * w.k, 0);

/** 遡上に使う長波成分の数（GLSL 側と揃える） */
const SWASH_MODES = 2;
const SWASH_K = 0.55;   // 岸沿いの波長を伸ばす
const SWASH_OM = 3.40;  // 遡上そのものは数秒周期で寄せて引く

/** 大域的な位相ゆらぎ：遠景の規則的な干渉縞を崩す（CPU/GPU 共通） */
export function wavePhaseOffset(x, z) {
  return Math.sin(x * 0.031 + z * 0.027) * 0.62
    + Math.sin(x * 0.017 - z * 0.039) * 0.48
    + Math.sin(x * 0.043 - z * 0.021) * 0.31;
}

export function wavePhaseOffsetGrad(x, z) {
  return {
    dx: Math.cos(x * 0.031 + z * 0.027) * 0.031 * 0.62
      + Math.cos(x * 0.017 - z * 0.039) * 0.017 * 0.48
      + Math.cos(x * 0.043 - z * 0.021) * 0.043 * 0.31,
    dz: Math.cos(x * 0.031 + z * 0.027) * 0.027 * 0.62
      + Math.cos(x * 0.017 - z * 0.039) * (-0.039) * 0.48
      + Math.cos(x * 0.043 - z * 0.021) * (-0.021) * 0.31,
  };
}

/** 波の高さ（wind: 1 で標準） */
export function waveHeight(x, z, t, wind = 1) {
  const phase = wavePhaseOffset(x, z);
  let h = 0;
  for (let i = 0; i < W.length; i++) {
    const w = W[i];
    h += w.amp * Math.sin((w.dx * x + w.dz * z) * w.k - t * w.om + phase * PHASE_W[i]);
  }
  return h * wind;
}

/** 波の勾配 dh/dx, dh/dz（解析微分） */
export function waveSlope(x, z, t, wind = 1) {
  const phase = wavePhaseOffset(x, z);
  const grad = wavePhaseOffsetGrad(x, z);
  let dx = 0, dz = 0;
  for (let i = 0; i < W.length; i++) {
    const w = W[i];
    const pw = PHASE_W[i];
    const c = Math.cos((w.dx * x + w.dz * z) * w.k - t * w.om + phase * pw) * w.amp * wind;
    dx += c * (w.k * w.dx + pw * grad.dx);
    dz += c * (w.k * w.dz + pw * grad.dz);
  }
  return { dx, dz };
}

/**
 * Gerstner の水平変位。h が sin なので水平は +Q·A·d·cos（GPU Gems 1, ch.1 と同形）。
 * 峰へ粒子が寄るので、同じ振幅でも峰が尖り谷が平らになる。
 */
export function waveDisplace(x, z, t, wind = 1) {
  const phase = wavePhaseOffset(x, z);
  let dx = 0, dz = 0;
  for (let i = 0; i < W.length; i++) {
    const w = W[i];
    const c = Math.cos((w.dx * x + w.dz * z) * w.k - t * w.om + phase * PHASE_W[i]);
    const a = CHOPPINESS * w.amp * c * wind;
    dx += a * w.dx;
    dz += a * w.dz;
  }
  return { dx, dz };
}

/**
 * 渚の遡上（swash）。正なら水が陸へ乗り上げ、負なら引き波で砂が出る。
 * 長波成分だけを遅く走らせ、さらに「セット」（大波・小波のうねり）で
 * 大きな遡上と小さな遡上が交互に来るようにする。
 */
export function shoreRunUp(x, z, t, wind = 1) {
  const phase = wavePhaseOffset(x, z);
  let h = 0;
  for (let i = 0; i < SWASH_MODES; i++) {
    const w = W[i];
    h += w.amp * Math.sin(
      (w.dx * x + w.dz * z) * w.k * SWASH_K - t * w.om * SWASH_OM + phase * PHASE_W[i]
    );
  }
  const sets = 0.62 + 0.38 * Math.sin(t * 0.30 + phase * 0.8);
  return h * SWASH_GAIN * sets * wind;
}

/**
 * 水深に応じた波の振幅係数。
 * 深場は 1、浅場では一度わずかに盛り上がってから（浅水変形＝shoaling）
 * 岸で 0 に落ちる。岸ぎわで単に減衰させるだけだと波が「岸に近づくほど
 * 静まる」逆の絵になるので、盛り上がり自体は残す。
 * ただし湖にうねりは来ないので、+12% 程度に抑える（+45% は砕ける前の
 * 海の波の膨らみで、渚が磯みたいに見える）。
 */
export const SHOAL_BUMP = 0.12;

export function shoalGain(depth) {
  const d = depth > 0 ? depth : 0;
  const damp = smoothstep(0, 1.6, d) * 0.85 + 0.15 * smoothstep(0, 5, d);
  const e = (d - 0.95) / 0.75;
  return damp * (1 + SHOAL_BUMP * Math.exp(-e * e));
}

/**
 * GPU 用に同じ式を GLSL として生成する。
 * @param {{prefix?: string, slim?: boolean}} opts
 *   prefix: 関数名の接頭辞（他シェーダへ同居させるときの衝突回避）
 *   slim: 位相と勾配だけを出す（コースティクス側は波の傾きしか要らない）
 */
export function waveGLSL({ prefix = '', slim = false } = {}) {
  const P = prefix;
  const fn = (name) => (P ? P + name[0].toUpperCase() + name.slice(1) : name);
  let sum = '', dsum = '', disp = '', swash = '';
  W.forEach((w, i) => {
    const ph = `((${w.dx.toFixed(5)} * p.x + ${w.dz.toFixed(5)} * p.y) * ${w.k.toFixed(5)} - t * ${w.om.toFixed(5)} + phase * ${PHASE_W[i].toFixed(5)})`;
    sum += `  h += ${w.amp.toFixed(5)} * sin(${ph});\n`;
    dsum += `  c = cos(${ph}) * ${w.amp.toFixed(5)};\n` +
      `  d += vec2(${w.k.toFixed(5)} * ${w.dx.toFixed(5)} + ${PHASE_W[i].toFixed(5)} * pg.x, ${w.k.toFixed(5)} * ${w.dz.toFixed(5)} + ${PHASE_W[i].toFixed(5)} * pg.y) * c;\n`;
    disp += `  a = ${(CHOPPINESS * w.amp).toFixed(5)} * cos(${ph});\n` +
      `  s += vec2(${w.dx.toFixed(5)}, ${w.dz.toFixed(5)}) * a;\n`;
    if (i < SWASH_MODES) {
      const sph = `((${w.dx.toFixed(5)} * p.x + ${w.dz.toFixed(5)} * p.y) * ${(w.k * SWASH_K).toFixed(5)} - t * ${(w.om * SWASH_OM).toFixed(5)} + phase * ${PHASE_W[i].toFixed(5)})`;
      swash += `  r += ${w.amp.toFixed(5)} * sin(${sph});\n`;
    }
  });
  const core = /* glsl */ `
float ${fn('wavePhase')}(vec2 p) {
  return sin(p.x * 0.031 + p.y * 0.027) * 0.62
       + sin(p.x * 0.017 - p.y * 0.039) * 0.48
       + sin(p.x * 0.043 - p.y * 0.021) * 0.31;
}
vec2 ${fn('wavePhaseGrad')}(vec2 p) {
  return vec2(
    cos(p.x * 0.031 + p.y * 0.027) * 0.031 * 0.62
      + cos(p.x * 0.017 - p.y * 0.039) * 0.017 * 0.48
      + cos(p.x * 0.043 - p.y * 0.021) * 0.043 * 0.31,
    cos(p.x * 0.031 + p.y * 0.027) * 0.027 * 0.62
      + cos(p.x * 0.017 - p.y * 0.039) * (-0.039) * 0.48
      + cos(p.x * 0.043 - p.y * 0.021) * (-0.021) * 0.31
  );
}
vec2 ${fn('waveD')}(vec2 p, float t) {
  float phase = ${fn('wavePhase')}(p);
  vec2 pg = ${fn('wavePhaseGrad')}(p);
  vec2 d = vec2(0.0);
  float c;
${dsum}  return d;
}
`;
  if (slim) return core;
  return core + /* glsl */ `
float ${fn('waveH')}(vec2 p, float t) {
  float phase = ${fn('wavePhase')}(p);
  float h = 0.0;
${sum}  return h;
}
/* Gerstner 水平変位：峰へ粒子を寄せて尖らせる */
vec2 ${fn('waveDisp')}(vec2 p, float t) {
  float phase = ${fn('wavePhase')}(p);
  vec2 s = vec2(0.0);
  float a;
${disp}  return s;
}
/* 渚の遡上（m）。正で陸へ乗り上げ、負で引き波 */
float ${fn('shoreRunUp')}(vec2 p, float t) {
  float phase = ${fn('wavePhase')}(p);
  float r = 0.0;
${swash}  float sets = 0.62 + 0.38 * sin(t * 0.30 + phase * 0.8);
  return r * ${SWASH_GAIN.toFixed(5)} * sets;
}
/* 浅水変形込みの振幅係数 */
float ${fn('shoalGain')}(float depth) {
  float d = max(depth, 0.0);
  float damp = smoothstep(0.0, 1.6, d) * 0.85 + 0.15 * smoothstep(0.0, 5.0, d);
  float e = (d - 0.95) / 0.75;
  return damp * (1.0 + ${SHOAL_BUMP.toFixed(5)} * exp(-e * e));
}
`;
}
