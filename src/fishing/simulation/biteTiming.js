// シングル/マルチで共有する「着水から魚が寄り始めるまで」の時間計算。
// シングルは game.js 内の同式を使用。マルチは worker が multiplayer: true で呼ぶ。
// rng はテスト時に固定できるよう注入可能にする。
export const BITE_DELAY_MIN_SEC = 2.2;
export const BITE_DELAY_MAX_SEC = 7.0;
export const BITE_DELAY_MP_MIN_MUL = 2;
export const BITE_DELAY_MP_MAX_MUL = 4;

export function biteDelaySeconds({
  baitAttract = 1,
  rodAttract = 1,
  lineAttract = 1,
  weatherBite = 1,
  castAcc = 0,
  depth = 1,
  rng = Math.random,
  multiplayer = false,
} = {}) {
  const acc = Math.max(0, Math.min(1, Number(castAcc) || 0));
  const attract = Math.max(0.01,
    (Number(baitAttract) || 1)
    * (Number(rodAttract) || 1)
    * (Number(lineAttract) || 1)
    * (Number(weatherBite) || 1)
    * (1 + 0.18 * acc));
  const minSec = multiplayer
    ? BITE_DELAY_MIN_SEC * BITE_DELAY_MP_MIN_MUL
    : BITE_DELAY_MIN_SEC;
  const maxSec = multiplayer
    ? BITE_DELAY_MAX_SEC * BITE_DELAY_MP_MAX_MUL
    : BITE_DELAY_MAX_SEC;
  let base = (minSec + rng() * (maxSec - minSec)) / attract;
  if ((Number(depth) || 0) < 0.9) base *= 1.7;
  return base;
}
