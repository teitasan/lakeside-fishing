/**
 * 夜空の検査。
 *
 * ここは «見た目» の話なので数値で縛れる部分が限られるが、壊れると
 * 気づきにくい割に画面ぜんたいが台無しになる箇所が 3 つある。
 *
 *  (1) キーライトの連続性。平行光 1 本を «昼は太陽・夜は月» として
 *      使い回しているので、すれ違う瞬間に強度が飛ぶと日没に照明が
 *      パチンと切れる（実際そうなっていた）
 *  (2) 夜が «見える» 明るさであること。常に満月という世界設定
 *  (3) 星が «点» であること。図法の歪みで四角い塊になっていた
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sky = readFileSync(join(root, 'src/sky.js'), 'utf8');
const water = readFileSync(join(root, 'src/water.js'), 'utf8');

/* ---------------- (1)(2) キーライト ---------------- */

/* 定数はソースから読む。テスト側に写すと «直したのにテストは古い値で
   通っている» が起きる */
const MOON = Number(/const MOON_INTENSITY = ([\d.]+);/.exec(sky)?.[1]);
assert.ok(MOON > 0, 'MOON_INTENSITY が読めない');

const KEYS = [...sky.matchAll(/\{ h: ([\d.]+), zen: 0x\w+, hor: 0x\w+, sun: 0x\w+, amb: ([\d.]+), dir: ([\d.]+) \}/g)]
  .map((m) => ({ h: +m[1], amb: +m[2], dir: +m[3] }));
assert.ok(KEYS.length >= 10, `KEYS が読めない (${KEYS.length})`);

const cl = (x) => Math.max(0, Math.min(1, x));
const ss = (a, b, x) => { const t = cl((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

/** sky.js の update() が光量を決めている手順を、そのまま写したもの */
function lightAt(t, cloud = 0.14) {
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].h <= t) i++;
  const A = KEYS[i], B = KEYS[i + 1], f = cl((t - A.h) / (B.h - A.h));
  const amb = lerp(A.amb, B.amb, f), dir = lerp(A.dir, B.dir, f);
  const ang = ((t - 6) / 24) * Math.PI * 2;
  const y = Math.sin(ang) / Math.hypot(1, 0.34);
  const cloudDim = 1 - cloud * 0.45;
  const gate = (v) => ss(-0.02, 0.14, v);
  const sunI = dir * cloudDim * gate(y);
  const moonI = MOON * cloudDim * gate(-y);
  const key = Math.max(sunI, moonI);
  const fill = cl(1 - (sunI + moonI) / 1.6) * 1.15;
  const hemi = (lerp(0.22, 0.78, amb) + fill) * lerp(1, 1.35, cloud);
  return { y, key, hemi, total: key + hemi, moon: moonI > sunI };
}

// (1) 1 ゲーム分あたりの変化。ここが飛ぶと «照明がパチンと切れる»
{
  let worst = 0, worstAt = 0, prev = null;
  for (let t = 0; t < 24; t += 1 / 60) {
    const v = lightAt(t).total;
    if (prev !== null && Math.abs(v - prev) > worst) { worst = Math.abs(v - prev); worstAt = t; }
    prev = v;
  }
  assert.ok(worst < 0.12,
    `光量が 1 分で ${worst.toFixed(3)} 跳ぶ（${worstAt.toFixed(2)} 時）。`
    + ' 太陽と月の «地平線ゲート» か薄明の埋めが効いていない');
  console.log(`  光量の最大変化 ${worst.toFixed(4)}/分（${worstAt.toFixed(1)} 時）`);
}

// キーライトが太陽から月へ裏返る瞬間は、直射がほぼ無いこと（向きの反転が見えない）
{
  let flipTotal = null, prevMoon = lightAt(0).moon;
  for (let t = 0; t < 24; t += 1 / 120) {
    const v = lightAt(t);
    if (v.moon !== prevMoon) { flipTotal = v; break; }
    prevMoon = v.moon;
  }
  assert.ok(flipTotal, '一日のうちで太陽と月が入れ替わらない');
  const share = flipTotal.key / flipTotal.total;
  assert.ok(share < 0.15,
    `入れ替わりの瞬間に直射が全体の ${(share * 100).toFixed(0)}% もある。`
    + ' 向きが 180° 裏返るので影と陰影が飛んで見える');
  console.log(`  入れ替わりの直射比 ${(share * 100).toFixed(1)}%`);
}

// (2) 夜の明るさ。«常に満月» なので、真昼の 3 割は割らない
{
  const noon = lightAt(12).total;
  let darkest = Infinity, at = 0;
  for (let t = 0; t < 24; t += 1 / 60) {
    const v = lightAt(t).total;
    if (v < darkest) { darkest = v; at = t; }
  }
  const ratio = darkest / noon;
  assert.ok(ratio > 0.30,
    `一日でいちばん暗い ${at.toFixed(1)} 時が真昼の ${(ratio * 100).toFixed(0)}%。`
    + ' 夜が «何も見えない» に戻っている');
  assert.ok(lightAt(0).total / noon < 0.75, '真夜中が明るすぎて昼と区別がつかない');
  console.log(`  最暗 ${at.toFixed(1)} 時 = 真昼の ${(ratio * 100).toFixed(0)}%`
    + ` / 真夜中 ${(lightAt(0).total / noon * 100).toFixed(0)}%`);
}

// 影を落とす平行光は 1 本だけ（2 本にするとシャドウマップがもう 1 枚要る）
assert.strictEqual(
  (sky.match(/new THREE\.DirectionalLight/g) || []).length, 1,
  '平行光が 2 本ある。月は太陽と同時に空へ出ないので 1 本を使い回すこと',
);
assert.ok(!/this\.moon\s*=/.test(sky), '月が別ライトとして残っている');

/* ---------------- (3) 星 ---------------- */

// 正積図法。これが崩れると天頂と水平で星の密度が 4 倍変わる
assert.match(sky, /sqrt\(2\.0 \/ \(1\.0 \+ clamp\(dir\.y/,
  '星がランベルト正積方位図法で切られていない');
assert.doesNotMatch(sky, /dir\.xz \/ \(abs\(dir\.y\) \+ 0\.25\)/,
  '天頂で歪む旧図法が残っている');

/* 大きさは fwidth でピクセルに直して決める。星は点光源なので、
   見かけの大きさは向きではなくレンズで決まる */
assert.match(sky, /float sPx = max\(fwidth\(sGrid\.x\), fwidth\(sGrid\.y\)\);/,
  '星の大きさが画面ピクセル基準になっていない');
/* fwidth は一様な制御フローで取ること。夜だけの if の中で取ると
   地平線ぎわで値が保証されない */
{
  const decl = sky.indexOf('float sPx = max(fwidth');
  const branch = sky.indexOf('if (uNight > 0.02 && hy > -0.02)');
  assert.ok(decl > 0 && branch > 0 && decl < branch,
    'fwidth が夜の分岐の中にある（非一様な制御フローでは未定義）');
}

// セルを丸ごと光らせる旧実装（＝四角い星）が残っていないこと
assert.doesNotMatch(sky, /smoothstep\(0\.9962, 0\.9995, n\)/,
  'セル全体を光らせる旧実装が残っている');
for (const need of ['float mag = 0.10 + 0.90 * pow(', 'vec3 tint', 'float twAmp']) {
  assert.ok(sky.includes(need), `星に ${need} が無い（等級・色・瞬きのどれかが欠けている）`);
}

// 映り込みには点星を焼かない
assert.match(sky, /uStars: \{ value: 1 \}/, 'uStars uniform が無い');
assert.match(sky, /\* uNight \* uStars;/, '星が uStars で切れるようになっていない');
{
  const cap = sky.length && water.slice(water.indexOf('captureReflection('),
    water.indexOf('capture(renderer, scene, camera)'));
  assert.ok(/skyU\.uStars\.value = 0;/.test(cap), '映り込みを焼く前に点星を切っていない');
  assert.ok(/skyU\.uStars\.value = starsWas;/.test(cap), '焼いたあとに点星を戻していない');
  assert.ok(cap.indexOf('uStars.value = 0') < cap.indexOf('renderer.render(scene, cam)'),
    '点星を切るのが描画より後になっている');
  assert.ok(cap.indexOf('uStars.value = starsWas') > cap.indexOf('renderer.render(scene, cam)'),
    '点星を戻すのが描画より前になっている');
}

console.log('night-sky-test: ok');
