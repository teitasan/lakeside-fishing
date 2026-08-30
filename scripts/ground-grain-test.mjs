/**
 * 地面の «粒»（砂利・砂）テクスチャの検査。
 *
 * 砂浜や湖底は fbm だけだと «塗った面» に見える。石を 1 つずつドームとして
 * 置いた高さ場から法線・遮蔽・粗さを焼くことで、実際の 3D 石を数十個しか
 * 置かなくても «石が敷き詰まっている» 密度が出る。ここではその高さ場が
 * (1) 継ぎ目なくタイルすること (2) 同じ種から必ず同じものが出ること
 * (3) 砂利と砂で粒の大きさがちゃんと違うこと、を押さえる。
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { makeTileablePebbleField } from '../src/tileableNoise.js';

const GRAVEL = { count: 300, rMin: 0.018, rMax: 0.11, flat: 0.74, grain: 0.16, grainFreq: 30, aoRadius: 0.055 };
const SAND = { count: 900, rMin: 0.006, rMax: 0.017, flat: 0.50, grain: 0.55, grainFreq: 44, aoRadius: 0.020 };

const N = 256;
const gravel = makeTileablePebbleField(N, 0x9a31c4, GRAVEL);
const sand = makeTileablePebbleField(N, 0x4c7215, SAND);

for (const [name, f] of [['砂利', gravel], ['砂', sand]]) {
  assert.strictEqual(f.h.length, N * N, `${name}: 高さ場の大きさ`);
  let min = 1, max = 0;
  for (const v of f.h) { if (v < min) min = v; if (v > max) max = v; }
  assert.ok(min >= 0 && max <= 1, `${name}: 高さが 0〜1 に収まる`);
  assert.ok(max - min > 0.9, `${name}: 高さの幅が足りない (${(max - min).toFixed(2)})`);

  // 遮蔽が «全部同じ» だと石の間が締まらず、平らに見えてしまう
  let ao = 0;
  for (const v of f.ao) ao += v;
  ao /= f.ao.length;
  let dev = 0;
  for (const v of f.ao) dev += (v - ao) * (v - ao);
  dev = Math.sqrt(dev / f.ao.length);
  assert.ok(dev > 0.08, `${name}: 遮蔽の散らばりが小さすぎる (${dev.toFixed(3)})`);

  // タイルの継ぎ目。左端と右端の差が «隣どうしのテクセル差» を超えなければ
  // 目地として見えることはない
  let seam = 0, neighbour = 0;
  for (let y = 0; y < N; y++) {
    seam = Math.max(seam, Math.abs(f.h[y * N] - f.h[y * N + N - 1]));
    seam = Math.max(seam, Math.abs(f.h[y] - f.h[(N - 1) * N + y]));
    for (let x = 1; x < N; x++) {
      neighbour = Math.max(neighbour, Math.abs(f.h[y * N + x] - f.h[y * N + x - 1]));
    }
  }
  assert.ok(seam <= neighbour * 1.2,
    `${name}: タイル境界に段差 (継ぎ目 ${seam.toFixed(3)} > 隣接 ${neighbour.toFixed(3)})`);
  console.log(`  ${name.padEnd(3)} 遮蔽 平均 ${ao.toFixed(2)} ばらつき ${dev.toFixed(3)}  継ぎ目 ${seam.toFixed(3)} / 隣接 ${neighbour.toFixed(3)}`);
}

/* 石ごとの色味。全部が同じ明るさだと «型押しした砂» に見える。
   砂利のタイルは石が敷き詰まるので、面積の大半に色味が入るのが正しい */
{
  let cov = 0, sum = 0, lo = 1, hi = 0;
  for (const v of gravel.tint) if (v > 0) { cov++; sum += v; lo = Math.min(lo, v); hi = Math.max(hi, v); }
  assert.ok(cov / gravel.tint.length > 0.8, `砂利: 石の被覆が低い (${(cov / gravel.tint.length).toFixed(2)})`);
  assert.ok(hi - lo > 0.55, `砂利: 石ごとの色味に幅がない (${(hi - lo).toFixed(2)})`);
  console.log(`  砂利  石の被覆 ${(cov / gravel.tint.length).toFixed(2)}  色味 ${lo.toFixed(2)}〜${hi.toFixed(2)}`);
}

// 同じ種なら毎回同じ。地面と 3D 石の «整合» はこれが前提
const again = makeTileablePebbleField(N, 0x9a31c4, GRAVEL);
for (let i = 0; i < gravel.h.length; i++) {
  assert.strictEqual(again.h[i], gravel.h[i], '同じ種で違う結果が出た');
}

/* 粒の «細かさ» を、符号が変わる回数で測る。砂は 0.30m、砂利は 1.1m で
   タイルするので、テクセルあたりの実寸は砂のほうが 3.7 倍細かい。
   同じ 256px なら砂利のほうが «滑らか» に見えるのが正しい */
function crossings(f) {
  let mean = 0;
  for (const v of f.h) mean += v;
  mean /= f.h.length;
  let c = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 1; x < N; x++) {
      if ((f.h[y * N + x] > mean) !== (f.h[y * N + x - 1] > mean)) c++;
    }
  }
  return c / (N * N);
}
const cg = crossings(gravel), cs = crossings(sand);
assert.ok(cs > cg * 1.5, `砂のほうが粒が細かいはず (砂利 ${cg.toFixed(3)} / 砂 ${cs.toFixed(3)})`);

// 地面側のシェーダが «陸にも» 粒を掛けていること。
// 以前は湖底だけに掛けていて、乾いた砂浜がのっぺりしたままだった
const terrain = readFileSync(new URL('../src/terrain.js', import.meta.url), 'utf8');
for (const need of [
  'createGroundDetailTexture',
  'uGroundGravel',
  'uGroundSand',
  'void groundDetail(',
  'gView * (gGroundW.x * 0.40)',      // 法線
  'grainAo * gGravelTint',            // 遮蔽（視差の沈み込みから）
  'gGround.a, gGroundW.x',            // 粗さ
  'gGravelTint',                      // 石ごとの色味
  'uGroundFade',                      // 遠景でのちらつき止め
  /* 視差オクルージョン。地面はほぼ水平で模様が world.xz なので、
     接空間は «接 +X / 従接 +Z / 法線 +Y» と決まる。接線を持たない
     地形メッシュでも解ける、というのがこの実装の肝 */
  'vec3 pomTrace(',
  'void groundParallax(',
  '-(V.xz / max(V.y, 0.30)) * depth',   // 視線と «逆» へずらす
  'off -= dOff * (1.0 - t);',           // 最後の 1 歩を詰める（縞防止）
  'uPomFade',                           // 効かない距離では回さない
]) {
  assert.ok(terrain.includes(need), `terrain.js に ${need} がない`);
}
// groundDetail は under（水中）で割らずに呼ぶ。陸にも効かせるため
const call = terrain.slice(terrain.indexOf('groundDetail(vBedWorldPos'), terrain.indexOf('groundDetail(vBedWorldPos') + 60);
assert.ok(!call.includes('under'), '粒が水中だけに掛かっている');

/* 視差のずれは «アルベドにも» 掛けること。
   法線だけずらすと «凹凸は動くのに絵が動かない» という一番不自然な絵になる */
assert.match(terrain, /vec2 pxz = wp\.xz \+ gPomOff;/, '粒に視差が掛かっていない');
assert.match(terrain, /vec2 xz = wp\.xz \+ gPomOff;/, 'アルベドに視差が掛かっていない');
/* 順番：視差 → アルベド → 粒。アルベドより後に決めても間に合わない */
assert.ok(
  terrain.indexOf('groundParallax(vBedWorldPos, vBed);')
  < terrain.indexOf('diffuseColor.rgb = applyLandAlbedo('),
  '視差はアルベドより先に決めること',
);
// 品質を落としたら回さない（ステップ 0 で素通り）
assert.match(terrain, /if \(uPom\.z < 0\.5\) return;/, '低品質で視差を切れない');
assert.match(terrain, /q === 'low' \? 0 :/, '低品質のステップ数が 0 でない');
// 効かない距離まで回さない（fbm を含む重い経路に入る前に距離で切る）
assert.ok(
  terrain.indexOf('if (pf < 0.01) return;') < terrain.indexOf('float g = gravelMix(wp, bedKind);'),
  '距離で切るより先に fbm を回している',
);

/* 視差の «効き終わり» でプレイヤーを中心とした円が出ないこと。
   遮蔽の式を step で切り替えると 15m のところに輪がはっきり出る。
   重み（距離フェード）で連続に混ぜ、平均も揃えておく必要がある */
assert.doesNotMatch(terrain, /step\(0\.001, gPomSink\)/,
  '遮蔽を step で切り替えている（フェード端に円が出る）');
assert.match(terrain, /1\.21 - gPomSink \* 0\.52, gPomW\);/,
  '遮蔽を視差の効き具合で連続に混ぜていない');
assert.match(terrain, /gPomW = pf;/, '視差の効き具合を持っていない');
assert.match(terrain, /gPomSink = r\.z;/,
  '沈み込みに距離フェードを掛けてしまっている（二重に掛かる）');

console.log('ground-grain-test: ok');
console.log(`  粒の細かさ 砂利 ${cg.toFixed(3)} / 砂 ${cs.toFixed(3)}`);
