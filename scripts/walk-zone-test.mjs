/**
 * 歩ける範囲（湖のまわりの帯）の検査。
 *
 * もとは「原点から 460m」で、汀線から 343m・61.3ha を歩けた。ところが
 * 飾ってあるのは下草が +110m、岩が +12m までで、そこから内陸は木が
 * 立っているだけの裸の地面だった。61.3ha を全部飾るより帯に絞るほうが
 * 釣りゲームとして正しい。
 *
 * 絞ると副産物として «絶対に近づけない木» が配置時に確定するので、
 * 静的なバケットへ回せる（毎フレームの距離判定にも行列の作り直しにも
 * 乗らないので、遠景の本数を塗りの費用だけで決められる）。
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const terrain = read('src/terrain.js');
const game = read('src/game.js');
const trees = read('src/trees.js');

/* --- 帯そのもの --- */
{
  const m = terrain.match(/export const WALK_INLAND = (\d+);/);
  assert.ok(m, 'WALK_INLAND が無い');
  const w = Number(m[1]);
  assert.ok(w >= 40 && w <= 120, `帯が極端 (${w}m)`);

  // 移動判定は «原点から» ではなく «汀線から» で切ること
  assert.match(game, /this\.terrain\.shoreRadius\(nx, nz\) \+ WALK_INLAND/,
    '移動制限が汀線基準になっていない');
  assert.doesNotMatch(game, /Math\.hypot\(nx, nz\) > 460/, '旧い «原点から 460m» が残っている');
  // 中を見に行けなくなると困るので、デバッグ中は素通りする
  assert.match(game, /!this\.debug\?\.enabled\s*\n\s*&& Math\.hypot\(nx, nz\)/,
    'デバッグ中も帯で止まってしまう');

  /* 飾りは «帯 ＋ 見通し» を覆うこと。覆えていないと、歩ける場所なのに
     地面に何も無い一角ができる（これが元の症状） */
  const ug = terrain.match(/const dist = rr - 8 \+ rng\(\) \* (\d+);/);
  assert.ok(ug, '下草を撒く帯が読めない');
  assert.ok(Number(ug[1]) - 8 > w + 40,
    `下草の帯 ${ug[1]}m が歩ける ${w}m ＋ 見通しに足りない`);
  // 岩も内陸へ。汀線まわりだけだと林床に何も落ちていない
  assert.match(terrain, /inward: -8, outward: 130/, '林床の石が無い');
}

/* --- 境界の見せ方 --- */
assert.match(terrain, /this\.undergrowthCounts\.thicket = placed;/,
  '境界に藪が無い（見えない壁だけで止めている）');
assert.match(terrain, /this\.addObstacle\(x, z, 0\.55, h \+ height \* 0\.8\);/,
  '藪に当たり判定が無いと «茂みで止まった» ことにならない');

/* --- 遠景を静的に --- */
{
  assert.match(trees, /addFar\(x, y, z, height, kind, variant, ry\)/, 'TreeSet.addFar が無い');
  assert.match(trees, /buildFar\(\)/, 'TreeSet.buildFar が無い');
  assert.match(terrain, /this\.treeSet\.addFar\(/, '遠景の木を静的に回していない');
  assert.match(terrain, /this\.treeSet\.buildFar\(\);/, 'buildFar を呼んでいない');

  /* 近景と遠景で «本数» を分けること。一律に増やすと近景の密度まで上がって、
     林の中に立ったときの負荷がそのまま増える（移動制限は近景を軽くしない） */
  assert.match(terrain, /const treeNear = /, '近景の本数が独立していない');
  assert.match(terrain, /const treeFar = /, '遠景の本数が独立していない');
  const near = Number(terrain.match(/const treeNear = q === 'low' \? \d+ : q === 'high' \? (\d+)/)[1]);
  const far = Number(terrain.match(/const treeFar = q === 'low' \? \d+ : q === 'high' \? (\d+)/)[1]);
  assert.ok(far > near * 2, `遠景を増やす意味が薄い（近 ${near} / 遠 ${far}）`);

  /* 静的に回す判定は «短めの距離» で行うこと。
     汀線は波打っているので、前後の一番外へ張り出した汀線を使って
     距離を短く見積もる＝静的にする木を減らす方向にしておく。
     長めに見積もると «近づけるのに遠景のまま» の木ができてしまう */
  assert.match(terrain, /if \(v > m\) m = v;/, '汀線は窓内の最大を取ること');
  assert.match(terrain, /const toBand = dist - shoreMaxNear\(ang\) - WALK_INLAND;/);
  assert.match(terrain, /const FAR_GATE = TREE_LOD_DIST\[TREE_LOD_DIST\.length - 1\] \+ TREE_FADE_BAND \+ 12;/,
    'クロスフェードの帯ぶんの余裕が無い');
}

console.log('walk-zone-test: ok');
