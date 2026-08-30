/* ===========================================================
   湖の地形フィールド（three.js 非依存の純粋な数学部分）

   ・シードから湖の形・桟橋・深い淵・藻場を決める
   ・「破綻」「詰み」が起きないことを検証してから採用する
     - 湖の中に陸ができない（藻場の底上げは水深 1.2m を残す）
     - 深い淵が土手を削らない（岸際でフェードアウト）
     - キャストで届く範囲に、全魚種の生息層が必ず存在する
   =========================================================== */
import { makeNoise2D, makeRng, clamp, clamp01, smoothstep, TAU } from './util.js?v=20260830-zone4';
import { REAL_FISH, depthFit, RODS } from './data.js';

export const WORLD_SIZE = 1000;    // 地形メッシュの一辺
export const WATER_REGION = 440;   // 水面メッシュ & 高さテクスチャの一辺
export const MAX_DEPTH = 26;       // 湖心の水深

/* プレイヤーが狙える距離（キャストの実効範囲 m）。竿の飛距離から決まる
   CAST_MAX   一番飛ぶ竿。ここまでに全魚種の生息層があることを保証する
   CAST_START 最初の竿。スタート地点の近さと、淵の「遠さ」の基準
   最初の竿で湖のすべてに手が届いてしまうと竿を買い替える理由がないので、
   深い淵は CAST_START の外・CAST_MAX の内側に置く */
export const CAST_MIN = 4.5;
export const CAST_MAX = Math.max(...RODS.map((r) => r.cast));
export const CAST_START = Math.min(...RODS.map((r) => r.cast));

/* 地形フィーチャの目標値 */
const HOLE_TARGET_DEPTH = 24.0;    // 深い淵の水深（レジェンドの層）
const HOLE_RADIUS = 30;
/* 淵を桟橋の先端から離す距離。最初の竿では届かず、中位の竿で届くところ */
const HOLE_DOCK_MIN = CAST_START + 14;
const HOLE_DOCK_MAX = CAST_MAX - 16;
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

  /* ---------- 岸線（角度のみの関数 → 湖は常に単連結） ----------
     大きなうねり + 細かい入り組み（岬とワンド）の 2 枚重ね。
     角度の関数である限り、どんなに入り組んでも湖の中に陸はできない */
  const shoreFrom = (cx, cz) => {
    const n = noise.fbm(cx * 1.55 + 11.3, cz * 1.55 - 4.7, 3);       // 大きな形
    const n2 = noise.fbm(cx * 4.3 - 27.1, cz * 4.3 + 9.4, 2);        // 岬・入り江
    return clamp(130 + 34 * n + 12 * n2, 88, 172);
  };
  const shoreAtAngle = (ang) => shoreFrom(Math.cos(ang), Math.sin(ang));
  const shoreRadius = (x, z) => {
    const r = Math.hypot(x, z) || 1e-4;
    return shoreFrom(x / r, z / r);
  };

  /* ---------- 方角ごとの湖底プロファイル：棚とかけあがりの階段 ----------
     なめらかな冪関数だけだと湖底が「どこも同じ傾き」になり、平場ができない。
     深さを「なめらかな斜面（全体の 30〜40%）」＋「2〜4 段の落ち込み」に分け、
     段のあいだを平らな棚（＝浅棚・ブレイクの上）にする。
     段は幅が狭いので、そこだけ急なかけあがりになる。
     配列を作らないのは heightAt が 30 万回以上呼ばれるため */
  const depthProfile = (cx, cz, k) => {
    const n = noise.fbm(cx * 0.95 + 31.7, cz * 0.95 - 17.3, 2);      // 斜面の指数
    const nb = noise.fbm(cx * 1.7 - 5.9, cz * 1.7 + 23.5, 2);        // なめらかな分の割合
    const nk = noise.fbm(cx * 2.4 + 14.2, cz * 2.4 - 31.8, 2);       // 段の位置と幅
    const nc = noise.fbm(cx * 3.1 - 21.4, cz * 3.1 + 6.6, 2);        // 段の数（連続的に増減）
    /* なめらかな分。これを下げると棚はより平らになるが、岸ぎわに
       水深 0 付近の広い平地ができて「湖の中に陸」になるため 0.30 が下限 */
    const smooth = 0.30 + 0.10 * (nb + 1);                            // 0.30〜0.40（残りは段）
    const exp = 0.62 + 0.38 * (n + 1);                                // 0.62（急）〜1.38（緩）
    const near = smoothstep(0, 0.09, k);                              // 岸ぎわで段を出さない
    let d = MAX_DEPTH * smooth * Math.pow(k, exp) * smoothstep(0, 0.075, k);
    /* 段（かけあがり）は 4 枠で、3・4 枠目は nc で 0 から連続的に立ち上がる。
       枠の数を整数で切り替えると方角ごとに深さが飛んで、湖底が扇状に割れるため。
       重みを合計で正規化するので、何段になっても総深さは変わらない */
    const gate = [1, 1, smoothstep(-0.18, 0.18, nc), smoothstep(0.22, 0.58, nc)];
    let sum = 0;
    for (let i = 0; i < 4; i++) sum += (0.55 + ((i + 0.5) / 4) * 0.9) * gate[i];
    const budget = (MAX_DEPTH * (1 - smooth)) / Math.max(sum, 1e-4);
    for (let i = 0; i < 4; i++) {
      if (gate[i] <= 0.001) continue;
      const t = (i + 0.5) / 4;
      const jitter = 0.10 * noise.fbm(cx * 5.3 + i * 13.7, cz * 5.3 - i * 8.1, 1);
      const kk = clamp(0.10 + t * 0.78 + jitter + nk * 0.06, 0.08, 0.95);
      const w = 0.020 + 0.030 * clamp01(0.5 + nk * 0.5) + t * 0.02;   // 段の幅（k 単位）
      d += budget * (0.55 + t * 0.9) * gate[i] * smoothstep(kk - w, kk + w, k) * near;
    }
    return Math.min(d, MAX_DEPTH + 6);
  };

  /* ---------- フィーチャなしの高さ ---------- */
  function baseHeight(x, z) {
    const r = Math.hypot(x, z);
    const shoreR = shoreRadius(x, z);
    const over = r - shoreR;
    if (over < 0) {
      const k = 1 - clamp01(r / shoreR);
      const depth = depthProfile(x / (r || 1e-4), z / (r || 1e-4), k);
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

  /* ---------- 桟橋の方角 ----------
     棚とかけあがりで方角ごとの水深がばらつくので、
     「先端が 7〜17m になる方角」を探して決める（検証落ちを減らす） */
  const pickDockAngle = () => {
    const a0 = rng() * TAU;
    let best = null;
    for (let i = 0; i < 24; i++) {
      const a = a0 + (i / 24) * TAU;
      const sr = crossing(a, baseHeight);
      const tip = -baseHeight(Math.cos(a) * (sr - DOCK_LENGTH), Math.sin(a) * (sr - DOCK_LENGTH));
      const sc = -Math.abs(tip - 11);
      if (tip >= 7 && tip <= 17 && (!best || sc > best.sc)) best = { a, sc };
    }
    return best ? best.a : a0;
  };
  const dockAngle = pickDockAngle();
  const dockCos = Math.cos(dockAngle), dockSin = Math.sin(dockAngle);
  const baseShoreDock = crossing(dockAngle, baseHeight);

  /* ---------- 深い淵（レジェンドの層） ----------
     1 つ目は桟橋の正面、HOLE_DOCK_MIN〜MAX の帯に置く。
     最初の竿では届かず、竿を伸ばすと届くようになる＝買い替えの目標。
     残りは湖のどこかに散らす（「なんでもない水域」を減らす） */
  const holes = [];
  const flats = [];
  /** 既にあるフィーチャと離れているか */
  const farFromAll = (x, z, min) =>
    ![...holes, ...flats].some((f) => (f.x - x) ** 2 + (f.z - z) ** 2 < min * min);

  const holeSign = rng() < 0.5 ? -1 : 1;
  {
    /* 桟橋の先端（この時点では概算）から沖へ、狙いの帯の中で
       掘って 24m にできる（元が深すぎず浅すぎない）所を探す */
    const tipR = Math.max(baseShoreDock * 0.35, baseShoreDock - DOCK_LENGTH);
    const tipX = dockCos * tipR, tipZ = dockSin * tipR;
    const outward = dockAngle + Math.PI;              // 岸 → 湖心
    /** 先端から dist・左右 spread の位置を評価する */
    const probe = (dist, spread) => {
      const a = outward + spread;
      const x = tipX + Math.cos(a) * dist, z = tipZ + Math.sin(a) * dist;
      const holeAngle = Math.atan2(z, x);
      const holeShore = crossing(holeAngle, baseHeight);
      const inset = holeShore - Math.hypot(x, z);
      const base = -baseHeight(x, z);
      return { x, z, angle: holeAngle, inset, base, dist };
    };
    let best = null;
    for (let i = 0; i < 24; i++) {
      const dist = HOLE_DOCK_MIN + ((i % 8) / 7) * (HOLE_DOCK_MAX - HOLE_DOCK_MIN);
      const spread = holeSign * (0.10 + Math.floor(i / 8) * 0.16 + rng() * 0.06);
      const c = probe(dist, spread);
      // 岸から十分内側で、掘れば淵になる水深であること
      c.sc = -Math.abs(c.base - 13);
      if (c.inset >= 20 && c.base >= 5 && c.base <= 24 && (!best || c.sc > best.sc)) best = c;
    }
    if (!best) best = probe((HOLE_DOCK_MIN + HOLE_DOCK_MAX) / 2, holeSign * 0.14);
    holes.push({
      x: best.x, z: best.z, r: HOLE_RADIUS, angle: best.angle, inset: best.inset,
      amp: clamp(HOLE_TARGET_DEPTH - best.base, 0, 21),
      main: true,
    });
  }

  /* ---------- 藻場（浅場の層を保証する） ---------- */
  {
    // 淵の反対側で、盛って 2.5m にできる（元が 3〜16m の）所を探す
    let best = null;
    for (let i = 0; i < 18; i++) {
      const flatAngle = dockAngle - holeSign * (0.5 + (i % 6) * 0.09 + rng() * 0.06);
      const flatInset = 14 + Math.floor(i / 6) * 6 + rng() * 5;
      const flatShore = crossing(flatAngle, baseHeight);
      const flatR = Math.max(flatShore * 0.5, flatShore - flatInset);
      const x = Math.cos(flatAngle) * flatR, z = Math.sin(flatAngle) * flatR;
      const base = -baseHeight(x, z);
      const sc = -Math.abs(base - 7);
      if (base >= 3 && base <= 16 && (!best || sc > best.sc)) {
        best = { sc, x, z, angle: flatAngle, inset: flatShore - flatR, base };
      }
    }
    if (!best) {
      const flatAngle = dockAngle - holeSign * 0.7;
      const flatShore = crossing(flatAngle, baseHeight);
      const flatR = Math.max(flatShore * 0.5, flatShore - 18);
      const x = Math.cos(flatAngle) * flatR, z = Math.sin(flatAngle) * flatR;
      best = { x, z, angle: flatAngle, inset: flatShore - flatR, base: -baseHeight(x, z) };
    }
    flats.push({
      x: best.x, z: best.z, r: FLAT_RADIUS, angle: best.angle, inset: best.inset,
      amp: clamp(best.base - FLAT_TARGET_DEPTH, 0, 16),
      main: true,
    });
  }

  /* ---------- 追加の淵・浅い平場（湖のあちこちに） ----------
     1 つずつだと「なんでもない水域」が広すぎるので、小ぶりのものを散らす。
     掘る／盛るだけなので陸はできず、岸ぎわではフェードして土手を守る */
  {
    // 桟橋の先の水深を動かさないよう、桟橋からは離して置く
    const tipR = baseShoreDock - DOCK_LENGTH;
    const tipX = dockCos * tipR, tipZ = dockSin * tipR;
    const extraHoles = 1 + Math.floor(rng() * 2);            // 1〜2
    const extraFlats = 2 + Math.floor(rng() * 2);            // 2〜3
    const place = (kind, want) => {
      let made = 0;
      for (let i = 0; i < want * 60 && made < want; i++) {
        const a = rng() * TAU;
        const sr = crossing(a, baseHeight);
        const rr = sr * (0.22 + rng() * 0.62);
        const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
        const r = kind === 'hole' ? 16 + rng() * 10 : 14 + rng() * 12;
        // 岸から離す（土手を削らない）／既存のフィーチャと重ねない
        if (sr - Math.hypot(x, z) < r * 0.8 + 6) continue;
        if ((x - tipX) ** 2 + (z - tipZ) ** 2 < 45 * 45) continue;
        if (!farFromAll(x, z, 44)) continue;
        const base = -baseHeight(x, z);
        if (kind === 'hole') {
          const target = 18 + rng() * 8;                     // 18〜26m
          const amp = clamp(target - base, 3, 16);
          if (amp < 3.5) continue;                           // 元から深い所は掘らない
          holes.push({ x, z, r, angle: a, inset: sr - Math.hypot(x, z), amp, main: false });
        } else {
          const target = 1.8 + rng() * 1.9;                  // 1.8〜3.7m
          const amp = clamp(base - target, 2, 16);
          // 元から浅い所は盛らない／深すぎる所は盛っても浅場にならない
          if (base < 3.2 || base > 14) continue;
          flats.push({ x, z, r, angle: a, inset: sr - Math.hypot(x, z), amp, main: false });
        }
        made++;
      }
      return made;
    };
    place('hole', extraHoles);
    place('flat', extraFlats);
  }
  const hole = holes[0];
  const flat = flats[0];

  /* ---------- 完成した高さ関数 ---------- */
  function heightAt(x, z) {
    const r = Math.hypot(x, z);
    const shoreR = shoreRadius(x, z);
    const over = r - shoreR;

    if (over >= 0) return baseHeight(x, z) + detail(x, z, over);

    const k = 1 - clamp01(r / shoreR);
    const depth = depthProfile(x / (r || 1e-4), z / (r || 1e-4), k);
    let h = -depth + noise.fbm(x * 0.017, z * 0.017, 3) * 1.35 * k;

    // 深い淵：掘るだけなので陸はできない。岸際ではフェードして土手を削らない
    for (let i = 0; i < holes.length; i++) {
      const o = holes[i];
      if (o.amp <= 0) continue;
      const dh = ((x - o.x) ** 2 + (z - o.z) ** 2) / (o.r * o.r);
      if (dh < 9) h -= o.amp * Math.exp(-dh * 1.1) * smoothstep(0, 0.12, k);
    }
    // 浅い平場：底上げするが、必ず FLAT_MIN_DEPTH の水を残す
    // （岸際のフェードは軽く。水を残すクランプ自体が土手を守るため）
    for (let i = 0; i < flats.length; i++) {
      const o = flats[i];
      if (o.amp <= 0) continue;
      const df = ((x - o.x) ** 2 + (z - o.z) ** 2) / (o.r * o.r);
      if (df < 9) {
        const want = o.amp * Math.exp(-df * 1.2) * smoothstep(0.01, 0.08, k);
        h += Math.min(want, Math.max(0, -h - FLAT_MIN_DEPTH));
      }
    }
    return h + detail(x, z, over);
  }

  /* ---------- 底質（泥 / 砂 / 岩） ----------
     深いほど泥、急斜面ほど岩、浅場はノイズで砂と岩が混じる */
  function bedValue(x, z, slope) {
    const d = Math.max(0, -heightAt(x, z));
    const n = noise.fbm(x * 0.019 + 5.5, z * 0.019 - 3.3, 2);
    return clamp01(0.52 + n * 0.62 + clamp01(slope - 0.3) * 0.7 - clamp01((d - 4) / 18) * 0.66);
  }
  const bedKindOf = (v) => (v < 0.34 ? 'mud' : v < 0.68 ? 'sand' : 'rock');

  /* ---------- 桟橋（完成した高さで岸線を取り直す） ---------- */
  const r0 = crossing(dockAngle, heightAt);
  /* 棚とかけあがりがあるので、先端の水深が 7〜17m になる長さを選ぶ
     （桟橋から浅場〜中深場が狙える状態を保つ） */
  const dockLen = (() => {
    let best = { len: DOCK_LENGTH, sc: -1e9 };
    for (let L = 18; L <= 32; L++) {
      const tip = -heightAt(dockCos * (r0 - L), dockSin * (r0 - L));
      const sc = (tip >= 7 && tip <= 17 ? 100 : 0) - Math.abs(tip - 11);
      if (sc > best.sc) best = { len: L, sc };
    }
    return best.len;
  })();
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
    endR: r0 - dockLen,
    y: dockY,
    len: dockLen,
    landMax,
    start: { x: dockCos * (r0 + DOCK_LAND), z: dockSin * (r0 + DOCK_LAND) },
    end: { x: dockCos * (r0 - dockLen), z: dockSin * (r0 - dockLen) },
    dir: { x: -dockCos, z: -dockSin },   // 岸 → 湖心
  };

  const slopeAt = (x, z, e = 1.2) => {
    const hL = heightAt(x - e, z), hR = heightAt(x + e, z);
    const hD = heightAt(x, z - e), hU = heightAt(x, z + e);
    const dx = (hR - hL) / (2 * e), dz = (hU - hD) / (2 * e);
    return Math.sqrt(dx * dx + dz * dz);
  };

  /* ---------- 水中のストラクチャー（沈み岩・立ち枯れ） ----------
     底質と水深で種類を決め、必ず水面より下に収める。
     桟橋の真上は避けるが、キャストで届く所に必ず何本か残る */
  const structures = [];
  {
    const want = 16 + Math.floor(rng() * 8);
    const dx0 = dock.start.x, dz0 = dock.start.z;
    const dx1 = dock.end.x, dz1 = dock.end.z;
    const distToDock = (x, z) => {
      const vx = dx1 - dx0, vz = dz1 - dz0;
      const t = clamp01(((x - dx0) * vx + (z - dz0) * vz) / (vx * vx + vz * vz));
      return Math.hypot(x - (dx0 + vx * t), z - (dz0 + vz * t));
    };
    for (let i = 0; i < want * 40 && structures.length < want; i++) {
      let x, z;
      if (structures.length < 4) {
        // 最初の何本かは桟橋の先から狙える扇の中に置く（スタート地点で必ず遊べる）
        const a = dockAngle + Math.PI + (rng() - 0.5) * 1.7;
        const dist = 8 + rng() * 32;
        x = dock.end.x + Math.cos(a) * dist;
        z = dock.end.z + Math.sin(a) * dist;
        if (Math.hypot(x, z) > shoreRadius(x, z) - 2) continue;
      } else {
        const a = rng() * TAU;
        const sr = shoreAtAngle(a);
        const rr = sr * (0.3 + rng() * 0.66);
        x = Math.cos(a) * rr; z = Math.sin(a) * rr;
      }
      const d = -heightAt(x, z);
      if (d < 1.2 || d > 20) continue;                        // 浅すぎ・深すぎは置かない
      if (distToDock(x, z) < 4.5) continue;                   // 桟橋の真下は避ける
      const gap = structures.length < 4 ? 8 : 11;
      if (structures.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < gap * gap)) continue;
      const bed = bedKindOf(bedValue(x, z, slopeAt(x, z)));
      const kind = bed === 'rock' || rng() < 0.4 ? 'rock' : 'snag';
      const h = kind === 'rock' ? 0.7 + rng() * 1.9 : 1.8 + rng() * 3.4;
      if (h > d - 0.5) continue;                              // 水面から出さない
      structures.push({
        x, z, depth: d, kind, h,
        r: kind === 'rock' ? 1.1 + rng() * 1.7 : 0.45 + rng() * 0.5,
        rot: rng() * TAU, v: rng(),
      });
    }
  }

  return {
    seed: s, noise, shoreAtAngle, shoreRadius, baseHeight, heightAt, slopeAt,
    depthAt: (x, z) => Math.max(0, -heightAt(x, z)),
    dock, hole, flat, holes, flats, baseShoreDock, structures,
    /** 底質（'mud' | 'sand' | 'rock'）。slope を渡せば計算を節約できる */
    bedAt(x, z, slope = null) {
      const v = bedValue(x, z, slope ?? slopeAt(x, z));
      return { v, kind: bedKindOf(v) };
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
  // 各層が「一番飛ぶ竿で届く」かどうか
  const bands = { shallow: false, mid: false, deep: false, veryDeep: false };
  // 最初の竿で届く範囲（スタートの遊びやすさと、淵の遠さを見る）
  const startBands = { shallow: false, mid: false, deep: false, veryDeep: false };
  let startMaxDepth = 0;
  /* 深淵（20m+）のサンプルが最初の竿の範囲でどれだけ「よくある」か。
     地形は棚のヘリ（かけあがり）が急なので、「1点も届かない」を求めると
     ほぼ全ての湖が不合格になる。「稀にしか無い」に緩めて割合で見る */
  let startWaterN = 0, startVeryDeepN = 0;

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
        if (dist <= CAST_START) {
          if (d > startMaxDepth) startMaxDepth = d;
          if (d >= 1.0 && d <= 4.0) startBands.shallow = true;
          if (d >= 5.0 && d <= 10.0) startBands.mid = true;
          if (d >= 12.0 && d <= 18.0) startBands.deep = true;
          if (d >= 20.0) startBands.veryDeep = true;
          startWaterN++;
          if (d >= 20.0) startVeryDeepN++;
        }
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

  /* 全魚種の生息水深（depthFit が 1 になる窓）が届く範囲にあるか。
     判定はゲーム本体と同じ depthFit を使う */
  const unreachable = REAL_FISH.filter((sp) => {
    const lo = sp.depth[0], hi = sp.depth[1];
    const reach = maxDepth >= lo && minDepth <= hi;
    return !reach || depthFit(sp, clamp(maxDepth, lo, hi)) < 1;
  }).map((sp) => sp.name);

  const startVeryDeepFrac = startWaterN ? startVeryDeepN / startWaterN : 0;

  return {
    bands, startBands, startMaxDepth, startVeryDeepFrac,
    minDepth, maxDepth, minFromDock, maxFromDock, dockTipDepth,
    holeDepth, flatDepth, holeFromDock, flatFromDock, holeFlatGap,
    holeInset: lake.hole.inset, flatInset: lake.flat.inset,
    holeAmp: lake.hole.amp, flatAmp: lake.flat.amp,
    landInLake, minLakeDepth, shoreMin, shoreMax, shoreSlope,
    dockClearance, dockY: lake.dock.y,
    shoreR0: lake.dock.r0, deepSpot, shallowSpot, unreachable,
    structures: lake.structures.length,
    /* 桟橋の先端からキャストで届くストラクチャーの数。CAST_MAX（一番良い竿）基準：
       「そこに何か狙う目標がある」かどうかの話であって、今の竿の話ではない。
       CAST_START で縛ると、最初の竿が短いほど桟橋際に構造物を詰め込む必要が出て、
       他の地形条件と衝突する */
    structNearDock: lake.structures.filter((t) =>
      Math.hypot(t.x - lake.dock.end.x, t.z - lake.dock.end.z) <= CAST_MAX).length,
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
  /* 淵は「最初の竿では届かない・良い竿なら届く」帯に入っていること。
     近すぎると竿を替える理由がなくなり、遠すぎると一生届かない */
  if (!(S.holeFromDock > CAST_START + 6)) bad.push(`淵が桟橋に近すぎる＝最初の竿で届く (${S.holeFromDock.toFixed(1)}m)`);
  if (!(S.holeFromDock <= CAST_MAX - 8)) bad.push(`淵が桟橋から遠すぎる (${S.holeFromDock.toFixed(1)}m)`);
  /* 最初の竿は意図的にごく短い（cast=10m）ので、浅場・中層が必ず届く
     ことまでは求めない（求めると、地形のかけあがりの都合でほぼ全ての湖が
     不合格になる）。ここで見るのは「深淵（20m+・レジェンドの主戦場）が
     ありふれていないか」だけ＝竿を買い替える動機を壊さないこと。
     「1点も届かない」を求めるとやはりほぼ全ての湖が不合格になるので
     （実測 3%）、サンプルに占める割合で見て、稀にしか無ければ良しとする */
  if (S.startVeryDeepFrac > 0.06) bad.push(`最初の竿でも深淵(20m+)がありふれている (${(S.startVeryDeepFrac * 100).toFixed(0)}%)`);
  if (!(S.holeInset >= 18)) bad.push(`淵が岸に近すぎる (${S.holeInset.toFixed(1)}m)`);
  if (!(S.flatDepth >= 1.4 && S.flatDepth <= 4.6)) bad.push(`藻場の水深が不適 (${S.flatDepth.toFixed(1)}m)`);
  if (!(S.flatInset >= 6)) bad.push(`藻場が岸に近すぎる (${S.flatInset.toFixed(1)}m)`);
  if (!(S.holeFlatGap >= 45)) bad.push(`淵と藻場が近すぎる (${S.holeFlatGap.toFixed(1)}m)`);
  if (!(S.shoreSlope <= 1.4)) bad.push(`桟橋の付け根が崖 (勾配 ${S.shoreSlope.toFixed(2)})`);
  if (!(S.dockClearance >= 0.25)) bad.push(`桟橋が地形に埋まる (余裕 ${S.dockClearance.toFixed(2)}m)`);
  if (S.unreachable.length) bad.push(`届かない魚種: ${S.unreachable.join(',')}`);
  if (!(S.structures >= 7)) bad.push(`水中ストラクチャーが少ない (${S.structures}個)`);
  if (!(S.structNearDock >= 2)) bad.push(`桟橋から狙えるストラクチャーがない (${S.structNearDock}個)`);

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
