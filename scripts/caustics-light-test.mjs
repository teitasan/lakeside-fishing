/**
 * コースティクスが光量に追随しているかの検査。
 *
 * 網目は totalEmissiveRadiance に足す自己発光なので、シーンのライトが
 * 掛からない。明るさは shaders.js が自前で減衰させるしかなく、そこが
 * 太陽光の曲線から外れると «地面は朝夕で暗くなるのに湖底の網目だけ
 * 真昼のまま» という食い違いになる。
 *
 * ここでは sky.js のキーフレームから太陽光を、shaders.js の減衰式を
 * 写したもので網目を出して、日中の形が揃っているかを見る。
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/shaders.js', import.meta.url), 'utf8');

/* 減衰式が «ゲート» と «光量» の 2 段になっていること。
   ゲート 1 本だけだと高度 17.5° で飽和して、日中ずっと一定になる */
assert.match(src, /smoothstep\(-0\.05, 0\.22, sd\.y\)/, 'ゲート（低い太陽で消す）');
assert.match(src, /mix\(0\.55, 1\.0, smoothstep\(0\.10, 0\.75, sd\.y\)\)/, '高度そのものへの比例');
assert.doesNotMatch(src, /smoothstep\(-0\.05, 0\.30, sd\.y\)/, '飽和の早い旧ゲートが残っている');
// 夜・雨・雲も効いていること
for (const u of ['uCaustNight', 'uCaustRain', 'uCaustCloud']) {
  assert.ok(src.includes(u), `${u} が効いていない`);
}

/* --- 日中の形が太陽光と揃うか --- */
// sky.js の KEYS（h, dir）と cloudDim / sunDir をそのまま写したもの
const KEYS = [[0, .05], [4.2, .09], [5.4, .55], [6.4, 1.9], [8.5, 2.9], [12, 3.3],
  [15.5, 2.9], [17.6, 1.7], [18.8, .5], [20, .11], [24, .05]];
const cl = (x) => Math.max(0, Math.min(1, x));
const ss = (e0, e1, x) => { const t = cl((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;

function sky(t) {
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1][0] <= t) i++;
  const A = KEYS[i], B = KEYS[i + 1], f = cl((t - A[0]) / (B[0] - A[0]));
  const ang = ((t - 6) / 24) * TAU;
  const v = [Math.cos(ang), Math.sin(ang), 0.34];
  const sy = v[1] / Math.hypot(...v);
  return { sy, dir: A[1] + (B[1] - A[1]) * f, night: cl(1 - ss(-0.16, 0.08, sy)) };
}
const CLOUD = 0.14;   // 晴れ
const caustFade = (s) => (1 - s.night * 0.94) * (1 - CLOUD * 0.62)
  * ss(-0.05, 0.22, s.sy) * mix(0.55, 1.0, ss(0.10, 0.75, s.sy));

const rows = [];
for (let h = 5; h <= 19; h += 0.5) {
  const s = sky(h);
  rows.push({ h, elev: Math.asin(s.sy) * 180 / Math.PI, sun: s.dir * (1 - CLOUD * 0.45), c: caustFade(s) });
}
const maxSun = Math.max(...rows.map((r) => r.sun));
const maxC = Math.max(...rows.map((r) => r.c));
assert.ok(maxC > 0.4, `正午の網目が弱すぎる (${maxC.toFixed(2)})`);

/* 太陽が十分高いところでは、正規化した曲線が太陽光から離れないこと。
   ここが «光量に追随する» 領域 */
const day = rows.filter((r) => r.elev > 15);
let worst = 0, sum = 0;
for (const r of day) {
  const d = Math.abs(r.c / maxC - r.sun / maxSun);
  worst = Math.max(worst, d);
  sum += d;
}
const mean = sum / day.length;
assert.ok(mean < 0.06, `日中の追随が悪い（平均ずれ ${mean.toFixed(3)}）`);
assert.ok(worst < 0.12, `日中に大きく外れる時刻がある（最大ずれ ${worst.toFixed(3)}）`);

/* 逆に浅い太陽では «太陽光より» 落ちること。
   入射角が寝るほど水面で反射されて水中に届かないので、地上の明るさと
   同じ比率で残ってはいけない。ここは追随ではなくゲートが仕事をする */
const graze = rows.filter((r) => r.elev > 3 && r.elev < 10);
assert.ok(graze.length > 0, '高度 3〜10° の標本が無い');
for (const r of graze) {
  assert.ok(r.c / maxC < r.sun / maxSun - 0.10,
    `高度 ${r.elev.toFixed(0)}°: 網目 ${(r.c / maxC).toFixed(2)} が太陽光 ${(r.sun / maxSun).toFixed(2)} に近すぎる`);
}
const horizon = rows.filter((r) => Math.abs(r.elev) < 1);
for (const r of horizon) {
  assert.ok(r.c / maxC < 0.10, `地平線の太陽で網目が残っている (${(r.c / maxC).toFixed(2)})`);
}

// 朝と正午で «同じ明るさ» になっていないこと（これが元の症状）
const at = (h) => rows.find((r) => r.h === h);
const morning = at(7).c / maxC, noon = at(12).c / maxC;
assert.ok(noon - morning > 0.20,
  `朝 7 時と正午の網目がほぼ同じ（${morning.toFixed(2)} vs ${noon.toFixed(2)}）`);

console.log('caustics-light-test: ok');
console.log(`  高度15°超の太陽光とのずれ 平均 ${mean.toFixed(3)} 最大 ${worst.toFixed(3)}`);
console.log(`  ゲート 高度7° 網目 ${(rows.find((r) => Math.abs(r.elev - 7) < 1.5).c / maxC).toFixed(2)}`
  + ` / 太陽光 ${(rows.find((r) => Math.abs(r.elev - 7) < 1.5).sun / maxSun).toFixed(2)}`);
console.log(`  7時 ${morning.toFixed(2)} / 12時 ${noon.toFixed(2)}（正午を 1.00 とした比）`);
