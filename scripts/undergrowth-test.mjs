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

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const src = read('src/undergrowth.js');
const terrain = read('src/terrain.js');

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
assert.match(src, /fadeBand: UNDER_FADE_BAND/);
assert.match(src, /lodDitherFade\(m, UNDER_FADE_BAND\)/,
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

console.log('undergrowth-test: ok');
