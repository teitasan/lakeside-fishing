// シングル/マルチで共有する「着水から魚が寄り始めるまで」の時間計算。
// rng はテスト時に固定できるよう注入可能にする。
export function biteDelaySeconds({
  baitAttract = 1,
  rodAttract = 1,
  lineAttract = 1,
  weatherBite = 1,
  castAcc = 0,
  depth = 1,
  rng = Math.random,
} = {}) {
  const acc = Math.max(0, Math.min(1, Number(castAcc) || 0));
  const attract = Math.max(0.01,
    (Number(baitAttract) || 1)
    * (Number(rodAttract) || 1)
    * (Number(lineAttract) || 1)
    * (Number(weatherBite) || 1)
    * (1 + 0.18 * acc));
  let base = (2.2 + rng() * (7.0 - 2.2)) / attract;
  if ((Number(depth) || 0) < 0.9) base *= 1.7;
  return base;
}
