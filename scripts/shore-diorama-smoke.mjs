#!/usr/bin/env node
/**
 * shore-diorama.html の静的スモークチェック（WebGL なし）
 * - 本番モジュール参照
 * - resolveLake + 岸焦点の決定が本番 dock から導けること
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { resolveLake } from '../src/lakefield.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, 'shore-diorama.html'), 'utf8');

const requiredImports = [
  './src/sky.js',
  './src/terrain.js',
  './src/lakefield.js',
  './src/water.js',
  './src/postfx.js',
  './src/causticTexture.js',
];
for (const mod of requiredImports) {
  assert.ok(html.includes(mod), `shore-diorama.html must import ${mod}`);
}

assert.match(html, /window\.__shoreDiorama/, 'must expose window.__shoreDiorama');
assert.match(html, /setHudVisible/, 'must expose a clean screenshot HUD toggle');
assert.match(html, /resolveLake/, 'must call resolveLake');
assert.match(html, /water\.capture\(/, 'must use production water capture pass');
assert.match(html, /captureReflection/, 'must use production reflection pass');
assert.match(html, /postfx\.render/, 'must use PostFX composer render');
assert.match(html, /updateShore/, 'must update shore wetness like production');
assert.match(html, /preserveDrawingBuffer:\s*true/, 'PNG capture must preserve the drawing buffer');
assert.match(html, /far: 3000/, 'camera far plane must include the production sky dome');
assert.doesNotMatch(html, /fragmentShader:\s*`/,
  'must not inline a custom water fragment shader');

const SHORE_ALONG_OFFSET = 8;
const resolved = resolveLake(20240711);
assert.ok(resolved?.lake?.dock, 'resolveLake must return dock metadata');
const d = resolved.lake.dock;
const lakeDir = { x: d.dir.x, z: d.dir.z };
const len = Math.hypot(lakeDir.x, lakeDir.z);
assert.ok(len > 0, 'dock.dir must be non-zero');
const lx = lakeDir.x / len;
const lz = lakeDir.z / len;
const along = { x: -lz, z: lx };
const alen = Math.hypot(along.x, along.z);
const landX = d.start.x + (along.x / alen) * SHORE_ALONG_OFFSET;
const landZ = d.start.z + (along.z / alen) * SHORE_ALONG_OFFSET;
const depth = resolved.lake.depthAt(landX, landZ);
assert.ok(depth <= 0.05, `shore focus must be on land, depth=${depth}`);

const presets = ['close', 'oblique', 'top'];
for (const p of presets) {
  assert.ok(html.includes(`'${p}'`), `preset ${p} must be defined`);
}

console.log('shore-diorama-smoke: ok');
