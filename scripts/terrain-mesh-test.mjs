/**
 * 同心円の地形メッシュの検査。
 *
 * 見たいのは 3 つ。
 *  (1) 隙間がないこと。バンドの境目で分割数が変わるので、縫い方を間違えると
 *      T 字が残って裂け目が見える。全部の辺がちょうど 2 枚に共有されていれば
 *      閉じた面になっている
 *  (2) 表を向いていること。1 枚でも裏返っていると、そこだけ黒い穴になる
 *  (3) 三角形が «歩く場所» に寄っていること。これが今回の目的そのもの
 */
import assert from 'node:assert';
import { buildRadialGrid, RADIAL_BANDS, DETAIL_BY_QUALITY } from '../src/terrainMesh.js';

const grid = buildRadialGrid({ detail: 1 });

/* (1) 隙間。辺を「小さいほうの頂点番号→大きいほう」に正規化して数える。
   閉じた面なら、どの辺もちょうど 2 枚の三角形に使われる */
{
  const seen = new Map();
  const idx = grid.index;
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const u = idx[t + e], v = idx[t + ((e + 1) % 3)];
      assert.notStrictEqual(u, v, '同じ頂点を 2 回使った三角形がある');
      const key = u < v ? u * 1e7 + v : v * 1e7 + u;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  }
  let open = 0, over = 0;
  for (const n of seen.values()) {
    if (n === 1) open++;
    else if (n > 2) over++;
  }
  // 外周のふちだけは 1 枚。それ以外に開いた辺があってはいけない
  const rim = Math.round(RADIAL_BANDS[RADIAL_BANDS.length - 1].seg);
  assert.strictEqual(over, 0, `3 枚以上に共有された辺が ${over} 本`);
  assert.strictEqual(open, rim, `開いた辺が ${open} 本（外周の ${rim} 本だけのはず）`);
  console.log(`  辺 ${seen.size} 本 / 開いているのは外周の ${open} 本だけ`);
}

/* (2) 向き。XZ 平面なので、外積の Y 成分が正なら上を向いている */
{
  const { xz, index } = grid;
  let flipped = 0, degenerate = 0;
  for (let t = 0; t < index.length; t += 3) {
    const i0 = index[t] * 2, i1 = index[t + 1] * 2, i2 = index[t + 2] * 2;
    const ax = xz[i1] - xz[i0], az = xz[i1 + 1] - xz[i0 + 1];
    const bx = xz[i2] - xz[i0], bz = xz[i2 + 1] - xz[i0 + 1];
    const ny = az * bx - ax * bz; // (a × b).y
    if (ny > 1e-9) continue;
    if (ny < -1e-9) flipped++;
    else degenerate++;
  }
  assert.strictEqual(flipped, 0, `裏返った三角形が ${flipped} 枚`);
  assert.strictEqual(degenerate, 0, `つぶれた三角形が ${degenerate} 枚`);
}

/* (3) 配分。汀線（半径 116〜153m）まわりにどれだけ寄っているか。
   一様 260 分割だと、この帯には 13.5 万枚のうち 4400 枚しか無かった */
{
  const { xz, index } = grid;
  const inBand = (r) => r >= 96 && r <= 186;
  let band = 0;
  for (let t = 0; t < index.length; t += 3) {
    let rs = 0;
    for (let e = 0; e < 3; e++) {
      const i = index[t + e] * 2;
      rs += Math.hypot(xz[i], xz[i + 1]);
    }
    if (inBand(rs / 3)) band++;
  }
  const share = band / grid.triangleCount;
  assert.ok(band > 100000, `汀線の帯の三角形が少なすぎる (${band})`);
  assert.ok(share > 0.6, `汀線に寄っていない (${(share * 100).toFixed(0)}%)`);

  // 帯のなかでのセルの大きさ。1.3m を超えると汀線が折れ線に見えてくる
  let maxCell = 0;
  for (let v = 0; v < grid.vertexCount; v++) {
    const r = Math.hypot(xz[v * 2], xz[v * 2 + 1]);
    if (inBand(r)) maxCell = Math.max(maxCell, grid.cell[v]);
  }
  assert.ok(maxCell < 1.6, `汀線のセルが粗い (${maxCell.toFixed(2)}m)`);
  console.log(`  三角形 ${(grid.triangleCount / 1000).toFixed(0)}k / 汀線の帯に ${(band / 1000).toFixed(0)}k (${(share * 100).toFixed(0)}%) / 帯のセル 最大 ${maxCell.toFixed(2)}m`);
}

/* 品質を落としても «縫える» こと。分割数の比が崩れると例外になる */
for (const [q, detail] of Object.entries(DETAIL_BY_QUALITY)) {
  const g = buildRadialGrid({ detail });
  assert.ok(g.triangleCount > 1000, `${q}: 三角形が少なすぎる`);
  // 外周のふち以外に開いた辺がないこと（縫えている証拠）
  const seen = new Map();
  for (let t = 0; t < g.index.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const u = g.index[t + e], v = g.index[t + ((e + 1) % 3)];
      const key = u < v ? u * 1e7 + v : v * 1e7 + u;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  }
  let open = 0;
  for (const n of seen.values()) if (n !== 2) open++;
  assert.strictEqual(open, Math.round(96 * detail), `${q}: 縫えていない辺が残った`);
  console.log(`  ${q.padEnd(6)} 頂点 ${(g.vertexCount / 1000).toFixed(0)}k  三角形 ${(g.triangleCount / 1000).toFixed(0)}k`);
}

// 1000m 四方の角（707m）まで覆っていること
assert.ok(grid.radius >= 707, `外周が足りない (${grid.radius}m)`);

console.log('terrain-mesh-test: ok');
