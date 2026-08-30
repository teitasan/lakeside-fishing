#!/usr/bin/env node
/* 植生（ブナ・スギ）の骨格生成と LOD 振り分けの回帰テスト */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { growTree, SPECIES, SPECIES_IDS, lodFor, LOD_DIST } from '../src/treeSkeleton.js';
import { makeRng } from '../src/util.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

/* ---------------- 樹種 ---------------- */
assert.deepStrictEqual(SPECIES_IDS, ['beech', 'cedar'], 'ブナとスギの 2 種');

/* ---------------- 骨格 ---------------- */
const stats = {};
for (const kind of SPECIES_IDS) {
  let branches = 0, leaves = 0, height = 0, crownR = 0, minR = Infinity;
  const N = 12;
  for (let i = 0; i < N; i++) {
    const t = growTree(kind, makeRng(0x1234 + i * 977));
    branches += t.branches.length;
    leaves += t.leaves.length;
    height += t.height;
    crownR += t.crownR;
    for (const b of t.branches) for (const p of b.points) minR = Math.min(minR, p.r);
    // 折れ線はどれも 2 点以上ないとチューブが作れない
    for (const b of t.branches) assert.ok(b.points.length >= 2, `${kind}: 枝の点が足りない`);
    // 座標が NaN / Infinity になっていない（正規化で 0 割りすると全部飛ぶ）
    for (const l of t.leaves) {
      assert.ok(Number.isFinite(l.x + l.y + l.z + l.size), `${kind}: 葉の座標が有限でない`);
      assert.ok(Math.abs(Math.hypot(l.dx, l.dy, l.dz) - 1) < 1e-6, `${kind}: 葉の向きが単位ベクトルでない`);
    }
    assert.ok(t.height > 1, `${kind}: 樹高が 0 だと正規化で発散する`);
  }
  stats[kind] = {
    branches: branches / N, leaves: leaves / N, height: height / N,
    crownR: crownR / N, minR,
  };
}

/* 樹形：スギは細い円錐、ブナは広い盃状。
   ここが崩れると「同じ木を 2 色で塗っただけ」になる */
const beech = stats.beech, cedar = stats.cedar;
const beechRatio = beech.crownR / beech.height;
const cedarRatio = cedar.crownR / cedar.height;
assert.ok(beechRatio > 0.30 && beechRatio < 0.55,
  `ブナの樹冠は樹高の 0.30〜0.55 倍であるべき（実測 ${beechRatio.toFixed(2)}）`);
assert.ok(cedarRatio > 0.12 && cedarRatio < 0.28,
  `スギの樹冠は樹高の 0.12〜0.26 倍であるべき（実測 ${cedarRatio.toFixed(2)}）`);
assert.ok(beechRatio > cedarRatio * 1.5,
  'ブナの樹冠はスギよりはっきり広くないと 2 種を分けた意味がない');
assert.ok(cedar.height > beech.height, 'スギのほうが高い');

/* スギは主幹が頂まで抜ける（excurrent）。
   幹の折れ線の最高点が樹高のほとんどを占めることで確認する */
for (let i = 0; i < 6; i++) {
  const t = growTree('cedar', makeRng(0x5150 + i * 31));
  const trunk = t.branches.find((b) => b.level === 0);
  const trunkTop = Math.max(...trunk.points.map((p) => p.y));
  assert.ok(trunkTop > t.height * 0.86,
    `スギの主幹は頂近くまで伸びるべき（幹 ${trunkTop.toFixed(1)}m / 樹高 ${t.height.toFixed(1)}m）`);
}
/* ブナは低い位置で分岐して主幹が頂まで届かない（decurrent） */
{
  let below = 0;
  for (let i = 0; i < 12; i++) {
    const t = growTree('beech', makeRng(0x9001 + i * 17));
    const trunk = t.branches.find((b) => b.level === 0);
    const trunkTop = Math.max(...trunk.points.map((p) => p.y));
    if (trunkTop < t.height * 0.82) below++;
  }
  assert.ok(below >= 10, 'ブナは主幹が頂まで届かず、枝が樹冠を作るべき');
}

/* 半径が 0 以下だとチューブが潰れて法線が NaN になる */
assert.ok(stats.beech.minR > 0 && stats.cedar.minR > 0, '枝の半径は必ず正');

/* 決定論：同じ seed なら同じ木。地形と同じくワールドは seed から再現できる必要がある */
{
  const a = growTree('beech', makeRng(4242));
  const b = growTree('beech', makeRng(4242));
  assert.strictEqual(a.branches.length, b.branches.length);
  assert.strictEqual(a.leaves.length, b.leaves.length);
  assert.ok(Math.abs(a.height - b.height) < 1e-12, '同じ seed なら樹高も一致する');
}

/* ---------------- LOD ---------------- */
/* 近景 / 中景 / 遠景のしきい値。
   木が 28000 本になったので、近景を広く取ると «本気のジオメトリ» の
   本数が跳ねる（85m だと近景 300 本・中景 1100 本 = 12M 三角形）。
   足元は下草が埋めるので、ここは詰めて本数へ回す */
assert.deepStrictEqual(LOD_DIST, [58, 145], '近景 / 中景 / 遠景のしきい値');
// 初回（cur = -1）は外側の境界で判定される
const [E0, E1] = LOD_DIST;
assert.strictEqual(lodFor(E0 * 0.2, -1), 0);
assert.strictEqual(lodFor((E0 + E1) / 2, -1), 1);
assert.strictEqual(lodFor(E1 * 2, -1), 2);
/* ヒステリシス：境界上を往復しても LOD が張り付き、
   毎フレーム行列を作り直す羽目にならないこと。
   しきい値そのものは調整するので、境界からの «相対» で書く */
assert.strictEqual(lodFor(E0 + 4, 0), 0, '境界 +4m ではまだ近景に留まる');
assert.strictEqual(lodFor(E0 + 10, 0), 1, '境界 +10m で中景へ落ちる');
assert.strictEqual(lodFor(E0 - 4, 1), 1, '中景から近景へ戻るには内側の境界まで近づく必要がある');
assert.strictEqual(lodFor(E0 - 10, 1), 0);
{
  // 境界のすぐ外を 2m 刻みで往復させて、切り替わりが 1 回ずつしか起きないこと
  let cur = 0, flips = 0;
  const up = [E0, E0 + 2, E0 + 4, E0 + 6, E0 + 8];
  for (let pass = 0; pass < 6; pass++) {
    const seq = pass % 2 ? [...up].reverse() : up;
    for (const d of seq) {
      const l = lodFor(d, cur);
      if (l !== cur) flips++;
      cur = l;
    }
  }
  assert.strictEqual(flips, 0, '遊び幅の中で往復しても LOD は切り替わらない');
}

/* ---------------- 実装の要点をソースで固定 ---------------- */
const treesSrc = read('src/trees.js');
const terrainSrc = read('src/terrain.js');

// 枝のフレームは平行移動で運ぶ（各点で作り直すと樹皮が螺旋に捻れる）
assert.match(treesSrc, /N\.copy\(prevN\)\.addScaledVector\(T, -prevN\.dot\(T\)\);/,
  'branch frames must be parallel-transported, not rebuilt per point');
// 葉の法線は樹冠中心からの外向きが主（面法線のままだと板の集合に見える）
assert.match(treesSrc, /nrm\.copy\(outward\)\.multiplyScalar\(0\.78\)/,
  'leaf normals must be dominated by the outward canopy direction');
/* 風：近景は幹・枝と葉が同じ bend で動く。葉だけ動かすと、近くで見たとき
   葉が枝から剥がれて浮いて見える（実際にそう見えたので直した） */
assert.match(treesSrc, /const barkNear = applyPatches\(new THREE\.MeshStandardMaterial\(barkBase\), \[sway\(bend\), fade\]\);/,
  'the trunk and branches must bend with the same wind term as the leaves');
assert.match(treesSrc, /sway\(\{ \.\.\.bend, flutter:/,
  'near foliage must reuse the very same bend options as the bark');
/* 葉の法線は «樹冠中心からの外向き» を自分で入れてある。DoubleSide の
   法線反転は表裏で決まるので、放っておくと樹冠の奥側の葉が手前と同じだけ
   太陽を向き、暗い側が消えて葉群ぜんたいが白っぽく飛ぶ */
assert.match(treesSrc, /keepAuthoredNormals, translucency, fade,/,
  'foliage normals must not be flipped by which side is facing the camera');
assert.match(treesSrc, /\[keepAuthoredNormals, \(m\) => foliageTranslucency\(m, 0\.10\),/,
  'the far impostor billboard has authored normals too');
/* 反転を止めると樹冠に暗い側が戻るが、フィルが半球光だけだと日陰側が
   ほぼ黒に落ちる。実際の葉は薄いので裏から光が抜ける */
assert.match(treesSrc, /const translucency = \(m\) => foliageTranslucency\(m, 0\.14\);/,
  'shaded foliage must get the light that passes through a leaf');
{
  const mp = read('src/materialPatch.js');
  assert.match(mp, /totalEmissiveRadiance \+= diffuseColor\.rgb \*/,
    'translucency is added as an albedo-proportional term');
}
{
  const mp = read('src/materialPatch.js');
  assert.match(mp, /normal = normalize\( vNormal \);/,
    'the flip must be undone right after normal_fragment_begin');
}
/* 木ごとの色ムラは 1 を超えないこと。アルベド 1.2 は物理的にありえない
   反射率で、日向でトーンマップに飛ばされて葉が白く抜ける */
{
  const { tintAt } = await import('../src/util.js');
  let mx = 0, mn = 1;
  for (let i = 0; i < 4000; i++) {
    const t = tintAt(i * 0.37 - 500, i * 0.71 - 300, 0.26, 0.14);
    for (const c of [t.r, t.g, t.b]) { mx = Math.max(mx, c); mn = Math.min(mn, c); }
  }
  assert.ok(mx <= 1.0000001, `色ムラの最大が ${mx.toFixed(3)}。1 を超えると白く飛ぶ`);
  assert.ok(mn > 0.6 && mx > 0.95, `色ムラの幅が足りない（${mn.toFixed(2)}〜${mx.toFixed(2)}）`);
}
assert.match(treesSrc, /tintAt\(x, z, 0\.26, 0\.14\)/,
  'the per-tree tint span must stay where it was tuned');
assert.match(treesSrc, /const barkMid = lodDitherFade\(new THREE\.MeshStandardMaterial\(barkBase\), LOD_FADE_BAND\);/,
  'mid-range bark must be static: moving those vertices buys nothing past 34m');
assert.match(treesSrc, /\{ geo: b0, mat: barkNear, shadow: true \}/);
assert.match(treesSrc, /\{ geo: b1, mat: barkMid, shadow: false \}/);
// 揺れの時刻を進める対象に中景の幹が混ざっていないこと
assert.match(treesSrc, /this\.swayMaterials\.push\(barkNear, leafNear, leafMid\);/,
  'only the swaying materials may be ticked');
// 房の 4 頂点は同じ位相（頂点ごとに変えるとカードが引き伸ばされる）
assert.match(treesSrc, /flt\.push\(phase\);/,
  'all four corners of a foliage card must share one flutter phase');
assert.match(treesSrc, /geo\.setAttribute\('aFlutter'/,
  'the flutter phase must reach the shader as an attribute');

const terrainWind = read('src/terrain.js');
assert.match(terrainWind, /flutter = 0,/, 'addWindSway must expose an opt-in flutter band');
assert.match(terrainWind, /bendPow = 1,/, 'addWindSway must expose a bend exponent so trunks stay stiff');
assert.match(terrainWind, /attribute float aFlutter;/,
  'the flutter band must read the per-cluster phase attribute');
assert.match(terrainWind, /if \(u\.uWindFlutter\) u\.uWindFlutter\.value = m\.userData\._flutterBase \* windPow;/,
  'the flutter amplitude must follow the weather like the bend does');

// 中景の葉も十字のまま（1 枚板は真横から消えて樹冠に穴があく）
assert.match(treesSrc, /const l1 = buildLeaves\(skel, \{ stride: 7, sizeScale: 2\.5, cross: true \}\);/,
  'mid-range foliage must stay crossed or cards vanish edge-on');
/* しきい値はインスタンスが持つ（実機で負荷を見ながら振れるように）。
   モジュール定数を直接読むと terrain.setLodScale が効かない */
assert.match(treesSrc, /lodDist: \[\.\.\.LOD_DIST\], hysteresis: 8, interval: 0\.15, fadeBand: LOD_FADE_BAND,/,
  'the tree LOD thresholds must be per-instance so they can be swept at runtime');
assert.match(treesSrc, /get lodDist\(\) \{ return this\.set\.lodDist; \}/,
  '木も共通の LodInstances に載せる');
/* 段の切り替わりは «ジオメトリが差し替わる» ので、岩のように
   部分集合にできない木では形が飛ぶ。境界の前後で両方描いて
   画面空間のディザで入れ替える */
{
  const li = read('src/lodInstances.js');
  const mp = read('src/materialPatch.js');
  assert.match(mp, /export function lodDitherFade\(mat, band = 10\)/);
  assert.match(mp, /if \(vLodFade < 0\.999 && vLodFade <= lodIgn\(gl_FragCoord\.xy\)\) discard;/,
    'the fade must be a screen-space dither discard');
  assert.match(li, /for \(const lod of \[it\.lod, it\.lod2\]\) \{/,
    '帯の中は 2 段ぶん書き込むこと');
  assert.match(li, /function withLodBand\(geo, lo, hi\)/,
    '段の受け持ち範囲は頂点属性で渡す（マテリアルは段をまたいで共有する）');
  assert.match(treesSrc, /export const LOD_FADE_BAND = 12;/);
}
{
  const terr = read('src/terrain.js');
  assert.match(terr, /setLodScale\(scale = 1\) \{/, '近景の範囲を一括で振るノブ');
  assert.match(terr, /if \(!set\._lodBase\) set\._lodBase = \[\.\.\.set\.lodDist\];/,
    '基準値を保持して掛け直す（掛け続けて発散しないこと）');
}

// 木ごとの色ムラ（同じ緑が 900 本並ぶのを避ける）
{
  // 段の振り分けと色ムラは LodInstances に共通化した
  const li = read('src/lodInstances.js');
  assert.match(treesSrc, /this\.set\.add\(x, y, z, height, `\$\{kind\}\|\$\{variant\}`, ry, tintAt\(/,
    'each tree must get its own tint through instanceColor');
  assert.match(li, /if \(it\.tinted\) im\.setColorAt\(n, col\);/);
  assert.match(li, /if \(im\.instanceColor\) im\.instanceColor\.needsUpdate = true;/,
    'the instance colours must be re-uploaded after a LOD rebuild');
}
// 内側の房を暗くする擬似 AO
assert.match(treesSrc, /const ao = lerp\(0\.62, 1\.0, depth \* depth\);/,
  'inner foliage must be darkened or the canopy reads as cotton candy');
// インポスターはアルベドのみ（トーンマップを二重に掛けない）
assert.match(treesSrc, /renderer\.toneMapping = THREE\.NoToneMapping;/,
  'the impostor bake must disable tone mapping so it is not applied twice');
// 0x0 の描画バッファで render するとコンテキストごと固まる。
// サイズが付くまで焼かず、中景で代用しておくこと
assert.match(treesSrc, /ctx\.drawingBufferWidth < 8 \|\| ctx\.drawingBufferHeight < 8/,
  'the impostor bake must wait for a real drawing buffer');
assert.ok(treesSrc.indexOf('this._tryBake();') < treesSrc.indexOf('this.set.update(dt, cameraPos);'),
  'the deferred bake must be retried from the per-frame update');
assert.match(treesSrc, /MeshBasicMaterial/,
  'the impostor must be baked unlit so far trees still follow the time of day');
// 透明部分を黒で埋めると mipmap で葉の縁が煤ける
assert.match(treesSrc, /renderer\.setClearColor\(clearColor, 0\);/,
  'the impostor must clear to the foliage colour so mipmaps do not bleed black');
// LOD をまたいでも同じ骨格を使う（またぐたびに形が変わると木が入れ替わって見える）
assert.match(treesSrc, /const skel = growTree\(/);
assert.ok(
  treesSrc.indexOf('const b0 = buildBranches(skel') > treesSrc.indexOf('const skel = growTree('),
  'every LOD must be derived from one skeleton per (species, variant)');
assert.doesNotMatch(treesSrc, /growTree\([^)]*\)[\s\S]{0,200}growTree\(/,
  'a variant must not regrow a different skeleton for another LOD');

// 旧実装（円柱＋円錐 2 段）が残っていないこと
assert.doesNotMatch(terrainSrc, /const leafGeo = new THREE\.ConeGeometry/,
  'the old cone-tree must be gone');
assert.match(terrainSrc, /this\.treeSet = new TreeSet\(/, 'terrain must build trees through TreeSet');
assert.match(terrainSrc, /updateTrees\(dt, cameraPos\)/, 'terrain must expose a per-frame LOD update');

const gameSrc = read('src/game.js');
assert.match(gameSrc, /this\.terrain\.updateTrees\(dt, this\.camera\.position\);/,
  'the LOD update must run every frame, and on real dt so it keeps working while paused');
assert.match(gameSrc, /renderer: this\.renderer,/,
  'the renderer must reach Terrain so impostors can be baked at load');

/* 枠が足りないときは «捨てる» のではなく «広げる»。
   クロスフェードで境界の帯にいる株は 2 段ぶん枠を食うので、登録時の枠だと
   足りなくなる。以前は溢れたぶんを黙って捨てていて、捨てられる株がカメラの
   位置で変わるため «近づくと草が消え、視点を振ると戻る» という見え方をした。 */
const lodSrc = read('src/lodInstances.js');
assert.match(lodSrc, /_demand\(\)\s*\{/, 'rebuild は書き込む前に必要数を数えること');
assert.match(lodSrc, /_grow\(im, need\)/, '足りない段は枠を張り替えること');
assert.ok(
  lodSrc.indexOf('const demand = this._demand();') < lodSrc.indexOf('im.setMatrixAt(n, m);'),
  '必要数を数えるのは書き込みより前でなければ意味がない',
);
assert.match(lodSrc, /GROW_LIMIT = \d+/, '青天井に確保しないよう上限を持つこと');

/* 樹皮は «全長を貫く縦縞» を作らないこと。円柱に巻くと縞が陰影に見えて、
   幹が縦に凹んで見える（照明を外しても暗いままなので照明の問題ではない）。 */
const barkSrc = treesSrc.slice(
  treesSrc.indexOf('export function makeBarkTexture'),
  treesSrc.indexOf('/* ---------------- 葉テクスチャ'),
);
assert.doesNotMatch(barkSrc, /fillRect\(xx, 0, w, size\)/,
  '全高を貫く縦縞は幹の «溝» に見える');
assert.match(barkSrc, /flattenBarkShading\(g, size\)/,
  '低周波の明暗を均さないと、うねりが円柱の陰影に化ける');
assert.match(treesSrc, /function flattenBarkShading/);
assert.match(treesSrc, /boxBlurWrap\(luma, size/,
  'ぼかしはタイル境界をまたぐこと（またがないと縁だけ均され方が変わる）');

console.log('tree-test: ok');
console.log(`  ブナ 枝${beech.branches.toFixed(0)} 葉${beech.leaves.toFixed(0)} ` +
  `樹高${beech.height.toFixed(1)}m 樹冠${beech.crownR.toFixed(1)}m (比 ${beechRatio.toFixed(2)})`);
console.log(`  スギ 枝${cedar.branches.toFixed(0)} 葉${cedar.leaves.toFixed(0)} ` +
  `樹高${cedar.height.toFixed(1)}m 樹冠${cedar.crownR.toFixed(1)}m (比 ${cedarRatio.toFixed(2)})`);
