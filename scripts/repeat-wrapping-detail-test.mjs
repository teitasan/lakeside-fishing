#!/usr/bin/env node
/* RepeatWrapping 詳細テクスチャが manual fract() でサンプルされないことの回帰テスト */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { makeTileableHeightField } from '../src/tileableNoise.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function extractFunctionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  throw new Error(`${name} body not found`);
}

function assertNoFractSample(src, label, sampler) {
  const re = new RegExp(`texture2D\\(${sampler},\\s*([^)]+)\\)`, 'g');
  const hits = [...src.matchAll(re)];
  assert.ok(hits.length > 0, `${label}: expected at least one ${sampler} sample`);
  for (const [, uvExpr] of hits) {
    assert.ok(
      !/\bfract\s*\(/.test(uvExpr),
      `${label}: ${sampler} must rely on RepeatWrapping, not fract() — got texture2D(${sampler}, ${uvExpr})`,
    );
  }
  return hits.length;
}

const waterSrc = readFileSync(join(root, 'src/water.js'), 'utf8');
const terrainSrc = readFileSync(join(root, 'src/terrain.js'), 'utf8');

assertNoFractSample(waterSrc, 'water', 'uRippleNormal');
assert.equal(assertNoFractSample(terrainSrc, 'terrain', 'uBedDetail'), 3, 'expected three uBedDetail samples');

assert.match(waterSrc, /tex\.wrapS = tex\.wrapT = THREE\.RepeatWrapping;/, 'ripple normal texture must use RepeatWrapping');
assert.match(waterSrc, /tex\.generateMipmaps = true;/, 'ripple normal texture must keep mipmaps');
assert.match(terrainSrc, /tex\.wrapS = tex\.wrapT = THREE\.RepeatWrapping;/, 'bed detail texture must use RepeatWrapping');
assert.match(terrainSrc, /tex\.generateMipmaps = true;/, 'bed detail texture must keep mipmaps');

assert.match(waterSrc, /makeTileableHeightField/, 'ripple normal must use tileable noise height field');
assert.match(terrainSrc, /makeTileableHeightField/, 'bed detail must use tileable noise height field');
const rippleBody = extractFunctionBody(waterSrc, 'createRippleNormalTexture');
const bedBody = extractFunctionBody(terrainSrc, 'createBedDetailTexture');
assert.doesNotMatch(
  rippleBody,
  /Math\.(?:sin|cos)\(\s*u\s*\*/,
  'ripple normal must not use fixed sin/cos lattice modes',
);
assert.doesNotMatch(
  bedBody,
  /Math\.(?:sin|cos)\(\s*u\s*\*/,
  'bed detail must not use fixed sin/cos lattice modes',
);

const SIZE = 128;
const waterHeight = makeTileableHeightField(SIZE, 0xa1f0001, {
  octaves: 4,
  baseFrequency: 5,
  secondaryFrequency: 11,
  secondaryMix: 0.32,
  gain: 0.52,
  amplitude: 4.2,
});
const bedHeight = makeTileableHeightField(SIZE, 0xbed0421, {
  octaves: 4,
  baseFrequency: 9,
  secondaryFrequency: 15,
  secondaryMix: 0.4,
  gain: 0.48,
  amplitude: 3.6,
});
const waterHeightAgain = makeTileableHeightField(SIZE, 0xa1f0001, {
  octaves: 4,
  baseFrequency: 5,
  secondaryFrequency: 11,
  secondaryMix: 0.32,
  gain: 0.52,
  amplitude: 4.2,
});

assert.equal(waterHeight(17, 43), waterHeightAgain(17, 43), 'tileable height must be deterministic');

let min = Infinity;
let max = -Infinity;
let mismatch = 0;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const w = waterHeight(x, y);
    const b = bedHeight(x, y);
    min = Math.min(min, w, b);
    max = Math.max(max, w, b);
    if (Math.abs(w - b) > 1e-12) mismatch++;
  }
}
assert.ok(min >= -1.7 && max <= 1.7, `height field must stay bounded, got [${min}, ${max}]`);
assert.ok(mismatch > SIZE * SIZE * 0.9, 'water and bed seeds must produce uncorrelated fields');

for (let y = 0; y < SIZE; y++) {
  assertClose(waterHeight(0, y), waterHeight(SIZE, y), 'height must wrap on x=0/size');
  assertClose(waterHeight(y, 0), waterHeight(y, SIZE), 'height must wrap on y=0/size');
  assertClose(waterHeight(-1, y), waterHeight(SIZE - 1, y), 'negative x must wrap for finite differences');

  const dx0 = waterHeight(1, y) - waterHeight(-1, y);
  const dxEdge = waterHeight(1, y) - waterHeight(SIZE - 1, y);
  const dy0 = waterHeight(y, 1) - waterHeight(y, -1);
  const dyEdge = waterHeight(y, 1) - waterHeight(y, SIZE - 1);
  assertClose(dx0, dxEdge, 'wrapped finite-difference slope must match at x seam');
  assertClose(dy0, dyEdge, 'wrapped finite-difference slope must match at y seam');
}
for (let x = 0; x < SIZE; x++) {
  assertClose(waterHeight(x, -1), waterHeight(x, SIZE - 1), 'negative y must wrap for finite differences');
}

function assertClose(actual, expected, message, epsilon = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} vs ${expected}`);
}

// Endpoints alone can hide a discontinuity if a caller applies mod(size).
// Non-integer samples on both sides verify that the noise field itself is periodic.
for (const [x, y] of [[0.125, 9.75], [17.375, 63.5], [91.25, -4.625]]) {
  assertClose(waterHeight(x, y), waterHeight(x + SIZE, y), 'height must be intrinsically periodic on x');
  assertClose(waterHeight(x, y), waterHeight(x, y + SIZE), 'height must be intrinsically periodic on y');
}

const seamRms = (height, axis) => {
  const eps = 1e-3;
  let seamSq = 0;
  let innerSq = 0;
  for (let i = 0; i < SIZE; i++) {
    const seamA = axis === 'x' ? height(eps, i + 0.37) : height(i + 0.37, eps);
    const seamB = axis === 'x' ? height(SIZE - eps, i + 0.37) : height(i + 0.37, SIZE - eps);
    const innerA = axis === 'x' ? height(41 + eps, i + 0.37) : height(i + 0.37, 41 + eps);
    const innerB = axis === 'x' ? height(41 - eps, i + 0.37) : height(i + 0.37, 41 - eps);
    seamSq += (seamA - seamB) ** 2;
    innerSq += (innerA - innerB) ** 2;
  }
  return Math.sqrt(seamSq / Math.max(innerSq, 1e-24));
};
for (const [label, height] of [['water', waterHeight], ['bed', bedHeight]]) {
  assert.ok(seamRms(height, 'x') < 2, `${label} x seam must not jump relative to an equal-width interior sample`);
  assert.ok(seamRms(height, 'y') < 2, `${label} y seam must not jump relative to an equal-width interior sample`);
}

function directionalAnisotropy(height, radius = 8) {
  const values = new Float64Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) values[y * SIZE + x] = height(x, y);
  }
  const wrap = (v) => ((v % SIZE) + SIZE) % SIZE;
  const sample = (x, y) => {
    const wx = wrap(x);
    const wy = wrap(y);
    const x0 = Math.floor(wx);
    const y0 = Math.floor(wy);
    const x1 = (x0 + 1) % SIZE;
    const y1 = (y0 + 1) % SIZE;
    const tx = wx - x0;
    const ty = wy - y0;
    const a = values[y0 * SIZE + x0] * (1 - tx) + values[y0 * SIZE + x1] * tx;
    const b = values[y1 * SIZE + x0] * (1 - tx) + values[y1 * SIZE + x1] * tx;
    return a * (1 - ty) + b * ty;
  };

  const energy = [];
  for (let degrees = 0; degrees < 180; degrees += 5) {
    const angle = degrees * Math.PI / 180;
    const ox = Math.cos(angle) * radius;
    const oy = Math.sin(angle) * radius;
    let sum = 0;
    let count = 0;
    for (let y = 0; y < SIZE; y += 4) {
      for (let x = 0; x < SIZE; x += 4) {
        const d = sample(x + ox, y + oy) - values[y * SIZE + x];
        sum += d * d;
        count++;
      }
    }
    energy.push(sum / count);
  }
  return Math.max(...energy) / Math.max(Math.min(...energy), 1e-12);
}

assert.ok(directionalAnisotropy(waterHeight) < 1.6, 'water detail must not regress to a directional crosshatch');
assert.ok(directionalAnisotropy(bedHeight) < 1.6, 'bed detail must not regress to a directional crosshatch');

console.log('repeat-wrapping-detail-test: ok');
