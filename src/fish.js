/* ===========================================================
   魚：プロシージャル生成メッシュ + 遊泳AI
   =========================================================== */
import * as THREE from 'three';
import { clamp, clamp01, lerp, rand, smoothstep, TAU, damp } from './util.js';
import { depthBandAt, colorsOf } from './data.js';

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
  gar: { h: 0.155, w: 0.13, dorsal: 0.11, tail: 0.16, fork: 0.25 },
  sturgeon: { h: 0.20, w: 0.16, dorsal: 0.14, tail: 0.22, fork: 0.60 },
};

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

/* ---------------- ジオメトリ結合（addons 不要の簡易版） ---------------- */
function mergeGeos(list) {
  const geos = list.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const c = g.attributes.color;
    pos.set(p.array.subarray(0, p.count * 3), o * 3);
    if (n) nor.set(n.array.subarray(0, p.count * 3), o * 3);
    if (c) col.set(c.array.subarray(0, p.count * 3), o * 3);
    else col.fill(1, o * 3, (o + p.count) * 3);
    o += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
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
  return g;
}

const hash3 = (x, y, z) => {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
};

/* ===========================================================
   魚メッシュ生成
   =========================================================== */
export function createFishGeometry(sp, opts = {}) {
  const albino = !!opts.albino;
  const lenM = (sp.len[1] * 0.85) / 100 * VIS_SCALE; // 代表サイズで作り、後でスケール
  const shape = PROFILES[sp.shape] ? sp.shape : 'slim';
  const B = BODY[shape];
  const prof = PROFILES[shape];
  const H = lenM * B.h, Wd = lenM * B.w;

  /* --- 胴体（回転体） --- */
  const N = 20;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    pts.push(new THREE.Vector2(Math.max(0.004, profileAt(prof, t) * 0.5), t - 0.5));
  }
  const body = new THREE.LatheGeometry(pts, 14);
  body.rotateZ(-Math.PI / 2);
  body.scale(lenM, H, Wd);

  const cols = colorsOf(sp, albino);
  const top = new THREE.Color(cols.top);
  const mid = new THREE.Color(cols.mid);
  const belly = new THREE.Color(cols.belly);
  const finC = new THREE.Color(cols.fin);
  const pattern = albino ? 'none'
    : sp.rarity >= 2 ? (sp.tags.includes('trout') ? 'spots' : sp.tags.includes('predator') ? 'stripe' : 'bars') : 'none';

  paint(body, (x, y, z, c) => {
    const v = clamp01((y / (H * 0.5) + 1) * 0.5); // 0=腹 1=背
    if (v > 0.62) c.copy(mid).lerp(top, smoothstep(0.62, 1.0, v));
    else c.copy(belly).lerp(mid, smoothstep(0.1, 0.62, v));

    const tx = x / lenM + 0.5; // 0=尾 1=頭
    if (pattern === 'spots') {
      const h = hash3(Math.floor(x * 190), Math.floor(y * 190), Math.floor(z * 90));
      if (h > 0.9 && v > 0.35) c.multiplyScalar(0.55);
      else if (h > 0.86 && v > 0.5) c.lerp(top, 0.5);
    } else if (pattern === 'stripe') {
      const band = Math.abs(v - 0.55) < 0.09 + Math.sin(tx * 22) * 0.025;
      if (band) c.multiplyScalar(0.5);
    } else if (pattern === 'bars') {
      const b = Math.sin(tx * 26) * 0.5 + 0.5;
      if (b > 0.78 && v > 0.4) c.multiplyScalar(0.72);
    }
    // 口元を暗く
    if (tx > 0.955) c.multiplyScalar(albino ? 0.82 : 0.5);
  });

  const parts = [body];

  /* --- 尾びれ --- */
  const tl = lenM * B.tail, th = H * (0.75 + B.fork * 0.7) + lenM * 0.03;
  const tail = finGeo([
    [-lenM * 0.47, 0],
    [-lenM * 0.47 - tl, th],
    [-lenM * 0.47 - tl * (1 - B.fork * 0.6), 0],
    [-lenM * 0.47 - tl, -th],
  ]);
  parts.push(paint(tail, (x, y, z, c) => {
    c.copy(finC).multiplyScalar(0.75 + 0.25 * clamp01(1 - Math.abs(y) / th));
  }));

  /* --- 背びれ --- */
  const dh = H * B.dorsal * 3.0;
  const dorsal = finGeo([
    [lenM * 0.12, H * 0.48],
    [-lenM * 0.02, H * 0.48 + dh],
    [-lenM * 0.16, H * 0.46],
  ]);
  parts.push(paint(dorsal, (x, y, z, c) => c.copy(finC).multiplyScalar(0.9)));

  /* --- 尻びれ --- */
  const anal = finGeo([
    [-lenM * 0.1, -H * 0.44],
    [-lenM * 0.22, -H * 0.44 - dh * 0.55],
    [-lenM * 0.3, -H * 0.42],
  ]);
  parts.push(paint(anal, (x, y, z, c) => c.copy(finC).multiplyScalar(0.8)));

  /* --- 胸びれ（左右） --- */
  for (const s of [1, -1]) {
    const pec = finGeo([
      [lenM * 0.2, -H * 0.05],
      [lenM * 0.04, -H * 0.42],
      [lenM * 0.02, -H * 0.02],
    ]);
    pec.rotateX(s * 1.15);
    pec.translate(0, 0, s * Wd * 0.42);
    parts.push(paint(pec, (x, y, z, c) => c.copy(finC).multiplyScalar(0.95)));
  }

  /* --- 目 --- */
  const eyeR = Math.max(lenM * 0.012, H * 0.13);
  for (const s of [1, -1]) {
    const eye = new THREE.SphereGeometry(eyeR, 8, 6);
    eye.translate(lenM * (shape === 'gar' ? 0.30 : 0.355), H * 0.13, s * Wd * 0.42);
    parts.push(paint(eye, (x, y, z, c) => {
      const front = z * s > Wd * 0.44;
      if (albino) c.setRGB(front ? 0.72 : 0.95, front ? 0.08 : 0.35, front ? 0.12 : 0.38);
      else c.setRGB(front ? 0.03 : 0.5, front ? 0.03 : 0.45, front ? 0.05 : 0.4);
    }));
    const glint = new THREE.SphereGeometry(eyeR * 0.42, 6, 4);
    glint.translate(lenM * (shape === 'gar' ? 0.31 : 0.365), H * 0.19, s * Wd * 0.5);
    parts.push(paint(glint, (x, y, z, c) => c.setRGB(1, 1, 1)));
  }

  /* --- ヒゲ（ナマズ類） --- */
  if (shape === 'eel') {
    for (const s of [1, -1]) {
      for (let k = 0; k < 2; k++) {
        const wl = lenM * (k === 0 ? 0.3 : 0.16);
        const bar = new THREE.CylinderGeometry(lenM * 0.006, lenM * 0.002, wl, 4);
        bar.rotateZ(Math.PI / 2);
        bar.rotateY(s * (0.5 + k * 0.35));
        bar.translate(lenM * 0.46, k === 0 ? H * 0.05 : -H * 0.2, s * Wd * 0.25);
        parts.push(paint(bar, (x, y, z, c) => c.copy(mid).multiplyScalar(0.85)));
      }
    }
  }

  const geo = mergeGeos(parts);
  geo.userData.baseLength = lenM;
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
export function createFishMaterial(shiny = 0.35) {
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
  mat.customProgramCacheKey = () => 'fish-wiggle-v1';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader =
      'uniform float uTime, uAmp, uFreq, uLen, uBend;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */ `
      vec3 transformed = vec3( position );
      float tailK = clamp(0.5 - position.x / uLen, 0.0, 1.0);
      float wig = sin(position.x / uLen * uFreq - uTime * 6.2831) * uAmp * uLen;
      transformed.z += wig * pow(tailK, 1.6);
      transformed.z += uBend * uLen * pow(tailK, 2.0);
      `
    );
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
    const matFactory = () => createFishMaterial(0.4);
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

  /** 近くの魚を驚かせる */
  startle(x, z, radius = 3.5) {
    for (const f of this.fishes) {
      if (!f.active || f.state === 'hooked') continue;
      const d = Math.hypot(f.pos.x - x, f.pos.z - z);
      if (d < radius) {
        f.startle = rand(1.2, 2.5);
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
