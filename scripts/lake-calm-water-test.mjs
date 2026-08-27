#!/usr/bin/env node
/* 湖波の穏やか化・位相ゆらぎ・水中ポストFX軽量化の回帰テスト */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const waterSrc = readFileSync(join(root, 'src/water.js'), 'utf8');
const postfxSrc = readFileSync(join(root, 'src/postfx.js'), 'utf8');

const TAU = Math.PI * 2;

function extractExportArray(src, name) {
  const m = src.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\];`));
  assert.ok(m, `${name} export missing`);
  return Function(`"use strict"; return [${m[1]}];`)();
}

const WAVES = extractExportArray(waterSrc, 'WAVES');
const PHASE_W = [0.28, 0.42, 0.60, 0.78, 0.96];
const W = WAVES.map((w) => {
  const l = Math.hypot(w.dx, w.dz);
  const k = TAU / w.len;
  return { dx: w.dx / l, dz: w.dz / l, k, amp: w.amp, om: w.speed * k };
});
const MAX_WAVE_AMP = W.reduce((a, w) => a + w.amp, 0);

function wavePhaseOffset(x, z) {
  return Math.sin(x * 0.031 + z * 0.027) * 0.62
    + Math.sin(x * 0.017 - z * 0.039) * 0.48
    + Math.sin(x * 0.043 - z * 0.021) * 0.31;
}

function waveHeight(x, z, t, wind = 1) {
  const phase = wavePhaseOffset(x, z);
  let h = 0;
  for (let i = 0; i < W.length; i++) {
    const w = W[i];
    h += w.amp * Math.sin((w.dx * x + w.dz * z) * w.k - t * w.om + phase * PHASE_W[i]);
  }
  return h * wind;
}

assert.ok(WAVES.length >= 4, 'expected multi-octave lake waves');
for (const w of WAVES) {
  assert.ok(w.speed <= 1.75, `wave speed should stay lake-calm, got ${w.speed}`);
  assert.ok(w.amp <= 0.12, `wave amp should stay moderate, got ${w.amp}`);
}

assert.ok(MAX_WAVE_AMP < 0.27, `total wave amp should be calmer, got ${MAX_WAVE_AMP}`);

const t = 12.7;
const h0 = waveHeight(4.2, -8.1, t);
const h1 = waveHeight(4.2, -8.1, t + 0.5);
assert.ok(Number.isFinite(h0) && Number.isFinite(h1), 'waveHeight must stay finite');
assert.ok(Math.abs(h1 - h0) < 0.08, 'half-second height delta should stay gentle');

const phaseA = wavePhaseOffset(0, 0);
const phaseB = wavePhaseOffset(40, -22);
assert.ok(Math.abs(phaseA - phaseB) > 0.05, 'phase offset must vary spatially');

assert.match(waterSrc, /export function wavePhaseOffset\(/, 'wave phase offset must stay exported');
assert.match(waterSrc, /wavePhase\(vec2 p\)/, 'GPU wave shader must include spatial phase offset');
assert.match(waterSrc, /wavePhaseGrad\(vec2 p\)/, 'GPU wave shader must include phase gradient');
assert.match(waterSrc, /farRip = mix\(1\.0, 0\.38/, 'distant ripples should be attenuated');
assert.match(waterSrc, /crestWeather = smoothstep\(1\.12, 1\.75, uWind\)/,
  'clear-weather crest foam should be gated by strong wind');

assert.match(waterSrc, /float shoreBand = smoothstep\(0\.68, 0\.0, shoreDepth\)/,
  'shore foam must use depth-driven shore band');
assert.match(waterSrc, /float shoreFeather = smoothstep\(0\.018, 0\.075, vDepth\)/,
  'shore edge feather must stay narrow so the shallowest water keeps foam coverage');
assert.match(waterSrc, /float breakThresh = mix\(0\.26, 0\.74, 1\.0 - shoreBand\)/,
  'shore foam breakup threshold must vary with depth');
assert.match(waterSrc, /float coarseN = fbm2\(coarseP\)/,
  'shore foam must use coarse fbm2 breakup');
assert.match(waterSrc, /float fineN = vnoise\(fineP\)/,
  'shore foam must use fine vnoise streaks');
assert.match(waterSrc, /float foamLag = runUp \* 2\.1 - uTime \* 0\.06/,
  'shore foam must trail wave height with phase lag');
assert.match(waterSrc, /shoreFoam \*= 1\.0 - smoothstep\(55\.0, 180\.0, vFogDepth\)/,
  'shore foam must fade with view distance');
assert.match(waterSrc, /vec3 foamTint = mix\(uShallow \* 1\.35, vec3\(0\.88, 0\.94, 0\.96\), shoreBand\)/,
  'shore foam tint must be lighting-aware, not flat white');
assert.doesNotMatch(waterSrc, /float lapThresh = mix\(0\.82, -0\.12, lap\)/,
  'legacy flat shore foam threshold must be removed');
assert.match(waterSrc, /makeTileableHeightField/, 'ripple normal must keep tileable noise');
assert.match(waterSrc, /RepeatWrapping/, 'ripple normal must keep RepeatWrapping');
assert.doesNotMatch(waterSrc, /fract\s*\([^)]*uRippleNormal/, 'ripple normal must not use manual fract()');

assert.match(postfxSrc, /0\.0007 \* uStrength/, 'underwater UV wobble should stay subtle');
assert.match(postfxSrc, /mix\(0\.16, 0\.35, uStrength\)/, 'underwater absorption should stay light');
assert.match(postfxSrc, /0\.04 \* uStrength/, 'underwater tint mix should stay light');
assert.match(postfxSrc, /haze \* 0\.14/, 'underwater haze should stay light');
assert.match(postfxSrc, /lerp\(0\.55, 0\.10, strength\)/, 'underwater bloom should stay subdued');

console.log('lake-calm-water-test: ok');
