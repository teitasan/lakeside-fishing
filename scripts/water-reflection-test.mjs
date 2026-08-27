#!/usr/bin/env node
import assert from 'node:assert/strict';
import { reflectCameraMatrixY } from '../src/reflectionMath.js';

const input = new Float64Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  7, 5, 11, 1,
]);
const out = new Float64Array(16);
reflectCameraMatrixY(input, out);

assert.deepEqual(Array.from(out.slice(12, 15)), [7, -5, 11], 'only camera Y position should mirror');
const forward = [-out[8], -out[9], -out[10]];
assert.ok(Math.abs(forward[0]) < 1e-12 && Math.abs(forward[1]) < 1e-12 && Math.abs(forward[2] + 1) < 1e-12,
  'horizontal camera forward must not flip across a horizontal plane');

// 任意のorthonormal basisでも X'=-S(X), Y'=S(Y), Z'=S(Z) を満たす。
const c = Math.cos(0.63), s = Math.sin(0.63);
const rotated = new Float64Array([
  c, 0, -s, 0,
  0, 1, 0, 0,
  s, 0, c, 0,
  -3, 8, 4, 1,
]);
reflectCameraMatrixY(rotated, out);
assert.deepEqual(Array.from(out.slice(12, 15)), [-3, -8, 4]);
assert.ok(Math.abs(out[8] - rotated[8]) < 1e-12);
assert.ok(Math.abs(out[9] + rotated[9]) < 1e-12);
assert.ok(Math.abs(out[10] - rotated[10]) < 1e-12);

const det3 = (m) => (
  m[0] * (m[5] * m[10] - m[6] * m[9])
  - m[4] * (m[1] * m[10] - m[2] * m[9])
  + m[8] * (m[1] * m[6] - m[2] * m[5])
);
assert.ok(Math.abs(det3(out) - 1) < 1e-12, 'reflected camera rotation must remain right-handed');

console.log('water-reflection-test: ok');
