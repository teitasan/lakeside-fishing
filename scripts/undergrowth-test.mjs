/**
 * 下草（低木・シダ・草の塊）の検査。
 *
 * ここは «森の中に見えるか» を決める層で、木の本数より効く。目の高さから
 * 下が空だと、いくら木を増やしても地面と幹の境目がそのまま見えてしまう。
 *
 * ジオメトリ生成は THREE を要るので、ここで見るのは寸法の整合と
 * «一度踏んだ罠» が戻っていないことの 2 つ。
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { spreadOrder } from '../src/util.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const src = read('src/undergrowth.js');
const terrain = read('src/terrain.js');
const wp = read('src/waterPlants.js');

/* 水草と陸草でフェード幅がずれると、同じ距離帯でも陸草だけ薄くなって
   チカチカして見える。共通定数を使い、切替条件とディザの幅を揃える。 */
{
  assert.match(wp, /export const PLANT_FADE_BAND = (\d+);/);
  assert.match(src, /PLANT_FADE_BAND/, '陸草も水草と共通のフェード幅を使うこと');
  assert.doesNotMatch(src, /export const UNDER_FADE_BAND/, '陸草専用のフェード幅を残さないこと');
  assert.match(src, /fadeBand: PLANT_FADE_BAND/);
  assert.match(src, /lodDitherFade\(m, PLANT_FADE_BAND\)/,
    '陸草の LOD ディザにも水草と同じフェード幅を使うこと');
  assert.match(src, /import \{[\s\S]*PLANT_FADE_BAND,[\s\S]*\} from '\.\/waterPlants\.js/,
    '陸草が水草の共通定数を import していること');
}

/* vertexColors を立てたら color 属性は必須。
   無いと WebGL の既定値 (0,0,0) が掛かって株が «真っ黒» になる。
   実際にこれで一度全部黒くなった。木の葉が無事だったのは color を
   持っていたからで、幹が無事だったのは vertexColors が false だったから。 */
{
  assert.match(src, /vertexColors: true/, '株ごとの色ムラには vertexColors が要る');
  assert.match(src, /setAttribute\('color'/,
    'vertexColors: true なら color 属性を入れること（無いと真っ黒になる）');
  assert.ok(
    src.indexOf("setAttribute('color'") < src.indexOf('return geo;'),
    'color 属性はジオメトリを返す前に入れること',
  );
}

/* 段のクロスフェード。fadeBand を渡したらマテリアル側に
   lodDitherFade を入れないと、帯の中で 2 段ぶんが同時に不透明で描かれて
   株が二重に見える */
assert.match(src, /fadeBand: PLANT_FADE_BAND/);
assert.match(src, /lodDitherFade\(m, PLANT_FADE_BAND\)/,
  'fadeBand を使うならディザも入れること');

// カードは表裏 2 枚ぶん索引する作り（水草と共通）。DoubleSide は使わない
assert.match(src, /side: THREE\.FrontSide/);
assert.doesNotMatch(src, /THREE\.DoubleSide/,
  'DoubleSide だと裏から見た面の法線が反転して黒くなる');

/* 描かれるのは最終しきい値まで。段を 2 つしか登録しないので、
   それより遠い株はバケツが無く描かれない（撒く範囲もそこに合わせる） */
{
  const m = src.match(/export const UNDER_LOD = \[(\d+), (\d+)\]/);
  assert.ok(m, 'UNDER_LOD が読めない');
  const far = Number(m[2]);
  assert.ok(far >= 30 && far <= 80, `下草の描画距離が極端 (${far}m)`);
  assert.match(src, /lod < UNDER_LOD\.length/, '段は UNDER_LOD の数だけ登録すること');
  // 撒く帯が描画距離より十分広いこと（帯の外に立つと «草が無い» のが見える）
  const band = terrain.match(/const dist = rr - 8 \+ rng\(\) \* (\d+)/);
  assert.ok(band, '下草を撒く帯が読めない');
  assert.ok(Number(band[1]) > far * 2,
    `撒く帯 ${band[1]}m が描画距離 ${far}m に対して狭い`);
}

// 風で揺れること。動かない草は «貼った絵» に見える
assert.match(src, /opts\.addWindSway/, '下草も風で揺らすこと');
assert.match(terrain, /this\.undergrowth = new Undergrowth\(this\.scene, \{[\s\S]{0,120}addWindSway/,
  'terrain が addWindSway を渡していない');
assert.match(terrain, /this\.undergrowth\?\.update\(dt, cameraPos\)/,
  '毎フレームの LOD 振り直しに入っていない');

// 砂浜と崖には生えない
assert.match(terrain, /if \(h < 0\.9 \|\| this\.slopeAt\(x, z\) > 0\.9\) continue;/,
  '砂浜・崖を除外していない');

/* 段が変わったときにカードの «向き» が変わらないこと。
   az0 + (i/n)·π と割り直すと 5 枚 → 3 枚で全部の向きが変わって、
   ディザで混ぜても «形が変わった» のが分かる。これが
   「近づいたら急に見た目が変わる」の正体だった。 */
{
  for (const n of [2, 3, 4, 5, 8]) {
    const o = spreadOrder(n);
    assert.strictEqual(o.length, n, `spreadOrder(${n}) の長さ`);
    assert.strictEqual(new Set(o).size, n, `spreadOrder(${n}) に重複がある`);
    assert.ok(o.every((k) => k >= 0 && k < n), `spreadOrder(${n}) が範囲外`);
    // 先頭から取っても散ること：先頭 2 枚が輪の上で 1 歩隣どうしにならない
    if (n >= 4) {
      const d = Math.min(Math.abs(o[0] - o[1]), n - Math.abs(o[0] - o[1]));
      assert.ok(d >= Math.floor(n / 3), `spreadOrder(${n}) の先頭 2 枚が寄っている`);
    }
    // 少ない段の向きが、多い段の «部分集合» になっていること
    for (let take = 1; take < n; take++) {
      const few = new Set(o.slice(0, take));
      assert.ok([...few].every((k) => o.includes(k)), '部分集合になっていない');
    }
  }
  // 3 枚のときは 0,1,2 のまま＝近景の見た目を変えずに導入できる
  assert.deepStrictEqual(spreadOrder(3), [0, 1, 2]);
}
assert.match(src, /spreadOrder\(nMax\)/, '段ごとに向きを割り直してはいけない');
assert.doesNotMatch(src, /n: Math\.max\(1, n - s\), az0: rng\(\)/,
  '旧実装（段ごとに n で割り直す）が残っている');
// 水草も同じ作りなので同じ罠を踏む
{
  assert.match(wp, /spreadOrder\(nMax\)\.slice\(0, n\)/,
    '水草も段ごとに向きを割り直さないこと');
}

console.log('undergrowth-test: ok');
