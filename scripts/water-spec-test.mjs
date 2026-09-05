/* 水面の鏡面反射（太陽・月）の検査。
 *
 * «光が水面に浮いた油膜に見える» のは、指数を固定した pow(N·H, k) が
 *   ・ローブの角幅を水面の状態と無関係に決めてしまう
 *   ・広がっても暗くならない（正規化が無い）
 * ことによる。とくに «光源を見下ろす» 配置（月が天頂・視線が真下）では
 * N·H が広い範囲で 1 に張り付き、ローブが一枚の板に潰れていた。
 *
 * water.js は円盤光源の GGX へ置き換えてある。ここでは
 *   1. 見下ろし配置で «明るい面» の割合が桁で小さく、代わりにピークが
 *      桁で大きいこと（＝膜ではなくまばらな閃きになっていること）
 *   2. 粗くするとピークが下がること（広がったぶん暗くなる）
 *   3. ピーク × ローブの立体角が粗さによらず一定であること（エネルギー保存）
 *   4. きらめきノイズの期待値が 1 に校正されていること
 * を見る。定数はソースから読むので、値を変えたのにテストだけ古い、が
 * 起きないようにしてある。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/water.js'), 'utf8');

const fails = [];
function check(label, ok, detail) {
  if (!ok) fails.push(`${label}: ${detail}`);
}

/* --- ソースから定数を読む --- */
function num(re, what) {
  const m = src.match(re);
  if (!m) throw new Error(`water.js から ${what} を読めない`);
  return parseFloat(m[1]);
}
const LIGHT_R    = num(/const float LIGHT_R = ([\d.]+);/, 'LIGHT_R');
const SUN_RAD    = num(/const float SUN_RAD\s*=\s*([\d.]+);/, 'SUN_RAD');
const MOON_RAD   = num(/const float MOON_RAD\s*=\s*([\d.]+);/, 'MOON_RAD');
const CAP_ROUGH  = num(/float capRough = ([\d.]+)/, 'capRough');
const LOD_ROUGH  = num(/float lodRough = ([\d.]+)/, 'lodRough');
const SPARK_AMT  = num(/float sparkAmt = ([\d.]+)/, 'sparkAmt');
const SPARK_GAIN = num(/float sparkle = mix\(1\.0, glitter \* ([\d.]+)/, 'sparkle gain');
const CLAMP      = num(/diskSpec\(N, V,  uSunDir, rough\) \* sparkle \* SUN_RAD,\s*([\d.]+)\)/, 'クランプ値');
const G_SOFT0    = num(/float gSoft = ([\d.]+)/, 'gSoft');
const G_THR = (() => {
  const m = src.match(
    /float glitter = smoothstep\(([\d.]+) - gSoft, ([\d.]+) \+ gSoft, g1\)\s*\*\s*smoothstep\(([\d.]+) - gSoft, ([\d.]+) \+ gSoft, g2\)/
  );
  if (!m) throw new Error('water.js から glitter の閾値を読めない');
  return m.slice(1).map(Number);
})();

check('旧実装の残骸', !/pow\(specT, 620\.0\)|pow\(mnd, 620\.0\)/.test(src),
  '固定指数の pow(N·H, 620) が残っている');

/* --- シェーダのノイズ（COMMON_GLSL の hash21 / vnoise）を JS へ --- */
const fr = (x) => x - Math.floor(x);
const f32 = Math.fround;
function hash21(px, py) {
  let x = fr(f32(px * 123.34)), y = fr(f32(py * 456.21));
  const d = f32(f32(x * f32(x + 45.32)) + f32(y * f32(y + 45.32)));
  x = f32(x + d); y = f32(y + d);
  return fr(f32(x * y));
}
function vnoise(px, py) {
  const ix = Math.floor(px), iy = Math.floor(py);
  let fx = px - ix, fy = py - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash21(ix, iy), b = hash21(ix + 1, iy);
  const c = hash21(ix, iy + 1), d = hash21(ix + 1, iy + 1);
  const ab = a + (b - a) * fx, cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
function glitterAt(gSoft) {
  const x = Math.random() * 400 - 200, y = Math.random() * 400 - 200;
  return smoothstep(G_THR[0] - gSoft, G_THR[1] + gSoft, vnoise(x, y))
       * smoothstep(G_THR[2] - gSoft, G_THR[3] + gSoft, vnoise(x * 2.63 + 13.7, y * 2.63 + 13.7));
}
const sparkleAt = (gSoft) => (1 - SPARK_AMT) + SPARK_AMT * glitterAt(gSoft) * SPARK_GAIN;

/* --- シェーダの diskSpec を JS へ移した実装 --- */
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (v) => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };

function diskSpec(N, V, L, rough) {
  const NoL = dot3(N, L);
  if (NoL <= 0) return 0;
  const H = norm3([V[0] + L[0], V[1] + L[1], V[2] + L[2]]);
  const NoH = Math.min(1, Math.max(0, dot3(N, H)));
  const NoV = Math.max(dot3(N, V), 1e-4);
  const a2 = rough * rough + LIGHT_R * LIGHT_R;
  const d = NoH * NoH * (a2 - 1) + 1;
  const D = a2 / (Math.PI * d * d);
  const lv = NoL * Math.sqrt(NoV * NoV * (1 - a2) + a2);
  const ll = NoV * Math.sqrt(NoL * NoL * (1 - a2) + a2);
  const Vis = 0.5 / Math.max(lv + ll, 1e-5);
  return D * Vis * NoL * (Math.PI * LIGHT_R * LIGHT_R);
}
// 置き換え前の実装（比較用）。太陽の «芯» の項
const oldSpec = (N, V, L) => {
  const H = norm3([V[0] + L[0], V[1] + L[1], V[2] + L[2]]);
  return Math.pow(Math.max(dot3(N, H), 0), 620) * 5.5;
};

/* 1. 見下ろし配置：光源が天頂、視線もほぼ真下。
      水面の法線を «傾き rms σ で散らばる面» とみなして統計を取る。 */
const SIGMA = 0.09;                                  // 凪いだ湖のさざ波（rad）
const L_UP = [0, 1, 0];
const V_DOWN = norm3([0.08, 1, 0.05]);               // ほぼ真下を見下ろす視線
/* «膜か閃きか» はスケールに依らない指標で見る。
   その実装自身のピークの 10% 以上に達する画素の割合。
   膜（一様に明るい板）なら大きく、閃き（まばらな点）なら小さい */
function litStats(specFn, sparkFn, samples = 120000) {
  const vals = new Float64Array(samples);
  let peak = 0;
  for (let i = 0; i < samples; i++) {
    // 傾きを 2 次元ガウスで振る（Box-Muller）
    const u = Math.max(Math.random(), 1e-9), v = Math.random();
    const r = SIGMA * Math.sqrt(-2 * Math.log(u));
    const sx = r * Math.cos(2 * Math.PI * v), sz = r * Math.sin(2 * Math.PI * v);
    const N = norm3([-sx, 1, -sz]);
    const s = Math.min(specFn(N, V_DOWN, L_UP) * sparkFn(), CLAMP);
    vals[i] = s;
    peak = Math.max(peak, s);
  }
  let lit = 0;
  for (let i = 0; i < samples; i++) if (vals[i] > peak * 0.1) lit++;
  return { frac: lit / samples, peak };
}
const neo = litStats((N, V, L) => diskSpec(N, V, L, CAP_ROUGH) * SUN_RAD, () => sparkleAt(G_SOFT0));
const old = litStats(oldSpec, () => 1);
check('見下ろしの膜', neo.frac < old.frac / 8,
  `ピークの 10% 以上に達する画素 旧 ${(old.frac * 100).toFixed(1)}% / 新 ${(neo.frac * 100).toFixed(2)}%`
    + '（新実装は «まばらな閃き» なので桁で小さくなるはず）');
check('見下ろしのピーク', neo.peak > old.peak * 3,
  `ピーク 旧 ${old.peak.toFixed(1)} / 新 ${neo.peak.toFixed(1)}`
    + '（狭いぶん明るくなるのが円盤反射）');

/* 2. 粗くすると暗くなる（固定指数には無い性質） */
const peakAt = (rough) => diskSpec([0, 1, 0], [0, 1, 0], [0, 1, 0], rough) * SUN_RAD;
const pCalm = peakAt(CAP_ROUGH);
const pRough = peakAt(0.15);
check('粗さで暗くなる', pRough < pCalm / 5,
  `ピーク 凪 ${pCalm.toFixed(1)} → 荒れ ${pRough.toFixed(1)}`);

/* 3. エネルギー保存。ピーク ∝ Ω/α'^2、ローブの立体角 ∝ π·α'^2 なので、
      その積は粗さによらず一定になる（＝広がったぶんだけ暗い） */
const energy = (rough) => {
  const a2 = rough * rough + LIGHT_R * LIGHT_R;
  return peakAt(rough) * Math.PI * a2;
};
const eCalm = energy(CAP_ROUGH), eRough = energy(0.15), eMid = energy(0.05);
const spread = Math.max(eCalm, eMid, eRough) / Math.min(eCalm, eMid, eRough);
check('エネルギー保存', spread < 1.05,
  `ピーク×立体角 の振れ幅 ${spread.toFixed(3)}（凪 ${eCalm.toExponential(3)} /`
    + ` 中 ${eMid.toExponential(3)} / 荒れ ${eRough.toExponential(3)}）`);

/* 4. きらめきノイズの期待値。sparkle の平均が 1 でないと、
      «ゆらぎを足す» つもりが明るさそのものを変えてしまう。
      gSoft も sparkAmt も距離で動くので、距離を振って最悪値を見る */
function slope(re, what) {
  const m = src.match(re);
  if (!m) throw new Error(`water.js から ${what} を読めない`);
  return m.slice(1).map(Number);
}
const [GS_A, GS_B, GS_C, GS_D] =
  slope(/float gSoft = ([\d.]+) \+ ([\d.]+) \* smoothstep\(([\d.]+), ([\d.]+), vFogDepth\)/, 'gSoft');
const [SA_A, SA_C, SA_D] =
  slope(/float sparkAmt = ([\d.]+) \* \(1\.0 - smoothstep\(([\d.]+), ([\d.]+), vFogDepth\)\)/, 'sparkAmt');
const gSoftAt = (d) => GS_A + GS_B * smoothstep(GS_C, GS_D, d);
const sparkAmtAt = (d) => SA_A * (1 - smoothstep(SA_C, SA_D, d));

function glitterMean(gSoft, n = 250000) {
  let s = 0;
  for (let i = 0; i < n; i++) s += glitterAt(gSoft);
  return s / n;
}
let worst = { d: 0, mean: 1 };
for (const d of [3, 10, 25, 50, 80, 120, 170, 240]) {
  const amt = sparkAmtAt(d);
  const mean = (1 - amt) + amt * glitterMean(gSoftAt(d), 120000) * SPARK_GAIN;
  if (Math.abs(mean - 1) > Math.abs(worst.mean - 1)) worst = { d, mean };
}
check('きらめきの校正', Math.abs(worst.mean - 1) < 0.05,
  `sparkle の期待値が 1 から最も外れるのは ${worst.d}m で ${worst.mean.toFixed(3)}`);

/* 5. 月は太陽より暗いこと、粗さの内訳が正の値であること */
check('月と太陽の比', MOON_RAD < SUN_RAD, `MOON_RAD ${MOON_RAD} >= SUN_RAD ${SUN_RAD}`);
check('粗さの下限', CAP_ROUGH > 0 && LOD_ROUGH > 0,
  `capRough ${CAP_ROUGH} / lodRough ${LOD_ROUGH}`);

if (fails.length) {
  console.error('water-spec-test: NG');
  for (const f of fails) console.error('  ' + f);
  process.exit(1);
}
console.log('water-spec-test: ok');
console.log(`  光源の視半径 ${(LIGHT_R * 180 / Math.PI).toFixed(2)}° / 輝度 太陽 ${SUN_RAD} 月 ${MOON_RAD}`);
console.log(`  見下ろしで明るい画素 旧 ${(old.frac * 100).toFixed(1)}% → 新 ${(neo.frac * 100).toFixed(2)}%`
  + ` / ピーク 旧 ${old.peak.toFixed(1)} → 新 ${neo.peak.toFixed(1)}`);
console.log(`  ピーク 凪 ${pCalm.toFixed(1)} → 荒れ(α=0.15) ${pRough.toFixed(2)}`
  + ` / エネルギーの振れ幅 ${spread.toFixed(3)}`);
console.log(`  sparkle の期待値 最悪 ${worst.mean.toFixed(3)}（${worst.d}m）`);
