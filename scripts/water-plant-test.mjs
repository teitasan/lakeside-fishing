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
const D = [32, 88];
assert.strictEqual(lodForList(5, D, -1), 0);
assert.strictEqual(lodForList(60, D, -1), 1);
assert.strictEqual(lodForList(200, D, -1), 2, '最後のしきい値より遠いと最終段');
// ヒステリシス：境界を往復しても段が張り付く
assert.strictEqual(lodForList(36, D, 0, 8), 0, '境界 +4m ではまだ近景');
assert.strictEqual(lodForList(42, D, 0, 8), 1, '境界 +10m で中景へ落ちる');
assert.strictEqual(lodForList(28, D, 1, 8), 1, '戻るには内側の境界まで近づく');
assert.strictEqual(lodForList(22, D, 1, 8), 0);
{
  let cur = 0, flips = 0;
  for (let pass = 0; pass < 6; pass++) {
    const seq = pass % 2 ? [40, 38, 36, 34, 32] : [32, 34, 36, 38, 40];
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
/* 管ジオメトリ（稈・茎）も持たない。稈も穂も輪生葉もテクスチャに描き込む。
   実測した現実の密度を出すには 1 株 10 三角ていどまで落とす必要がある */
assert.doesNotMatch(wp, /function tube\(/, '管ジオメトリは持たない');
assert.doesNotMatch(wp, /function curvePts\(/, '中心線の生成も不要');
assert.match(wp, /culms: \[5, 8\], plumes: \[2, 4\],/,
  'the reed culms and panicles must be painted into the texture');
assert.match(wp, /function paintSprig\(/, 'クロモの小枝もテクスチャに描く');
assert.match(wp, /const CARDS_PER_LOD = \[3, 2, 1\];/,
  '遠景でもカードは 1 枚残す（0 枚だと真横から株が消える）');

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
  for (const kind of ['reed', 'manomo', 'tuft', 'hydrilla']) {
    // 種のブロック（次の }, まで）の中から h を拾う。コメントが入っても壊れないように
    const blk = cfg.match(new RegExp(`${kind}: \\{([\\s\\S]*?)\\n {4}\\},`));
    const hm = blk && blk[1].match(/h: ([\d.]+)/);
    assert.ok(hm, `${kind} の h が読めない`);
    const want = 1 / parseFloat(hm[1]);
    assert.ok(Math.abs(aspects[kind] - want) < 1e-9,
      `${kind}: BLADE_ASPECT ${aspects[kind]} とテクスチャ縦横比 ${want} が一致しない`);
  }
}

/* LOD をまたいでも同じ株のまま：設計図を 1 回引いて 2 段を起こす */
assert.match(wp, /const plan = planFor\(name, makeRng\(.*\);\s*\n\s*for \(let lod = 0; lod < tiers; lod\+\+\) \{/,
  'every tier must be emitted from one plan so the plant does not change shape');
assert.match(wp, /const n = CARDS_PER_LOD\[Math\.min\(lod, CARDS_PER_LOD\.length - 1\)\];/,
  '段で変わるのはカード枚数だけ。大きさは設計図のまま');
/* 枚数が変わっても «向き» は変わらないこと。
   az0 + (i/n)·π と割り直すと 3 枚 → 2 枚で全部の向きが変わり、
   近づいた瞬間に株の形が変わって見える。最大枚数ぶんの向きを先に決めて、
   段はその先頭何枚かを取る（少ないほうが多いほうの部分集合になる） */
assert.match(wp, /spreadOrder\(nMax\)\.slice\(0, n\)/,
  '段ごとにカードの向きを割り直してはいけない');
assert.match(wp, /az0: plan\.az \+ \(k \/ nMax\) \* Math\.PI/,
  '向きは最大枚数で割ること（段の枚数で割ると段ごとにずれる）');

/* クロモは水中プロップと同じマテリアル＝流れの揺れ・caustics・距離間引き */
assert.match(uwp, /export function patchUwMaterial\(/, 'patchUwMaterial が公開されていること');
assert.match(wp, /\[\(m\) => uw\(m, 5\.4\), fade\]\);/,
  'クロモは水中マテリアル（流れの揺れ・caustics・距離間引き）で、揺れは大きく取る');
/* 段の切り替わりは境界の前後でディザのクロスフェード */
assert.match(wp, /export const PLANT_FADE_BAND = 8;/);
assert.match(wp, /fadeBand: PLANT_FADE_BAND/, '両方の LodInstances に帯を渡すこと');

/* 抽水植物は水面をまたぐので «風で揺れる» と «水面下だけ caustics» の両方 */
// パッチの合成は materialPatch.js に共通化した（木と水草で同じ問題）
const mpatch = read('src/materialPatch.js');
assert.match(mpatch, /export function applyPatches\(mat, patches\) \{/,
  'onBeforeCompile を上書きし合わないよう合成すること');
assert.match(wp, /import \{ applyPatches, lodDitherFade \} from '\.\/materialPatch\.js/,
  '水草も共通の合成を使う');
assert.match(wp, /bladeBase\(this\.bladeTex\.reed\)\), \[wind\(reedWind\), caust, fade\]\)/,
  'ヨシは風と caustics の両方');
assert.match(wp, /bladeBase\(this\.bladeTex\.manomo\)\), \[wind\(manomoWind\), caust, fade\]\)/,
  'マコモも同様');

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

/* 密度：現実のヨシ原は 50〜200 稈/m2。1 株が «葉の束» なので株数はそれより
   ずっと少なくて済むが、0.2 株/m2 では明らかにスカスカだった。
   実測した生育可能面積に対して 1 株/m2 を下回らないこと */
{
  const AREA = { reed: 5982, manomo: 2780, hydrilla: 10539 };   // Node で実測
  const m = terrain.match(/const PLANT = \{([\s\S]*?)\};/);
  assert.ok(m, 'PLANT が読めない');
  for (const [kind, area] of Object.entries(AREA)) {
    const nm = m[1].match(new RegExp(`${kind}: Math\\.round\\((\\d+) \\* plantScale\\)`));
    assert.ok(nm, `${kind} の株数が読めない`);
    const dens = parseInt(nm[1], 10) / area;
    assert.ok(dens > 1.0,
      `${kind}: ${dens.toFixed(2)} 株/m2 では «わしゃわしゃ» にならない（1.0 以上必要）`);
  }
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
assert.match(li, /if \(l !== it\.lod \|\| l2 !== it\.lod2\) \{ it\.lod = l; it\.lod2 = l2; changed = true; \}/,
  '変化がなければ再アップロードしない');
assert.match(li, /if \(!list\) continue;\s*\/\/ 最終段より遠い＝描かない/,
  '最終段より遠い株は描かない');
// tintAt は純粋な数学なので THREE 非依存の util.js に置く（テストから呼べる）
assert.match(li, /export \{ tintAt \} from '\.\/util\.js/, '株ごとの色ムラ');

console.log('water-plant-test: ok');
