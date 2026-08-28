/* ===========================================================
   樹木の骨格生成（THREE 非依存）

   枝を「先細りの折れ線」として再帰的に伸ばし、最終レベルの枝に葉を撒く。
   ここでは座標だけを作り、チューブ化・葉カード化は trees.js が行う。
   THREE を import しないので Node の回帰テストから直接呼べる。

   考え方は EZ-Tree（dgreenheck/ez-tree, MIT）と同じで、
   「1 本の枝＝進行方向を少しずつ乱しながら伸ばす折れ線」を再帰させる。
   本物らしさは枝分かれの角度そのものより、
     - 枝の付け根が親のどこに付くか（startAt / 方位の散らし方）
     - 高さによって枝の長さが変わるか（lengthAtHeight）
     - 先端が上を向くか垂れるか（gravity）
   で決まるので、樹種の差はこの 3 つに集約している。
   =========================================================== */
import { TAU, clamp01, lerp } from './util.js';

/* ---------------- 小さなベクトル演算 ---------------- */
const v = (x = 0, y = 0, z = 0) => ({ x, y, z });
const add = (a, b) => v(a.x + b.x, a.y + b.y, a.z + b.z);
const mul = (a, s) => v(a.x * s, a.y * s, a.z * s);
const len = (a) => Math.hypot(a.x, a.y, a.z);
function norm(a) {
  const l = len(a) || 1;
  return v(a.x / l, a.y / l, a.z / l);
}
function cross(a, b) {
  return v(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}
/** a に直交する単位ベクトルを 1 本返す（a が上向きでも縮退しない） */
function anyPerp(a) {
  const ref = Math.abs(a.y) > 0.92 ? v(1, 0, 0) : v(0, 1, 0);
  return norm(cross(a, ref));
}
/** 軸 axis まわりに v を ang 回す（ロドリゲス） */
function rotAxis(p, axis, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const k = cross(axis, p);
  const d = axis.x * p.x + axis.y * p.y + axis.z * p.z;
  return v(
    p.x * c + k.x * s + axis.x * d * (1 - c),
    p.y * c + k.y * s + axis.y * d * (1 - c),
    p.z * c + k.z * s + axis.z * d * (1 - c)
  );
}
/** 単位球上の一様乱数 */
function randDir(rng) {
  const z = rng() * 2 - 1;
  const a = rng() * TAU;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return v(Math.cos(a) * r, z, Math.sin(a) * r);
}

/* ---------------- 樹種 ---------------- */
/*
  height       : 樹高（m）。実際にはこの ±15% で振れる
  levels[i]    : 深さ i の枝のパラメータ
    segments     折れ線の分割数（多いほど幹が滑らかに曲がる）
    taper        枝先の半径 / 付け根の半径
    gnarliness   1m 進むごとに向きへ足す乱れの量（節くれ）
    gravity      1m 進むごとに足す上下バイアス。+ で立ち上がり - で垂れる
    count        親 1 本あたりの子の本数
    startAt      親のどこから子を出し始めるか（0=根元, 1=先端）
    endAt        どこまで出すか
    angle        親からの開き角（rad）
    lengthScale  親の長さに対する比
    radiusScale  親の半径に対する比
    lengthAtHeight(t) 親のどの高さから出たかで長さを補正する。
                 これが樹形そのもの：スギは上ほど短くして円錐、
                 ブナは中段を長くして盃状にする
*/
export const SPECIES = {
  /* ブナ（Fagus crenata）
     灰白色のなめらかな幹。低い位置で数本に分かれ、枝先が上へ立ち上がって
     盃状〜ドーム状の広い樹冠を作る。葉は小さく明るい黄緑。 */
  beech: {
    id: 'beech',
    nameJa: 'ブナ',
    height: 21,
    trunkRadius: 0.40,
    crownRatio: 0.36,        // 樹冠半径 / 樹高（当たり判定と LOD 用の目安）
    barkColor: 0xa9a79c,     // 灰白。地衣類の斑は trees.js のテクスチャ側で足す
    leafColor: 0x6f9440,
    leafSize: 0.80,          // 葉 1 枚ではなく「小枝ひと房」を 1 カードで表す
    leafPerTip: 22,
    leafLevels: 2,           // 最終段だけだと樹冠の内側が抜ける
    levels: [
      { segments: 8, taper: 0.34, gnarliness: 0.055, gravity: 0.05 },
      {
        segments: 6, taper: 0.30, gnarliness: 0.16, gravity: 0.16,
        count: 4, startAt: 0.30, endAt: 0.94, angle: 0.86,
        lengthScale: 0.62, radiusScale: 0.44,
        // 中段の枝を一番長くする＝盃状に開く
        lengthAtHeight: (t) => lerp(1.25, 0.55, clamp01((t - 0.3) / 0.64)),
      },
      {
        segments: 5, taper: 0.28, gnarliness: 0.26, gravity: 0.24,
        count: 3, startAt: 0.24, endAt: 0.96, angle: 0.74,
        lengthScale: 0.58, radiusScale: 0.42,
        lengthAtHeight: () => 1,
      },
      {
        segments: 3, taper: 0.30, gnarliness: 0.34, gravity: 0.20,
        count: 3, startAt: 0.20, endAt: 1.0, angle: 0.66,
        lengthScale: 0.52, radiusScale: 0.42,
        lengthAtHeight: () => 1,
      },
    ],
  },

  /* スギ（Cryptomeria japonica）
     まっすぐ 1 本の主幹が頂まで抜ける（excurrent）。枝は短く輪生し、
     上ほど短いので細い円錐になる。葉は濃い青緑の房。 */
  cedar: {
    id: 'cedar',
    nameJa: 'スギ',
    height: 27,
    trunkRadius: 0.44,
    crownRatio: 0.20,
    barkColor: 0x6d4a37,     // 赤褐色の縦裂
    leafColor: 0x33512f,
    leafSize: 0.95,          // 房を大きく取って枚数を増やさずに密度を出す
    leafPerTip: 8,
    leafLevels: 2,
    levels: [
      // 主幹はほとんど曲がらない
      { segments: 10, taper: 0.10, gnarliness: 0.012, gravity: 0 },
      {
        segments: 4, taper: 0.26, gnarliness: 0.10, gravity: -0.18,
        count: 34, startAt: 0.14, endAt: 0.99, angle: 1.16,
        lengthScale: 0.150, radiusScale: 0.20,
        // 根元で長く頂で短い＝円錐。裾を少し絞って傘状にしない
        lengthAtHeight: (t) => lerp(1.35, 0.16, clamp01((t - 0.16) / 0.84)) * lerp(0.7, 1, clamp01(t / 0.3)),
      },
      {
        segments: 3, taper: 0.30, gnarliness: 0.20, gravity: -0.22,
        count: 3, startAt: 0.30, endAt: 1.0, angle: 0.62,
        lengthScale: 0.46, radiusScale: 0.40,
        lengthAtHeight: () => 1,
      },
    ],
  },
};

export const SPECIES_IDS = Object.keys(SPECIES);

/**
 * 骨格を作る。
 * @param {string} kind SPECIES のキー
 * @param {() => number} rng [0,1) を返す決定論的乱数
 * @param {{levels?: number}} opts levels で枝の再帰段数を打ち切る（LOD 用ではなく形の調整用）
 * @returns {{branches: Array, leaves: Array, height: number, crownR: number, species: object}}
 */
export function growTree(kind, rng, { levels } = {}) {
  const sp = SPECIES[kind];
  if (!sp) throw new Error(`unknown species: ${kind}`);
  const maxLevel = Math.min(levels ?? sp.levels.length, sp.levels.length) - 1;

  const branches = [];
  const leaves = [];
  const height = sp.height * (0.85 + rng() * 0.3);
  const trunkLen = height * (sp.id === 'cedar' ? 0.98 : 0.62);

  /**
   * 枝を 1 本伸ばして折れ線にし、子枝と葉を再帰的に付ける。
   * heightT は「この枝が親のどこから出たか」。樹形はここで効く。
   */
  function branchOut(level, origin, dir0, length, radius, heightT) {
    const p = sp.levels[level];
    const step = length / p.segments;
    let d = norm(dir0);
    let cur = origin;
    const points = [{ x: cur.x, y: cur.y, z: cur.z, r: radius }];
    for (let i = 1; i <= p.segments; i++) {
      const t = i / p.segments;
      // 節くれ（進行方向を毎ステップ少し乱す）
      d = norm(add(d, mul(randDir(rng), p.gnarliness * step)));
      // 上下バイアス。枝先が立ち上がる／垂れるのはここ
      d = norm(add(d, v(0, p.gravity * step, 0)));
      cur = add(cur, mul(d, step));
      points.push({ x: cur.x, y: cur.y, z: cur.z, r: radius * lerp(1, p.taper, t) });
    }
    const bi = branches.length;
    branches.push({ level, points, heightT });

    /* 葉は最終段だけでなく 1 段手前にも付ける（leafLevels）。
       最終段だけだと樹冠の内側が空洞になり、外殻に葉を貼った風船に見える */
    const leafFrom = maxLevel - ((sp.leafLevels ?? 1) - 1);
    if (level >= leafFrom) placeLeaves(bi, points, level, level === maxLevel ? 1 : 0.5);
    if (level >= maxLevel) return;

    const cp = sp.levels[level + 1];
    const n = Math.max(1, Math.round(cp.count * (0.75 + rng() * 0.5)));
    /* 方位は黄金角で回す。等分だと輪生が揃いすぎて人工物に見え、
       完全な乱数だと片側に固まって禿げる */
    const golden = Math.PI * (3 - Math.sqrt(5));
    let az = rng() * TAU;
    for (let i = 0; i < n; i++) {
      az += golden + (rng() - 0.5) * 0.5;
      const f = cp.startAt + (cp.endAt - cp.startAt) * ((i + 0.5) / n + (rng() - 0.5) * 0.14);
      const at = clamp01(f);
      const { pos, tan, r } = sampleAlong(points, at);
      // 親の接線から angle だけ倒し、方位 az で回す
      const perp = anyPerp(tan);
      const axis = rotAxis(perp, tan, az);
      const childDir = rotAxis(tan, axis, cp.angle * (0.78 + rng() * 0.44));
      const hT = level === 0 ? at : heightT;
      const cl = length * cp.lengthScale * cp.lengthAtHeight(hT) * (0.78 + rng() * 0.44);
      branchOut(level + 1, pos, childDir, Math.max(cl, 0.12), Math.max(r * cp.radiusScale, 0.008), hT);
    }
  }

  /** 最終レベルの枝に沿って葉カードを撒く */
  function placeLeaves(branchIdx, points, level, density = 1) {
    const n = Math.max(1, Math.round(sp.leafPerTip * density));
    for (let i = 0; i < n; i++) {
      const at = 0.12 + 0.88 * ((i + rng()) / n);
      const { pos, tan } = sampleAlong(points, at);
      // 枝の接線まわりにランダムな方位で、少し外へ倒して付ける
      const perp = rotAxis(anyPerp(tan), tan, rng() * TAU);
      const dir = norm(add(mul(tan, 0.45), mul(perp, 0.9)));
      leaves.push({
        x: pos.x, y: pos.y, z: pos.z,
        dx: dir.x, dy: dir.y, dz: dir.z,
        size: sp.leafSize * (0.7 + rng() * 0.6),
        roll: rng() * TAU,
        branch: branchIdx,
        level,
      });
    }
  }

  branchOut(0, v(0, 0, 0), v(0, 1, 0), trunkLen, sp.trunkRadius, 0);

  let crownR = 0, top = 0;
  for (const l of leaves) {
    crownR = Math.max(crownR, Math.hypot(l.x, l.z));
    top = Math.max(top, l.y);
  }
  for (const b of branches) {
    for (const q of b.points) top = Math.max(top, q.y);
  }
  return { branches, leaves, height: top, crownR, species: sp };
}

/** 折れ線上の位置 at∈[0,1]（弧長ではなく点の等分）を補間して返す */
export function sampleAlong(points, at) {
  const n = points.length - 1;
  const f = clamp01(at) * n;
  const i = Math.min(Math.floor(f), n - 1);
  const u = f - i;
  const a = points[i], b = points[i + 1];
  const pos = v(lerp(a.x, b.x, u), lerp(a.y, b.y, u), lerp(a.z, b.z, u));
  const tan = norm(v(b.x - a.x, b.y - a.y, b.z - a.z));
  return { pos, tan, r: lerp(a.r, b.r, u) };
}

/* ---------------- LOD ---------------- */

/**
 * 距離のしきい値。木は 2000 本あるので、近景だけ本気のジオメトリにして
 * 中景を軽い枝、遠景を板 1 枚（インポスター）に落とす。
 * 近景の面積は半径の 2 乗で効くので、ここを詰めるだけで本数を倍にできる。
 */
export const LOD_DIST = [34, 105];

/**
 * どの LOD を使うか。境界でパタパタ切り替わらないよう、
 * いま使っている LOD から離れる方向にだけヒステリシスを付ける。
 * @param {number} dist カメラからの距離
 * @param {number} cur いま割り当てられている LOD（初回は -1）
 * @param {number} hyst 境界の遊び幅（m）
 */
export function lodFor(dist, cur = -1, hyst = 8) {
  let lod = 0;
  for (let i = 0; i < LOD_DIST.length; i++) {
    /* すでに粗い側にいるなら内側の境界まで戻らないと細かい側へ復帰しない。
       境界をまたいで往復するときの再アップロードを止めるのが目的 */
    const edge = cur > i ? LOD_DIST[i] - hyst : LOD_DIST[i] + hyst;
    if (dist > edge) lod = i + 1;
  }
  return lod;
}
