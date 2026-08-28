#!/usr/bin/env node
/* 岩の形状生成と、大きさによる作り分けの回帰テスト。
   rocks.js は three を import するので、数値の検証は THREE 非依存の
   rockShape.js に対して行い、残りはソースの不変条件で固定する。 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  makeNoise3D, icosphere, makeRockShape, ROCK_PRESETS, ROCK_KINDS,
} from '../src/rockShape.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

/* ---------------- 3D ノイズ ---------------- */
{
  const n = makeNoise3D(42);
  let mn = 1, mx = -1;
  for (let i = 0; i < 4000; i++) {
    const v = n(i * 0.137, i * 0.271, i * 0.093);
    assert.ok(Number.isFinite(v), 'ノイズが有限でない');
    mn = Math.min(mn, v); mx = Math.max(mx, v);
  }
  assert.ok(mn < -0.2 && mx > 0.2, `振幅が足りない（${mn.toFixed(2)}〜${mx.toFixed(2)}）`);
  // 決定論：同じ seed なら同じ場
  const m = makeNoise3D(42);
  assert.strictEqual(n(1.3, -2.7, 0.4), m(1.3, -2.7, 0.4));
  assert.notStrictEqual(n(1.3, -2.7, 0.4), makeNoise3D(43)(1.3, -2.7, 0.4));
  // 岩肌は 3 次元。y を動かしたら値が変わること（2D ノイズの流用でないこと）
  assert.notStrictEqual(n(0.4, 0.2, 0.7), n(0.4, 1.9, 0.7));
}

/* ---------------- 基本形状 ---------------- */
for (const d of [0, 1, 2, 3]) {
  const { verts, faces } = icosphere(d);
  assert.strictEqual(faces.length, 20 * 4 ** d, `detail ${d} の面数`);
  // 分割した頂点はすべて単位球上（球面へ押し戻していること）
  for (const [x, y, z] of verts) {
    assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-9, '頂点が単位球上でない');
  }
  // 中点の共有：頂点数は V = 10*4^d + 2
  assert.strictEqual(verts.length, 10 * 4 ** d + 2,
    '中点が共有されていない（辺ごとに複製すると継ぎ目が割れる）');
}

/* ---------------- 岩の形 ---------------- */
assert.deepStrictEqual(ROCK_KINDS, ['boulder', 'rubble', 'slab', 'ledge'],
  '湖畔で使う 4 プリセット');

for (const kind of ROCK_KINDS) {
  for (const detail of [1, 2, 3]) {
    const r = makeRockShape(kind, 0x1234, { detail });
    assert.strictEqual(r.tris, 20 * 4 ** detail);
    assert.strictEqual(r.position.length, r.normal.length);
    assert.strictEqual(r.cavity.length, r.position.length / 3);

    let minY = Infinity, maxY = -Infinity, maxR = 0;
    for (let i = 0; i < r.position.length; i += 3) {
      const x = r.position[i], y = r.position[i + 1], z = r.position[i + 2];
      assert.ok(Number.isFinite(x + y + z), `${kind}: 座標が有限でない`);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      maxR = Math.max(maxR, Math.hypot(x, z));
    }
    /* 原点は «底面中央»、いちばん長い辺が 1 に正規化。配置側は地面の高さへ
       そのまま置き、scale をそのまま «岩の最大辺(m)» として使える。
       高さだけで正規化すると、横に 2.4 倍広い slab が巨石になる */
    let bx = 0, bz = 0;
    {
      let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity;
      for (let i = 0; i < r.position.length; i += 3) {
        mnX = Math.min(mnX, r.position[i]); mxX = Math.max(mxX, r.position[i]);
        mnZ = Math.min(mnZ, r.position[i + 2]); mxZ = Math.max(mxZ, r.position[i + 2]);
      }
      bx = mxX - mnX; bz = mxZ - mnZ;
    }
    assert.ok(Math.abs(minY) < 1e-5, `${kind}: 底が y=0 でない（${minY}）`);
    const longest = Math.max(maxY, bx, bz);
    assert.ok(Math.abs(longest - 1) < 1e-5, `${kind}: 最大辺が 1 でない（${longest}）`);
    assert.ok(maxY > 0.18, `${kind}: 平たすぎて板に見える（高さ ${maxY.toFixed(2)}）`);
    assert.ok(maxR > 0.1 && maxR < 1.0, `${kind}: 平面方向の広がりが異常（${maxR}）`);

    // 法線は単位ベクトル
    for (let i = 0; i < r.normal.length; i += 3) {
      const l = Math.hypot(r.normal[i], r.normal[i + 1], r.normal[i + 2]);
      assert.ok(Math.abs(l - 1) < 1e-4, `${kind}: 法線が単位でない`);
    }
    // 窪みは 0..1 で、その岩の中で幅を持つこと（AO も苔も効かなくなる）
    let cmin = 1, cmax = 0, csum = 0;
    for (const c of r.cavity) { cmin = Math.min(cmin, c); cmax = Math.max(cmax, c); csum += c; }
    assert.ok(cmin >= 0 && cmax <= 1, `${kind}: 窪みが 0..1 の外`);
    if (detail >= 2) {
      const avg = csum / r.cavity.length;
      assert.ok(avg > 0.15 && avg < 0.75,
        `${kind}: 窪みの平均が ${avg.toFixed(2)}。偏ると AO も苔も出ない`);
      assert.ok(cmax - cmin > 0.6, `${kind}: 窪みに幅が無い`);
    }
    // 索引はすべて範囲内
    const vn = r.position.length / 3;
    for (const i of r.index) assert.ok(i >= 0 && i < vn, '索引が範囲外');
  }
}

/* 同じ seed / 違う detail は «同じ岩の粗い版»。
   LOD をまたいだ瞬間に別の岩へ入れ替わって見えないこと。
   重心と最大半径が近ければシルエットは保たれている */
for (const kind of ROCK_KINDS) {
  const stat = (detail) => {
    const r = makeRockShape(kind, 0x77, { detail });
    let cx = 0, cz = 0, maxR = 0;
    const n = r.position.length / 3;
    for (let i = 0; i < r.position.length; i += 3) {
      cx += r.position[i]; cz += r.position[i + 2];
      maxR = Math.max(maxR, Math.hypot(r.position[i], r.position[i + 2]));
    }
    return { cx: cx / n, cz: cz / n, maxR };
  };
  const a = stat(3), b = stat(1);
  assert.ok(Math.abs(a.maxR - b.maxR) / a.maxR < 0.35,
    `${kind}: detail を落としたら幅が ${(Math.abs(a.maxR - b.maxR) / a.maxR * 100).toFixed(0)}% 変わった`);
  assert.ok(Math.hypot(a.cx - b.cx, a.cz - b.cz) < 0.25,
    `${kind}: detail を落としたら重心がずれた`);
}

// 決定論：同じ seed なら同じ岩（ワールドは seed から再現できる必要がある）
{
  const a = makeRockShape('boulder', 999, { detail: 2 });
  const b = makeRockShape('boulder', 999, { detail: 2 });
  for (let i = 0; i < a.position.length; i++) {
    assert.strictEqual(a.position[i], b.position[i], '同じ seed なら同じ形');
  }
  const c = makeRockShape('boulder', 1000, { detail: 2 });
  let same = true;
  for (let i = 0; i < a.position.length; i++) if (a.position[i] !== c.position[i]) same = false;
  assert.ok(!same, 'seed を変えたら形が変わること');
}

/* プリセットは «別の岩» として区別が付くこと。
   slab は平たい（同じ高さに対して幅が広い）、rubble は角が立つ */
{
  // 幅 / 高さ の比。最大辺で正規化してあるので «比» で見る
  const width = (kind) => {
    let acc = 0;
    for (let s = 0; s < 4; s++) {
      const r = makeRockShape(kind, 100 + s * 31, { detail: 2 });
      let mx = 0, my = 0;
      for (let i = 0; i < r.position.length; i += 3) {
        mx = Math.max(mx, Math.hypot(r.position[i], r.position[i + 2]));
        my = Math.max(my, r.position[i + 1]);
      }
      acc += mx / my;
    }
    return acc / 4;
  };
  const slab = width('slab'), boulder = width('boulder');
  assert.ok(slab > boulder * 1.25,
    `slab は板状であるべき（幅/高さ slab ${slab.toFixed(2)} / boulder ${boulder.toFixed(2)}）`);
  assert.ok(ROCK_PRESETS.rubble.chip > ROCK_PRESETS.boulder.chip * 1.8,
    'rubble は boulder より強く角が欠けること');
  assert.ok(ROCK_PRESETS.slab.erosion.passes > ROCK_PRESETS.rubble.erosion.passes,
    'slab は侵食が進んで上面が座っていること');
}

/* LOD の各段は «同じ頂点集合の部分». 段ごとに工程を回し直すと角の欠けも
   熱侵食も結果が変わり、切り替わった瞬間に岩の形そのものが動く
   （実測で正規化後 0.026〜0.072 ＝ 4.6m の岩で 12〜33cm 動いていた） */
{
  const { makeRockLods } = await import('../src/rockShape.js');
  for (const kind of ROCK_KINDS) {
    const [fine, mid, coarse] = makeRockLods(kind, 0x77, { details: [3, 2, 1] });
    for (const lo of [mid, coarse]) {
      for (let i = 0; i < lo.position.length; i++) {
        assert.strictEqual(lo.position[i], fine.position[i],
          `${kind}: 粗い段の頂点が細かい段と一致しない（LOD の切り替わりで形が動く）`);
      }
      for (let i = 0; i < lo.cavity.length; i++) {
        assert.strictEqual(lo.cavity[i], fine.cavity[i], `${kind}: 窪みも引き継ぐこと`);
      }
    }
    assert.strictEqual(coarse.tris, 80);
    assert.strictEqual(mid.tris, 320);
  }
}

/* ---------------- 実装の不変条件 ---------------- */
const rocks = read('src/rocks.js');
const shape = read('src/rockShape.js');
const terrain = read('src/terrain.js');

/* 苔は焼かない。インスタンスごとにランダム回転させるので、
   ローカル法線で焼くと回転後に横面や下面へ苔が付く */
assert.doesNotMatch(shape, /moss/i, '苔は形状側に焼かないこと');
assert.match(rocks, /float up = smoothstep\(uMossParams\.y, uMossParams\.y \+ 0\.50, wn\.y\);/,
  'moss must be derived from the world normal, not baked per vertex');

/* 窪みは回転しても変わらない量なので、こちらは焼いてよい */
assert.match(shape, /export function vertexCavity\(/);
assert.match(rocks, /attribute float aCavity;/, '窪みは頂点属性で渡す');

/* triplanar：岩に UV を張るとどこかで必ず伸びる */
assert.match(rocks, /vec3 triplanar\(sampler2D tex, vec3 wp, vec3 wn, float scale\) \{/,
  'rocks must be textured triplanar');
// 岩に UV は付けない（球の展開は極で必ず伸びる）。属性そのものを見る
assert.ok(!('uv' in makeRockShape('boulder', 1, { detail: 1 })),
  '岩の形状は UV を返さないこと');
assert.doesNotMatch(rocks, /setAttribute\('uv'/, 'ジオメトリにも UV を付けない');

/* 法線は逆転置で運ぶ。異方スケールのインスタンスで素の行列を掛けると
   斜面の陰影がずれ、triplanar の混合比も狂う */
assert.match(rocks, /const lods = makeRockLods\(kind, seed/,
  'LOD はまとめて作る（段ごとに工程を回し直さない）');
assert.match(rocks, /vec3 rn = objectNormal \/ max\(sc \* sc, vec3\(1e-6\)\);/,
  'instance normals must use the inverse transpose approximation');

/* 濡れは水面（y=0）基準。水中は完全に濡れ、上は毛管ぶんだけ残す */
assert.match(rocks, /wet = max\(wet, step\(vRockWorldPos\.y, 0\.0\)\);/,
  'everything below the waterline must read as wet');
assert.match(rocks, /roughnessFactor = mix\(roughnessFactor, 0\.30, wet \* 0\.85\);/,
  '濡れた岩はつるつるになる');

/* 階層ごとに形の種をずらすこと。tier.length を種にしていたときは
   cobble も pebble も 6 文字なので、中石と小石が同じ 5 形状になっていた */
{
  const salts = [...rocks.matchAll(/salt: (0x[0-9a-f]+)/g)].map((m) => m[1]);
  assert.strictEqual(salts.length, 3, '階層ごとに salt を持つこと');
  assert.strictEqual(new Set(salts).size, 3, `salt が重複している: ${salts.join(', ')}`);
  assert.doesNotMatch(rocks, /tier\.length \* 0x51ed/,
    'tier.length を種にしてはいけない（cobble と pebble が同じ長さ）');
  assert.match(rocks, /makeRockLods\(kind, seed \^ \(0x9e37 \* \(va \+ 1\)\) \^ cfg\.salt,/);
}

/* 生成は «起動時に固定回数だけ»。インスタンスごとに作り直していないこと */
assert.match(rocks, /for \(let va = 0; va < ROCK_VARIANTS; va\+\+\) \{/);
assert.doesNotMatch(rocks, /add\([\s\S]{0,400}makeRock/,
  'add() の中で形を作ってはいけない（InstancedMesh で共有する）');

/* 大きさで作りを分ける（全部テクスチャでも全部ポリゴンでもない） */
assert.match(rocks, /boulder: \{ lodDist: \[60, 140, 320\], detail: \[3, 2, 1\], salt: 0x[0-9a-f]+ \}/);
assert.match(rocks, /cobble: \{ lodDist: \[40, 100\], detail: \[2, 1\], salt: 0x[0-9a-f]+ \}/);
assert.match(rocks, /pebble: \{ lodDist: \[34\], detail: \[1\], salt: 0x[0-9a-f]+ \}/,
  '小石は近距離だけ。遠くは地面テクスチャに任せる');
// 岩は板にしない（動かず、シルエットが単純で、半透明も細い枝も無い）
assert.doesNotMatch(rocks, /impostor|billboard/i, '岩はインポスターにしない');

/* 水際に寄せて置く。水面と交差する石は形そのものが景観に効く */
assert.match(terrain, /tier: 'boulder', n: ROCK\.boulder, inward: 26, outward: 12,/);
assert.match(terrain, /hMin: -2\.6, hMax: 13, size: \[1\.1, 4\.6\]/, '大岩は水面をまたぐ帯に置く');
assert.match(terrain, /this\.rockSet = new RockSet\(/);
assert.match(terrain, /this\.rockSet\?\.update\(dt, cameraPos\);/, '毎フレーム LOD を振り直す');
// 旧実装（正二十面体 1 個）が残っていないこと
assert.doesNotMatch(terrain, /const rockGeo = new THREE\.IcosahedronGeometry/,
  'the old single-icosahedron rock must be gone');

/* 小さい石ほど数が多いこと（大きい石が同じ数あると «巨石群» になる） */
{
  const m = terrain.match(/const ROCK = \{([\s\S]*?)\};/);
  assert.ok(m, 'ROCK が読めない');
  const num = (k) => {
    const t = m[1].match(new RegExp(`${k}: Math\\.round\\((\\d+) \\* rockScale\\)`));
    assert.ok(t, `${k} の数が読めない`);
    return parseInt(t[1], 10);
  };
  assert.ok(num('pebble') > num('cobble') && num('cobble') > num('boulder'),
    '小石 > 中石 > 大岩 の順に多いこと');
}

console.log('rock-test: ok');
for (const kind of ROCK_KINDS) {
  const r = makeRockShape(kind, 0x1234, { detail: 2 });
  let c = 0;
  for (const v of r.cavity) c += v;
  console.log(`  ${kind.padEnd(8)} ${String(r.tris).padStart(4)}tri  窪み平均 ${(c / r.cavity.length).toFixed(2)}`);
}
