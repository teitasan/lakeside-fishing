#!/usr/bin/env node
/* UnderwaterPropScatter の制約・決定論・shader hook 回帰テスト */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { makeRng } from '../src/util.js';
import {
  fitWeedScale,
  placeUpToTarget,
  WEED_BLADE_HEIGHT,
  WEED_SURFACE_CLEARANCE,
} from '../src/underwaterScatterMath.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, 'src/underwaterProps.js'), 'utf8');

if (!src.includes('InstancedMesh')) throw new Error('InstancedMesh expected');
if (!src.includes('CAUSTICS_GLSL')) throw new Error('caustics shader hook expected');
if (!src.includes('0.25')) throw new Error('low density factor expected');
if (!src.includes('#include <clipping_planes_fragment>')) throw new Error('distance discard hook missing');
if (!src.includes('totalEmissiveRadiance += causticLight')) throw new Error('caustics must be injected before lighting');
if (src.includes('#include <output_fragment>')) throw new Error('Three r180 has no output_fragment hook');
if (!src.includes('shuffleInstances')) throw new Error('quality subsets must be spatially unbiased');
if (!src.includes('basisX / basisXLen') || !src.includes('basisZ / basisZLen')) {
  throw new Error('world flow must be transformed into each instance local basis');
}
if (!src.includes('if (vUwKeep < 0.5) gl_Position')) {
  throw new Error('discarded LOD instances must be clipped before rasterization');
}
if (!src.includes('causticLight(vUwWorldPos, normal)')) {
  throw new Error('caustics must be gated by the post-normal-map surface normal');
}

let attempts = 0;
const capped = placeUpToTarget(9, 200, () => { attempts++; return true; });
assert.deepEqual(capped, { placed: 9, tries: 9 });
assert.equal(attempts, 9, 'successful structure scatter must stop at its target');

let mixedTry = 0;
const mixed = placeUpToTarget(4, 20, () => (++mixedTry % 3) === 0);
assert.deepEqual(mixed, { placed: 4, tries: 12 });
const exhausted = placeUpToTarget(5, 40, () => null);
assert.deepEqual(exhausted, { placed: 0, tries: 1 });

assert.equal(fitWeedScale(1.2, 0.2), null, 'too-shallow weeds must be rejected');
for (const depth of [0.35, 0.6, 1.5, 5.0]) {
  for (const desired of [0.25, 0.8, 1.7]) {
    const scale = fitWeedScale(desired, depth);
    if (scale === null) continue;
    const tipY = -depth + WEED_BLADE_HEIGHT * scale;
    assert.ok(tipY <= -WEED_SURFACE_CLEARANCE + 1e-9, `weed breaches surface at depth ${depth}`);
  }
}

const a = makeRng(42 ^ 0xa11ce);
const b = makeRng(42 ^ 0xa11ce);
for (let i = 0; i < 32; i++) {
  if (a() !== b()) throw new Error('underwater scatter seed must be deterministic');
}

console.log('underwater-props-test: ok');
