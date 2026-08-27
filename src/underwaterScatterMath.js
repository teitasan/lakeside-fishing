/* 水中プロップ散布の副作用を持たない制約ロジック。Node の回帰テストからも利用する。 */

export const WEED_BLADE_HEIGHT = 0.9;
export const WEED_SURFACE_CLEARANCE = 0.14;

/**
 * 水草の先端が平均水面を突き抜けない範囲へ Y scale を収める。
 * 浅すぎて最低サイズを置けない場合は null。
 */
export function fitWeedScale(
  desired,
  depth,
  clearance = WEED_SURFACE_CLEARANCE,
  bladeHeight = WEED_BLADE_HEIGHT,
  minScale = 0.22
) {
  if (!Number.isFinite(desired) || !Number.isFinite(depth) || bladeHeight <= 0) return null;
  const maxScale = (depth - clearance) / bladeHeight;
  if (maxScale < minScale) return null;
  return Math.min(Math.max(minScale, desired), maxScale);
}

/** 成功数が target に達した時点で止める、決定論的 scatter 用の試行ループ。 */
export function placeUpToTarget(target, maxTries, attempt) {
  let placed = 0;
  let tries = 0;
  while (placed < target && tries < maxTries) {
    tries++;
    const result = attempt(tries - 1);
    if (result === null) break;
    if (result) placed++;
  }
  return { placed, tries };
}
