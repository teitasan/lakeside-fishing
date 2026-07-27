/* ===========================================================
   湖の地形フィールド（three.js 非依存の純粋な数学部分）

   ・シードから湖の形・桟橋・深い淵・藻場を決める
   ・「破綻」「詰み」が起きないことを検証してから採用する
     - 湖の中に陸ができない（藻場の底上げは水深 1.2m を残す）
     - 深い淵が土手を削らない（岸際でフェードアウト）
     - キャストで届く範囲に、全魚種の生息層が必ず存在する
   =========================================================== */
import { makeNoise2D, makeRng, clamp, clamp01, smoothstep, TAU } from './util.js';
import { REAL_FISH } from './data.js';

export const WORLD_SIZE = 1000;    // 地形メッシュの一辺
export const WATER_REGION = 440;   // 水面メッシュ & 高さテクスチャの一辺
export const MAX_DEPTH = 26;       // 湖心の水深

/* プレイヤーが狙える距離（キャストの実効範囲 m） */
export const CAST_MIN = 7;
export const CAST_MAX = 46;

/* 地形フィーチャの目標値 */
const HOLE_TARGET_DEPTH = 24.0;    // 深い淵の水深（レジェンドの層）
const HOLE_RADIUS = 30;
const FLAT_TARGET_DEPTH = 2.5;     // 藻場の水深（浅場の魚の層）
const FLAT_RADIUS = 30;
const FLAT_MIN_DEPTH = 1.2;        // 藻場でもこれ以上は必ず水を残す
const DOCK_LENGTH = 26;            // 岸線から沖へ出す桟橋の長さ
const DOCK_LAND = 3.5;             // 岸線から陸側へ出す長さ
const DOCK_CLEARANCE = 0.5;        // 陸側の地面から床までの余裕

/**
 * シードから湖を生成する（メッシュは作らない）
 * @param {number} seed
 */
export function makeLake(seed) {
  const s = seed >>> 0;
  const noise = makeNoise2D(s);
  const rng = makeRng((Math.imul(s, 2654435761) ^ 0x9e3779b9) >>> 0);

  /* ---------- 岸線（角度のみの関数 → 湖は常に単連結） ---------- */
  const shoreAtAngle = (ang) => {
    const n = noise.fbm(Math.cos(ang) * 1.55 + 11.3, Math.sin(ang) * 1.55 - 4.7, 3);
    return clamp(130 + 34 * n, 92, 168);
  };
  const shoreRadius = (x, z) => {
    const r = Math.hypot(x, z) || 1e-4;
    const n = noise.fbm((x / r) * 1.55 + 11.3, (z / r) * 1.55 - 4.7, 3);
    return clamp(130 + 34 * n, 92, 168);
  };

  /* ---------- フィーチャなしの高さ ---------- */
  function baseHeight(x, z) {
    const r = Math.hypot(x, z);
    const shoreR = shoreRadius(x, z);
    const over = r - shoreR;
    if (over < 0) {
      const t = clamp01(r / shoreR);
      const k = 1 - t;
      const depth = MAX_DEPTH * Math.pow(k, 0.6) * smoothstep(0, 0.075, k);
      return -depth + noise.fbm(x * 0.017, z * 0.017, 3) * 1.35 * k;
    }
    return over * 0.15
      + noise.fbm(x * 0.0072 + 3.1, z * 0.0072 - 8.2, 4) * 7.5 * smoothstep(0, 34, over)
      + noise.ridge(x * 0.0031, z * 0.0031, 4) * 105 * smoothstep(70, 320, over);
  }
  const detail = (x, z, over) =>
    noise.fbm(x * 0.055, z * 0.055, 2) * 0.42 * smoothstep(0, 11, Math.abs(over));

  /** ある方角で高さが 0 になる半径（＝岸線）を二分探索 */
  function crossing(ang, hf) {
    const cx = Math.cos(ang), cz = Math.sin(ang);
    let lo = 40, hi = 240;
    for (let i = 0; i < 42; i++) {
      const mid = (lo + hi) / 2;
      if (hf(cx * mid, cz * mid) < 0) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /* ---------- 桟橋の方角 ---------- */
  const dockAngle = rng() * TAU;
  const dockCos = Math.cos(dockAngle), dockSin = Math.sin(dockAngle);
  const baseShoreDock = crossing(dockAngle, baseHeight);

  /* ---------- 深い淵（レジェンドの層を保証する） ---------- */
  const holeSign = rng() < 0.5 ? -1 : 1;
  // 桟橋からキャストで届く範囲に置く（詰み防止）
  const holeAngle = dockAngle + holeSign * (0.13 + rng() * 0.19);
  const holeInset = 26 + rng() * 10;                       // 岸線から内側へ
  const holeShore = crossing(holeAngle, baseHeight);
  const holeR = Math.max(holeShore * 0.35, holeShore - holeInset);
  const hole = {
    x: Math.cos(holeAngle) * holeR,
    z: Math.sin(holeAngle) * holeR,
    r: HOLE_RADIUS,
    angle: holeAngle,
    inset: holeShore - holeR,
    amp: 0,
  };
  const holeBaseDepth = -baseHeight(hole.x, hole.z);
  hole.amp = clamp(HOLE_TARGET_DEPTH - holeBaseDepth, 0, 16);

  /* ---------- 藻場（浅場の層を保証する） ---------- */
  const flatAngle = dockAngle - holeSign * (0.5 + rng() * 0.5);
  const flatInset = 14 + rng() * 10;
  const flatShore = crossing(flatAngle, baseHeight);
  const flatR = Math.max(flatShore * 0.5, flatShore - flatInset);
  const flat = {
    x: Math.cos(flatAngle) * flatR,
    z: Math.sin(flatAngle) * flatR,
    r: FLAT_RADIUS,
    angle: flatAngle,
    inset: flatShore - flatR,
    amp: 0,
  };
  const flatBaseDepth = -baseHeight(flat.x, flat.z);
  flat.amp = clamp(flatBaseDepth - FLAT_TARGET_DEPTH, 0, 12);

  /* ---------- 完成した高さ関数 ---------- */
  function heightAt(x, z) {
    const r = Math.hypot(x, z);
    const shoreR = shoreRadius(x, z);
    const over = r - shoreR;

    if (over >= 0) return baseHeight(x, z) + detail(x, z, over);

    const t = clamp01(r / shoreR);
    const k = 1 - t;
    const depth = MAX_DEPTH * Math.pow(k, 0.6) * smoothstep(0, 0.075, k);
    let h = -depth + noise.fbm(x * 0.017, z * 0.017, 3) * 1.35 * k;

    // 深い淵：掘るだけなので陸はできない。岸際ではフェードして土手を削らない
    if (hole.amp > 0) {
      const dh = ((x - hole.x) ** 2 + (z - hole.z) ** 2) / (hole.r * hole.r);
      if (dh < 9) h -= hole.amp * Math.exp(-dh * 1.1) * smoothstep(0, 0.12, k);
    }
    // 藻場：底上げするが、必ず FLAT_MIN_DEPTH の水を残す
    // （岸際のフェードは軽く。水を残すクランプ自体が土手を守るため）
    if (flat.amp > 0) {
      const df = ((x - flat.x) ** 2 + (z - flat.z) ** 2) / (flat.r * flat.r);
      if (df < 9) {
        const want = flat.amp * Math.exp(-df * 1.2) * smoothstep(0.01, 0.08, k);
        h += Math.min(want, Math.max(0, -h - FLAT_MIN_DEPTH));
      }
    }
    return h + detail(x, z, over);
  }

  /* ---------- 桟橋（完成した高さで岸線を取り直す） ---------- */
  const r0 = crossing(dockAngle, heightAt);
  // 陸側の地面が床を突き抜けないよう、床の高さを地形に合わせる
  let landMax = 0;
  for (let i = 0; i <= 8; i++) {
    const rr = r0 + (DOCK_LAND * i) / 8;
    for (const off of [-1.7, 0, 1.7]) {          // 桟橋の幅も見る
      const px = dockCos * rr - dockSin * off;
      const pz = dockSin * rr + dockCos * off;
      landMax = Math.max(landMax, heightAt(px, pz));
    }
  }
  const dockY = clamp(landMax + DOCK_CLEARANCE, 1.15, 2.6);
  const dock = {
    angle: dockAngle,
    r0,
    startR: r0 + DOCK_LAND,
    endR: r0 - DOCK_LENGTH,
    y: dockY,
    landMax,
    start: { x: dockCos * (r0 + DOCK_LAND), z: dockSin * (r0 + DOCK_LAND) },
    end: { x: dockCos * (r0 - DOCK_LENGTH), z: dockSin * (r0 - DOCK_LENGTH) },
    dir: { x: -dockCos, z: -dockSin },   // 岸 → 湖心
  };

  return {
    seed: s, noise, shoreAtAngle, shoreRadius, baseHeight, heightAt,
    depthAt: (x, z) => Math.max(0, -heightAt(x, z)),
    dock, hole, flat, baseShoreDock,
    slopeAt(x, z, e = 1.2) {
      const hL = heightAt(x - e, z), hR = heightAt(x + e, z);
      const hD = heightAt(x, z - e), hU = heightAt(x, z + e);
      const dx = (hR - hL) / (2 * e), dz = (hU - hD) / (2 * e);
      return Math.sqrt(dx * dx + dz * dz);
    },
  };
}

/* ===========================================================
   検証：破綻・詰みがないか
   =========================================================== */

/** 桟橋の先端と岸沿いから「キャストで届く」水深の範囲を調べる */
export function analyzeLake(lake, opts = {}) {
  const shoreSamples = opts.shoreSamples ?? 64;
  const rays = opts.rays ?? 9;
  const steps = opts.steps ?? 14;

  let minDepth = Infinity, maxDepth = 0;
  let maxFromDock = 0, minFromDock = Infinity;
  let deepSpot = null, shallowSpot = null;
  // 各層が「キャストで届く」かどうか
  const bands = { shallow: false, mid: false, deep: false, veryDeep: false };

  /** 立ち位置 p から扇状にキャストして水深を集める */
  const scan = (px, pz, aimAngle, isDock) => {
    for (let i = 0; i < rays; i++) {
      const a = aimAngle + (i / (rays - 1) - 0.5) * 1.5; // ±43°
      const ca = Math.cos(a), sa = Math.sin(a);
      for (let j = 0; j <= steps; j++) {
        const dist = CAST_MIN + (CAST_MAX - CAST_MIN) * (j / steps);
        const x = px + ca * dist, z = pz + sa * dist;
        const d = lake.depthAt(x, z);
        if (d < 0.35) continue;                     // 水がない
        if (d < minDepth) { minDepth = d; shallowSpot = { x, z, d }; }
        if (d > maxDepth) { maxDepth = d; deepSpot = { x, z, d }; }
        if (d >= 1.0 && d <= 4.0) bands.shallow = true;
        if (d >= 5.0 && d <= 10.0) bands.mid = true;
        if (d >= 12.0 && d <= 18.0) bands.deep = true;
        if (d >= 20.0) bands.veryDeep = true;
        if (isDock) {
          if (d > maxFromDock) maxFromDock = d;
          if (d < minFromDock) minFromDock = d;
        }
      }
    }
  };

  // 桟橋の先端から湖心方向へ
  scan(lake.dock.end.x, lake.dock.end.z, Math.atan2(lake.dock.dir.z, lake.dock.dir.x), true);
  // 岸沿いを一周
  for (let i = 0; i < shoreSamples; i++) {
    const ang = (i / shoreSamples) * TAU;
    const r = lake.shoreAtAngle(ang);
    scan(Math.cos(ang) * r, Math.sin(ang) * r, ang + Math.PI, false);
  }

  // 湖の中に陸ができていないか
  let landInLake = 0, minLakeDepth = Infinity;
  for (let i = 0; i < 96; i++) {
    const ang = (i / 96) * TAU;
    const sr = lake.shoreAtAngle(ang);
    for (let t = 0.12; t <= 0.94; t += 0.04) {
      const x = Math.cos(ang) * sr * t, z = Math.sin(ang) * sr * t;
      const h = lake.heightAt(x, z);
      if (h > -0.2) landInLake++;
      if (-h < minLakeDepth) minLakeDepth = -h;
    }
  }

  // 岸線の広がり
  let shoreMin = Infinity, shoreMax = 0;
  for (let i = 0; i < 128; i++) {
    const r = lake.shoreAtAngle((i / 128) * TAU);
    if (r < shoreMin) shoreMin = r;
    if (r > shoreMax) shoreMax = r;
  }

  const dockTipDepth = lake.depthAt(lake.dock.end.x, lake.dock.end.z);
  const holeDepth = lake.depthAt(lake.hole.x, lake.hole.z);
  const flatDepth = lake.depthAt(lake.flat.x, lake.flat.z);
  const dx = lake.hole.x - lake.dock.end.x, dz = lake.hole.z - lake.dock.end.z;
  const holeFromDock = Math.hypot(dx, dz);
  const fdx = lake.flat.x - lake.dock.end.x, fdz = lake.flat.z - lake.dock.end.z;
  const flatFromDock = Math.hypot(fdx, fdz);
  const holeFlatGap = Math.hypot(lake.hole.x - lake.flat.x, lake.hole.z - lake.flat.z);

  // 桟橋の付け根が歩ける斜面か
  const sx = lake.dock.start.x, sz = lake.dock.start.z;
  const shoreSlope = Math.max(
    lake.slopeAt(sx, sz),
    lake.slopeAt(sx + lake.dock.dir.x * -6, sz + lake.dock.dir.z * -6)
  );

  // 桟橋の床が地形に埋まっていないか（幅も含めて全長をチェック）
  let dockClearance = Infinity;
  const D = lake.dock;
  for (let i = 0; i <= 24; i++) {
    const rr = D.startR + ((D.endR - D.startR) * i) / 24;
    for (const off of [-1.8, 0, 1.8]) {
      const px = Math.cos(D.angle) * rr - Math.sin(D.angle) * off;
      const pz = Math.sin(D.angle) * rr + Math.cos(D.angle) * off;
      dockClearance = Math.min(dockClearance, D.y - lake.heightAt(px, pz));
    }
  }

  // 全魚種の生息層（fit = 1 の窓）が届く範囲にあるか
  const unreachable = REAL_FISH.filter((sp) => {
    const lo = sp.depth[0], hi = sp.depth[1] + 3;
    return !(maxDepth >= lo && minDepth <= hi);
  }).map((sp) => sp.name);

  return {
    bands,
    minDepth, maxDepth, minFromDock, maxFromDock, dockTipDepth,
    holeDepth, flatDepth, holeFromDock, flatFromDock, holeFlatGap,
    holeInset: lake.hole.inset, flatInset: lake.flat.inset,
    holeAmp: lake.hole.amp, flatAmp: lake.flat.amp,
    landInLake, minLakeDepth, shoreMin, shoreMax, shoreSlope,
    dockClearance, dockY: lake.dock.y,
    shoreR0: lake.dock.r0, deepSpot, shallowSpot, unreachable,
  };
}

/** 採用してよい湖か */
export function validateLake(lake, stats = analyzeLake(lake)) {
  const bad = [];
  const S = stats;

  if (!(S.shoreR0 > 60 && S.shoreR0 < 200)) bad.push(`岸線が異常 (r0=${S.shoreR0.toFixed(1)})`);
  if (!(S.dockTipDepth >= 6 && S.dockTipDepth <= 19)) bad.push(`桟橋先端の水深が不適 (${S.dockTipDepth.toFixed(1)}m)`);
  for (const [k, label] of [['shallow', '浅場 1〜4m'], ['mid', '中層 5〜10m'], ['deep', '深場 12〜18m'], ['veryDeep', '深淵 20m+']]) {
    if (!S.bands[k]) bad.push(`${label} に届かない`);
  }
  if (S.landInLake > 0) bad.push(`湖の中に陸がある (${S.landInLake}点)`);
  if (S.minLakeDepth < 0.25) bad.push(`湖内に浅すぎる場所がある (${S.minLakeDepth.toFixed(2)}m)`);
  if (!(S.maxDepth >= 20)) bad.push(`届く範囲に深場がない (最深 ${S.maxDepth.toFixed(1)}m)`);
  if (!(S.minDepth <= 3.0)) bad.push(`届く範囲に浅場がない (最浅 ${S.minDepth.toFixed(1)}m)`);
  if (!(S.maxFromDock >= 12)) bad.push(`桟橋から深場が狙えない (${S.maxFromDock.toFixed(1)}m)`);
  if (!(S.holeDepth >= 20 && S.holeDepth <= 34)) bad.push(`淵の水深が不適 (${S.holeDepth.toFixed(1)}m)`);
  if (!(S.holeFromDock <= 44)) bad.push(`淵が桟橋から遠すぎる (${S.holeFromDock.toFixed(1)}m)`);
  if (!(S.holeInset >= 18)) bad.push(`淵が岸に近すぎる (${S.holeInset.toFixed(1)}m)`);
  if (!(S.flatDepth >= 1.4 && S.flatDepth <= 4.6)) bad.push(`藻場の水深が不適 (${S.flatDepth.toFixed(1)}m)`);
  if (!(S.flatInset >= 6)) bad.push(`藻場が岸に近すぎる (${S.flatInset.toFixed(1)}m)`);
  if (!(S.holeFlatGap >= 45)) bad.push(`淵と藻場が近すぎる (${S.holeFlatGap.toFixed(1)}m)`);
  if (!(S.shoreSlope <= 1.4)) bad.push(`桟橋の付け根が崖 (勾配 ${S.shoreSlope.toFixed(2)})`);
  if (!(S.dockClearance >= 0.25)) bad.push(`桟橋が地形に埋まる (余裕 ${S.dockClearance.toFixed(2)}m)`);
  if (S.unreachable.length) bad.push(`届かない魚種: ${S.unreachable.join(',')}`);

  return { ok: bad.length === 0, reasons: bad, stats: S };
}

/**
 * 検証を通るシードを決めて湖を返す。
 * 落ちた場合はシードを +1 して再挑戦するので、必ず遊べる湖になる。
 */
export function resolveLake(seed, maxTries = 40) {
  let cur = (seed >>> 0) || 1;
  let last = null;
  for (let i = 0; i < maxTries; i++) {
    const lake = makeLake(cur);
    const v = validateLake(lake);
    if (v.ok) return { lake, seed: cur, tries: i + 1, stats: v.stats };
    last = { lake, seed: cur, tries: i + 1, stats: v.stats, reasons: v.reasons };
    cur = (cur + 1) >>> 0 || 1;
  }
  console.warn('[lakefield] 検証を通る湖が見つかりませんでした', last && last.reasons);
  return last;
}

export const randomSeed = () => (Math.random() * 0xffffffff) >>> 0 || 1;
