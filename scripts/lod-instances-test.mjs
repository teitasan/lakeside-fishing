#!/usr/bin/env node
/**
 * LodInstances の LOD 帯・ヒステリシス・シェーダ距離の整合。
 *
 * 近づいたときに植生がポッと消えるのは、
 *   1) ヒステリシスで主段 l が帯の «向こう側» に留まる
 *   2) 旧 l2 判定が d<e だけで隣段を決め l2===l になる
 *   3) シェーダだけが vLodFade<1 で間引く
 * という連鎖が原因だった。
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { lodForList, lodFadeMate, smoothstep } from '../src/util.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

/* ---------------- lodFadeMate：帯内は常に l の隣接段 ---------------- */
{
  const D = [58, 145];   // 木
  const band = 12;

  // 遠景側の帯 (133,157)：l=2 のまま留まるヒステリシス帯
  assert.strictEqual(lodFadeMate(140, D, 2, band, 2), 1,
    'l=2 が帯内にいるときは細かい段 1 も描く');
  assert.strictEqual(lodFadeMate(150, D, 1, band, 2), 2,
    'l=1 が帯内にいるときは粗い段 2 も描く');

  // 旧実装だと l2===l で -1 になり、ここが消えていた
  for (const d of [134, 140, 150, 156]) {
    const l = lodForList(d, D, d < 145 ? 2 : 1, 8);
    const mate = lodFadeMate(d, D, l, band, 2);
    assert.ok(mate >= 0 && mate !== l,
      `d=${d} l=${l}: 帯内では mate=${mate} が l と異なること`);
  }

  // 帯外
  assert.strictEqual(lodFadeMate(120, D, 1, band, 2), -1);
  assert.strictEqual(lodFadeMate(170, D, 2, band, 2), -1);
  assert.strictEqual(lodFadeMate(100, D, 1, band, 2), -1, 'どの境界帯にも入らない距離');
}

/* ---------------- 下草・水草のしきい値でも同様 ---------------- */
{
  const D = [22, 48];
  const band = 8;
  assert.strictEqual(lodFadeMate(44, D, 1, band, 1), -1,
    '最終段の外側境界では粗い段が無いので mate なし');
  assert.strictEqual(lodFadeMate(25, D, 0, band, 1), 1, '22m 境界の帯');
  assert.strictEqual(lodFadeMate(25, D, 1, band, 1), 0);
}

/* ---------------- シェーダ距離と CPU 距離の帯幅は同じ smoothstep ---------------- */
{
  const band = 12;
  const fade = (d, loV, hiV) => {
    const inF = loV <= 0 ? 1 : smoothstep(loV - band, loV, d);
    const outF = hiV <= 0 ? 0 : smoothstep(hiV, hiV + band, d);
    return Math.max(0, Math.min(1, inF * (1 - outF)));
  };

  // l=2 単独描画（旧バグ）：d=140 で約 42% が捨てられる
  const solo2 = fade(140, 145, -1);
  assert.ok(solo2 > 0.5 && solo2 < 0.65, `l=2 単独の vLodFade=${solo2.toFixed(3)}`);

  // l=1 単独描画（旧バグ）：d=150
  const solo1 = fade(150, 58, 145);
  assert.ok(solo1 > 0.5 && solo1 < 0.65, `l=1 単独の vLodFade=${solo1.toFixed(3)}`);

  // 両方描けば、同じディザ閾値に対する被覆率は常に 1 になる
  const cover = (d) => Math.max(fade(d, 145, -1), fade(d, 58, 145));
  for (const d of [134, 140, 150, 156]) {
    assert.ok(cover(d) > 0.95, `d=${d} で両段の被覆率=${cover(d).toFixed(3)}`);
  }
}

/* ---------------- ソースの不変条件 ---------------- */
{
  const li = read('src/lodInstances.js');
  const util = read('src/util.js');
  const mp = read('src/materialPatch.js');

  assert.match(util, /export function lodFadeMate\(/);
  assert.match(li, /lodFadeMate\(d, this\.lodDist, l, band, this\.maxLod\)/,
    '帯内の隣段は lodFadeMate で決めること');
  assert.doesNotMatch(li, /d < e \? i \+ 1 : i/,
    '旧 l2 判定（帯の内外だけ）を残さないこと');
  assert.match(li, /_syncLodBands\(\)/,
    'setLodScale で lodDist が変わったら aLodBand を同期すること');
  assert.match(li, /this\._syncLodBands\(\)/,
    'update の先頭で aLodBand を同期すること');

  // CPU 距離とシェーダ距離は同じ 3D 距離
  assert.match(li, /Math\.hypot\(it\.x - cameraPos\.x, it\.y - cameraPos\.y, it\.z - cameraPos\.z\)/);
  assert.match(mp, /float lodD = distance\(lodPos, cameraPosition\);/);
  assert.match(mp, /smoothstep\(aLodBand\.x - b, aLodBand\.x, lodD\)/);
  assert.match(mp, /smoothstep\(aLodBand\.y, aLodBand\.y \+ b, lodD\)/);
}


/* 実際の Three.js バッファと LodInstances を使い、往復時の描画登録を確認。
   Node には import map が無いので、同梱 Three.js の URL に解決する。 */
const threeUrl = pathToFileURL(join(root, 'vendor/three.module.min.js')).href;
const THREE = await import(threeUrl);
const moduleSource = read('src/lodInstances.js')
  .replaceAll("'three'", JSON.stringify(threeUrl))
  .replaceAll("'./util.js?v=20260830-zone5'",
    JSON.stringify(pathToFileURL(join(root, 'src/util.js')).href));
const { LodInstances } = await import('data:text/javascript;base64,' + Buffer.from(moduleSource).toString('base64'));
function makeSet(distances, hysteresis, band, levels) {
  const set = new LodInstances(new THREE.Scene(), {
    lodDist: [...distances], hysteresis, fadeBand: band, interval: 0.22,
  });
  for (let lod = 0; lod < levels; lod++) {
    set.register('plant', lod, [{geo: new THREE.PlaneGeometry(1, 1), mat: new THREE.MeshBasicMaterial()}], 2);
  }
  set.add(0, 0, 0, 1, 'plant');
  return set;
}
for (const [distances, hysteresis, band, levels] of [
  [[22, 48], 5, 8, 2], [[58, 145], 8, 12, 3],
]) {
  const set = makeSet(distances, hysteresis, band, levels);
  for (let i = 0; i < levels - 1; i++) {
    const edge = distances[i];
    const inward = Array.from({length: band * 2 + 5}, (_, n) => edge + band + 2 - n);
    for (const distance of [...inward, ...[...inward].reverse()]) {
      set.update(1, {x: 0, y: 0, z: distance});
      if (Math.abs(distance - edge) >= band) continue;
      for (const lod of [i, i + 1]) {
        assert.equal(set.buckets.get(`plant|${lod}`)[0].count, 1,
          `${distance}m: LOD${lod} must remain uploaded throughout the fade band`);
      }
    }
  }
}
{
  const set = makeSet([22, 48], 5, 8, 2);
  set.update(1, {x: 0, y: 0, z: 60});
  assert.ok([...set.buckets.values()].every(([mesh]) => mesh.count === 0),
    'unregistered far LOD must stay culled');
  set.update(1, {x: 0, y: 0, z: 50});
  assert.equal(set.buckets.get('plant|1')[0].count, 1,
    'approaching from beyond draw distance must bring back the fading last LOD');
}
{
  const set = makeSet([58, 145], 8, 12, 3);
  set.addFixed(0, 0, 170, 1, 'plant', 2);
  set.buildFixed();
  const replacement = new THREE.PlaneGeometry(2, 2);
  set.replace('plant', 2, [{geo: replacement}]);
  assert.equal(replacement.getAttribute('aLodBand'), undefined,
    'replacement source geometry must not be mutated');
  for (const map of [set.buckets, set.fixedBuckets]) {
    const attr = map.get('plant|2')[0].geometry.getAttribute('aLodBand');
    assert.ok(attr, 'baked tree replacement must retain fade distances');
    assert.equal(attr.getX(0), 145);
  }
  set.update(1, {x: 0, y: 0, z: 100});
  set.lodDist[0] = 116; set.lodDist[1] = 290;
  set.update(0, {x: 0, y: 0, z: 100});
  assert.equal(set.items[0].lod, 0, 'changed distances must bypass the stale update interval');
  for (const map of [set.buckets, set.fixedBuckets]) {
    const attr = map.get('plant|2')[0].geometry.getAttribute('aLodBand');
    assert.equal(attr.getX(0), 290, 'dynamic and fixed meshes must use the current distance');
  }
}
console.log('lod-instances-test: ok');
