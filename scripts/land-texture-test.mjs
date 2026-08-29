/**
 * 陸タイル（浜・草地・林床・岩肌）の検査。
 *
 *  (1) 4 枚が 1024² で、平均色が頂点色の実測値からずれていない
 *  (2) 左右・上下端の差が隣テクセル差を超えない（目地に見えない）
 *  (3) 輝度から焼いた派生マップもタイルする
 *  (4) シェーダが陸アルベドを高さ・傾きで混ぜている
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bakeLandDetailMaps } from '../src/tileableNoise.js';
import {
  LAND_TILES, decodeRgb, meanRgb, parseHex, seamReport, SIZE,
} from './process-land-textures.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

for (const spec of LAND_TILES) {
  const path = join(root, 'assets/textures', `${spec.id}.webp`);
  const rgb = decodeRgb(path);
  assert.strictEqual(rgb.length, SIZE * SIZE * 3, `${spec.id}: 1024² rgb`);
  const mean = meanRgb(rgb);
  const target = parseHex(spec.hex);
  const drift = Math.max(...mean.map((v, i) => Math.abs(v - target[i])));
  assert.ok(drift <= 3, `${spec.id}: 平均 ${mean.map((v) => v.toFixed(1))} が ${spec.hex} から ${drift.toFixed(1)}`);
  const seam = seamReport(rgb);
  assert.ok(seam.ok, `${spec.id}: 継ぎ目 ${seam.seam.toFixed(1)} > 隣接 ${seam.neighbour.toFixed(1)}`);
  console.log(
    `  ${spec.id.padEnd(12)} ${spec.hex}  drift ${drift.toFixed(1)}`
    + `  seam ${seam.seam.toFixed(1)} / nbor ${seam.neighbour.toFixed(1)}`,
  );
}

{
  const N = 64;
  const luma = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      luma[y * N + x] = 0.5
        + 0.28 * Math.sin((2 * Math.PI * x) / N)
        * Math.cos((2 * Math.PI * y) / N);
    }
  }
  const { data } = bakeLandDetailMaps(luma, N, { aoRadius: 0.06, nScale: 2.4 });
  let seam = 0;
  let neighbour = 0;
  const d = (i, j) => {
    let s = 0;
    for (let c = 0; c < 4; c++) {
      const a = data[i + c] - data[j + c];
      s += a * a;
    }
    return Math.sqrt(s);
  };
  for (let y = 0; y < N; y++) {
    const row = y * N * 4;
    seam = Math.max(seam, d(row, row + (N - 1) * 4));
    for (let x = 1; x < N; x++) neighbour = Math.max(neighbour, d(row + x * 4, row + (x - 1) * 4));
  }
  for (let x = 0; x < N; x++) {
    seam = Math.max(seam, d(x * 4, ((N - 1) * N + x) * 4));
    for (let y = 1; y < N; y++) neighbour = Math.max(neighbour, d((y * N + x) * 4, ((y - 1) * N + x) * 4));
  }
  assert.ok(seam <= neighbour * 1.2, `派生マップ継ぎ目 ${seam.toFixed(1)} > 隣接 ${neighbour.toFixed(1)}`);
  console.log(`  detail maps  seam ${seam.toFixed(1)} / nbor ${neighbour.toFixed(1)}`);
}

const terrain = readFileSync(join(root, 'src/terrain.js'), 'utf8');
const game = readFileSync(join(root, 'src/game.js'), 'utf8');
for (const need of [
  'loadLandTextures',
  'uLandAlbedo',
  'uLandDetail',
  'applyLandAlbedo',
  'aSlope',
  'bakeLandDetailLayer',
  'uLandScale',
  '1 / 2, 1 / 3, 1 / 3, 1 / 4',
]) {
  assert.ok(terrain.includes(need), `terrain.js に ${need} がない`);
}

/* サンプラの本数。
 *
 * WebGL2 が保証する MAX_TEXTURE_IMAGE_UNITS は 16 本しかなく、実際に 16 の
 * 環境がある。地形のフラグメントはそこへ
 *   terrain.js が 8 本（湖底 3・粒 2・砂利/砂の派生 1・陸 2）
 *   shaders.js が 2 本（uCaustTex / uShoreHeightTex）
 *   three が影用に数本（directionalShadowMap ほか）
 * を積む。超えるとリンクが通らず «program not valid» で地形が丸ごと
 * 消えるが、例外は出ないので気づけない。実際に陸タイルを 4 種 ×
 * アルベド／派生 = 8 本で足したときそれが起きた。だから 4 種は
 * sampler2DArray 1 本にまとめてある。
 *
 * 増やしたくなったら、まず層にまとめられないか考えること。 */
{
  const decls = [...terrain.matchAll(/uniform\s+sampler\w*\s+(\w+)/g)].map((m) => m[1]);
  const uniq = [...new Set(decls)];
  const BUDGET = 9;
  assert.ok(
    uniq.length <= BUDGET,
    `地形のサンプラが ${uniq.length} 本（上限 ${BUDGET}）: ${uniq.join(', ')}\n`
    + '  16 本を超えるとリンクに失敗して地面が消える。層（sampler2DArray）にまとめること',
  );
  // 陸が層になっていること（配列でなければ 4 種で 8 本に戻る）
  assert.ok(
    /uniform\s+sampler2DArray\s+uLandAlbedo/.test(terrain)
    && /uniform\s+sampler2DArray\s+uLandDetail/.test(terrain),
    '陸タイルが sampler2DArray になっていない',
  );
  console.log(`  サンプラ ${uniq.length}/${BUDGET} 本  (${uniq.join(', ')})`);
}
assert.ok(game.includes('Terrain.loadLandTextures()'), 'game.js が陸テクスチャを読んでいない');
assert.ok(game.includes('landTextures'), 'game.js が landTextures を渡していない');
assert.ok(
  terrain.includes('diffuseColor.rgb = applyLandAlbedo'),
  '陸アルベドが color_fragment で混ざっていない',
);
assert.ok(
  /applyLandAlbedo\(vBedWorldPos,\s*under/.test(terrain),
  '陸アルベドが under（水中）のあと・濡れ砂の前に掛かること',
);
assert.ok(!/sampleLand[\s\S]{0,500}fract\s*\(/.test(terrain), '陸サンプルが fract() を使っている');

const r = spawnSync(process.execPath, [
  join(root, 'scripts/process-land-textures.mjs'),
  '--verify',
], { cwd: root, encoding: 'utf8' });
assert.equal(r.status, 0, `verify failed:\n${r.stdout}\n${r.stderr}`);

console.log('land-texture-test: ok');
