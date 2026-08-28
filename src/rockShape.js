/* ===========================================================
   岩の形状生成（THREE 非依存）

   RockGenerator（dgreenheck ほか, MIT）と同じ工程を踏む。
     基本形状 → ノイズ変形 → 角の欠け → 熱侵食 → 頂点 AO
   苔だけは «焼かない»。インスタンスごとにランダム回転させるので、
   ローカル法線で焼くと回転後に横面や下面へ苔が付いてしまう。
   苔はシェーダ側でワールド法線から出す（rocks.js）。

   出力は素の配列なので Node の回帰テストから直接呼べる。
   =========================================================== */
import { clamp01, lerp, smoothstep } from './util.js';

/* ---------------- 3D 勾配ノイズ ---------------- */

/** 決定論的な 3D 勾配ノイズ。岩肌は 3 次元なので 2D では巻けない */
export function makeNoise3D(seed = 1) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const SIZE = 256;
  const perm = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i++) perm[i] = i;
  for (let i = SIZE - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  // 単位球上の勾配ベクトル
  const gx = new Float32Array(SIZE), gy = new Float32Array(SIZE), gz = new Float32Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
    const z = rnd() * 2 - 1;
    const ang = rnd() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    gx[i] = Math.cos(ang) * r; gy[i] = z; gz[i] = Math.sin(ang) * r;
  }
  const hash = (i, j, k) => perm[(perm[(perm[i & 255] + (j & 255)) & 255] + (k & 255)) & 255];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

  /** -1..1 */
  function noise(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = fade(xf), v = fade(yf), w = fade(zf);
    let acc = 0;
    for (let dz = 0; dz < 2; dz++) {
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const h = hash(xi + dx, yi + dy, zi + dz);
          const ex = xf - dx, ey = yf - dy, ez = zf - dz;
          const dot = gx[h] * ex + gy[h] * ey + gz[h] * ez;
          const wx = dx ? u : 1 - u, wy = dy ? v : 1 - v, wz = dz ? w : 1 - w;
          acc += dot * wx * wy * wz;
        }
      }
    }
    return clamp01(acc * 0.85 + 0.5) * 2 - 1;
  }

  /** オクターブを重ねる */
  noise.fbm = (x, y, z, oct = 4, lac = 2.03, gain = 0.5) => {
    let s = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      s += amp * noise(x * f, y * f, z * f);
      norm += amp;
      f *= lac; amp *= gain;
    }
    return s / (norm || 1);
  };
  /** 稜線ノイズ。割れ目や崩れた稜に効く */
  noise.ridge = (x, y, z, oct = 3) => {
    let s = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      s += amp * (1 - Math.abs(noise(x * f, y * f, z * f)));
      norm += amp;
      f *= 2.07; amp *= 0.5;
    }
    return s / (norm || 1);
  };
  return noise;
}

/* ---------------- 基本形状（icosphere） ---------------- */

/**
 * 正二十面体を detail 回分割した球。三角形数は 20 * 4^detail。
 * UV は付けない（岩は triplanar で貼るので UV は要らないし、
 * 球の UV は極で必ず伸びる）。
 */
export function icosphere(detail = 2) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(([x, y, z]) => {
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
  });
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  for (let d = 0; d < detail; d++) {
    const mid = new Map();
    const next = [];
    const midpoint = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const hit = mid.get(key);
      if (hit !== undefined) return hit;
      const va = verts[a], vb = verts[b];
      let x = va[0] + vb[0], y = va[1] + vb[1], z = va[2] + vb[2];
      const l = Math.hypot(x, y, z);
      x /= l; y /= l; z /= l;
      const idx = verts.length;
      verts.push([x, y, z]);
      mid.set(key, idx);
      return idx;
    };
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  return { verts, faces };
}

/* ---------------- 形状プリセット ---------------- */
/*
  RockGenerator の 12 プリセットのうち、湖畔で使う 4 つだけ。
    boulder 丸みのある転石。水際に転がっている主役
    rubble  角の立った崩れ石。がれ場
    slab    平たい板状。水面から少しだけ出る «踏み石» になる
    ledge   片側が持ち上がった段。岸の張り出し
  scale は分割前の異方スケール、shear は上へ行くほど横へずらす量。
*/
export const ROCK_PRESETS = {
  boulder: {
    scale: [1.0, 0.82, 0.95], shear: 0.10,
    amp: 0.20, freq: 1.5, oct: 4,
    ridgeAmp: 0.06, ridgeFreq: 2.6,
    chip: 0.10, chipThreshold: 0.55,
    erosion: { passes: 2, talus: 0.62, rate: 0.35 },
    flatBottom: 0.24,
  },
  rubble: {
    scale: [1.0, 0.72, 0.88], shear: 0.16,
    amp: 0.26, freq: 2.1, oct: 4,
    ridgeAmp: 0.16, ridgeFreq: 3.4,
    // 角を強く欠かせると «割れた石» になる
    chip: 0.24, chipThreshold: 0.34,
    erosion: { passes: 1, talus: 0.85, rate: 0.22 },
    flatBottom: 0.16,
  },
  slab: {
    scale: [1.15, 0.34, 1.0], shear: 0.08,
    amp: 0.14, freq: 1.7, oct: 3,
    ridgeAmp: 0.05, ridgeFreq: 2.2,
    chip: 0.16, chipThreshold: 0.42,
    erosion: { passes: 3, talus: 0.42, rate: 0.42 },
    flatBottom: 0.42,
  },
  ledge: {
    scale: [1.05, 0.62, 0.78], shear: 0.34,
    amp: 0.18, freq: 1.6, oct: 4,
    ridgeAmp: 0.10, ridgeFreq: 2.8,
    chip: 0.14, chipThreshold: 0.46,
    erosion: { passes: 2, talus: 0.55, rate: 0.30 },
    flatBottom: 0.30,
  },
};

export const ROCK_KINDS = Object.keys(ROCK_PRESETS);

/* ---------------- 生成 ---------------- */

/** LOD をどの分割から切り出すか。ここより細かい段は作らない */
export const BASE_DETAIL = 3;

/** detail 段の頂点数。icosphere は分割で «元の頂点を保ったまま» 中点を足す */
export const vertCountFor = (detail) => 10 * 4 ** detail + 2;

/**
 * 岩を 1 つ作る。LOD の各段を «同じ頂点集合の部分» として返す。
 *
 * icosphere の分割は元の頂点を保って中点を追記していくので、
 * detail=1 の 42 頂点は detail=3 の 642 頂点の «先頭 42 個» と一致する。
 * だから工程は最高分割で 1 回だけ回し、粗い段はその頂点を切り出して
 * 粗い面で張り直せばよい。
 *
 * 段ごとに工程を回し直すと、角の欠けも熱侵食も «近傍» を見るので
 * 結果が変わり、正規化の基準も変わる。すると LOD が切り替わった瞬間に
 * 岩の形そのものが動いて «近づくといきなり形が変わる» ように見える。
 *
 * @param {string} kind ROCK_PRESETS のキー
 * @param {number} seed 形を決める種
 * @param {{details?: number[]}} opts 欲しい段（降順でなくてよい）
 * @returns {Array<{position, normal, cavity, index, tris}>} details と同順
 */
export function makeRockLods(kind, seed, { details = [3, 2, 1] } = {}) {
  const full = makeRockShape(kind, seed, { detail: BASE_DETAIL });
  return details.map((d) => {
    if (d >= BASE_DETAIL) return full;
    const n = vertCountFor(d);
    const faces = icosphere(d).faces;
    const position = full.position.slice(0, n * 3);
    const cavity = full.cavity.slice(0, n);
    // 法線は «粗い面» から取り直す。細かい面の法線を残すと平らな面が歪んで光る
    const normal = vertexNormals(position, faces, n);
    const index = new (n > 65535 ? Uint32Array : Uint16Array)(faces.length * 3);
    for (let i = 0; i < faces.length; i++) {
      index[i * 3] = faces[i][0];
      index[i * 3 + 1] = faces[i][1];
      index[i * 3 + 2] = faces[i][2];
    }
    return { position, normal, cavity, index, tris: faces.length };
  });
}

/**
 * 岩を 1 つ作る（単段）。LOD を並べるときは makeRockLods を使うこと。
 *
 * @param {string} kind ROCK_PRESETS のキー
 * @param {number} seed 形を決める種
 * @param {{detail?: number}} opts
 * @returns {{position: Float32Array, normal: Float32Array, cavity: Float32Array,
 *            index: Uint16Array|Uint32Array, tris: number}}
 */
export function makeRockShape(kind, seed, { detail = 2 } = {}) {
  const p = ROCK_PRESETS[kind];
  if (!p) throw new Error(`unknown rock preset: ${kind}`);
  const noise = makeNoise3D(seed);
  const { verts, faces } = icosphere(detail);
  const n = verts.length;

  /* --- 異方スケール + せん断 --- */
  const V = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = verts[i];
    V[i * 3] = x * p.scale[0] + y * p.shear;
    V[i * 3 + 1] = y * p.scale[1];
    V[i * 3 + 2] = z * p.scale[2];
  }

  /* --- ノイズ変形 ---
     法線方向へ押し出す。fbm で大きなうねりを、ridge で割れ目に近い
     «稜» を足す。ridge を引き算にすると溝になる */
  for (let i = 0; i < n; i++) {
    let x = V[i * 3], y = V[i * 3 + 1], z = V[i * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    const nx = x / l, ny = y / l, nz = z / l;
    const f = p.freq;
    const d = noise.fbm(x * f, y * f, z * f, p.oct) * p.amp
      - noise.ridge(x * p.ridgeFreq, y * p.ridgeFreq, z * p.ridgeFreq) * p.ridgeAmp;
    V[i * 3] = x + nx * d;
    V[i * 3 + 1] = y + ny * d;
    V[i * 3 + 2] = z + nz * d;
  }

  /* --- 近傍表 --- */
  const nb = buildNeighbours(n, faces);

  /* --- 角の欠け ---
     出っ張っている（凸な）頂点だけを法線方向へ引っ込める。
     一様に縮めると丸くなるだけなので、凸性でしきい値を切る */
  chipEdges(V, nb, n, p, noise);

  /* --- 熱侵食 ---
     隣より高すぎる頂点を下げる。実際の転石は上面が «座った» 形になる */
  thermalErode(V, nb, n, p.erosion);

  /* --- 底面を平らにする ---
     地面に置く物なので、底が丸いと «浮いている» か «沈んでいる» に見える */
  let minY = Infinity;
  for (let i = 0; i < n; i++) minY = Math.min(minY, V[i * 3 + 1]);
  const cut = minY + p.flatBottom * 0.5;
  for (let i = 0; i < n; i++) {
    if (V[i * 3 + 1] < cut) V[i * 3 + 1] = lerp(V[i * 3 + 1], cut, 0.85);
  }

  /* --- 原点を «底面中央» に合わせる ---
     配置側で地面の高さへ素直に置けるようにする */
  let cx = 0, cz = 0;
  minY = Infinity;
  for (let i = 0; i < n; i++) {
    cx += V[i * 3]; cz += V[i * 3 + 2];
    minY = Math.min(minY, V[i * 3 + 1]);
  }
  cx /= n; cz /= n;
  let maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    V[i * 3] -= cx; V[i * 3 + 1] -= minY; V[i * 3 + 2] -= cz;
    maxY = Math.max(maxY, V[i * 3 + 1]);
    minX = Math.min(minX, V[i * 3]); maxX = Math.max(maxX, V[i * 3]);
    minZ = Math.min(minZ, V[i * 3 + 2]); maxZ = Math.max(maxZ, V[i * 3 + 2]);
  }
  /* «最大辺» で 1 に正規化する。高さだけで正規化すると、平たい slab は
     横が高さの 2.4 倍あるので «高さ 3.4m の板» が幅 8m の巨石になる。
     最大辺で揃えれば、配置側の scale がそのまま «岩のいちばん長い辺(m)» */
  const inv = 1 / Math.max(maxY, maxX - minX, maxZ - minZ, 1e-6);
  for (let i = 0; i < n * 3; i++) V[i] *= inv;

  const normal = vertexNormals(V, faces, n);
  const cavity = vertexCavity(V, normal, nb, n);

  const position = new Float32Array(V);
  const IndexArray = n > 65535 ? Uint32Array : Uint16Array;
  const index = new IndexArray(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    index[i * 3] = faces[i][0];
    index[i * 3 + 1] = faces[i][1];
    index[i * 3 + 2] = faces[i][2];
  }
  return { position, normal, cavity, index, tris: faces.length };
}

function buildNeighbours(n, faces) {
  const sets = Array.from({ length: n }, () => new Set());
  for (const [a, b, c] of faces) {
    sets[a].add(b); sets[a].add(c);
    sets[b].add(a); sets[b].add(c);
    sets[c].add(a); sets[c].add(b);
  }
  return sets.map((s) => Array.from(s));
}

/** 凸な頂点を引っ込めて角を欠かせる */
function chipEdges(V, nb, n, p, noise) {
  if (p.chip <= 0) return;
  const conv = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const list = nb[i];
    let ax = 0, ay = 0, az = 0;
    for (const j of list) { ax += V[j * 3]; ay += V[j * 3 + 1]; az += V[j * 3 + 2]; }
    ax /= list.length; ay /= list.length; az /= list.length;
    const dx = V[i * 3] - ax, dy = V[i * 3 + 1] - ay, dz = V[i * 3 + 2] - az;
    const l = Math.hypot(V[i * 3], V[i * 3 + 1], V[i * 3 + 2]) || 1;
    // 半径方向へどれだけ飛び出しているか
    conv[i] = (dx * V[i * 3] + dy * V[i * 3 + 1] + dz * V[i * 3 + 2]) / l;
  }
  let maxC = 1e-6;
  for (let i = 0; i < n; i++) maxC = Math.max(maxC, conv[i]);
  for (let i = 0; i < n; i++) {
    const c = conv[i] / maxC;
    if (c < p.chipThreshold) continue;
    const w = smoothstep(p.chipThreshold, 1, c);
    // 欠けは場所によってばらつく（全部の角が同じだけ欠けると人工的）
    const jitter = 0.45 + 0.55 * (noise(V[i * 3] * 4.1, V[i * 3 + 1] * 4.1, V[i * 3 + 2] * 4.1) * 0.5 + 0.5);
    const l = Math.hypot(V[i * 3], V[i * 3 + 1], V[i * 3 + 2]) || 1;
    const k = 1 - (p.chip * w * jitter) / l;
    V[i * 3] *= k; V[i * 3 + 1] *= k; V[i * 3 + 2] *= k;
  }
}

/**
 * 熱侵食。隣より talus より高い頂点を下げ、その分を隣へ寄せる。
 * 回数を増やすほど上面が平らに «座る»。
 */
function thermalErode(V, nb, n, { passes = 2, talus = 0.6, rate = 0.35 } = {}) {
  for (let pass = 0; pass < passes; pass++) {
    const dy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (const j of nb[i]) {
        const dx = V[i * 3] - V[j * 3], dz = V[i * 3 + 2] - V[j * 3 + 2];
        const horiz = Math.hypot(dx, dz) || 1e-6;
        const drop = V[i * 3 + 1] - V[j * 3 + 1];
        if (drop / horiz > talus) {
          const move = (drop - talus * horiz) * rate * 0.5;
          dy[i] -= move; dy[j] += move;
        }
      }
    }
    for (let i = 0; i < n; i++) V[i * 3 + 1] += dy[i] / Math.max(nb[i].length, 1);
  }
}

function vertexNormals(V, faces, n) {
  const N = new Float32Array(n * 3);
  for (const [a, b, c] of faces) {
    const ax = V[a * 3], ay = V[a * 3 + 1], az = V[a * 3 + 2];
    const ux = V[b * 3] - ax, uy = V[b * 3 + 1] - ay, uz = V[b * 3 + 2] - az;
    const vx = V[c * 3] - ax, vy = V[c * 3 + 1] - ay, vz = V[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) {
      N[i * 3] += nx; N[i * 3 + 1] += ny; N[i * 3 + 2] += nz;
    }
  }
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1;
    N[i * 3] /= l; N[i * 3 + 1] /= l; N[i * 3 + 2] /= l;
  }
  return N;
}

/**
 * 頂点 AO の代わりに «窪み具合» を焼く。
 * 半球サンプリングのレイキャストは重いので、隣の平均より内側に
 * 引っ込んでいる量で近似する。窪みは暗く、苔や泥も溜まりやすい。
 * 回転しても変わらない量なので、インスタンス化しても正しい。
 */
export function vertexCavity(V, N, nb, n) {
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const list = nb[i];
    let ax = 0, ay = 0, az = 0, scale = 0;
    for (const j of list) {
      ax += V[j * 3]; ay += V[j * 3 + 1]; az += V[j * 3 + 2];
      scale += Math.hypot(V[j * 3] - V[i * 3], V[j * 3 + 1] - V[i * 3 + 1], V[j * 3 + 2] - V[i * 3 + 2]);
    }
    const k = list.length;
    ax /= k; ay /= k; az /= k;
    scale = scale / k || 1e-6;
    // 法線方向に見て、隣の平均より «内» にあれば窪み
    raw[i] = ((ax - V[i * 3]) * N[i * 3] + (ay - V[i * 3 + 1]) * N[i * 3 + 1]
      + (az - V[i * 3 + 2]) * N[i * 3 + 2]) / scale;
  }
  /* 岩はほぼ凸なので、生の値は大半が «凸側» に寄る。絶対値でしきい値を
     切ると窪みがほぼ 0 になって AO も苔も効かない。
     分布の 15〜90 パーセンタイルで正規化して、その岩の中での
     «相対的に窪んでいる所» を出す */
  const sorted = Array.from(raw).sort((a, b) => a - b);
  const lo = sorted[Math.floor(n * 0.15)];
  const hi = sorted[Math.min(n - 1, Math.floor(n * 0.90))];
  const span = Math.max(hi - lo, 1e-6);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = clamp01((raw[i] - lo) / span);
  return out;
}
