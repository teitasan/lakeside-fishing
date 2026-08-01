/* ===========================================================
   仕掛け（ハリ）とエサのプロシージャルメッシュ

   方針
   - ハリとエサを同じ座標系で作る（原点＝道糸の付け根／y- が水底方向）。
     エサは必ずハリに刺さった位置に置く。宙に浮かせない。
   - 低ポリ＋フラットシェーディングで、地形・岩・木と質感を合わせる。
   - うねりは「入れ子の関節」で回す。節を個別に回すとバラけるので、
     必ず親の先端に子をぶら下げる（動かしても分解しない）。
   - 1 エサ 1 マテリアル（頂点カラー）。部品はマージしてドローコールを抑える。
   =========================================================== */
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const V = (x, y, z = 0) => new THREE.Vector3(x, y, z);
const C = (hex) => new THREE.Color(hex);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* ハリの寸法。エサはこの値を基準に配置する
   軸は x=0 を真下へ、ふところ（曲がり）は XY 平面（＝縦向き）の U 字 */
export const HOOK = {
  shankTop: -0.012,   // 軸の上端（オモリの中）
  shankBot: -0.060,   // 軸の下端＝ふところの始まり
  cx: 0.016,          // ふところの中心
  cy: -0.060,
  r: 0.016,           // ふところの半径（＝ハリのふところ幅の半分）
  wire: 0.0028,       // 軸の太さ
};

/** ふところの弧の上の点。deg: 180=軸の下端 / 270=最下部 / 360=外側 / 390=先端の根元 */
function hookAt(deg) {
  const a = (deg * Math.PI) / 180;
  return V(HOOK.cx + Math.cos(a) * HOOK.r, HOOK.cy + Math.sin(a) * HOOK.r, 0);
}
/** 弧の接線（反時計回り＝先端へ向かう向き） */
function hookTan(deg) {
  const a = (deg * Math.PI) / 180;
  return V(-Math.sin(a), Math.cos(a), 0);
}

/* ---------------- 低ポリの部品 ---------------- */

/** 座標から決まる擬似乱数。同じ位置の頂点は同じ値になるので、揺らしても面が裂けない */
function hash(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

function paint(geo, fn) {
  const p = geo.attributes.position;
  const col = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    fn(p.getX(i), p.getY(i), p.getZ(i), c);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

const solid = (geo, color) => paint(geo, (x, y, z, c) => c.copy(color));

/** position / normal / color だけをまとめる（テクスチャは使わない） */
function mergeGeo(parts) {
  const geos = [];
  for (const g of parts) {
    if (!g) continue;
    if (!g.index) { geos.push(g); continue; }
    const n = g.toNonIndexed();
    g.dispose();
    geos.push(n);
  }
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

/**
 * 折れ線に沿った連続した向き。
 * 節ごとに UP から向きを求めると、真下に近い向きでねじれが暴れて
 * 断面がバラバラになる（＝でこぼこに見える）。前の節から回して繋ぐ。
 */
function chainFrames(points) {
  const out = [];
  const q = new THREE.Quaternion();
  let prev = UP.clone();
  for (let i = 0; i < points.length - 1; i++) {
    const d = new THREE.Vector3().subVectors(points[i + 1], points[i]);
    if (d.lengthSq() < 1e-12) { out.push(q.clone()); continue; }
    d.normalize();
    q.premultiply(new THREE.Quaternion().setFromUnitVectors(prev, d));
    out.push(q.clone());
    prev = d;
  }
  return out;
}

/** from→to の筒。節ごとに閉じておく（曲げても中身が覗かない） */
function tubeGeo(from, to, r0, r1, radial = 5, quat = null) {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length();
  if (len < 1e-6) return null;
  const g = new THREE.CylinderGeometry(r1, r0, len, radial, 1, false);
  g.translate(0, len * 0.5, 0);
  g.applyQuaternion(quat || new THREE.Quaternion().setFromUnitVectors(UP, dir.divideScalar(len)));
  g.translate(from.x, from.y, from.z);
  return g;
}

/** 両端をふさいだ棒（触角・脚・ハリの軸） */
function rodGeo(from, to, r0, r1, radial = 4) {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length();
  if (len < 1e-6) return null;
  const g = new THREE.CylinderGeometry(r1, r0, len, radial, 1, false);
  g.translate(0, len * 0.5, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.divideScalar(len)));
  g.translate(from.x, from.y, from.z);
  return g;
}

/** from から dir 方向へ伸びる円錐（先端＝from + dir*len） */
function coneGeo(from, dir, len, r, radial = 5) {
  const g = new THREE.ConeGeometry(r, len, radial);
  g.translate(0, len * 0.5, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize()));
  g.translate(from.x, from.y, from.z);
  return g;
}

function ballGeo(pos, r, detail = 0) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  g.translate(pos.x, pos.y, pos.z);
  return g;
}

/** ごつごつした塊（練り餌・撒き餌）。半径方向にだけ揺らすので面は裂けない */
function lumpGeo(pos, r, jitter, seed, detail = 1) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 + (hash(v.x * 900 + seed, v.y * 900, v.z * 900) - 0.5) * jitter;
    p.setXYZ(i, v.x * k, v.y * k, v.z * k);
  }
  g.computeVertexNormals();
  g.translate(pos.x, pos.y, pos.z);
  return g;
}

/** 厚みのない板（ヒレ）。points は XY の輪郭、[0] を扇の要にする */
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

/**
 * 入れ子の関節でつないだ胴。points（絶対座標の折れ線）に沿って作る。
 * 返す bones は「静止姿勢が単位回転」のグループなので、
 * rotation を足すだけで曲がり、先の節がちゃんと付いてくる。
 */
function boneChain(points, radii, material, colorFn, radial = 6) {
  const root = new THREE.Group();
  root.position.copy(points[0]);
  const bones = [];
  const n = points.length - 1;
  const frames = chainFrames(points);
  const inv = new THREE.Quaternion();
  let parent = root;
  let prevLen = 0;
  for (let i = 0; i < n; i++) {
    const len = points[i].distanceTo(points[i + 1]);
    if (len < 1e-6) continue;

    const socket = new THREE.Group();               // 静止姿勢（親の先端に付く）
    socket.position.set(0, prevLen, 0);
    if (i === 0) socket.quaternion.copy(frames[0]);
    else socket.quaternion.copy(inv.copy(frames[i - 1]).invert()).multiply(frames[i]);
    parent.add(socket);
    const flex = new THREE.Group();                 // ここを回す
    socket.add(flex);

    const r0 = radii[i];
    const r1 = radii[i + 1];
    // 継ぎ目：次の節の中に少しだけ差し込んでおくと、曲げても切れ目が出ない
    const parts = [tubeGeo(V(0, 0, 0), V(0, len, 0), r0, r1, radial)];
    if (i < n - 1) parts.push(tubeGeo(V(0, len, 0), V(0, len + r1 * 0.5, 0), r1 * 0.9, r1 * 0.82, radial));
    else parts.push(ballGeo(V(0, len, 0), r1 * 0.98));          // 尻をまるめる
    if (i === 0) parts.push(ballGeo(V(0, 0, 0), r0 * 0.98));    // 頭をまるめる
    const geo = mergeGeo(parts);
    paint(geo, (x, y, z, c) => colorFn(clamp01((i + y / len) / n), x, y, z, c));
    flex.add(new THREE.Mesh(geo, material));

    bones.push(flex);
    parent = flex;
    prevLen = len;
  }
  return { root, bones };
}

/** 揺れの支点。中身は支点を原点に置き直す */
function pivotMesh(parts, pivot, material) {
  const geo = mergeGeo(parts);
  geo.translate(-pivot.x, -pivot.y, -pivot.z);
  return new THREE.Mesh(geo, material);
}

function baitMat(opts = {}) {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: opts.flat !== false,
    side: THREE.DoubleSide,
    roughness: opts.roughness ?? 0.7,
    metalness: opts.metalness ?? 0.02,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
  });
}

/* ===========================================================
   ハリ
   =========================================================== */
export function createHookMesh(material) {
  const parts = [];
  // 軸
  parts.push(rodGeo(V(0, HOOK.shankTop), V(0, HOOK.shankBot), HOOK.wire, HOOK.wire, 5));
  // ふところ（縦向きの U 字。180°→390° の弧）
  const bend = new THREE.TorusGeometry(HOOK.r, HOOK.wire, 4, 10, Math.PI * (210 / 180));
  bend.rotateZ(Math.PI);
  bend.translate(HOOK.cx, HOOK.cy, 0);
  parts.push(bend);
  // 針先（軸の方を向く）
  const base = hookAt(390);
  const dir = hookTan(390);
  parts.push(coneGeo(base, dir, 0.015, HOOK.wire, 5));
  // カエシ
  const barb = base.clone().addScaledVector(dir, 0.0065);
  parts.push(coneGeo(barb, V(0.6, -0.8, 0), 0.006, 0.0021, 4));

  const mesh = new THREE.Mesh(mergeGeo(parts), material);
  mesh.name = 'hook';
  return mesh;
}

/* ===========================================================
   エサ
   =========================================================== */

/** ミミズ：軸に縫い刺しして、ふところをくぐらせ、先を垂らす */
function wormMesh() {
  const mat = baitMat({ roughness: 0.5 });
  const skin = C(0xa85c47);
  const dark = C(0x7e3f33);
  const band = C(0xd39d86);
  // 頭はオモリの下から出す。軸に縫い刺しして、ふところをまたいで垂れる
  const pts = [
    V(0.000, -0.040, 0.000),      // 軸を体の芯が通る＝縫い刺し
    V(-0.001, -0.050, 0.001),
    V(0.000, -0.059, -0.001),
    V(0.004, -0.066, -0.003),
    V(0.011, -0.071, -0.002),
    V(0.019, -0.075, 0.001),      // ここでふところの線をまたぐ
    V(0.026, -0.081, 0.003),
    V(0.030, -0.091, 0.005),
    V(0.026, -0.101, 0.003),
  ];
  const rad = [0.0054, 0.0070, 0.0074, 0.0071, 0.0065, 0.0057, 0.0047, 0.0034, 0.0012];
  const { root, bones } = boneChain(pts, rad, mat, (t, x, y, z, c) => {
    const ring = 0.5 + 0.5 * Math.sin(t * 78);          // 体節の輪
    c.copy(skin).lerp(dark, ring * 0.3 + t * 0.25);
    if (t > 0.22 && t < 0.30) c.lerp(band, 0.65);       // 環帯
  });

  const g = new THREE.Group();
  g.add(root);
  g.userData.materials = [mat];
  // 刺さっている頭側はほとんど動かず、垂れた先ほど大きくうねる
  g.userData.anim = {
    bones: bones.map((o, i) => ({
      o,
      az: 0.03 + 0.20 * Math.pow(i / (bones.length - 1), 1.6),
      ax: 0.02 + 0.12 * Math.pow(i / (bones.length - 1), 1.6),
      f: 2.6,
      p: -i * 0.85,
    })),
  };
  return g;
}

/** アカムシ：ふところに小さい赤虫を数匹刺した房 */
function akamushiMesh() {
  const mat = baitMat({ roughness: 0.45 });
  const red = C(0xc4342c);
  const deep = C(0x8e1f1c);
  const pale = C(0xe1685c);
  const g = new THREE.Group();
  const anim = { bones: [] };
  const N = 7;
  for (let k = 0; k < N; k++) {
    // ふところの下半分に寄せて刺す（房になるように）
    const deg = 215 + k * 20 + (k % 2) * 6;
    const a = (deg * Math.PI) / 180;
    const out = V(Math.cos(a), Math.sin(a), 0);
    const side = V(Math.cos(k * 2.4), 0, Math.sin(k * 2.4)).normalize();
    const p0 = hookAt(deg).addScaledVector(out, 0.0008).addScaledVector(side, 0.0016);
    const d0 = out.clone().multiplyScalar(0.12).add(V(0, -1, 0)).addScaledVector(side, 0.22).normalize();
    const len = 0.0068 + (k % 3) * 0.0014;
    const p1 = p0.clone().addScaledVector(d0, len);
    const d1 = d0.clone().addScaledVector(side, 0.75).add(V(0, 0.10, 0)).normalize();
    const p2 = p1.clone().addScaledVector(d1, len * 0.8);
    const d2 = d1.clone().addScaledVector(side, 1.1).add(V(0, 0.55, 0)).normalize();   // 先はくるんと丸まる
    const p3 = p2.clone().addScaledVector(d2, len * 0.62);
    const { root, bones } = boneChain(
      [p0, p1, p2, p3],
      [0.0019, 0.0018, 0.0013, 0.0006],
      mat,
      (t, x, y, z, c) => {
        c.copy(red).lerp(deep, 0.4 - t * 0.4).lerp(pale, t * 0.55);
      },
      5
    );
    g.add(root);
    bones.forEach((o, i) => anim.bones.push({
      o,
      az: 0.12 + i * 0.20,
      ax: 0.10 + i * 0.16,
      f: 4.2 + k * 0.31,
      p: k * 1.7 - i * 0.8,
    }));
  }
  g.userData.materials = [mat];
  g.userData.anim = anim;
  return g;
}

/** 練り餌：ふところを包むように丸めて、針先だけ出す */
function doughMesh() {
  const mat = baitMat({ roughness: 0.95 });
  const pale = C(0xe3d3a8);
  const shade = C(0xbca878);
  const parts = [];
  const core = lumpGeo(V(0.015, -0.068, 0), 0.021, 0.24, 3.1, 1);
  core.scale(1.06, 0.94, 1.0);
  parts.push(core);
  parts.push(lumpGeo(V(0.005, -0.050, 0.002), 0.0105, 0.3, 9.4, 1));  // 軸に押し付けた分
  parts.push(lumpGeo(V(0.026, -0.077, -0.004), 0.008, 0.35, 5.7, 0)); // ちぎれかけの粒
  const geo = mergeGeo(parts);
  paint(geo, (x, y, z, c) => {
    const v = clamp01((y + 0.090) / 0.045);            // 下ほど濡れて暗い
    c.copy(shade).lerp(pale, v * 0.85 + 0.15);
    c.lerp(shade, hash(x * 700, y * 700, z * 700) * 0.22);
  });
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, mat));
  g.userData.materials = [mat];
  return g;
}

/** イクラ：ふところに数粒を串刺し */
function roeMesh() {
  const mat = baitMat({ flat: false, roughness: 0.22, metalness: 0.0 });
  const skinC = C(0xf07a2c);
  const deepC = C(0xc9491a);
  const hiC = C(0xffc07a);
  const eggs = [
    { deg: 196, r: 0.0082, z: 0.0008 },
    { deg: 236, r: 0.0090, z: -0.0010 },
    { deg: 278, r: 0.0092, z: 0.0012 },
    { deg: 320, r: 0.0086, z: -0.0006 },
    { deg: 356, r: 0.0076, z: 0.0009 },
  ];
  const parts = [];
  for (const e of eggs) {
    const p = hookAt(e.deg);
    p.z += e.z;
    const geo = new THREE.IcosahedronGeometry(e.r, 1);
    geo.translate(p.x, p.y, p.z);
    paint(geo, (x, y, z, c) => {
      const v = clamp01((y - (p.y - e.r)) / (e.r * 2));
      c.copy(deepC).lerp(skinC, clamp01(v * 1.5));
      c.lerp(hiC, Math.pow(clamp01((v - 0.55) / 0.45), 2) * 0.9);   // 上面のツヤ
    });
    parts.push(geo);
  }
  const g = new THREE.Group();
  g.add(new THREE.Mesh(mergeGeo(parts), mat));
  g.userData.materials = [mat];
  return g;
}

/** 川エビ：尾を針先に刺して、頭を下にぶら下げる */
function shrimpMesh() {
  const mat = baitMat({ roughness: 0.45 });
  const shell = C(0xdcc0ab);
  const backC = C(0xa87f65);
  const pale = C(0xf2e6dc);
  const limb = C(0xe6d4c6);
  const eyeC = C(0x141418);

  const body = [
    V(0.0235, -0.0455, 0),      // 尾（ここを針先が貫く）
    V(0.0215, -0.0530, 0),
    V(0.0180, -0.0620, 0),
    V(0.0130, -0.0700, 0),
    V(0.0055, -0.0775, 0),
    V(-0.0030, -0.0835, 0),     // 頭
  ];
  const rad = [0.0032, 0.0052, 0.0066, 0.0076, 0.0078, 0.0052];
  const parts = [];
  // 胴（節）— 動かさないので 1 枚にマージ。断面はつなげて回す（でこぼこ防止）
  const frames = chainFrames(body);
  for (let i = 0; i < body.length - 1; i++) {
    const seg = tubeGeo(body[i], body[i + 1], rad[i], rad[i + 1], 6, frames[i]);
    const t0 = i / (body.length - 1);
    parts.push(paint(seg, (x, y, z, c) => {
      const up = clamp01((y - (body[i].y - rad[i])) / (rad[i] * 2));
      c.copy(pale).lerp(shell, up * 0.8);
      if (i < 4) c.lerp(backC, 0.16 + (i % 2) * 0.20);      // 腹節の縞
      c.lerp(backC, clamp01(t0 * 0.3));
    }));
  }
  parts.push(solid(ballGeo(body[body.length - 1], rad[rad.length - 1] * 1.05), shell));

  // 尾扇（3枚）：胴の延長方向へ広げる
  const fanDir = new THREE.Vector3().subVectors(body[0], body[1]).normalize();
  for (const roll of [-0.62, 0, 0.62]) {
    const leaf = finGeo([[0, 0], [0.0042, 0.0092], [0.0020, 0.0158], [-0.0020, 0.0158], [-0.0042, 0.0092]]);
    leaf.rotateY(roll);
    leaf.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, fanDir));
    leaf.translate(body[0].x, body[0].y, body[0].z);
    parts.push(solid(leaf, pale.clone().lerp(backC, 0.25)));
  }
  // 額角（トゲ）
  parts.push(solid(coneGeo(V(-0.0015, -0.0820, 0), V(-0.78, -0.62, 0), 0.0135, 0.0024, 4), backC));
  // 目
  for (const s of [1, -1]) {
    parts.push(solid(ballGeo(V(0.0005, -0.0800, s * 0.0040), 0.0022), eyeC));
  }
  // 触角（長・短）
  for (const s of [1, -1]) {
    parts.push(solid(rodGeo(
      V(-0.0020, -0.0830, s * 0.0022), V(-0.0180, -0.1010, s * 0.0130), 0.0012, 0.0004, 3), backC));
    parts.push(solid(rodGeo(
      V(-0.0025, -0.0845, s * 0.0018), V(-0.0090, -0.0985, s * 0.0055), 0.0009, 0.0003, 3), limb));
  }
  // 歩脚（左右 3 対）：腹側から前下へ折れる
  for (const s of [1, -1]) {
    for (let i = 0; i < 3; i++) {
      const t = i / 2;
      const base = V(lerp(0.0115, 0.0048, t) - 0.0018, lerp(-0.0745, -0.0820, t), s * 0.0028);
      const knee = V(base.x - 0.0048, base.y - 0.0052, s * 0.0074);
      parts.push(solid(rodGeo(base, knee, 0.0013, 0.0010, 3), limb));
      parts.push(solid(rodGeo(knee, V(knee.x - 0.0055, knee.y - 0.0058, s * 0.0062), 0.0010, 0.0004, 3), limb));
    }
  }

  const anchor = V(0.0235, -0.0455, 0);
  const pivot = new THREE.Group();
  pivot.position.copy(anchor);
  pivot.add(pivotMesh(parts, anchor, mat));

  const g = new THREE.Group();
  g.add(pivot);
  g.userData.materials = [mat];
  g.userData.anim = { swing: { o: pivot, ay: 0.20, az: 0.10, f: 1.35 } };
  return g;
}

/** 小魚（泳がせ）：背掛け。ふところが背中を通り、体は下にぶら下がる */
function minnowMesh() {
  const mat = baitMat({ roughness: 0.35, metalness: 0.12 });
  const y0 = -0.0800;                 // 体の中心線
  const cx = 0.002;                   // 体の中心（x）
  const H = 0.0078;                   // 体高の半分
  const hinge = V(0.028, y0, 0);      // 尾の付け根
  const anchor = V(0.016, -0.0755, 0);// 針が刺さっている背中

  const backC = C(0x5f7c8c);
  const flank = C(0xb7c8d1);
  const bellyC = C(0xf1f5f5);
  const finC = C(0x8ba1ac);
  const eyeC = C(0x14161a);

  const paintBody = (x, y, z, c) => {
    const v = clamp01((y - y0) / H * 0.5 + 0.5);                 // 0=腹 1=背
    if (v > 0.58) c.copy(flank).lerp(backC, clamp01((v - 0.58) / 0.42));
    else c.copy(bellyC).lerp(flank, clamp01(v / 0.58));
    if (Math.abs(v - 0.5) < 0.06) c.lerp(C(0xdfe9ee), 0.55);     // 側線の銀
    if (x < cx - 0.022) c.lerp(C(0x39434a), 0.5);                // 口先
  };

  /* --- 胴（回転体を横に寝かせ、Z を潰して魚らしく） --- */
  const profile = [
    new THREE.Vector2(0.0000, -0.0280),
    new THREE.Vector2(0.0034, -0.0235),
    new THREE.Vector2(0.0062, -0.0160),
    new THREE.Vector2(0.0078, -0.0060),
    new THREE.Vector2(0.0080, 0.0030),
    new THREE.Vector2(0.0066, 0.0120),
    new THREE.Vector2(0.0040, 0.0210),
    new THREE.Vector2(0.0021, 0.0255),
    new THREE.Vector2(0.0000, 0.0285),      // 尾の付け根で閉じる（穴を残さない）
  ];
  const bodyGeo = new THREE.LatheGeometry(profile, 7);
  bodyGeo.rotateZ(-Math.PI / 2);        // 軸を +X（頭が -X）へ
  bodyGeo.scale(1, 0.98, 0.62);
  bodyGeo.translate(cx, y0, 0);
  const parts = [paint(bodyGeo, paintBody)];

  // 背びれ（ハリはこの後ろに掛ける）・尻びれ・胸びれ
  parts.push(solid(finGeo([
    [cx - 0.013, y0 + 0.0064], [cx - 0.007, y0 + 0.0170], [cx - 0.001, y0 + 0.0072],
  ]), finC));
  parts.push(solid(finGeo([
    [cx + 0.014, y0 - 0.0054], [cx + 0.019, y0 - 0.0130], [cx + 0.023, y0 - 0.0034],
  ]), finC.clone().lerp(bellyC, 0.25)));
  for (const s of [1, -1]) {
    const pec = finGeo([[0, 0], [-0.0080, -0.0055], [-0.0100, 0.0018]]);
    pec.rotateX(s * 0.95);
    pec.translate(cx - 0.014, y0 - 0.0012, s * 0.0026);
    parts.push(solid(pec, finC.clone().lerp(bellyC, 0.35)));
  }
  // 目
  for (const s of [1, -1]) {
    parts.push(solid(ballGeo(V(cx - 0.0196, y0 + 0.0026, s * 0.0028), 0.0019), eyeC));
  }

  /* --- 尾（付け根で振れる） --- */
  const tailParts = [
    paint(tubeGeo(V(0.0265, y0, 0), V(0.0315, y0, 0), 0.0024, 0.0014, 5), paintBody),
    solid(ballGeo(V(0.0270, y0, 0), 0.0026), flank),
    solid(finGeo([
      [0.0300, y0], [0.0445, y0 + 0.0135], [0.0395, y0], [0.0445, y0 - 0.0135],
    ]), finC),
  ];

  const pivot = new THREE.Group();
  pivot.position.copy(anchor);
  pivot.add(pivotMesh(parts, anchor, mat));
  const tail = new THREE.Group();
  tail.position.copy(hinge).sub(anchor);
  tail.add(pivotMesh(tailParts, hinge, mat));
  pivot.add(tail);

  const g = new THREE.Group();
  g.add(pivot);
  g.userData.materials = [mat];
  g.userData.anim = {
    swing: { o: pivot, ay: 0.16, az: 0.07, f: 1.1 },
    bones: [{ o: tail, ay: 0.45, az: 0.05, f: 5.2, p: 0.6 }],
  };
  return g;
}

/** 秘伝の撒き餌：黒く発酵した塊に、金の粒が混じって鈍く光る */
function secretMesh() {
  const mat = baitMat({ roughness: 0.8 });
  const glowMat = baitMat({
    flat: true, roughness: 0.35,
    emissive: 0xd9c274, emissiveIntensity: 0.55,
  });
  const darkC = C(0x3b3628);
  const mudC = C(0x564d34);
  const parts = [];
  const core = lumpGeo(V(0.015, -0.068, 0), 0.0215, 0.3, 1.7, 1);
  core.scale(1.04, 0.96, 1.0);
  parts.push(core);
  parts.push(lumpGeo(V(0.004, -0.049, -0.002), 0.0105, 0.34, 7.2, 1));
  parts.push(lumpGeo(V(0.028, -0.079, 0.003), 0.0075, 0.4, 4.4, 0));
  const geo = mergeGeo(parts);
  paint(geo, (x, y, z, c) => {
    const n = hash(x * 800, y * 800, z * 800);
    c.copy(darkC).lerp(mudC, n * 0.7);
    c.multiplyScalar(0.85 + clamp01((y + 0.092) / 0.05) * 0.3);
  });

  const g = new THREE.Group();
  const body = new THREE.Mesh(geo, mat);
  g.add(body);

  // 金の粒：塊の表面に半分だけ顔を出させる
  const flecks = [];
  const center = V(0.015, -0.068, 0);
  const dirs = [
    [-0.52, 0.62, 0.59], [0.68, 0.44, -0.58], [-0.10, -0.86, 0.50],
    [0.86, -0.30, 0.41], [-0.72, -0.25, -0.65], [0.22, 0.80, -0.56],
  ];
  for (const d of dirs) {
    const n = V(...d).normalize();
    const p = center.clone().addScaledVector(n, 0.0205 + hash(d[0] * 91, d[1] * 57, d[2] * 33) * 0.0018);
    const f = new THREE.OctahedronGeometry(0.0032 + hash(d[1] * 41, d[2] * 77, d[0] * 23) * 0.0016, 0);
    f.translate(p.x, p.y, p.z);
    flecks.push(solid(f, C(0xf0dc9a)));
  }
  g.add(new THREE.Mesh(mergeGeo(flecks), glowMat));

  g.userData.materials = [mat, glowMat];
  g.userData.anim = {
    swing: { o: g, ay: 0.10, az: 0.05, f: 0.7 },
    glow: [{ mat: glowMat, base: 0.5, amp: 0.3, f: 2.4 }],
  };
  return g;
}

const BUILDERS = {
  worm: wormMesh,
  akamushi: akamushiMesh,
  dough: doughMesh,
  roe: roeMesh,
  shrimp: shrimpMesh,
  minnow: minnowMesh,
  secret: secretMesh,
};

/**
 * エサの見た目グループを作る。座標系は HOOK と共通（原点＝道糸の付け根）。
 * @returns {THREE.Group}
 */
export function createBaitMesh(id) {
  const build = BUILDERS[id] || BUILDERS.worm;
  const g = build();
  g.name = `bait:${id}`;
  g.userData.baitId = id;
  g.userData.phase = Math.random() * Math.PI * 2;
  return g;
}

/** 種別ごとの弱いうねり・揺れ。t は秒 */
export function updateBaitMesh(group, t) {
  const anim = group && group.userData.anim;
  if (!anim) return;
  const time = t + (group.userData.phase || 0);
  if (anim.bones) {
    for (const b of anim.bones) {
      const s = Math.sin(time * b.f + (b.p || 0));
      if (b.az) b.o.rotation.z = s * b.az;
      if (b.ax) b.o.rotation.x = Math.sin(time * b.f * 0.63 + (b.p || 0) * 1.7) * b.ax;
      if (b.ay) b.o.rotation.y = s * b.ay;
    }
  }
  if (anim.swing) {
    const s = anim.swing;
    s.o.rotation.y = Math.sin(time * s.f) * s.ay;
    s.o.rotation.z = Math.sin(time * s.f * 0.71 + 1.1) * s.az;
  }
  if (anim.glow) {
    for (const g of anim.glow) {
      g.mat.emissiveIntensity = g.base + Math.sin(time * g.f) * g.amp;
    }
  }
}

export function disposeBaitMesh(group) {
  if (!group) return;
  group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  for (const m of group.userData.materials || []) m.dispose();
}
