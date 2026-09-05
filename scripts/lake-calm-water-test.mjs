#!/usr/bin/env node
/* 湖波・渚（swash / 濡れ砂 / 泡）・水中（スネルの窓 / 体積散乱 / コースティクス）の回帰テスト */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import {
  WAVES, PHASE_W, W, MAX_WAVE_AMP, WAVE_STEEPNESS, CHOPPINESS, SWASH_GAIN, SHOAL_BUMP,
  waveHeight, waveSlope, waveDisplace, shoreRunUp, shoalGain, wavePhaseOffset, waveGLSL,
} from '../src/waveField.js';
import { makeTileableFoldCaustics } from '../src/tileableNoise.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const waterSrc = readFileSync(join(root, 'src/water.js'), 'utf8');
const postfxSrc = readFileSync(join(root, 'src/postfx.js'), 'utf8');
const terrainSrc = readFileSync(join(root, 'src/terrain.js'), 'utf8');
const shadersSrc = readFileSync(join(root, 'src/shaders.js'), 'utf8');
const gameSrc = readFileSync(join(root, 'src/game.js'), 'utf8');
const caustTexSrc = readFileSync(join(root, 'src/causticTexture.js'), 'utf8');

/* ---------------- 波そのもの ---------------- */
assert.ok(WAVES.length >= 4, 'expected multi-octave lake waves');
for (const w of WAVES) {
  assert.ok(w.speed <= 1.75, `wave speed should stay lake-calm, got ${w.speed}`);
  assert.ok(w.amp <= 0.12, `wave amp should stay moderate, got ${w.amp}`);
}
assert.ok(MAX_WAVE_AMP < 0.27, `total wave amp should be calmer, got ${MAX_WAVE_AMP}`);
assert.equal(PHASE_W.length, WAVES.length, 'phase weights must cover every wave');

const t = 12.7;
const h0 = waveHeight(4.2, -8.1, t);
const h1 = waveHeight(4.2, -8.1, t + 0.5);
assert.ok(Number.isFinite(h0) && Number.isFinite(h1), 'waveHeight must stay finite');
assert.ok(Math.abs(h1 - h0) < 0.08, 'half-second height delta should stay gentle');

assert.ok(Math.abs(wavePhaseOffset(0, 0) - wavePhaseOffset(40, -22)) > 0.05,
  'phase offset must vary spatially');

/* 解析微分が数値微分と一致すること（法線が波とずれないことの担保） */
{
  const e = 1e-4;
  const s = waveSlope(3.1, -7.4, t);
  const nx = (waveHeight(3.1 + e, -7.4, t) - waveHeight(3.1 - e, -7.4, t)) / (2 * e);
  const nz = (waveHeight(3.1, -7.4 + e, t) - waveHeight(3.1, -7.4 - e, t)) / (2 * e);
  assert.ok(Math.abs(s.dx - nx) < 1e-5, `waveSlope.dx must match finite difference: ${s.dx} vs ${nx}`);
  assert.ok(Math.abs(s.dz - nz) < 1e-5, `waveSlope.dz must match finite difference: ${s.dz} vs ${nz}`);
}

/* ---------------- Gerstner（峰の尖り） ---------------- */
assert.ok(CHOPPINESS > 1, 'Gerstner choppiness must actually sharpen crests');
assert.ok(WAVE_STEEPNESS < 1,
  `sum of Q*A*k must stay under 1 or the Gerstner surface self-intersects, got ${WAVE_STEEPNESS}`);
{
  const d = waveDisplace(11.3, 4.9, t);
  assert.ok(Number.isFinite(d.dx) && Number.isFinite(d.dz), 'waveDisplace must stay finite');
  let maxDisp = 0;
  for (let i = 0; i < 400; i++) {
    const p = waveDisplace(i * 0.73, -i * 1.19, t + i * 0.031);
    maxDisp = Math.max(maxDisp, Math.hypot(p.dx, p.dz));
  }
  assert.ok(maxDisp > 0.05, 'horizontal displacement must be visible');
  assert.ok(maxDisp < 1.2, `horizontal displacement must stay lake-scale, got ${maxDisp}`);
}

/* ---------------- 浅水変形（shoaling） ---------------- */
const pureDamp = (d) => {
  const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  return ss(0, 1.6, d) * 0.85 + 0.15 * ss(0, 5, d);
};
assert.equal(shoalGain(0), 0, 'no waves exactly at the waterline');
assert.ok(shoalGain(0.95) > shoalGain(0.3) * 4, 'waves must swell before the shore');
assert.ok(Math.abs(shoalGain(5) - 1) < 1e-6, 'deep water must be unchanged (gain 1)');
assert.ok(shoalGain(2) < 1, 'shoaling must not brighten the whole lake');
{
  // 盛り上がりは残すが、湖にうねりは来ないので海の surf 並みには膨らませない
  const bump = shoalGain(0.95) / pureDamp(0.95);
  assert.ok(bump > 1.05, `the shoaling bump must still be visible, got ${bump}`);
  assert.ok(bump < 1.25, `a lake must not swell like pre-breaking surf, got ${bump}`);
  assert.ok(SHOAL_BUMP > 0 && SHOAL_BUMP < 0.2, `SHOAL_BUMP must stay lake-scale, got ${SHOAL_BUMP}`);
}

/* ---------------- 渚の遡上（swash） ---------------- */
{
  let mn = Infinity, mx = -Infinity, sum = 0, n = 0;
  for (let tt = 0; tt < 240; tt += 0.11) {
    for (const [x, z] of [[10, 20], [-40, 55], [120, 70], [-95, -33]]) {
      const r = shoreRunUp(x, z, tt, 1);
      mn = Math.min(mn, r); mx = Math.max(mx, r); sum += r; n++;
    }
  }
  assert.ok(mx > 0.012, `run-up must still move the waterline, got ${mx}`);
  assert.ok(mn < -0.012, `back-wash must still expose a little sand, got ${mn}`);
  /* ここは「湖」なので、遡上は砂浜のスケールにしない。
     典型的な岸の勾配 0.065 で汀線の往復が 1.5m を超えると海に見える
     （0.85 のときは 4.9m 動いていて「波打ち際が荒すぎて海みたい」だった） */
  const shoreSlope = 0.065;
  const sweep = (mx - mn) / shoreSlope;
  assert.ok(sweep > 0.25, `the waterline must not look frozen, got ${sweep}m`);
  assert.ok(sweep < 1.5, `a lake shoreline must only lap, not run up a beach, got ${sweep}m`);
  // 平均が 0 付近でないと汀線の平均位置がずれ、水深・キャスト距離の意味が変わる
  assert.ok(Math.abs(sum / n) < 0.03, `mean waterline must not drift, got ${sum / n}`);
}
assert.ok(SWASH_GAIN > 0, 'swash gain must be positive');
assert.ok(SWASH_GAIN < 0.3, `swash gain must stay lake-scale, got ${SWASH_GAIN}`);

/* ---------------- CPU / GPU の式が同一であること ---------------- */
{
  const glsl = waveGLSL();
  for (const fn of ['float waveH(', 'vec2 waveD(', 'vec2 waveDisp(', 'float shoreRunUp(', 'float shoalGain(']) {
    assert.ok(glsl.includes(fn), `generated GLSL must define ${fn}`);
  }
  // 波テーブルの数値がそのまま GLSL に焼かれていること
  for (const w of W) {
    assert.ok(glsl.includes(w.amp.toFixed(5)), `GLSL must carry amp ${w.amp}`);
    assert.ok(glsl.includes(w.k.toFixed(5)), `GLSL must carry k ${w.k}`);
    assert.ok(glsl.includes((CHOPPINESS * w.amp).toFixed(5)), `GLSL must carry Q*A for ${w.amp}`);
  }
  assert.ok(glsl.includes(SWASH_GAIN.toFixed(5)), 'GLSL must carry the swash gain');

  const slim = waveGLSL({ prefix: 'cs', slim: true });
  assert.ok(slim.includes('vec2 csWaveD('), 'slim GLSL must expose the prefixed slope');
  assert.ok(!slim.includes('csWaveH('), 'slim GLSL must not emit the unused height sum');
  assert.ok(waveGLSL({ prefix: 'sw' }).includes('float swShoreRunUp('),
    'prefixed GLSL must expose the shore run-up for the terrain shader');
}

/* ---------------- 水面シェーダ ---------------- */
// 汀線：頂点補間ではなくフラグメントで高さテクスチャから引く（等高線ファセット対策）
assert.match(waterSrc, /float ground = groundAtF\(vWorld\.xz\);/,
  'shore depth must be sampled per fragment from the height texture');
assert.match(waterSrc, /float wet = still \+ runUp;/,
  'the waterline must include the swash run-up');
assert.match(waterSrc, /if \(wet <= 0\.004\) discard;/,
  'the water edge must be driven by the moving waterline, not the static bathymetry');
assert.doesNotMatch(waterSrc, /if \(vDepth <= 0\.02\) discard;/,
  'the frozen static waterline must be gone');
assert.match(waterSrc, /float runUp = shoreRunUp\(vWorld\.xz, uTime\) \* uWind;/,
  'run-up must use the shared wave field');
// 渚では水面が薄いシートになって砂に沿う
assert.match(waterSrc, /float sheet = min\(ground \+ uShoreLift/,
  'the swash sheet must climb the beach instead of being clipped at y=0');
assert.match(waterSrc, /polygonOffset: true/, 'the near-coplanar shore needs a depth offset');

// Gerstner
assert.match(waterSrc, /wp\.xz \+= waveDisp\(wp\.xz, uTime\) \* uWind \* shoalGain\(depth\);/,
  'the vertex shader must apply Gerstner horizontal displacement');
assert.match(waterSrc, /float gain = shoalGain\(depth\) \* uWind;/,
  'wave amplitude must use the shared shoaling gain');

// 逆光の峰の透け
assert.match(waterSrc, /float backLit = pow\(max\(dot\(V, -uSunDir\), 0\.0\), 3\.0\);/,
  'back-lit crest transmittance must exist');
assert.match(waterSrc, /vec3 sss = uShallow \* uSunColor/, 'crest SSS must tint with the shallow colour');
assert.match(waterSrc, /\+ encodeOut\(sss, uExposure, uLinearOut\)/, 'SSS must be added below the Fresnel mix');

// スネルの窓 / 全反射
// cos(asin(1/1.333)) = 0.6612。0.7442 だと窓が 41.9° 相当まで縮み、太陽高度が
// 28° を切ると太陽の像が窓の外へ落ちて消えてしまう
assert.match(waterSrc, /const float CRIT = 0\.6612;/,
  'the Snell window must sit on the real critical angle (48.6 deg), not a 41.9 deg one');
assert.match(waterSrc, /smoothstep\(CRIT - 0\.065, CRIT \+ 0\.065, ndv\)/,
  'the rim softening must stay symmetric about CRIT or the window size drifts');
assert.match(waterSrc, /vec3 aboveLin = skyAt\(dirSky\);/,
  'the window content must start from the sky in the refracted direction');
// 窓の中で太陽の位置が分かること：円盤が無いと方位を振っても絵が変わらない
assert.match(waterSrc, /aboveLin \+= uSunColor \* pow\(sdw, 220\.0\)/,
  'the window must carry a sun disc so the sun reads as a direction, not a wash');
assert.doesNotMatch(waterSrc, /lin \+= uSunColor \* rim \* 0\.30/,
  'the rim must not be a uniform sun-coloured halo: it made the window azimuth-independent');
assert.match(waterSrc, /lin \+= aboveLin \* rim \* 0\.42/,
  'the rim must lift the sky in that direction so only the sun side brightens');
// 窓には水上の景色（桟橋・釣り人）も映る
assert.match(waterSrc, /vec4 wp4 = uProjView \* vec4\(vWorld \+ Rf \* 32\.0, 1\.0\);/,
  'the window must reproject the refracted ray into the capture to show above-water objects');
assert.match(waterSrc, /if \(wpos\.y > 0\.05\) aboveLin = texture2D\(uSceneColor, wuv\)\.rgb;/,
  'only geometry above the waterline may fill the window; underwater hits must fall back to sky');
assert.match(waterSrc, /float sinT = min\(sinI \* 1\.333, 0\.9995\);/,
  'the window must refract through Snell so the rim compresses');
assert.match(waterSrc, /vec3 tirLin = mix\(uDeep, uShallow, 0\.34\)/,
  'outside the window the surface must act as a total-internal-reflection mirror');
assert.doesNotMatch(waterSrc, /under \? 0\.35 : fres/,
  'the flat 0.35 underwater blend must be gone');

// リップルはテクスチャのみ（フラグメント fbm 撤退）
{
  const m = waterSrc.match(/vec2 rippleSlope\(vec2 xz, float t\) \{[\s\S]*?\n        \}/);
  assert.ok(m, 'rippleSlope must exist');
  assert.ok(!/fbm2\(/.test(m[0]), 'rippleSlope must not evaluate fbm in the fragment shader any more');
  assert.equal((m[0].match(/rippleTexSlope\(/g) || []).length, 5,
    'rippleSlope should use five rotated texture taps');
}
assert.match(waterSrc, /const size = 256;/, 'the ripple normal texture must be 256 for the low-frequency layer');

// 映り込み：縦 3 タップ + 粗さ LOD
assert.equal((waterSrc.match(/texture2D\(uReflColor,/g) || []).length, 3,
  'planar reflection must be smeared vertically with three taps');
assert.match(waterSrc, /float rough = clamp\(length\(slope\) \* 1\.55/,
  'reflection blur must grow with wave slope and distance');
assert.match(waterSrc, /reflSize = opts\.quality === 'high' \? 1024 : 512/,
  'reflection render target must be larger than the old 512/320');

// 泡：細かいスケール + 破れた先端 + 引き波レース + 時間減衰
assert.match(waterSrc, /float tip = smoothstep\(uFoamTip\.x, uFoamTip\.y, wet\);/,
  'the swash tip must produce a tight bright line');
assert.match(waterSrc, /uFoamTip: \{ value: new THREE\.Vector4\(0\.016, 0\.002, 0\.036, 0\.004\) \}/,
  'a lake shore only gets a thin lapping line and a narrow wash band');
assert.match(waterSrc, /uFoamLace: \{ value: new THREE\.Vector4\(0\.40, 0\.68, 0\.62, 0\.76\) \}/,
  'lake foam must stay sparse and faint. the thresholds are shallower than the '
  + 'procedural era because the foam photo already carries its own contrast');
assert.match(waterSrc, /float leading = tip /,
  'the leading foam must be a separate broken layer');
assert.match(waterSrc, /float retreat = band /,
  'the retreat foam must be a separate wash layer');
assert.match(waterSrc, /float age = smoothstep\(0\.04, 0\.22, wet\);/,
  'foam must fade with age behind the tip');
// 泡は写真タイル（1 タイル 30cm）を 3 スケールで叩く
assert.equal((waterSrc.match(/texture2D\(uFoamTex,/g) || []).length, 3,
  'foam must be three taps of the foam photo, not procedural noise');
assert.match(waterSrc, /rot\(fa, 1\.94\) \* 2\.7/, 'the mid foam tap must be rotated and scaled up');
assert.match(waterSrc, /rot\(fa, 3\.71\) \* 6\.1/, 'the fine foam tap must be rotated and scaled up');
assert.doesNotMatch(waterSrc, /vnoise\(sp \* 17\.0/, 'the procedural lace octave must be gone');
assert.doesNotMatch(waterSrc, /vnoise\(sp \* 38\.0/, 'the procedural bubble octave must be gone');
/* 二値に近いマスクは mip が効くほど平均へ寄る。汀線は斜めから見るので
   1 画素の足跡が長く、固定の閾値だと «寄った先» が閾値の下に落ちて
   泡がまるごと消える。距離ではなく fwidth で測ること */
assert.match(waterSrc, /float fw = clamp\(max\(fwidth\(fa\.x\), fwidth\(fa\.y\)\)/,
  'the foam threshold must follow the pixel footprint, not distance');
assert.match(waterSrc, /float lo = mix\(uFoamLace\.x, 0\.44, fw\);/,
  'a blurred foam sample must pull the threshold toward the tile mean (0.47)');
assert.match(waterSrc, /tex\.colorSpace = THREE\.NoColorSpace;/,
  'the foam mask is coverage, not colour: converting it to linear would drop the '
  + 'mean from 0.47 to 0.19 and put every threshold off');
assert.doesNotMatch(waterSrc, /shoreP \* 3\.6/, 'the old metre-scale smoky foam must be gone');
assert.doesNotMatch(waterSrc, /float shoreBand = smoothstep\(0\.68, 0\.0, shoreDepth\)/,
  'the old depth-band foam must be gone');
assert.doesNotMatch(waterSrc, /float breakThresh = mix\(0\.26, 0\.74/,
  'the contour-banding foam threshold must be gone');

// 屈折：浅場の湖底がちゃんと揺れる
assert.match(waterSrc, /mix\(0\.020, 0\.052, 1\.0 - uRain \* 0\.35\)/,
  'refraction offset must be big enough to wobble the shallow bed');
assert.match(waterSrc, /bool refrBad = sceneZ < vFogDepth - 0\.02 \|\| abs\(sceneZ - sceneZ0\) > 2\.5;/,
  'refraction must not sample things in front of the surface: dock posts and the rod would smear onto the water');
assert.match(waterSrc, /float path = max\(0\.0, sceneZ0 - vFlatDepth\) \* rayScale;/,
  'water thickness must come from the un-offset sample and the still-water plane, '
  + 'or the veil pulses with the waves and dark objects seen through it shimmer');
assert.match(waterSrc, /vFlatDepth = -\(viewMatrix \* vec4\(wp\.x, 0\.0, wp\.z, 1\.0\)\)\.z;/,
  'the still-water reference depth must be carried to the fragment shader');
assert.match(waterSrc, /uMixAmt: \{ value: new THREE\.Vector3\(1\.0, 1\.0, 1\.0\) \}/,
  'the through-water terms must stay individually tunable for diagnosis');
assert.match(waterSrc, /float sssPath = 1\.0 - exp\(-uAbsorb\.g \* path \* 1\.6\);/,
  'back-lit transmittance is in-scattered light, so it must scale with the optical path — '
  + 'otherwise it lifts dark objects seen through thin water into a yellow shimmer');

// タイルテクスチャの約束は据え置き
assert.match(waterSrc, /makeTileableHeightField/, 'ripple normal must keep tileable noise');
assert.match(waterSrc, /RepeatWrapping/, 'ripple normal must keep RepeatWrapping');
assert.doesNotMatch(waterSrc, /fract\s*\([^)]*uRippleNormal/, 'ripple normal must not use manual fract()');

// プランクトン
assert.match(waterSrc, /gl_PointSize = min\(gl_PointSize, 5\.0\);/,
  'plankton must not become giant blobs up close');
assert.match(waterSrc, /const fade = smoothstep\(0\.35, 1\.4, d\)/,
  'plankton must fade in near the camera instead of looking like stars');

/* ---------------- 地形：濡れ砂 ---------------- */
assert.match(terrainSrc, /vec3 shoreWetness\(vec3 wp\)/, 'the terrain must compute shore wetness');
assert.match(terrainSrc, /uniform sampler2D uShoreHeightTex;/,
  'the wet band must key off the same height texture as the water, so the waterline agrees');
assert.match(terrainSrc, /swShoreRunUp\(wp\.xz, uShoreTime\) \* uShoreWind/,
  'the wet band must follow the same run-up as the water');
assert.match(terrainSrc, /float capillary = 1\.0 - smoothstep\(0\.0, top, max\(ground, 0\.0\)\);/,
  'a permanently damp capillary band must exist above the run-up');
assert.match(terrainSrc, /float top = uShoreTop \* \(0\.62 \+ 0\.76 \* shoreNoise/,
  'the damp band must have a ragged top edge, not a dead-straight contour');
assert.match(terrainSrc, /base \*= mix\(1\.0, 0\.66, sw\.x\);/, 'wet sand must darken');
assert.match(shadersSrc, /net = min\(net, vec3\(uCaustRange\.x\)\);/,
  'caustic highlights must be clamped so shallow rocks do not blow out to cyan');
assert.match(shadersSrc, /uniform vec3 uCaustMixW;/,
  'caustic layer combination must be tunable');
assert.match(shadersSrc, /uniform vec2 uCaustScale;/,
  'caustic shape must be tunable at runtime');
assert.match(terrainSrc, /roughnessFactor = mix\(roughnessFactor, 0\.28, gShoreWet\.x \* 0\.85\);/,
  'wet sand must go glossy so the sun sheens off it');
assert.match(terrainSrc, /float wrack = smoothstep\(0\.60, 0\.86, shoreNoise\(wp\.xz \* 2\.7\)\)/,
  'the high-water mark needs a wrack line so the beach is not blank');
assert.match(terrainSrc, /float peb = smoothstep\(0\.90, 0\.99, shoreNoise/,
  'the beach needs pebble speckle');
assert.match(terrainSrc, /float lod = 1\.0 - smoothstep\(5\.0, 20\.0, length\(wp - cameraPosition\)\);/,
  'procedural beach detail has no mipmaps, so it must be band-limited by distance');
assert.match(terrainSrc, /base = mix\(base, vec3\(0\.88, 0\.91, 0\.92\), sw\.y \* 0\.32\);/,
  'left-behind foam must stay a sparse lace, not white blotches over the whole beach');
assert.match(terrainSrc, /float atReach = mix\(0\.30, 1\.0, smoothstep\(0\.12, 0\.0, abs\(ground - past\)\)\);/,
  'foam residue must concentrate at the high-water mark');
assert.match(waterSrc, /float foamLod = 1\.0 - smoothstep\(9\.0, 32\.0, vFogDepth\);/,
  'the fine foam octaves must be band-limited by distance too');
assert.match(terrainSrc, /vec3 gShoreWet = vec3\(0\.0\);/,
  'shore wetness must be evaluated once and shared by colour/roughness/normal');
assert.match(gameSrc, /this\.terrain\.updateShore\(this\.water\.time, this\.water\.wind\);/,
  'the terrain shore must be driven by the water clock every frame');

/* ---------------- コースティクス ---------------- */
assert.match(shadersSrc, /uniform sampler2D uCaustTex;/,
  'caustics must come from a baked texture, not fragment fbm');
assert.match(shadersSrc, /vec2 slope = csWaveD\(surf, uCaustTime\);/,
  'caustics must be warped by the real wave slope');
/* 深場でのふるまい。横ずれは深さに比例するので上限を切らないと、深い湖底で
   網目が数セルぶん滑って「底面全体が揺れている」ように見える */
assert.match(shadersSrc, /vec2 q = surf \+ slope \* \(min\(depth, uCaustWarp\.y\) \* uCaustWarp\.x \+ 0\.6\);/,
  'the caustic warp must cap the depth it scales with, or the deep bed sloshes');
assert.match(shadersSrc, /float lod = log2\(1\.0 \+ depth \* uCaustMag\);/,
  'depth must soften the net through a mip bias, not by scaling the coordinate');
/* 座標に深度依存の倍率を掛けると、q がワールド座標（岸は原点から 100m 超）
   なので斜面方向にだけ何倍にも引き伸ばされた「細長い」網目になる */
assert.doesNotMatch(shadersSrc, /\(q \* uCaustScale\.[xy][^)]*\) \* mag/,
  'the caustic UV must stay world-anchored: scaling it by a depth-varying factor shears the net');
assert.doesNotMatch(shadersSrc, /float mag = 1\.0 \/ \(1\.0 \+ depth \* uCaustMag\);/,
  'the coordinate magnification must be gone');
assert.match(shadersSrc, /\* \(1\.0 - smoothstep\(uCaustFar\.x, uCaustFar\.y, depth\)\);/,
  'caustics must fade out with depth through a tunable range');
assert.doesNotMatch(shadersSrc, /1\.0 - smoothstep\(6\.0, 26\.0, depth\)/,
  'a lake must not keep caustics down to 26m');
assert.match(gameSrc, /uCaustWarp: \{ value: new THREE\.Vector2\(1\.15, 2\.5\) \}/,
  'the warp depth cap must stay a few metres');
/* 湖の透明度を倍にした（uAbsorb を半分）ので、網目の生き延びる深さも倍。
   ただし湖底（26m）まで届かせてはいけない、という上の条件は変えない */
assert.match(gameSrc, /uCaustFar: \{ value: new THREE\.Vector2\(6\.0, 20\.0\) \}/,
  'caustics must be gone by ~20m, well above the 26m bed');
assert.match(shadersSrc, /float sw = sa \/ 1\.333;/,
  'the caustic projection point must be refracted through Snell');
assert.doesNotMatch(shadersSrc, /caustFbm2\(/, 'the old blobby fbm caustics must be gone');
assert.doesNotMatch(shadersSrc, /a \* b \* uCaustShape\.x/,
  'the two caustic layers must be summed, not multiplied (a product only lights crossings)');
assert.match(shadersSrc, /vec3 net = a \* uCaustMixW\.x \+ b \* uCaustMixW\.y \+ a \* b \* uCaustMixW\.z;/,
  'caustic layers must combine through the tunable weights');
assert.doesNotMatch(caustTexSrc, /makeTileableCausticField/,
  'the Voronoi cell-edge caustic texture must be gone: its cells read as a hex lattice');
assert.match(caustTexSrc, /makeTileableFoldCaustics/,
  'caustics must be baked from the folds of the refraction map');
assert.match(caustTexSrc, /export const CAUSTIC_TEX_SIZE = 512;/,
  'a 256 texture makes the caustic filaments sub-texel and they alias into sand glitter');

/* 折り目コースティクスの実値チェック */
{
  const size = 128;
  const a = makeTileableFoldCaustics(size, 0xabc, { frequency: 8, stencil: 2 });
  const b = makeTileableFoldCaustics(size, 0xabc, { frequency: 8, stencil: 2 });
  assert.deepEqual(Array.from(a.data.slice(0, 64)), Array.from(b.data.slice(0, 64)),
    'the caustic bake must be deterministic');
  assert.equal(a.data.length, size * size * 4, 'bake must fill an RGBA buffer');
  assert.ok(a.mean > 0.05 && a.mean < 0.40,
    `caustics must stay sparse bright lines, not a bright wash (mean ${a.mean})`);
  assert.ok(a.max > 0.6, `caustic filaments must actually peak bright (max ${a.max})`);
  // RGB がずれている＝色収差が入っている
  let chromatic = 0;
  for (let i = 0; i < size * size; i++) {
    if (Math.abs(a.data[i * 4] - a.data[i * 4 + 2]) > 8) chromatic++;
  }
  assert.ok(chromatic > size * size * 0.02,
    `caustics must carry chromatic dispersion (${chromatic} px differ)`);
  // タイル可能であること（左右・上下の端が連続）
  const at = (x, y, c) => a.data[(y * size + x) * 4 + c];
  let seam = 0, inner = 0;
  for (let y = 0; y < size; y++) {
    seam += Math.abs(at(0, y, 1) - at(size - 1, y, 1));
    inner += Math.abs(at(40, y, 1) - at(39, y, 1));
  }
  assert.ok(seam < inner * 2.5, `x seam must not jump (${seam} vs ${inner})`);
}
assert.match(shadersSrc, /float viewDist = length\(worldPos - cameraPosition\);/,
  'caustics must fade with view distance or the squared product aliases into glitter');
assert.match(shadersSrc, /fade \*= smoothstep\(0\.15, 0\.72, dot\(normalize\(viewNormal\), upView\)\);/,
  'caustics must favour upward-facing surfaces so shallow rocks do not turn into ice');
assert.doesNotMatch(shadersSrc, /pow\(clamp\(c1 \* c2 \* 2\.1, 0\.0, 1\.0\), 2\.4\)/,
  'the old caustic blob formula must be gone');
assert.match(gameSrc, /uCaustTex: \{ value: createCausticTexture\(\) \}/,
  'the caustic texture must be created once and shared');

/* ---------------- 水中ポストFX ---------------- */
/* --- 透明度と、それに連動する «深さ方向» の定数 ---

   水の澄み具合は uAbsorb ただ 1 つで決まるが、それに比例すべき定数が
   3 つ別々の場所に直書きされている。

     ambient       水中の環境光が深さで落ちる速さ
     shaft         光の柱が深さで消える速さ
     surfaceLight  水面直下の明るみが消える速さ

   uAbsorb だけ半分にしてこれらを置き忘れると、«横は 40m 見通せるのに
   26m の湖底は真っ暗» という食い違いが出る。逆にこちらだけ触ると
   «底まで明るいのに 5m 先が見えない» になる。比を縛っておく。 */
{
  const grab = (src, what) => {
    const m = /uAbsorb: \{ value: new THREE\.Vector3\(([\d.]+), ([\d.]+), ([\d.]+)\) \}/.exec(src)
      || /'uAbsorb', new THREE\.Uniform\(new THREE\.Vector3\(([\d.]+), ([\d.]+), ([\d.]+)\)\)/.exec(src);
    assert.ok(m, `${what}: uAbsorb が読めない`);
    return [+m[1], +m[2], +m[3]];
  };
  const a = grab(waterSrc, 'water.js');
  const b = grab(postfxSrc, 'postfx.js');
  assert.deepStrictEqual(a, b, 'water.js と postfx.js の uAbsorb が食い違っている');

  // 人間の目が見る減衰。Rec.709 の輝度で重みづけ
  const sigma = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  // コントラストが 2% まで落ちる距離 ＝ 見通し
  const visibility = Math.log(1 / 0.02) / sigma;

  const num = (re, what) => {
    const m = re.exec(postfxSrc);
    assert.ok(m, `postfx.js: ${what} が読めない`);
    return +m[1];
  };
  const linked = [
    ['ambient', num(/float ambient = exp\(-camDepth \* ([\d.]+)\)/, 'ambient'), 2.21],
    ['shaft', num(/exp\(-max\(below, 0\.0\) \* ([\d.]+)\)/, 'shaft'), 1.12],
    ['surfaceLight', num(/float surfaceLight = exp\(-camDepth \* ([\d.]+)\)/, 'surface'), 0.453],
  ];
  for (const [name, k, want] of linked) {
    const ratio = sigma / k;
    assert.ok(Math.abs(ratio / want - 1) < 0.06,
      `${name} の減衰 ${k} が uAbsorb と釣り合っていない`
      + `（σ/k = ${ratio.toFixed(2)}、あるべき ${want}）。`
      + ' uAbsorb を変えたら同じ倍率でここも変えること');
  }

  /* 見通しより «湖の深さ» のほうが浅いこと。逆になると、水中カメラから
     対岸の岸まで見えてしまって湖が «水槽» に見える */
  assert.ok(visibility > 26 && visibility < 70,
    `見通し ${visibility.toFixed(0)}m が湖（水深 26m）に対して極端`);
  console.log(`  透明度 σ=${sigma.toFixed(3)}/m  見通し ${visibility.toFixed(0)}m`
    + `  (色が残るのは ${(Math.log(1 / 0.5) / a[0]).toFixed(1)}m まで)`);
}

assert.match(postfxSrc, /vec3 trans = exp\(-sigma \* dist\);/,
  'underwater extinction must be exponential and wavelength selective');
assert.match(postfxSrc, /vec3 inscatter = scatterCol \* ambient \* \(vec3\(1\.0\) - trans\);/,
  'the light removed by extinction must come back as in-scattering');
assert.match(postfxSrc, /float ambient = exp\(-camDepth \* 0\.043\)/,
  'ambient light must fall off exponentially with camera depth');
assert.match(postfxSrc, /\['uShaft', new THREE\.Uniform\(0\.30\)\]/,
  'shaft strength must stay restrained');
assert.match(postfxSrc, /vec3 worldAt\(vec2 uv, float depth\)/,
  'god rays must be built in world space, so a depth->world reconstruction is required');
assert.match(postfxSrc, /vec3 sunUnderwater\(vec3 sd\)/,
  'the shafts must follow the refracted sun direction, not the direction in air');
assert.match(postfxSrc, /float sw = sa \/ 1\.333;/, 'the shaft direction must go through Snell');
assert.match(postfxSrc, /float shaftMask\(vec3 p, vec3 U, vec3 V, float t\)/,
  'the shaft pattern must live on the plane perpendicular to the light ray');
assert.doesNotMatch(postfxSrc, /atan\(d\.y, d\.x\)/,
  'screen-space polar shafts look like a rising-sun flag and swim with the camera');
assert.doesNotMatch(postfxSrc, /uSunUv/, 'the screen-space shaft origin must be gone');
assert.match(postfxSrc, /exp\(-max\(below, 0\.0\) \* 0\.085\)/,
  'shafts must fade exponentially with depth below the surface');
assert.match(postfxSrc, /acc \*= smoothstep\(2\.4, 12\.0, march\)/,
  'shafts must not be painted right in front of the camera');
assert.match(gameSrc, /_fillUnderwaterOptics\(uwCtx\);/, 'turbidity must still be fed each frame');
assert.doesNotMatch(gameSrc, /_fillSunScreenPos/, 'the sun screen projection helper must be gone');
assert.doesNotMatch(postfxSrc, /float caust = fbm2\(uv \* 18\.0/,
  'screen-space caustics must be gone (they swim with the camera)');
assert.doesNotMatch(postfxSrc, /mix\(0\.16, 0\.35, uStrength\)/,
  'the token underwater absorption must be gone');
assert.doesNotMatch(postfxSrc, /haze \* 0\.14/, 'the token underwater haze must be gone');
assert.match(postfxSrc, /0\.0007 \* uStrength/, 'underwater UV wobble should stay subtle');
assert.match(postfxSrc, /lerp\(BLOOM_INTENSITY, 0\.08, strength\)/, 'underwater bloom should stay subdued');
assert.match(postfxSrc, /const BLOOM_INTENSITY = 0\.35;/, 'bloom must stay restrained');
assert.match(postfxSrc, /luminanceThreshold: 0\.85,/,
  'a low bloom threshold makes the bright sky and shallows bleed over the rod and the angler '
  + 'as a yellow haze — only real highlights may bloom');
assert.doesNotMatch(postfxSrc, /luminanceThreshold: 0\.62,/, 'the old low bloom threshold must be gone');


console.log('lake-calm-water-test: ok');
