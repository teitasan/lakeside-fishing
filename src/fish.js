/* ===========================================================
   魚：プロシージャル生成メッシュ + 遊泳AI
   =========================================================== */
import * as THREE from 'three';
import { CAUSTICS_GLSL } from './shaders.js?v=20260830-zone5';
import { clamp, clamp01, lerp, rand, smoothstep, TAU, damp } from './util.js?v=20260830-zone5';
import { depthBandAt, colorsOf } from './data.js';
import { textureTypeFor, fishTexture, FIN_UV } from './fishTextures.js';

/** 見やすさのための視覚倍率（実寸だと小さすぎるため） */
export const VIS_SCALE = 1.4;

/* ---------------- 体型プロファイル ---------------- */
/* [t, radius] : t=0 尾びれ付け根 / t=1 口先 */
export const PROFILES = {
  slim: [[0, 0.05], [0.08, 0.11], [0.26, 0.44], [0.5, 0.86], [0.7, 1.0], [0.87, 0.74], [0.96, 0.36], [1, 0.03]],
  deep: [[0, 0.07], [0.1, 0.2], [0.3, 0.64], [0.55, 0.96], [0.72, 1.0], [0.86, 0.8], [0.95, 0.42], [1, 0.04]],
  wide: [[0, 0.06], [0.1, 0.17], [0.28, 0.52], [0.5, 0.9], [0.7, 1.0], [0.85, 0.92], [0.95, 0.52], [1, 0.06]],
  eel: [[0, 0.05], [0.15, 0.3], [0.4, 0.6], [0.62, 0.82], [0.78, 1.0], [0.9, 0.95], [0.97, 0.72], [1, 0.4]],
  gar: [[0, 0.05], [0.12, 0.22], [0.34, 0.6], [0.54, 0.92], [0.68, 1.0], [0.78, 0.72], [0.85, 0.34], [0.93, 0.18], [1, 0.08]],
  sturgeon: [[0, 0.05], [0.12, 0.2], [0.32, 0.62], [0.52, 0.94], [0.68, 1.0], [0.8, 0.68], [0.9, 0.34], [1, 0.04]],
};

/* 体高・体幅（体長に対する比） */
export const BODY = {
  slim: { h: 0.23, w: 0.115, dorsal: 0.16, tail: 0.20, fork: 0.55 },
  deep: { h: 0.40, w: 0.125, dorsal: 0.26, tail: 0.19, fork: 0.45 },
  wide: { h: 0.27, w: 0.16, dorsal: 0.19, tail: 0.20, fork: 0.40 },
  eel: { h: 0.17, w: 0.155, dorsal: 0.10, tail: 0.17, fork: 0.15 },
  gar: { h: 0.155, w: 0.13, dorsal: 0.11, tail: 0.12, fork: 0.18 },
  sturgeon: { h: 0.20, w: 0.16, dorsal: 0.14, tail: 0.16, fork: 0.35 },
};

/* ===========================================================
   種ごとの見た目（look）
   shape の粗い体型に、ヒレ形・口・模様・ヒゲなどを上乗せする
   =========================================================== */
const LOOK_BASE = {
  h: 1, w: 1, snout: 0,
  eye: 1, eyeX: 0.355, eyeY: 0.13,
  dorsalH: 1, dorsalX: 0.08, dorsalLen: 1, dorsalTip: 0.55,
  analH: 1, pec: 1,
  adipose: false, pelvic: true,
  tail: 'fork', fork: null, tailLen: 1,
  pattern: null,
  whiskers: 0, whiskerLen: 1,
  mouth: 'normal', // small | normal | wide | beak | up | sucker
  cheek: false, lateral: 0, ribbon: false, scutes: false,
  headFlat: 0, // ナマズ系の頭の扁平さ（体幅前方だけ広げる）
};

/** タグ・体型からの既定 look */
function defaultLook(sp) {
  const L = { ...LOOK_BASE };
  const t = sp.tags || [];
  if (t.includes('trout')) {
    L.adipose = true;
    L.pattern = 'spots';
    L.tail = 'softfork';
    L.h = 1.05;
    L.dorsalH = 0.85;
  }
  if (t.includes('carp')) {
    L.tail = 'fork';
    L.dorsalH = 1.15;
    L.dorsalLen = 1.35;
    L.mouth = 'sucker';
    L.whiskers = sp.shape === 'deep' || sp.shape === 'wide' ? 1 : 0;
    L.pattern = 'none';
  }
  if (t.includes('predator') && !t.includes('trout')) {
    L.pattern = L.pattern || 'blotch';
    L.mouth = 'wide';
    L.eye = 0.9;
  }
  if (sp.shape === 'eel') {
    L.tail = 'round';
    L.fork = 0.12;
    L.pattern = L.pattern || 'mottle';
    L.pelvic = false;
  }
  if (sp.shape === 'gar') {
    L.snout = 1;
    L.mouth = 'beak';
    L.eyeX = 0.30;
    L.dorsalX = -0.12;
    L.pattern = 'none';
  }
  if (sp.shape === 'sturgeon') {
    L.snout = 0.55;
    L.tail = 'hetero';
    L.scutes = true;
    L.whiskers = 2;
    L.whiskerLen = 0.55;
    L.mouth = 'sucker';
    L.eyeX = 0.28;
    L.pattern = 'none';
  }
  if (sp.shape === 'deep') {
    L.h = 1.08;
    L.dorsalH = 1.2;
  }
  if (sp.rarity === 1 && !L.pattern) L.pattern = 'none';
  return L;
}

/** 種 ID ごとの上書き（ここが「細かく分ける」本体） */
const SPECIES_LOOK = {
  medaka: {
    h: 0.78, w: 0.85, eye: 1.55, eyeX: 0.38, eyeY: 0.22,
    dorsalH: 0.55, dorsalLen: 0.7, analH: 0.55, pec: 0.7,
    tail: 'softfork', fork: 0.7, pattern: 'none', mouth: 'small',
  },
  moroko: {
    h: 0.88, w: 0.9, eye: 1.15, dorsalH: 0.75, dorsalLen: 0.85,
    tail: 'fork', fork: 0.65, pattern: 'none', mouth: 'small',
  },
  bluegill: {
    h: 1.22, w: 0.95, eye: 1.1, eyeX: 0.37,
    dorsalH: 1.55, dorsalLen: 1.45, dorsalTip: 0.35, analH: 1.25,
    tail: 'softfork', fork: 0.35, pattern: 'bars', cheek: true, mouth: 'small',
  },
  funa: {
    h: 1.12, w: 1.05, eye: 0.95, dorsalH: 1.35, dorsalLen: 1.55,
    tail: 'fork', fork: 0.4, pattern: 'none', mouth: 'sucker', whiskers: 0,
  },
  ugui: {
    h: 0.95, w: 0.92, eye: 1.05, dorsalH: 0.9,
    tail: 'fork', fork: 0.62, pattern: 'stripe', lateral: 0.55, mouth: 'normal',
  },
  dojo: {
    h: 0.72, w: 0.95, snout: 0.15, eye: 0.7, eyeX: 0.34, eyeY: 0.08,
    dorsalH: 0.45, dorsalLen: 0.9, analH: 0.5, pec: 0.55,
    tail: 'round', fork: 0.08, pattern: 'mottle', whiskers: 3, whiskerLen: 0.55,
    mouth: 'small', pelvic: false, headFlat: 0.15,
  },
  oikawa: {
    h: 0.92, w: 0.88, eye: 1.1, dorsalH: 1.05, dorsalLen: 0.95,
    tail: 'fork', fork: 0.68, pattern: 'none', mouth: 'small',
  },
  tanago: {
    h: 1.28, w: 0.9, eye: 1.2, eyeX: 0.36,
    dorsalH: 1.15, dorsalLen: 0.85, analH: 1.1, pec: 0.75,
    tail: 'softfork', fork: 0.4, pattern: 'none', mouth: 'small',
  },
  rainbow: {
    h: 1.02, w: 0.95, adipose: true, pattern: 'spots', lateral: 0.85,
    dorsalH: 0.9, tail: 'softfork', fork: 0.55, mouth: 'normal',
  },
  bass: {
    h: 1.15, w: 1.2, eye: 0.95, eyeX: 0.34,
    dorsalH: 1.35, dorsalLen: 1.4, dorsalTip: 0.4, analH: 1.1, pec: 1.15,
    tail: 'softfork', fork: 0.35, pattern: 'blotch', mouth: 'wide', headFlat: 0.2,
  },
  yamame: {
    h: 1.0, w: 0.92, adipose: true, pattern: 'parr',
    dorsalH: 0.85, tail: 'softfork', fork: 0.5, mouth: 'normal',
  },
  namazu: {
    h: 0.85, w: 1.25, snout: 0.1, eye: 0.55, eyeX: 0.32, eyeY: 0.18,
    dorsalH: 0.55, dorsalLen: 0.7, analH: 0.9, pec: 1.2,
    tail: 'truncate', fork: 0.1, pattern: 'mottle', whiskers: 2, whiskerLen: 1.35,
    mouth: 'wide', pelvic: false, headFlat: 0.55, ribbon: false,
  },
  koi: {
    // wide 基準でやや胴長。deep+高背びれだと図鑑でも水中でも寸詰まりに見える
    h: 1.2, w: 1.08, snout: 0.12, eye: 0.85, eyeX: 0.34,
    dorsalH: 1.28, dorsalLen: 1.5, dorsalX: 0.06, analH: 0.95, pec: 1.05,
    tail: 'fork', fork: 0.42, tailLen: 1.08,
    pattern: 'none', mouth: 'sucker', whiskers: 1, whiskerLen: 0.75,
  },
  wakasagi: {
    h: 0.7, w: 0.75, eye: 1.45, eyeX: 0.37, eyeY: 0.18,
    dorsalH: 0.65, dorsalLen: 0.7, analH: 0.6, pec: 0.7,
    tail: 'fork', fork: 0.82, tailLen: 1.15, pattern: 'none', mouth: 'small',
  },
  nigoi: {
    h: 0.95, w: 0.95, snout: 0.35, eye: 0.9, eyeX: 0.33,
    dorsalH: 1.05, dorsalLen: 1.2, tail: 'fork', fork: 0.5,
    pattern: 'none', mouth: 'sucker',
  },
  hasu: {
    h: 0.85, w: 0.85, snout: 0.2, eye: 1.15, eyeY: 0.2,
    dorsalH: 0.9, tail: 'fork', fork: 0.7, pattern: 'none', mouth: 'up',
  },
  iwana: {
    h: 1.05, w: 0.95, adipose: true, pattern: 'lightspots',
    dorsalH: 0.9, tail: 'softfork', fork: 0.48, mouth: 'normal',
  },
  snakehead: {
    h: 0.95, w: 1.1, snout: 0.2, eye: 0.85, eyeX: 0.33,
    dorsalH: 1.1, dorsalLen: 1.7, dorsalX: 0.18, analH: 1.05, pec: 0.9,
    tail: 'round', fork: 0.12, pattern: 'mottle', mouth: 'wide',
    pelvic: true, headFlat: 0.25, whiskers: 0,
  },
  grasscarp: {
    h: 0.92, w: 1.0, snout: 0.15, eye: 0.85, eyeX: 0.34,
    dorsalH: 0.95, dorsalLen: 1.1, tail: 'fork', fork: 0.45,
    pattern: 'none', mouth: 'sucker', whiskers: 0,
  },
  biwatrout: {
    h: 1.0, w: 0.92, adipose: true, pattern: 'spots', lateral: 0.4,
    dorsalH: 0.88, tail: 'softfork', fork: 0.55, mouth: 'normal',
  },
  unagi: {
    h: 0.65, w: 0.9, snout: 0.08, eye: 0.55, eyeX: 0.36, eyeY: 0.1,
    dorsalH: 0.35, analH: 0.35, pec: 0.45,
    tail: 'ribbon', fork: 0.05, pattern: 'none', mouth: 'small',
    whiskers: 0, pelvic: false, ribbon: true, headFlat: 0.1,
  },
  sakuramasu: {
    h: 1.02, w: 0.94, adipose: true, pattern: 'spots', lateral: 0.5,
    dorsalH: 0.9, tail: 'softfork', fork: 0.58, mouth: 'normal',
  },
  aouo: {
    h: 1.2, w: 1.35, eye: 0.7, eyeX: 0.33,
    dorsalH: 1.1, dorsalLen: 1.25, pec: 1.2,
    tail: 'fork', fork: 0.32, pattern: 'none', mouth: 'sucker', headFlat: 0.15,
  },
  sturgeon: {
    h: 0.95, w: 1.1, snout: 0.6, eye: 0.65, eyeX: 0.27, eyeY: 0.08,
    dorsalH: 0.7, dorsalX: -0.08, dorsalLen: 0.75,
    tail: 'hetero', fork: 0.35, tailLen: 0.75, pattern: 'none', scutes: true,
    whiskers: 2, whiskerLen: 0.5, mouth: 'sucker', pelvic: true,
  },
  gar: {
    h: 0.9, w: 0.95, snout: 1.15, eye: 0.75, eyeX: 0.29, eyeY: 0.1,
    dorsalH: 0.7, dorsalX: -0.18, dorsalLen: 0.75, analH: 0.75,
    tail: 'round', fork: 0.12, tailLen: 0.55, pattern: 'none', mouth: 'beak',
  },
  nushi: {
    h: 0.95, w: 1.4, snout: 0.12, eye: 0.45, eyeX: 0.30, eyeY: 0.2,
    dorsalH: 0.5, dorsalLen: 0.65, analH: 1.0, pec: 1.35,
    tail: 'truncate', fork: 0.08, pattern: 'mottle',
    whiskers: 2, whiskerLen: 1.6, mouth: 'wide', pelvic: false, headFlat: 0.7,
  },
  itou: {
    h: 1.12, w: 1.05, adipose: true, pattern: 'spots', lateral: 0.25,
    dorsalH: 1.0, dorsalLen: 1.05, pec: 1.1, analH: 1.05,
    tail: 'softfork', fork: 0.5, tailLen: 1.1, mouth: 'wide', eye: 0.85,
  },
};

/** 完成した look（3D・図鑑アイコン共通） */
export function lookOf(sp) {
  if (!sp) return { ...LOOK_BASE };
  return { ...defaultLook(sp), ...(SPECIES_LOOK[sp.id] || {}) };
}

export function profileAt(list, t) {
  for (let i = 0; i < list.length - 1; i++) {
    const [t0, r0] = list[i], [t1, r1] = list[i + 1];
    if (t <= t1) {
      const f = (t - t0) / Math.max(1e-6, t1 - t0);
      return lerp(r0, r1, clamp01(f));
    }
  }
  return list[list.length - 1][1];
}

/** ヒレ等：テクスチャの明るい腹側をサンプリング（模様をほぼ乗せるな） */
function setFinUV(geo) {
  const n = geo.attributes.position.count;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    uv[i * 2] = FIN_UV.u;
    uv[i * 2 + 1] = FIN_UV.v;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/** 胴体：U=尾→頭、V=腹→背（画像は上が背・下が腹。図鑑 2D と同じ向き） */
function setBodyUV(geo, bodyLen, H) {
  const p = geo.attributes.position;
  const uv = new Float32Array(p.count * 2);
  const h = Math.max(1e-6, H);
  const len = Math.max(1e-6, bodyLen);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    // 円周成分を混ぜると横帯がねじれるので、頭尾×背腹だけにする
    // flipY=true 時 v=1 が画像上端（背）になる
    uv[i * 2] = clamp01(x / len + 0.5);
    uv[i * 2 + 1] = clamp01(y / h + 0.5);
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/* ---------------- ジオメトリ結合（addons 不要の簡易版） ---------------- */
function mergeGeos(list) {
  const geos = list.map((g) => {
    if (!g.attributes.uv) setFinUV(g);
    return g.index ? g.toNonIndexed() : g;
  });
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);
  let o = 0;
  for (const g of geos) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const c = g.attributes.color;
    const u = g.attributes.uv;
    pos.set(p.array.subarray(0, p.count * 3), o * 3);
    if (n) nor.set(n.array.subarray(0, p.count * 3), o * 3);
    if (c) col.set(c.array.subarray(0, p.count * 3), o * 3);
    else col.fill(1, o * 3, (o + p.count) * 3);
    if (u) uvs.set(u.array.subarray(0, p.count * 2), o * 2);
    else for (let i = 0; i < p.count; i++) {
      uvs[(o + i) * 2] = FIN_UV.u;
      uvs[(o + i) * 2 + 1] = FIN_UV.v;
    }
    o += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return out;
}

/** 頂点カラーを関数で塗る */
function paint(geo, fn) {
  const p = geo.attributes.position;
  const col = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    fn(p.getX(i), p.getY(i), p.getZ(i), c, i);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** 三角形の板（fin）を作る: 2D 点列(XY) を厚みなしで */
function finGeo(points) {
  const verts = [];
  for (let i = 1; i < points.length - 1; i++) {
    verts.push(points[0][0], points[0][1], 0);
    verts.push(points[i][0], points[i][1], 0);
    verts.push(points[i + 1][0], points[i + 1][1], 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  g.computeVertexNormals();
  return setFinUV(g);
}

const hash3 = (x, y, z) => {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
};

/** 模様を頂点色に載せる */
function applyPattern(c, pattern, tx, v, x, y, z, top, mid, albino) {
  if (albino || !pattern || pattern === 'none') return;
  if (pattern === 'spots') {
    const h = hash3(Math.floor(x * 200), Math.floor(y * 200), Math.floor(z * 100));
    if (h > 0.91 && v > 0.32) c.multiplyScalar(0.52);
    else if (h > 0.87 && v > 0.48) c.lerp(top, 0.45);
  } else if (pattern === 'lightspots') {
    // イワナ：暗い地に白い斑点
    const h = hash3(Math.floor(x * 170), Math.floor(y * 170), Math.floor(z * 80));
    if (h > 0.88 && v > 0.28) c.lerp(new THREE.Color('#f2efe4'), 0.72);
  } else if (pattern === 'parr') {
    // ヤマメ：パーマーク（縦長の楕円斑）
    const slot = Math.floor(tx * 9);
    const cx = (slot + 0.5) / 9;
    const dx = (tx - cx) * 14;
    const dy = (v - 0.52) * 5;
    if (dx * dx + dy * dy < 0.55 && tx > 0.18 && tx < 0.78) c.multiplyScalar(0.55);
  } else if (pattern === 'stripe') {
    if (Math.abs(v - 0.52) < 0.08 + Math.sin(tx * 18) * 0.02) c.multiplyScalar(0.48);
  } else if (pattern === 'bars') {
    const b = Math.sin(tx * 28) * 0.5 + 0.5;
    if (b > 0.76 && v > 0.35) c.multiplyScalar(0.68);
  } else if (pattern === 'blotch') {
    const h = hash3(Math.floor(tx * 14), Math.floor(v * 8), 3);
    if (h > 0.62 && v > 0.3 && v < 0.85) c.lerp(top, 0.55).multiplyScalar(0.75);
  } else if (pattern === 'mottle') {
    const h = hash3(Math.floor(x * 90), Math.floor(y * 70), Math.floor(z * 60));
    if (h > 0.55) c.lerp(top, 0.35 + (h - 0.55) * 0.5);
  }
}

/** 尾びれの点列（種類別） */
function tailPoints(kind, fork, baseX, tl, th) {
  if (kind === 'ribbon') {
    return [
      [baseX, th * 0.35],
      [baseX - tl * 0.55, th * 0.15],
      [baseX - tl * 0.7, 0],
      [baseX - tl * 0.55, -th * 0.15],
      [baseX, -th * 0.35],
    ];
  }
  if (kind === 'round') {
    return [
      [baseX, th * 0.12],
      [baseX - tl * 0.45, th * 0.62],
      [baseX - tl * 0.85, th * 0.28],
      [baseX - tl * 0.95, 0],
      [baseX - tl * 0.85, -th * 0.28],
      [baseX - tl * 0.45, -th * 0.62],
      [baseX, -th * 0.12],
    ];
  }
  if (kind === 'truncate') {
    return [
      [baseX, th * 0.2],
      [baseX - tl * 0.85, th * 0.75],
      [baseX - tl, th * 0.55],
      [baseX - tl, -th * 0.55],
      [baseX - tl * 0.85, -th * 0.75],
      [baseX, -th * 0.2],
    ];
  }
  if (kind === 'hetero') {
    // チョウザメ：上葉が胴の延長、下葉は短い（旧座標は帆のように巨大化していた）
    return [
      [baseX, th * 0.12],
      [baseX - tl * 0.22, th * 0.42],
      [baseX - tl * 0.9, th * 0.62],
      [baseX - tl * 0.45, th * 0.08],
      [baseX - tl * 0.55, -th * 0.32],
      [baseX - tl * 0.18, -th * 0.18],
      [baseX, -th * 0.06],
    ];
  }
  // fork / softfork
  const notch = kind === 'softfork' ? 0.45 : 0.62;
  const inset = tl * (1 - fork * notch);
  return [
    [baseX, th * 0.08],
    [baseX - tl, th],
    [baseX - inset, 0],
    [baseX - tl, -th],
    [baseX, -th * 0.08],
  ];
}

/* ===========================================================
   魚メッシュ生成
   =========================================================== */
export function createFishGeometry(sp, opts = {}) {
  const albino = !!opts.albino;
  const L = lookOf(sp);
  const lenM = (sp.len[1] * 0.85) / 100 * VIS_SCALE; // 代表サイズで作り、後でスケール
  const shape = PROFILES[sp.shape] ? sp.shape : 'slim';
  const B = BODY[shape];
  const prof = PROFILES[shape];
  const H = lenM * B.h * L.h;
  const Wd = lenM * B.w * L.w;
  const fork = L.fork != null ? L.fork : B.fork;

  /* --- 胴体（回転体）。snout で口先を伸ばし、headFlat で頭を扁平に --- */
  const N = 22;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    let r = profileAt(prof, t) * 0.5;
    // 口先：プロファイルを前方へ引き伸ばす
    if (L.snout > 0 && t > 0.78) {
      const k = smoothstep(0.78, 1, t);
      r = lerp(r, r * (0.35 + 0.2 * (1 - L.snout)), k * L.snout);
    }
    pts.push(new THREE.Vector2(Math.max(0.003, r), t - 0.5));
  }
  const body = new THREE.LatheGeometry(pts, 16);
  body.rotateZ(-Math.PI / 2);
  // snout 分だけ全体を +X に伸ばす（頭側）
  const snoutStretch = 1 + L.snout * 0.28;
  body.scale(lenM * snoutStretch, H, Wd);
  if (L.headFlat > 0) {
    // 頭側の頂点だけ横に広げて扁平な頭にする
    const pos = body.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const t = x / (lenM * snoutStretch) + 0.5;
      if (t > 0.55) {
        const k = smoothstep(0.55, 0.95, t) * L.headFlat;
        pos.setZ(i, pos.getZ(i) * (1 + k * 0.85));
        pos.setY(i, pos.getY(i) * (1 - k * 0.35));
      }
    }
    pos.needsUpdate = true;
    body.computeVertexNormals();
  }

  const cols = colorsOf(sp, albino);
  const top = new THREE.Color(cols.top);
  const mid = new THREE.Color(cols.mid);
  const belly = new THREE.Color(cols.belly);
  const finC = new THREE.Color(cols.fin);
  const bodyLen = lenM * snoutStretch;
  const texType = textureTypeFor(sp, L, albino);
  // AI テクスチャがある種は頂点色を薄いティントにし、map の色を優先する
  const pattern = albino || texType ? 'none' : (L.pattern || 'none');

  paint(body, (x, y, z, c) => {
    const v = clamp01((y / (H * 0.5) + 1) * 0.5); // 0=腹 1=背
    if (v > 0.62) c.copy(mid).lerp(top, smoothstep(0.62, 1.0, v));
    else c.copy(belly).lerp(mid, smoothstep(0.1, 0.62, v));

    const tx = clamp01(x / bodyLen + 0.5); // 0=尾 1=頭
    if (texType) {
      // テクスチャのアルベドを活かす（白に寄せた薄い種色）
      c.lerp(new THREE.Color('#f2f0ea'), 0.72);
    } else {
      applyPattern(c, pattern, tx, v, x, y, z, top, mid, albino);
      if (!albino && L.lateral > 0 && Math.abs(v - 0.48) < 0.07) {
        c.lerp(finC, L.lateral * 0.85);
      }
    }
    // ブルーギルのエラ蓋斑
    if (!albino && L.cheek && tx > 0.78 && tx < 0.9 && v > 0.35 && v < 0.7 && Math.abs(z) > Wd * 0.25) {
      c.setRGB(0.12, 0.1, 0.18);
    }
    // 口の形で先端の影を変える
    const mouthDark = L.mouth === 'wide' || L.mouth === 'beak' ? 0.92 : 0.96;
    if (tx > mouthDark) c.multiplyScalar(albino ? 0.85 : (L.mouth === 'beak' ? 0.4 : 0.55));
  });
  setBodyUV(body, bodyLen, H);

  /* 胴の輪郭上の高さ・幅（吻ストレッチ後の bodyLen 基準）。
     ヒレを lenM 固定座標で置くとチョウザメ／ガー等で胴から浮く */
  const bodyRadAt = (x) => {
    const t = clamp01(x / bodyLen + 0.5);
    let r = profileAt(prof, t);
    if (L.snout > 0 && t > 0.78) {
      const k = smoothstep(0.78, 1, t);
      r = lerp(r, r * (0.35 + 0.2 * (1 - L.snout)), k * L.snout);
    }
    return r * 0.5; // Lathe の正規化半径
  };
  const bodyYAt = (x) => bodyRadAt(x) * H;
  const bodyZAt = (x) => bodyRadAt(x) * Wd;

  const parts = [body];

  /* --- チョウザメの硬鱗列（控えめな骨板） --- */
  if (L.scutes && !albino) {
    for (let i = 0; i < 7; i++) {
      const t = 0.18 + i * 0.1;
      const x = (t - 0.5) * bodyLen;
      const sc = new THREE.ConeGeometry(bodyLen * 0.007, bodyLen * 0.014, 5);
      sc.translate(0, bodyLen * 0.007, 0);
      sc.translate(x, bodyYAt(x) * 0.94, 0);
      parts.push(paint(sc, (x, y, z, c) => c.copy(top).lerp(mid, 0.3).multiplyScalar(0.85)));
    }
  }

  /* --- 尾びれ --- */
  const hetero = L.tail === 'hetero';
  const roundTail = L.tail === 'round';
  // 長い胴（ガー等）で bodyLen 比例が効きすぎないよう丸尾・歪尾は抑える
  const tl = bodyLen * B.tail * L.tailLen * (hetero ? 0.85 : roundTail ? 0.62 : 1);
  const th = hetero
    ? H * (0.7 + fork * 0.35) + bodyLen * 0.012
    : roundTail
      ? H * (0.55 + fork * 0.35) + bodyLen * 0.006
      : H * (0.72 + fork * 0.7) + bodyLen * 0.025;
  const baseX = -bodyLen * 0.48;
  const tail = finGeo(tailPoints(L.tail, fork, baseX, tl, th));
  parts.push(paint(tail, (x, y, z, c) => {
    c.copy(finC).multiplyScalar(0.72 + 0.28 * clamp01(1 - Math.abs(y) / Math.max(1e-3, th)));
  }));

  /* --- 背びれ（ウナギは長いリボン） --- */
  if (L.ribbon) {
    const rx = [0.25, 0.05, -0.35, -0.45].map((f) => bodyLen * f);
    const ribbon = finGeo([
      [rx[0], bodyYAt(rx[0]) * 0.95],
      [rx[1], bodyYAt(rx[1]) * 0.95 + H * 0.22],
      [rx[2], bodyYAt(rx[2]) * 0.9 + H * 0.18],
      [rx[3], bodyYAt(rx[3]) * 0.85],
    ]);
    parts.push(paint(ribbon, (x, y, z, c) => c.copy(finC).multiplyScalar(0.85)));
    const bx = [0.1, -0.1, -0.4, -0.45].map((f) => bodyLen * f);
    const bellyR = finGeo([
      [bx[0], -bodyYAt(bx[0]) * 0.9],
      [bx[1], -bodyYAt(bx[1]) * 0.9 - H * 0.2],
      [bx[2], -bodyYAt(bx[2]) * 0.85 - H * 0.16],
      [bx[3], -bodyYAt(bx[3]) * 0.7],
    ]);
    parts.push(paint(bellyR, (x, y, z, c) => c.copy(finC).multiplyScalar(0.8)));
  } else {
    const dh = H * B.dorsal * 2.8 * L.dorsalH;
    const dx = L.dorsalX;
    const dLen = 0.14 * L.dorsalLen;
    const tipT = L.dorsalTip;
    const x0 = bodyLen * (dx + dLen * 0.55);
    const x1 = bodyLen * (dx + dLen * (0.55 - tipT));
    const x2 = bodyLen * (dx - dLen * 0.55);
    const y0 = bodyYAt(x0) * 0.98;
    const y2 = bodyYAt(x2) * 0.98;
    const dorsal = finGeo([
      [x0, y0],
      [x1, Math.max(y0, y2) + dh],
      [x2, y2],
    ]);
    parts.push(paint(dorsal, (x, y, z, c) => c.copy(finC).multiplyScalar(0.9)));

    /* --- 尻びれ --- */
    const ah = dh * 0.55 * L.analH;
    const ax0 = -bodyLen * 0.08;
    const ax1 = -bodyLen * 0.20;
    const ax2 = -bodyLen * 0.30;
    const anal = finGeo([
      [ax0, -bodyYAt(ax0) * 0.95],
      [ax1, -bodyYAt(ax1) * 0.95 - ah],
      [ax2, -bodyYAt(ax2) * 0.95],
    ]);
    parts.push(paint(anal, (x, y, z, c) => c.copy(finC).multiplyScalar(0.8)));

    /* --- 脂びれ（鱒） --- */
    if (L.adipose) {
      const ad0 = -bodyLen * 0.22;
      const ad1 = -bodyLen * 0.28;
      const ad2 = -bodyLen * 0.34;
      const ad = finGeo([
        [ad0, bodyYAt(ad0) * 0.98],
        [ad1, bodyYAt(ad1) * 0.98 + H * 0.16],
        [ad2, bodyYAt(ad2) * 0.98],
      ]);
      parts.push(paint(ad, (x, y, z, c) => c.copy(finC).multiplyScalar(0.95)));
    }
  }

  /* --- 腹びれ --- */
  if (L.pelvic) {
    for (const s of [1, -1]) {
      const px0 = -bodyLen * 0.02;
      const px1 = -bodyLen * 0.12;
      const px2 = -bodyLen * 0.16;
      const py = -bodyYAt(px0) * 0.35;
      const pel = finGeo([
        [px0, py],
        [px1, py - H * 0.28],
        [px2, py + H * 0.02],
      ]);
      pel.rotateX(s * 0.85);
      pel.translate(0, 0, s * bodyZAt(px0) * 0.85);
      parts.push(paint(pel, (x, y, z, c) => c.copy(finC).multiplyScalar(0.88)));
    }
  }

  /* --- 胸びれ（左右） --- */
  for (const s of [1, -1]) {
    const ps = L.pec;
    const px = bodyLen * 0.22;
    const py = -bodyYAt(px) * 0.12;
    const pec = finGeo([
      [px, py],
      [px - bodyLen * 0.18 * ps, py - H * 0.38 * ps],
      [px - bodyLen * 0.2 * ps, py + H * 0.02],
    ]);
    pec.rotateX(s * (L.mouth === 'wide' ? 1.35 : 1.15));
    pec.translate(0, 0, s * bodyZAt(px) * 0.9);
    parts.push(paint(pec, (x, y, z, c) => c.copy(finC).multiplyScalar(0.95)));
  }

  /* --- 口の張り出し（バス・ガーなど） --- */
  if (L.mouth === 'wide' || L.mouth === 'beak') {
    const jawLen = lenM * (L.mouth === 'beak' ? 0.22 + L.snout * 0.12 : 0.1);
    const jaw = new THREE.ConeGeometry(H * (L.mouth === 'beak' ? 0.12 : 0.18), jawLen, 6);
    jaw.rotateZ(-Math.PI / 2);
    jaw.translate(bodyLen * 0.48 + jawLen * 0.15, -H * 0.06, 0);
    if (L.mouth === 'beak') jaw.scale(1, 0.55, 0.55);
    parts.push(paint(jaw, (x, y, z, c) => c.copy(mid).multiplyScalar(albino ? 0.95 : 0.55)));
  } else if (L.mouth === 'up') {
    // ハス：上向きの口
    const jaw = new THREE.ConeGeometry(H * 0.1, lenM * 0.08, 5);
    jaw.rotateZ(-Math.PI / 2);
    jaw.rotateZ(-0.45);
    jaw.translate(bodyLen * 0.48, H * 0.05, 0);
    parts.push(paint(jaw, (x, y, z, c) => c.copy(belly).multiplyScalar(0.9)));
  } else if (L.mouth === 'sucker') {
    const lip = new THREE.TorusGeometry(H * 0.09, H * 0.035, 5, 10);
    lip.rotateY(Math.PI / 2);
    lip.translate(bodyLen * 0.48, -H * 0.08, 0);
    parts.push(paint(lip, (x, y, z, c) => c.copy(belly).multiplyScalar(0.85)));
  }

  /* --- 目 --- */
  const eyeR = Math.max(lenM * 0.01, H * 0.12 * L.eye);
  for (const s of [1, -1]) {
    const ex = bodyLen * L.eyeX;
    const ey = H * L.eyeY;
    const ez = Wd * (0.38 + L.headFlat * 0.15);
    const eye = new THREE.SphereGeometry(eyeR, 8, 6);
    eye.translate(ex, ey, s * ez);
    parts.push(paint(eye, (x, y, z, c) => {
      const front = z * s > ez * 0.95;
      if (albino) c.setRGB(front ? 0.72 : 0.95, front ? 0.08 : 0.35, front ? 0.12 : 0.38);
      else c.setRGB(front ? 0.03 : 0.5, front ? 0.03 : 0.45, front ? 0.05 : 0.4);
    }));
    const glint = new THREE.SphereGeometry(eyeR * 0.4, 6, 4);
    glint.translate(ex + lenM * 0.008, ey + eyeR * 0.35, s * (ez + eyeR * 0.35));
    parts.push(paint(glint, (x, y, z, c) => c.setRGB(1, 1, 1)));
  }

  /* --- ヒゲ --- */
  if (L.whiskers > 0) {
    for (const s of [1, -1]) {
      for (let k = 0; k < L.whiskers; k++) {
        const wl = lenM * (0.14 + (L.whiskers - k) * 0.08) * L.whiskerLen;
        const bar = new THREE.CylinderGeometry(lenM * 0.005, lenM * 0.0018, wl, 4);
        bar.rotateZ(Math.PI / 2 + (k - 1) * 0.25);
        bar.rotateY(s * (0.35 + k * 0.28));
        bar.translate(
          bodyLen * (0.44 + L.snout * 0.05),
          H * (0.08 - k * 0.14),
          s * Wd * (0.22 + L.headFlat * 0.15)
        );
        parts.push(paint(bar, (x, y, z, c) => c.copy(mid).multiplyScalar(0.82)));
      }
    }
  }

  const geo = mergeGeos(parts);
  geo.userData.baseLength = bodyLen;
  geo.userData.look = L;
  geo.userData.texType = texType;
  return geo;
}

/* ---------------- ゴミ用メッシュ ---------------- */
export function createJunkGeometry(sp) {
  const parts = [];
  const col = new THREE.Color(sp.colors.mid);
  const dark = new THREE.Color(sp.colors.top);
  const L = 0.3;
  if (sp.id === 'boot') {
    const shaft = new THREE.BoxGeometry(0.16, 0.3, 0.16);
    shaft.translate(0, 0.02, 0);
    parts.push(paint(shaft, (x, y, z, c) => c.copy(col)));
    const foot = new THREE.BoxGeometry(0.3, 0.11, 0.15);
    foot.translate(0.09, -0.18, 0);
    parts.push(paint(foot, (x, y, z, c) => c.copy(col)));
    const sole = new THREE.BoxGeometry(0.33, 0.035, 0.17);
    sole.translate(0.09, -0.24, 0);
    parts.push(paint(sole, (x, y, z, c) => c.copy(dark)));
  } else if (sp.id === 'can') {
    const can = new THREE.CylinderGeometry(0.065, 0.065, 0.14, 12);
    can.rotateZ(Math.PI / 2);
    parts.push(paint(can, (x, y, z, c) => {
      c.copy(col);
      if (Math.abs(x) > 0.065) c.copy(dark);
      else if (Math.abs(z) < 0.02) c.lerp(new THREE.Color(0xd94b3a), 0.5);
    }));
  } else if (sp.id === 'weeds') {
    for (let i = 0; i < 9; i++) {
      const s = new THREE.CylinderGeometry(0.012, 0.004, rand(0.2, 0.45), 4);
      s.rotateZ(rand(-1.4, 1.4));
      s.rotateY(rand(0, TAU));
      s.translate(rand(-0.1, 0.1), rand(-0.05, 0.08), rand(-0.1, 0.1));
      parts.push(paint(s, (x, y, z, c) => c.copy(col).multiplyScalar(rand(0.7, 1.15))));
    }
  } else {
    // 流木
    for (let i = 0; i < 4; i++) {
      const len = rand(0.25, 0.65);
      const s = new THREE.CylinderGeometry(rand(0.02, 0.05), rand(0.015, 0.04), len, 6);
      s.rotateZ(Math.PI / 2 + rand(-0.35, 0.35));
      s.rotateY(rand(-0.5, 0.5));
      s.translate(rand(-0.15, 0.15), rand(-0.06, 0.06), rand(-0.08, 0.08));
      parts.push(paint(s, (x, y, z, c) => c.copy(i === 0 ? col : dark).multiplyScalar(rand(0.8, 1.1))));
    }
  }
  const geo = mergeGeos(parts);
  geo.userData.baseLength = L;
  return geo;
}

/* ===========================================================
   甲殻類（エビ・ザリガニ・カニ）メッシュ生成
   魚と同じく +X が前・+Y が上。魚の体型プロファイルでは作れないので専用に組む
   =========================================================== */
export const CRUST_SHAPES = ['shrimp', 'crayfish', 'crab'];

export function createCrustGeometry(sp, opts = {}) {
  const albino = !!opts.albino;
  const lenM = (sp.len[1] * 0.85) / 100 * VIS_SCALE;
  const cols = colorsOf(sp, albino);
  const shell = new THREE.Color(cols.mid);
  const dark = new THREE.Color(cols.top);
  const pale = new THREE.Color(cols.belly);
  const limb = new THREE.Color(cols.fin);
  const eyePaint = albino
    ? (x, y, z, c) => c.setRGB(0.72, 0.08, 0.12)
    : (x, y, z, c) => c.setRGB(0.04, 0.04, 0.05);
  const parts = [];
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  /** 棒（脚・触角・ハサミの腕）を from から dir 方向へ。先端座標を返すので節を繋げられる */
  const rod = (from, dir, len, r0, r1, col) => {
    const d = dir.clone().normalize();
    const g = new THREE.CylinderGeometry(r0, r1, len, 5);
    g.translate(0, len * 0.5, 0);                                  // 根元を原点に
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d));
    g.translate(from.x, from.y, from.z);
    parts.push(paint(g, (x, y, z, c) => c.copy(col)));
    return from.clone().addScaledVector(d, len);
  };
  /** ハサミ（掌 + 可動爪）を pos に、dir 向きで置く */
  const claw = (pos, dir, size, side) => {
    const d = dir.clone().normalize();
    const palm = new THREE.SphereGeometry(size, 8, 6);
    palm.scale(1.75, 0.55, 0.85);
    palm.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d));
    palm.translate(pos.x, pos.y, pos.z);
    parts.push(paint(palm, (x, y, z, c) => c.copy(shell).lerp(dark, 0.22)));
    const tipPos = pos.clone().addScaledVector(d, size * 1.5);
    const nip = new THREE.ConeGeometry(size * 0.42, size * 1.9, 6);
    nip.translate(0, size * 0.95, 0);
    nip.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d));
    nip.translate(tipPos.x, tipPos.y + size * 0.12 * side, tipPos.z);
    parts.push(paint(nip, (x, y, z, c) => c.copy(pale)));
  };

  if (sp.shape === 'crab') {
    /* --- カニ：横に広い平たい甲羅 + 8本脚 + ハサミ（甲幅を体長として扱う） --- */
    const W = lenM;
    const carapace = new THREE.SphereGeometry(W * 0.5, 16, 10);
    carapace.scale(0.60, 0.30, 1.06);          // 前後に短く・平たく・横に広い
    parts.push(paint(carapace, (x, y, z, c) => {
      c.copy(y > 0 ? shell : pale).lerp(dark, clamp01(Math.abs(z) / (W * 0.5)) * 0.55);
      if (y > W * 0.05 && Math.abs(z) < W * 0.1) c.lerp(dark, 0.3);       // 甲の中央線
      if (x > W * 0.2) c.lerp(dark, 0.25);                                // 前縁
    }));
    // 目（前縁の短い眼柱）
    for (const s of [1, -1]) {
      const base = V(W * 0.24, W * 0.02, s * W * 0.12);
      const tip = rod(base, V(0.55, 0.75, s * 0.25), W * 0.1, W * 0.028, W * 0.024, limb);
      const eye = new THREE.SphereGeometry(W * 0.042, 6, 5);
      eye.translate(tip.x, tip.y, tip.z);
      parts.push(paint(eye, eyePaint));
    }
    // 歩脚：片側 4 本。甲羅の下から外へ伸ばし、関節で下へ折る
    for (const s of [1, -1]) {
      for (let i = 0; i < 4; i++) {
        const fx = 0.4 - i * 0.3;                                         // 前後の付け根位置
        const base = V(W * 0.26 * fx, -W * 0.03, s * W * 0.12);
        const knee = rod(base, V(fx * 0.5, 0.3, s * 1.0), W * 0.42, W * 0.032, W * 0.026, limb);
        rod(knee, V(fx * 0.3, -1.2, s * 0.35), W * 0.36, W * 0.026, W * 0.008, limb);
      }
      // ハサミ脚（前方外向き。モクズガニらしく大きめ）
      const base = V(W * 0.22, -W * 0.03, s * W * 0.16);
      const elbow = rod(base, V(0.9, 0.08, s * 0.45), W * 0.32, W * 0.05, W * 0.042, shell);
      claw(elbow, V(0.95, 0.0, s * 0.3), W * 0.13, s);
    }
    const geo = mergeGeos(parts);
    geo.userData.baseLength = lenM;
    return geo;
  }

  /* --- エビ・ザリガニ：頭胸部 + 節のある腹 + 尾扇 + ハサミ --- */
  const crayfish = sp.shape === 'crayfish';
  const bodyR = lenM * (crayfish ? 0.13 : 0.1);
  // 頭胸部
  const head = new THREE.SphereGeometry(bodyR, 12, 9);
  head.scale(1.9, 1.0, crayfish ? 1.15 : 0.95);
  head.translate(lenM * 0.22, 0, 0);
  parts.push(paint(head, (x, y, z, c) => {
    c.copy(y > 0 ? shell : pale);
    if (x > lenM * 0.36) c.lerp(dark, 0.4);              // 額（額角の付け根）
  }));
  // 額角
  rod(V(lenM * 0.4, bodyR * 0.2, 0), V(1, 0.35, 0), lenM * (crayfish ? 0.14 : 0.2),
    bodyR * 0.14, bodyR * 0.03, dark);
  // 腹（節）：後ろへ細くなりながら少し下がる
  const SEG = 6;
  for (let i = 0; i < SEG; i++) {
    const t = i / (SEG - 1);
    const r = bodyR * lerp(0.95, 0.42, t);
    const seg = new THREE.CylinderGeometry(r, r * 0.92, lenM * 0.08, 9);
    seg.rotateZ(Math.PI / 2);
    seg.scale(1, 1, 0.9);
    seg.translate(lenM * (0.05 - t * 0.42), -t * t * bodyR * 0.55, 0);
    parts.push(paint(seg, (x, y, z, c) => {
      c.copy(y > 0 ? shell : pale).lerp(dark, 0.12 + (i % 2) * 0.18);
    }));
  }
  // 尾扇（3枚）
  const tf = lenM * 0.15;
  for (const s of [1, -1, 0]) {
    const fan = finGeo([[0, 0], [-tf, tf * (s === 0 ? 0.3 : 0.85)], [-tf * 1.2, 0], [-tf, -tf * 0.4]]);
    if (s !== 0) fan.rotateX(s * 0.85);
    fan.translate(-lenM * 0.4, -bodyR * 0.55, 0);
    parts.push(paint(fan, (x, y, z, c) => c.copy(limb).lerp(pale, 0.3)));
  }
  for (const s of [1, -1]) {
    // 触角（長い）＋小触角
    rod(V(lenM * 0.38, bodyR * 0.15, s * bodyR * 0.35), V(1, 0.28, s * 0.5),
      lenM * (crayfish ? 0.42 : 0.8), bodyR * 0.08, bodyR * 0.02, dark);
    rod(V(lenM * 0.38, -bodyR * 0.1, s * bodyR * 0.3), V(1, -0.15, s * 0.75),
      lenM * 0.22, bodyR * 0.06, bodyR * 0.02, dark);
    // 目
    const eye = new THREE.SphereGeometry(bodyR * 0.22, 6, 5);
    eye.translate(lenM * 0.33, bodyR * 0.45, s * bodyR * 0.42);
    parts.push(paint(eye, eyePaint));
    // 歩脚 4 本（下へ・少し外へ）
    for (let i = 0; i < 4; i++) {
      const base = V(lenM * (0.3 - i * 0.09), -bodyR * 0.55, s * bodyR * 0.42);
      const knee = rod(base, V(0.15, -0.5, s * 1.0), lenM * 0.1, bodyR * 0.1, bodyR * 0.07, limb);
      rod(knee, V(0.1, -1.0, s * 0.35), lenM * 0.09, bodyR * 0.07, bodyR * 0.03, limb);
    }
    /* ハサミ脚：テナガエビは細長く前へ、ザリガニは太く短く */
    const armFrom = V(lenM * 0.33, -bodyR * 0.35, s * bodyR * 0.5);
    const armDir = V(1, crayfish ? -0.1 : -0.18, s * (crayfish ? 0.42 : 0.3));
    const armL = lenM * (crayfish ? 0.26 : 0.44);
    const elbow = rod(armFrom, armDir, armL, bodyR * (crayfish ? 0.3 : 0.15), bodyR * (crayfish ? 0.24 : 0.1),
      crayfish ? shell : limb);
    claw(elbow, V(1, 0.1, s * (crayfish ? 0.3 : 0.18)), bodyR * (crayfish ? 0.62 : 0.3), s);
  }

  const geo = mergeGeos(parts);
  geo.userData.baseLength = lenM;
  return geo;
}

/* ---------------- マテリアル（体をうねらせる） ---------------- */
export function createFishMaterial(shiny = 0.35, causticsUniforms = null) {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.55 - shiny * 0.3,
    metalness: 0.05 + shiny * 0.25,
    side: THREE.DoubleSide,
  });
  const u = {
    uTime: { value: 0 },
    uAmp: { value: 0.1 },
    uFreq: { value: 10 },
    uLen: { value: 1 },
    uBend: { value: 0 },
  };
  mat.userData.u = u;
  mat.customProgramCacheKey = () => `fish-wiggle-v4-normal-caustics-${causticsUniforms ? 1 : 0}`;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    if (causticsUniforms) Object.assign(shader.uniforms, causticsUniforms);
    shader.vertexShader =
      'uniform float uTime, uAmp, uFreq, uLen, uBend;\n' +
      'varying vec3 vFishWorldPos;\n' +
      shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */ `
      vec3 transformed = vec3( position );
      float tailK = clamp(0.5 - position.x / uLen, 0.0, 1.0);
      float wig = sin(position.x / uLen * uFreq - uTime * 6.2831) * uAmp * uLen;
      transformed.z += wig * pow(tailK, 1.6);
      transformed.z += uBend * uLen * pow(tailK, 2.0);
      vFishWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      `
    );
    if (causticsUniforms) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>\n          varying vec3 vFishWorldPos;\n${CAUSTICS_GLSL}`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += causticLight(vFishWorldPos, normal);`
      );
    }
  };
  return mat;
}

/* ===========================================================
   魚エンティティ
   =========================================================== */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _xAxis = new THREE.Vector3();
const _yAxis = new THREE.Vector3();
const _zAxis = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Fish {
  constructor(geoCache, matFactory) {
    this.geoCache = geoCache;
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), matFactory());
    this.mesh.castShadow = false;
    this.mesh.visible = false;
    this.mesh.frustumCulled = true;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3(0, 0, 1);
    this.target = new THREE.Vector3();
    this.state = 'idle';
    this.species = null;
    this.length = 30;
    this.albino = false;
    this.phase = rand(0, 10);
    this.timer = 0;
    this.roll = 0;
    this.jumpVy = 0;
    this.active = false;
  }

  /** 魚種と個体サイズを設定 */
  spawn(sp, length, pos, opts = {}) {
    this.species = sp;
    this.length = length;
    this.albino = !!opts.albino && sp.rarity > 0;
    const key = this.albino ? `${sp.id}:albino` : sp.id;
    let geo = this.geoCache.get(key);
    if (!geo) {
      geo = sp.rarity === 0 ? createJunkGeometry(sp)
        : CRUST_SHAPES.includes(sp.shape) ? createCrustGeometry(sp, { albino: this.albino })
          : createFishGeometry(sp, { albino: this.albino });
      this.geoCache.set(key, geo);
    }
    this.mesh.geometry = geo;
    const base = geo.userData.baseLength || 1;
    const want = (length / 100) * VIS_SCALE;
    const s = sp.rarity === 0 ? 1 : want / base;
    this.mesh.scale.setScalar(s);
    this.mesh.material.userData.u.uLen.value = base;
    // AI 生成テクスチャを map に載せる（種タイプごと。未ロードなら頂点色のみ）
    const texType = geo.userData.texType || textureTypeFor(sp, lookOf(sp), this.albino);
    const mat = this.mesh.material;
    const map = texType ? fishTexture(texType) : null;
    if (mat.map !== map) {
      mat.map = map;
      mat.needsUpdate = true;
    }
    this.mesh.visible = true;
    this.active = true;
    this.pos.copy(pos);
    this.mesh.position.copy(pos);
    this.state = 'wander';
    this.timer = rand(0.5, 3);
    this.speed = 0.78 + (length / 100) * 1.7;
    this.home = pos.clone();
    this.startle = 0;
  }

  despawn() {
    this.active = false;
    this.mesh.visible = false;
    this.state = 'idle';
  }

  /** 好む水深（実際の水深で制限）。日周移動する魚は時間帯で上下する */
  preferredY(depth, band = null) {
    const [b0, b1] = depthBandAt(this.species, band);
    const dmin = Math.min(b0, Math.max(0.4, depth - 0.5));
    const dmax = Math.min(b1, Math.max(0.6, depth - 0.4));
    return -lerp(dmin, dmax, this._depthBias ?? 0.5);
  }

  pickWanderTarget(ctx) {
    const { terrain } = ctx;
    for (let i = 0; i < 12; i++) {
      const a = rand(0, TAU);
      const r = rand(3, 16);
      const x = this.pos.x + Math.cos(a) * r;
      const z = this.pos.z + Math.sin(a) * r;
      const d = terrain.depthAt(x, z);
      if (d < Math.max(0.5, this.species.depth[0] * 0.5)) continue;
      if (d > this.species.depth[1] + 8) continue;
      this._depthBias = clamp01((this._depthBias ?? 0.5) + rand(-0.3, 0.3));
      this.target.set(x, this.preferredY(d, ctx.band), z);
      return true;
    }
    // 見つからなければ深い方へ
    this.target.set(this.pos.x * 0.9, this.pos.y, this.pos.z * 0.9);
    return false;
  }

  update(dt, ctx) {
    if (!this.active) return;
    const { water, terrain } = ctx;
    const sp = this.species;
    this.timer -= dt;
    this.startle = Math.max(0, this.startle - dt);

    let speedMul = 1;

    switch (this.state) {
      case 'wander': {
        if (this.timer <= 0 || this.pos.distanceTo(this.target) < 1.2) {
          this.pickWanderTarget(ctx);
          this.timer = rand(2.5, 6);
        }
        speedMul = 0.26 + Math.sin(this.phase + ctx.time * 0.6) * 0.05;
        if (this.startle > 0) speedMul = 1.5;
        // 稀に跳ねる
        if (sp.rarity > 0 && this.timer > 0.4 && Math.random() < dt * 0.012) {
          const surf = water.surfaceY(this.pos.x, this.pos.z);
          if (terrain.depthAt(this.pos.x, this.pos.z) > 1.2 && this.pos.y > -2.2) {
            this.state = 'jump';
            this.jumpVy = rand(3.4, 5.6);
            this.pos.y = surf - 0.05;
            water.addSplash(this.pos.x, surf, this.pos.z, 12, 0.8);
            water.addRipple(this.pos.x, this.pos.z, 0.9, 1.6);
            if (ctx.onJump) ctx.onJump(this);
          }
        }
        break;
      }
      case 'approach': {
        this.target.copy(ctx.bait);
        speedMul = 1.45;
        if (this.pos.distanceTo(this.target) < 0.5 + this.length * 0.004) {
          this.state = 'nibble';
          this.timer = rand(0.6, 1.4);
        }
        break;
      }
      case 'nibble': {
        // 餌の周りをうろうろ
        const a = ctx.time * 1.6 + this.phase;
        this.target.set(
          ctx.bait.x + Math.cos(a) * 0.45,
          ctx.bait.y + Math.sin(a * 0.7) * 0.18,
          ctx.bait.z + Math.sin(a) * 0.45
        );
        speedMul = 0.35;
        break;
      }
      case 'hooked': {
        // 位置・向き・体のうねりは fight ロジックが毎フレーム指定する
        // （ここで向きを上書きすると「巻かれている＝プレイヤーを向く」が崩れる）
        this.mesh.position.copy(this.pos);
        return;
      }
      case 'flee': {
        speedMul = 1.7;
        if (this.timer <= 0) { this.state = 'wander'; this.timer = 1; }
        break;
      }
      case 'jump': {
        this.jumpVy -= 13 * dt;
        this.pos.y += this.jumpVy * dt;
        this.pos.addScaledVector(this.vel, dt * 0.6);
        const surf = water.surfaceY(this.pos.x, this.pos.z);
        this._wiggle(dt, 3.2, 0.2);
        if (this.pos.y < surf && this.jumpVy < 0) {
          water.addSplash(this.pos.x, surf, this.pos.z, 18, 1.1);
          water.addRipple(this.pos.x, this.pos.z, 1.2, 1.8);
          if (ctx.onSplash) ctx.onSplash(this);
          this.state = 'wander';
          this.timer = 1.5;
          this.pos.y = surf - 0.3;
        }
        this.mesh.position.copy(this.pos);
        _v1.copy(this.vel).setY(this.jumpVy * 0.35).normalize();
        this._orient(dt, _v1, 0.2);
        return;
      }
      case 'landed': {
        this.mesh.position.copy(this.pos);
        this._wiggle(dt, 1.5, 0.25);
        return;
      }
      default:
        return;
    }

    /* --- 移動 --- */
    const sp2 = this.speed * speedMul;
    _v1.subVectors(this.target, this.pos);
    const dist = _v1.length();
    if (dist > 0.001) _v1.multiplyScalar(1 / dist);
    _v1.multiplyScalar(sp2);
    // 上下の動きは控えめに
    _v1.y *= 0.55;
    this.vel.lerp(_v1, 1 - Math.exp(-2.6 * dt));

    this.pos.addScaledVector(this.vel, dt);

    /* --- 水中に収める --- */
    const bed = terrain.heightAt(this.pos.x, this.pos.z);
    const surf = water.surfaceY(this.pos.x, this.pos.z);
    const minY = bed + 0.22 + this.length * 0.0016;
    const maxY = surf - 0.18 - this.length * 0.0012;
    if (this.pos.y < minY) { this.pos.y = minY; this.vel.y = Math.max(0, this.vel.y); }
    if (this.pos.y > maxY) { this.pos.y = maxY; this.vel.y = Math.min(0, this.vel.y); }
    if (maxY < minY) this.pos.y = (maxY + minY) * 0.5;

    this.mesh.position.copy(this.pos);
    const spd = this.vel.length();
    _v1.copy(this.vel);
    if (spd < 0.02) _v1.set(Math.cos(this.phase), 0, Math.sin(this.phase));
    this._orient(dt, _v1.normalize(), clamp(-this.vel.x * 0.06, -0.4, 0.4));
    this._wiggle(dt, 0.9 + spd * 1.9, 0.045 + spd * 0.05);
  }

  _wiggle(dt, freq, amp) {
    const u = this.mesh.material.userData.u;
    const shape = this.species && this.species.shape;
    // 甲殻類は体をうねらせない（脚で歩く／尾で跳ねる生き物なので小刻みに）
    const crust = CRUST_SHAPES.includes(shape);
    u.uTime.value += dt * freq * (crust ? 1.6 : 1);
    u.uAmp.value = crust ? amp * 0.22 : amp;
    u.uFreq.value = shape === 'eel' ? 7 : crust ? 2.2 : 5.2;
  }

  /**
   * 糸を結ぶ点＝口の位置（ローカル +X が頭）。
   * ゴミは向きに意味がないので中心を返す
   * @param {THREE.Vector3} out
   */
  mouthPos(out) {
    const base = (this.mesh.geometry.userData.baseLength || 0) * 0.48;
    const mx = this.species && this.species.rarity === 0 ? 0 : base;
    return out.set(mx * this.mesh.scale.x, 0, 0)
      .applyQuaternion(this.mesh.quaternion)
      .add(this.pos);
  }

  _orient(dt, fwd, roll) {
    _xAxis.copy(fwd);
    _yAxis.copy(UP).addScaledVector(_xAxis, -UP.dot(_xAxis));
    if (_yAxis.lengthSq() < 1e-6) _yAxis.set(0, 0, 1);
    _yAxis.normalize();
    _zAxis.crossVectors(_xAxis, _yAxis);
    _m.makeBasis(_xAxis, _yAxis, _zAxis);
    _q.setFromRotationMatrix(_m);
    this.roll = damp(this.roll, roll, 4, dt);
    _q.multiply(_qRoll.setFromAxisAngle(_XAXIS, this.roll));
    this.mesh.quaternion.slerp(_q, 1 - Math.exp(-9 * dt));
  }
}

const _qRoll = new THREE.Quaternion();
const _XAXIS = new THREE.Vector3(1, 0, 0);

/* ===========================================================
   魚群マネージャ
   =========================================================== */
export class FishSchool {
  constructor(scene, terrain, water, opts = {}) {
    this.scene = scene;
    this.terrain = terrain;
    this.water = water;
    this.geoCache = new Map();
    this.count = opts.count ?? 22;
    this.fishes = [];
    const matFactory = () => createFishMaterial(0.4, water.causticsUniforms);
    for (let i = 0; i < 34; i++) {
      const f = new Fish(this.geoCache, matFactory);
      scene.add(f.mesh);
      this.fishes.push(f);
    }
  }

  setCount(n) {
    this.count = clamp(n, 6, this.fishes.length);
    for (let i = this.count; i < this.fishes.length; i++) {
      if (this.fishes[i].active && this.fishes[i].state !== 'hooked') this.fishes[i].despawn();
    }
  }

  /** 指定位置付近に魚を配置（ゲーム側の抽選関数を使う） */
  populate(center, rollSpecies) {
    for (let i = 0; i < this.count; i++) {
      const f = this.fishes[i];
      if (f.active) continue;
      this._spawnNear(f, center, rollSpecies, true);
    }
  }

  _spawnNear(f, center, rollSpecies, initial = false) {
    for (let k = 0; k < 24; k++) {
      const a = rand(0, TAU);
      const r = initial ? rand(6, 52) : rand(26, 58);
      const x = center.x + Math.cos(a) * r;
      const z = center.z + Math.sin(a) * r;
      const d = this.terrain.depthAt(x, z);
      if (d < 0.7) continue;
      const sp = rollSpecies(d);
      if (!sp) continue;
      const len = sp.len[0] + Math.pow(Math.random(), 1.8) * (sp.len[1] - sp.len[0]);
      const y = -clamp(lerp(sp.depth[0], Math.min(sp.depth[1], d - 0.5), Math.random()), 0.4, Math.max(0.5, d - 0.4));
      f.spawn(sp, Math.round(len * 10) / 10, _v1.set(x, y, z));
      f._depthBias = Math.random();
      return true;
    }
    return false;
  }

  update(dt, ctx) {
    let budget = 3; // 1フレームあたりの再配置回数上限（負荷対策）
    for (let i = 0; i < this.fishes.length; i++) {
      const f = this.fishes[i];
      if (!f.active) continue;
      f.update(dt, ctx);
      // 遠い魚・陸に乗った魚は入れ替え
      if (i < this.count && f.state !== 'hooked' && f.state !== 'landed') {
        const d = Math.hypot(f.pos.x - ctx.center.x, f.pos.z - ctx.center.z);
        if (d > 78 || this.terrain.depthAt(f.pos.x, f.pos.z) < 0.35) {
          f.despawn();
          if (budget > 0 && this._spawnNear(f, ctx.center, ctx.rollSpecies)) budget--;
        }
      }
    }
    // 不足分を補充（少しずつ）
    for (let i = 0; i < this.count && budget > 0; i++) {
      if (!this.fishes[i].active) {
        this._spawnNear(this.fishes[i], ctx.center, ctx.rollSpecies);
        budget--;
      }
    }
  }

  /** 餌に興味を持つ魚を選ぶ */
  findCandidate(bait, baitDepth, scoreFn) {
    let best = null, bestScore = 0;
    for (const f of this.fishes) {
      if (!f.active || f.state === 'hooked' || f.state === 'landed' || f.state === 'jump') continue;
      const d = Math.hypot(f.pos.x - bait.x, f.pos.z - bait.z);
      if (d > 34) continue;
      const s = scoreFn(f, d) * rand(0.6, 1.4);
      if (s > bestScore) { bestScore = s; best = f; }
    }
    return best;
  }

  /**
   * 近くの魚を驚かせる。
   * sec は驚いている時間（個体ごとに ±25% ばらす）。キャストの精度で
   * 半径と時間の両方が変わるので、呼ぶ側から渡せるようにしている
   */
  startle(x, z, radius = 3.5, sec = 1.8) {
    for (const f of this.fishes) {
      if (!f.active || f.state === 'hooked') continue;
      const d = Math.hypot(f.pos.x - x, f.pos.z - z);
      if (d < radius) {
        f.startle = sec * rand(0.75, 1.25);
        if (f.state === 'wander') {
          _v1.set(f.pos.x - x, 0, f.pos.z - z).normalize().multiplyScalar(14);
          f.target.set(f.pos.x + _v1.x, f.pos.y, f.pos.z + _v1.z);
          f.timer = 2;
        }
      }
    }
  }

  /** 未使用の Fish を1つ確保（釣り上げ演出用） */
  reserve() {
    for (let i = this.count; i < this.fishes.length; i++) {
      if (!this.fishes[i].active) return this.fishes[i];
    }
    for (const f of this.fishes) if (!f.active) return f;
    return this.fishes[this.fishes.length - 1];
  }
}
