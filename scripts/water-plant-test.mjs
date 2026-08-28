#!/usr/bin/env node
/* 水辺〜水中の植物（ヨシ・マコモ・クロモ）と LOD インスタンス管理の回帰テスト。
   waterPlants.js は three を import するので、数値の検証は THREE 非依存の
   util.lodForList に対して行い、残りはソースの不変条件で固定する。 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { lodForList } from '../src/util.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

/* ---------------- LOD 判定（植生共通） ---------------- */
const D = [28, 78];
assert.strictEqual(lodForList(5, D, -1), 0);
assert.strictEqual(lodForList(50, D, -1), 1);
assert.strictEqual(lodForList(200, D, -1), 2, '最後のしきい値より遠いと最終段');
// ヒステリシス：境界を往復しても段が張り付く
assert.strictEqual(lodForList(32, D, 0, 8), 0, '境界 +4m ではまだ近景');
assert.strictEqual(lodForList(38, D, 0, 8), 1, '境界 +10m で中景へ落ちる');
assert.strictEqual(lodForList(24, D, 1, 8), 1, '戻るには内側の境界まで近づく');
assert.strictEqual(lodForList(18, D, 1, 8), 0);
{
  let cur = 0, flips = 0;
  for (let pass = 0; pass < 6; pass++) {
    const seq = pass % 2 ? [36, 34, 32, 30, 28] : [28, 30, 32, 34, 36];
    for (const d of seq) {
      const l = lodForList(d, D, cur, 8);
      if (l !== cur) flips++;
      cur = l;
    }
  }
  assert.strictEqual(flips, 0, '遊び幅の中で往復しても切り替わらない');
}
// しきい値が 3 段以上でも順に効く
assert.strictEqual(lodForList(120, [30, 100, 200], -1), 2);
assert.strictEqual(lodForList(400, [30, 100, 200], -1), 3);

/* ---------------- 実装の不変条件 ---------------- */
const wp = read('src/waterPlants.js');
const li = read('src/lodInstances.js');
const terrain = read('src/terrain.js');
const uwp = read('src/underwaterProps.js');

// 3 種そろっていること
for (const k of ['planReed', 'planManomo', 'planHydrilla']) {
  assert.match(wp, new RegExp(`export function ${k}\\(`), `${k} が無い`);
}

/* 葉群はジオメトリのリボンではなく «葉を描いたカード»。
   リボンはシルエットが硬く、根元の暗さや葉先の透けが出ず、
   遠くでピクセル未満になってチラつく（実際そう見えたので描き替えた） */
assert.match(wp, /export function makeBladeTexture\(/,
  'foliage must come from a painted blade texture, not ribbon geometry');
assert.doesNotMatch(wp, /function ribbon\(/,
  'the ribbon blade builder must be gone');
assert.match(wp, /function cardFan\(/, '葉群はカードのファンで置く');

/* カードは表裏 2 枚ぶん索引して FrontSide で描く。
   DoubleSide の法線反転は gl_FrontFacing で決まるので、上向きの法線を
   持つカードを裏から見ると法線が真下を向いて真っ黒になる */
assert.match(wp, /function pushQuad\(out, base\) \{/, 'カードは巻き 2 通りで索引する');
assert.match(wp, /out\.idx\.push\(base, base \+ 2, base \+ 1, base, base \+ 3, base \+ 2\);/,
  'the reversed winding must be emitted so the back side is not normal-flipped');
assert.doesNotMatch(wp, /side: THREE\.DoubleSide,\s*alphaTest/,
  'alpha-tested cards must not rely on DoubleSide');
assert.match(wp, /side: THREE\.FrontSide, alphaTest: 0\.26/, '葉群カードは FrontSide');

/* カードの縦横比とテクスチャの縦横比が一致していること。
   ずれるとカード上で葉が伸び縮みして «針金» に見える */
{
  const aspects = {};
  const m = wp.match(/export const BLADE_ASPECT = \{([^}]*)\}/);
  assert.ok(m, 'BLADE_ASPECT が無い');
  for (const part of m[1].split(',')) {
    const p = part.match(/(\w+)\s*:\s*1 \/ ([\d.]+)|(\w+)\s*:\s*1\b/);
    if (!p) continue;
    if (p[1]) aspects[p[1]] = 1 / parseFloat(p[2]);
    else if (p[3]) aspects[p[3]] = 1;
  }
  const cfg = wp.slice(wp.indexOf('export function makeBladeTexture('));
  for (const kind of ['reed', 'manomo', 'tuft']) {
    const hm = cfg.match(new RegExp(`${kind}: \\{[\\s\\S]{0,120}?h: ([\\d.]+)`));
    assert.ok(hm, `${kind} の h が読めない`);
    const want = 1 / parseFloat(hm[1]);
    assert.ok(Math.abs(aspects[kind] - want) < 1e-9,
      `${kind}: BLADE_ASPECT ${aspects[kind]} とテクスチャ縦横比 ${want} が一致しない`);
  }
}

/* LOD をまたいでも同じ株のまま：設計図を 1 回引いて 2 段を起こす */
assert.match(wp, /const plan = planFor\(name, makeRng\(.*\);\s*\n\s*for \(let lod = 0; lod < 2; lod\+\+\) \{/,
  'both LODs must be emitted from one plan so the plant does not change shape');

/* クロモは水中プロップと同じマテリアル＝流れの揺れ・caustics・距離間引き */
assert.match(uwp, /export function patchUwMaterial\(/, 'patchUwMaterial が公開されていること');
assert.match(wp, /this\.mats\.hydrillaStem = uw\(/, 'クロモは水中マテリアルを使う');
assert.match(wp, /const uwSway = 5\.4;/, '沈水植物は流れで大きく倒れる');
assert.match(wp, /this\.mats\.hydrillaLeaf = uw\(new THREE\.MeshStandardMaterial\(\{[\s\S]*?\}\), uwSway\);/,
  '茎と葉の揺れ量は同じでないと葉が茎から抜ける');

/* 抽水植物は水面をまたぐので «風で揺れる» と «水面下だけ caustics» の両方 */
assert.match(wp, /function applyPatches\(mat, patches\) \{/,
  'onBeforeCompile を上書きし合わないよう合成すること');
assert.match(wp, /\[wind\(reedWind\), caust\]/, 'ヨシは風と caustics の両方');
assert.match(wp, /\[wind\(manomoWind\), caust\]/, 'マコモも同様');

/* 湖底の «藻» が円錐 1 個のままだと、描いた葉のクロモの隣で浮く */
assert.match(uwp, /let weedGeo = this\.weedGeo;/, '藻のジオメトリを差し替えられること');
assert.match(terrain, /weedGeo: buildSubmergedTuft\(/, 'terrain が藻を房に差し替える');
assert.match(terrain, /weedMap: this\.waterPlants\?\.bladeTex\?\.tuft/, '藻にも葉テクスチャを渡す');

/* 水深の帯：ヨシ（汀線〜1m）→ マコモ（0.1〜1.3m）→ クロモ（0.6〜4.6m） */
{
  const band = (kind) => {
    const m = terrain.match(new RegExp(`kind: '${kind}'[^}]*hMin: (-?[\\d.]+), hMax: (-?[\\d.]+)`));
    assert.ok(m, `${kind} の帯が読めない`);
    return { min: parseFloat(m[1]), max: parseFloat(m[2]) };
  };
  const reed = band('reed'), manomo = band('manomo'), hyd = band('hydrilla');
  assert.ok(reed.max > 0, 'ヨシは汀線より上まで生える');
  assert.ok(manomo.max < 0, 'マコモは水中から');
  assert.ok(hyd.min < manomo.min, 'クロモが一番深い');
  assert.ok(hyd.max < manomo.max, 'クロモは抽水植物より深いところだけ');
  for (const b of [reed, manomo, hyd]) assert.ok(b.min < b.max, '帯の上下が逆');
}

/* 群落：等確率で撒くと岸をぐるりと均一に縁取って花壇に見える */
assert.match(terrain, /if \(this\.noise\.fbm\(x \* 0\.042 \+ b\.salt, z \* 0\.042 - b\.salt, 2\) < b\.thr\) continue;/,
  'plants must be clumped by a noise mask, not scattered uniformly');
assert.match(terrain, /salt: 11\.3.*\n?/, '種ごとに群落の位置をずらす salt を持つこと');

/* 旧実装（円錐 1 個の «葦»）が残っていないこと */
assert.doesNotMatch(terrain, /const reedGeo = new THREE\.ConeGeometry/,
  'the old single-cone reed must be gone');
assert.match(terrain, /this\.waterPlants = new WaterPlants\(/);
assert.match(terrain, /this\.waterPlants\?\.update\(dt, cameraPos\);/, '毎フレーム LOD を振り直す');

/* 沈水植物は水面の鏡像に写らないので反射パスから外す */
const gameSrc = read('src/game.js');
assert.match(gameSrc, /\.\.\.\(this\.terrain\.waterPlants\?\.submergedMeshes \|\| \[\]\),/,
  'submerged plants must be excluded from the reflection pass');

/* LodInstances：段が変わった株があったときだけ行列を作り直す */
assert.match(li, /if \(this\._timer > 0 && !this\._dirty\) return;/,
  'LOD の振り直しは間隔を空けること');
assert.match(li, /if \(l !== it\.lod\) \{ it\.lod = l; changed = true; \}/,
  '変化がなければ再アップロードしない');
assert.match(li, /if \(!list\) continue;\s*\/\/ 最終段より遠い＝描かない/,
  '最終段より遠い株は描かない');
assert.match(li, /export function tintAt\(/, '株ごとの色ムラ');

console.log('water-plant-test: ok');
