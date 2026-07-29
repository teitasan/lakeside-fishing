/* ===========================================================
   地形・湖底・岸辺の装飾・桟橋
   =========================================================== */
import * as THREE from 'three';
import { makeRng, clamp, clamp01, lerp, smoothstep, TAU } from './util.js';
import { WORLD_SIZE, WATER_REGION, MAX_DEPTH, resolveLake } from './lakefield.js';

export { WORLD_SIZE, WATER_REGION, MAX_DEPTH };

const DOCK_HALF_W = 1.62;   // 床の半幅（見た目 3.4m のうち内側）
const OBS_CELL = 8;         // 障害物グリッドのセルサイズ(m)

const tmpColor = new THREE.Color();
const tmpSand = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const _dl = { al: 0, si: 0 };
const _dl2 = { al: 0, si: 0 };

/** 線分 vs AABB（スラブ法） */
function segBoxHit(p0, p1, min, max) {
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = p1[i] - p0[i];
    if (Math.abs(d) < 1e-9) {
      if (p0[i] < min[i] || p0[i] > max[i]) return false;
      continue;
    }
    let ta = (min[i] - p0[i]) / d, tb = (max[i] - p0[i]) / d;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  return true;
}

export class Terrain {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts  lake（lakefield.resolveLake の結果）または seed
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.quality = opts.quality || 'mid';

    // 地形の数学部分は lakefield.js（検証済みの湖）に委譲
    this.lake = opts.lake || resolveLake(opts.seed ?? 20240711).lake;
    this.seed = this.lake.seed;
    this.noise = this.lake.noise;
    this.hole = this.lake.hole;
    this.flat = this.lake.flat;
    this.dockAngle = this.lake.dock.angle;

    this.obstacles = [];        // [x, z, r, x, z, r, ...]
    this._obsGrid = new Map();

    this._buildHeightTexture();
    this._buildTerrainMesh();
    this._findDock();
    this._buildDock();
    this._buildProps();
  }

  /* ---------------- 高さ関数（lakefield へ委譲） ---------------- */
  shoreRadius(x, z) { return this.lake.shoreRadius(x, z); }
  heightAt(x, z) { return this.lake.heightAt(x, z); }

  depthAt(x, z) {
    return Math.max(0, -this.heightAt(x, z));
  }

  isWater(x, z) {
    return this.heightAt(x, z) < 0;
  }

  normalAt(x, z, e = 0.7) {
    const hL = this.heightAt(x - e, z), hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e), hU = this.heightAt(x, z + e);
    return new THREE.Vector3(hL - hR, 2 * e, hD - hU).normalize();
  }

  slopeAt(x, z, e = 1.2) {
    const hL = this.heightAt(x - e, z), hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e), hU = this.heightAt(x, z + e);
    const dx = (hR - hL) / (2 * e), dz = (hU - hD) / (2 * e);
    return Math.sqrt(dx * dx + dz * dz);
  }

  /* ---------------- 水面シェーダ用の高さテクスチャ ---------------- */
  _buildHeightTexture() {
    const N = 512;
    const data = new Float32Array(N * N);
    const half = WATER_REGION / 2;
    for (let j = 0; j < N; j++) {
      const z = (j / (N - 1)) * WATER_REGION - half;
      for (let i = 0; i < N; i++) {
        const x = (i / (N - 1)) * WATER_REGION - half;
        data[j * N + i] = this.heightAt(x, z);
      }
    }
    const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.FloatType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.heightTexture = tex;
  }

  /* ---------------- 地形メッシュ ---------------- */
  _buildTerrainMesh() {
    const segs = this.quality === 'low' ? 150 : this.quality === 'high' ? 260 : 210;
    const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = this.heightAt(x, z);
      pos.setY(i, h);
      const slope = this.slopeAt(x, z, WORLD_SIZE / segs);
      this._terrainColor(h, slope, x, z, tmpColor);
      colors[i * 3] = tmpColor.r;
      colors[i * 3 + 1] = tmpColor.g;
      colors[i * 3 + 2] = tmpColor.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0,
      flatShading: true,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = 'terrain';
    this.scene.add(this.mesh);
  }

  _terrainColor(h, slope, x, z, out) {
    const n = this.noise.fbm(x * 0.09, z * 0.09, 2) * 0.5 + 0.5;
    const rocky = clamp01((slope - 0.5) * 1.6);

    if (h < -0.15) {
      /* 湖底：底質（砂地・岩場・泥底）で色を変える。
         深いほど暗く落として、水の透明度と合わせる */
      const bed = this.lake.bedAt(x, z, slope);
      const d = clamp01(-h / 16);
      const shade = lerp(1.0, 0.34, d);
      if (bed.kind === 'rock') {
        out.setRGB((0.40 + n * 0.10) * shade, (0.39 + n * 0.09) * shade, (0.36 + n * 0.08) * shade);
      } else if (bed.kind === 'sand') {
        out.setRGB((0.52 + n * 0.07) * shade, (0.46 + n * 0.06) * shade, (0.31 + n * 0.05) * shade);
      } else {
        out.setRGB((0.26 + n * 0.05) * shade, (0.25 + n * 0.05) * shade, (0.19 + n * 0.04) * shade);
      }
      // 砂と岩の境目を少し混ぜて、パッチの縁を柔らかくする
      if (bed.v > 0.62 && bed.v < 0.74) out.multiplyScalar(0.94);
    } else if (h < 1.1) {
      // 汀線の砂浜
      const t = clamp01((h + 0.15) / 1.25);
      out.setRGB(0.52 + n * 0.07, 0.47 + n * 0.06, 0.36 + n * 0.05);
      out.lerp(tmpSand.setRGB(0.30 + n * 0.08, 0.36 + n * 0.09, 0.19), t * 0.55);
    } else {
      const t = clamp01((h - 1.1) / 22);
      // 草地 -> 深い森
      out.setRGB(
        lerp(0.24, 0.13, t) + n * 0.07,
        lerp(0.36, 0.24, t) + n * 0.09,
        lerp(0.15, 0.12, t) + n * 0.04
      );
      // 岩肌
      out.lerp(tmpSand.setRGB(0.30 + n * 0.06, 0.29 + n * 0.05, 0.27 + n * 0.05), rocky * 0.85);
      // 高山の雪
      const snow = smoothstep(58, 82, h) * (1 - clamp01(slope - 0.85));
      out.lerp(tmpSand.setRGB(0.92, 0.94, 0.98), clamp01(snow));
    }
  }

  /* ---------------- 桟橋（位置は lakefield が決定・検証済み） ---------------- */
  _findDock() {
    const d = this.lake.dock;
    const len = Math.hypot(d.end.x - d.start.x, d.end.z - d.start.z);
    this._dockU = { x: (d.end.x - d.start.x) / len, z: (d.end.z - d.start.z) / len };
    this._dockLen = len;
    this.shoreR0 = d.r0;
    this.dockDir = new THREE.Vector3(d.dir.x, 0, d.dir.z);   // 岸→湖心
    this.dockStart = new THREE.Vector3(d.start.x, 0, d.start.z);
    this.dockEnd = new THREE.Vector3(d.end.x, 0, d.end.z);
    this.dockY = d.y;
    this.spawnPos = this.dockEnd.clone().addScaledVector(this.dockDir, -3).setY(this.dockY);
  }

  _buildDock() {
    const g = new THREE.Group();
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x7a5b3c, roughness: 0.92 });
    const woodDark = new THREE.MeshStandardMaterial({ color: 0x5a4029, roughness: 0.95 });

    const a = this.dockStart, b = this.dockEnd;
    const len = a.distanceTo(b);
    const dir = new THREE.Vector3().subVectors(b, a).normalize();
    const yaw = Math.atan2(dir.x, dir.z);
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const W = 3.4;

    // 板（インスタンス）
    const plankCount = Math.max(6, Math.floor(len / 0.55));
    const plankGeo = new THREE.BoxGeometry(W, 0.12, 0.42);
    const planks = new THREE.InstancedMesh(plankGeo, woodMat, plankCount);
    planks.castShadow = true; planks.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const s = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    for (let i = 0; i < plankCount; i++) {
      const t = (i + 0.5) / plankCount;
      p.lerpVectors(a, b, t).setY(this.dockY);
      s.set(1, 1, 0.92 + (i % 3) * 0.04);
      m.compose(p, q, s);
      planks.setMatrixAt(i, m);
    }
    planks.instanceMatrix.needsUpdate = true;
    g.add(planks);

    // 縦桁
    const beamGeo = new THREE.BoxGeometry(0.22, 0.28, len);
    for (const off of [-W / 2 + 0.2, W / 2 - 0.2]) {
      const beam = new THREE.Mesh(beamGeo, woodDark);
      beam.position.copy(mid).setY(this.dockY - 0.2);
      beam.position.x += Math.cos(yaw) * off;
      beam.position.z += -Math.sin(yaw) * off;
      beam.rotation.y = yaw;
      beam.castShadow = true;
      g.add(beam);
    }

    // 杭
    const postGeo = new THREE.CylinderGeometry(0.16, 0.19, 1, 7);
    const postRows = Math.max(2, Math.floor(len / 3.2));
    const posts = new THREE.InstancedMesh(postGeo, woodDark, postRows * 2);
    posts.castShadow = true;
    let pi = 0;
    for (let i = 0; i < postRows; i++) {
      const t = (i + 0.5) / postRows;
      const base = new THREE.Vector3().lerpVectors(a, b, t);
      for (const off of [-W / 2 + 0.25, W / 2 - 0.25]) {
        const px = base.x + Math.cos(yaw) * off;
        const pz = base.z - Math.sin(yaw) * off;
        const bed = this.heightAt(px, pz);
        const bot = Math.min(bed - 0.4, this.dockY - 0.6);
        const hh = this.dockY - 0.28 - bot;
        p.set(px, bot + hh / 2, pz);
        s.set(1, hh, 1);
        m.compose(p, new THREE.Quaternion(), s);
        posts.setMatrixAt(pi++, m);
      }
    }
    posts.count = pi;
    posts.instanceMatrix.needsUpdate = true;
    g.add(posts);

    // 手すり（先端の3方向）
    const railMat = woodDark;
    const railPost = new THREE.CylinderGeometry(0.07, 0.08, 0.95, 6);
    const railBar = new THREE.BoxGeometry(0.09, 0.09, 1);
    const tip = b.clone();
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const corners = [
      tip.clone().addScaledVector(right, -W / 2 + 0.2),
      tip.clone().addScaledVector(right, W / 2 - 0.2),
      tip.clone().addScaledVector(right, -W / 2 + 0.2).addScaledVector(dir, -1.9),
      tip.clone().addScaledVector(right, W / 2 - 0.2).addScaledVector(dir, -1.9),
    ];
    corners.forEach((cp) => {
      const rp = new THREE.Mesh(railPost, railMat);
      rp.position.copy(cp).setY(this.dockY + 0.48);
      rp.castShadow = true;
      g.add(rp);
    });
    // 先端の横バー
    const bar = new THREE.Mesh(railBar, railMat);
    bar.position.copy(tip).setY(this.dockY + 0.9);
    bar.scale.z = W - 0.4;
    bar.rotation.y = yaw + Math.PI / 2;
    g.add(bar);

    // 灯篭（夜に点く）
    const lampPost = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 2.2, 7), woodDark);
    const lampBase = a.clone().addScaledVector(dir, 1.2).addScaledVector(right, W / 2 - 0.15);
    lampPost.position.copy(lampBase).setY(this.dockY + 1.0);
    lampPost.castShadow = true;
    g.add(lampPost);

    this.lampMat = new THREE.MeshStandardMaterial({
      color: 0xffd9a0, emissive: 0xffb050, emissiveIntensity: 0, roughness: 0.5,
    });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), this.lampMat);
    bulb.position.copy(lampBase).setY(this.dockY + 2.15);
    g.add(bulb);
    this.lampLight = new THREE.PointLight(0xffb060, 0, 26, 2);
    this.lampLight.position.copy(bulb.position);
    g.add(this.lampLight);
    this.addObstacle(lampBase.x, lampBase.z, 0.26, this.dockY + 2.3);

    // 小舟（雰囲気）
    const boat = new THREE.Group();
    const hull = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.62, 2.6, 4, 10),
      new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.9 })
    );
    hull.rotation.z = Math.PI / 2;
    hull.scale.set(1, 1, 0.55);
    boat.add(hull);
    const inner = new THREE.Mesh(
      new THREE.BoxGeometry(3.0, 0.5, 0.9),
      new THREE.MeshStandardMaterial({ color: 0x2b2118, roughness: 1 })
    );
    inner.position.y = 0.45;
    boat.add(inner);
    boat.position.copy(a).addScaledVector(dir, 4).addScaledVector(right, -(W / 2 + 1.7));
    boat.position.y = 0.05;
    boat.rotation.y = yaw + 0.25;
    boat.castShadow = true;
    this.boat = boat;
    g.add(boat);
    // 小舟にも当たり判定（船体に沿って2点）
    for (const t of [-0.9, 0.9]) {
      this.addObstacle(boat.position.x + dir.x * t, boat.position.z + dir.z * t, 0.85, boat.position.y + 0.95);
    }

    this.dock = g;
    this.scene.add(g);
  }

  /** 桟橋の上か（歩行判定用） */
  /** 桟橋ローカル座標（along: 岸→沖 / side: 右） */
  _dockLocal(x, z, out = { al: 0, si: 0 }) {
    const a = this.dockStart;
    out.al = (x - a.x) * this._dockU.x + (z - a.z) * this._dockU.z;
    out.si = -(x - a.x) * this._dockU.z + (z - a.z) * this._dockU.x;
    return out;
  }

  /**
   * 桟橋の床の上か（矩形判定）。以前はカプセル判定だったため、
   * 先端の外側に半円状の「見えない床」ができていた。
   */
  onDock(x, z) {
    const p = this._dockLocal(x, z, _dl);
    if (p.al < 0 || p.al > this._dockLen) return null;
    if (Math.abs(p.si) > DOCK_HALF_W) return null;
    return this.dockY;
  }

  /** 桟橋の中心線までの距離（装飾の配置除外用） */
  distToDock(x, z) {
    const p = this._dockLocal(x, z, _dl);
    const al = clamp(p.al, 0, this._dockLen);
    const dAl = p.al - al;
    return Math.hypot(dAl, p.si);
  }

  /**
   * 線分が桟橋（床＋先端の手すり）を貫通するか。
   * 糸が桟橋を突き抜けて釣りができてしまうのを防ぐ。
   */
  dockBlocksSegment(x0, y0, z0, x1, y1, z1) {
    const a = this._dockLocal(x0, z0, _dl);
    const p0 = [a.al, y0, a.si];
    const b = this._dockLocal(x1, z1, _dl2);
    const p1 = [b.al, y1, b.si];
    const L = this._dockLen, W = DOCK_HALF_W, Y = this.dockY;
    // 床（桁も含む厚み）
    if (segBoxHit(p0, p1, [0, Y - 0.42, -W], [L, Y + 0.18, W])) return true;
    // 先端の手すり
    if (segBoxHit(p0, p1, [L - 2.3, Y - 0.42, -W], [L, Y + 1.05, W])) return true;
    return false;
  }

  /* ---------------- 障害物（岩・木） ---------------- */
  /** @param top 上端の高さ（糸の判定に使う） */
  /** 水中ストラクチャーが近くにあるか（あれば一番近いものを返す） */
  structureNear(x, z, radius = 4.5) {
    let best = null, bd = radius * radius;
    for (const t of this.structures || []) {
      const d = (t.x - x) ** 2 + (t.z - z) ** 2;
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  /** 底質（'mud' | 'sand' | 'rock'） */
  bedAt(x, z) { return this.lake.bedAt(x, z); }

  addObstacle(x, z, r, top = 0) {
    this.obstacles.push(x, z, r, top);
    const key = ((Math.floor(x / OBS_CELL) & 1023) << 10) | (Math.floor(z / OBS_CELL) & 1023);
    let arr = this._obsGrid.get(key);
    if (!arr) { arr = []; this._obsGrid.set(key, arr); }
    arr.push(this.obstacles.length - 4);
  }

  /** (x,z) が半径 rad の円として障害物にぶつかるか */
  blockedAt(x, z, rad = 0.32) {
    const cx = Math.floor(x / OBS_CELL), cz = Math.floor(z / OBS_CELL);
    const o = this.obstacles;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this._obsGrid.get((((cx + dx) & 1023) << 10) | ((cz + dz) & 1023));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          const ddx = x - o[i], ddz = z - o[i + 1], rr = o[i + 2] + rad;
          if (ddx * ddx + ddz * ddz < rr * rr) return true;
        }
      }
    }
    return false;
  }

  /** (x,z) を覆っている障害物の上端の最大値（無ければ -Infinity） */
  obstacleTopAt(x, z) {
    const cx = Math.floor(x / OBS_CELL), cz = Math.floor(z / OBS_CELL);
    const o = this.obstacles;
    let top = -Infinity;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this._obsGrid.get((((cx + dx) & 1023) << 10) | ((cz + dz) & 1023));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          const ddx = x - o[i], ddz = z - o[i + 1], rr = o[i + 2];
          if (ddx * ddx + ddz * ddz < rr * rr && o[i + 3] > top) top = o[i + 3];
        }
      }
    }
    return top;
  }

  /**
   * 糸（ロッド先端 → 到達点）が地形や岩を貫通するか。
   * たるみ（sag）も考慮した曲線でサンプリングする。
   * @returns {null|{x:number,y:number,z:number,ground:number,kind:string}}
   */
  lineBlocked(x0, y0, z0, x1, y1, z1, opts = {}) {
    const tol = opts.tol ?? 0.22;
    const slack = opts.slack ?? 0.5;
    const dx = x1 - x0, dz = z1 - z0;
    const dist = Math.hypot(dx, dz, y1 - y0);
    if (dist < 1) return null;
    const sag = Math.min(dist * 0.16, 1.2) * slack;
    // 地形の細部ノイズは波長 18m 程度なので 1.6m 刻みで十分
    const N = Math.min(40, Math.max(8, Math.ceil(dist / 1.6)));
    for (let i = 1; i < N; i++) {
      const t = i / N;
      const x = x0 + dx * t, z = z0 + dz * t;
      const y = y0 + (y1 - y0) * t - Math.sin(t * Math.PI) * sag;
      const g = this.heightAt(x, z);
      if (y + tol < g) return { x, y, z, ground: g, kind: 'terrain' };
      const ot = this.obstacleTopAt(x, z);
      if (ot > -Infinity && y + tol < ot) return { x, y, z, ground: ot, kind: 'rock' };
    }
    return null;
  }

  /* ---------------- 岸辺の装飾 ---------------- */
  _buildProps() {
    const rng = makeRng(this.seed ^ 0x5a5a);
    const q = this.quality;
    const treeTarget = q === 'low' ? 260 : q === 'high' ? 900 : 620;
    const rockTarget = q === 'low' ? 120 : 260;
    const reedTarget = q === 'low' ? 260 : 720;

    /* --- 木 --- */
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 1, 6);
    trunkGeo.translate(0, 0.5, 0);
    const leafGeo = new THREE.ConeGeometry(1, 1, 7);
    leafGeo.translate(0, 0.5, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 1 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f5a2c, roughness: 0.95, flatShading: true });

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeTarget);
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, treeTarget * 2);
    trunks.castShadow = true;
    leaves.castShadow = true;
    const leafColor = new THREE.Color();

    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const qt = new THREE.Quaternion();
    const s = new THREE.Vector3();
    let ti = 0, li = 0, tries = 0;

    while (ti < treeTarget && tries < treeTarget * 30) {
      tries++;
      const ang = rng() * TAU;
      const rr = this.shoreRadius(Math.cos(ang) * 150, Math.sin(ang) * 150);
      const dist = rr + 5 + Math.pow(rng(), 0.7) * 230;
      const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
      const h = this.heightAt(x, z);
      if (h < 1.6 || h > 66) continue;
      if (this.slopeAt(x, z) > 0.62) continue;
      if (this.distToDock(x, z) < 3.6) continue;
      if (Math.hypot(x - this.spawnPos.x, z - this.spawnPos.z) < 6) continue;

      const scale = 2.6 + rng() * 4.4 * (1 - clamp01(h / 80));
      const tsx = scale * (0.7 + rng() * 0.35), tsz = scale * (0.7 + rng() * 0.35);
      qt.setFromAxisAngle(UP, rng() * TAU);
      p.set(x, h - 0.2, z);
      s.set(tsx, scale, tsz);
      m.compose(p, qt, s);
      trunks.setMatrixAt(ti, m);
      // 幹の当たり判定（根元の半径 0.34 × スケール／上端は幹の高さ）
      this.addObstacle(x, z, Math.max(tsx, tsz) * 0.34 * 0.62, h - 0.2 + scale * 0.95);

      // 葉（2段の円錐）
      const cold = clamp01((h - 30) / 40);
      leafColor.setRGB(
        lerp(0.13, 0.16, cold) + rng() * 0.05,
        lerp(0.34, 0.26, cold) + rng() * 0.08,
        lerp(0.14, 0.20, cold) + rng() * 0.04
      );
      for (let k = 0; k < 2; k++) {
        if (li >= leaves.count) break;
        const ls = scale * (k === 0 ? 1.0 : 0.68);
        p.set(x, h - 0.2 + scale * (k === 0 ? 0.55 : 1.02), z);
        s.set(ls * 0.62, ls * 1.15, ls * 0.62);
        m.compose(p, qt, s);
        leaves.setMatrixAt(li, m);
        leaves.setColorAt(li, leafColor);
        li++;
      }
      ti++;
    }
    trunks.count = ti;
    leaves.count = li;
    trunks.instanceMatrix.needsUpdate = true;
    leaves.instanceMatrix.needsUpdate = true;
    if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    this.scene.add(trunks, leaves);
    // 水面より上にしか存在しない物（水越しには絶対に写らないので、
    // 水中描画用のシーン取り込みでは省いて負荷を下げる）。
    // 岸の岩は水際にまたがって置かれる＝水中部分が見えるので入れない
    this.overWaterProps = [trunks, leaves];

    /* --- 岩 --- */
    const rockGeo = new THREE.IcosahedronGeometry(1, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x6b6b66, roughness: 0.95, flatShading: true });
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockTarget);
    rocks.castShadow = true; rocks.receiveShadow = true;
    let ri = 0; tries = 0;
    while (ri < rockTarget && tries < rockTarget * 40) {
      tries++;
      const ang = rng() * TAU;
      const rr = this.shoreRadius(Math.cos(ang) * 150, Math.sin(ang) * 150);
      const dist = rr + (rng() * 2 - 1) * 26;
      const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
      const h = this.heightAt(x, z);
      if (h < -2.5 || h > 14) continue;
      if (this.distToDock(x, z) < 3.4) continue;
      const sc = 0.5 + Math.pow(rng(), 2) * 3.4;
      const rsx = sc * (0.7 + rng() * 0.6), rsy = sc * (0.5 + rng() * 0.5), rsz = sc * (0.7 + rng() * 0.6);
      qt.setFromEuler(new THREE.Euler(rng() * TAU, rng() * TAU, rng() * TAU));
      p.set(x, h + sc * 0.15, z);
      s.set(rsx, rsy, rsz);
      m.compose(p, qt, s);
      rocks.setMatrixAt(ri++, m);
      // 岩の当たり判定（水中の小石は無視／上端は岩の高さ）
      if (h > -0.9 && sc > 0.65) {
        this.addObstacle(x, z, Math.max(rsx, rsz) * 0.72, h + sc * 0.15 + rsy * 0.82);
      }
    }
    rocks.count = ri;
    rocks.instanceMatrix.needsUpdate = true;
    this.scene.add(rocks);

    /* --- 岩場の転石 ---
       底質が岩の所に小さめの石をたくさん置いて、見た目で「岩場」と分かるようにする。
       境目は底質の値でまばらにして、砂地との境が不自然な線にならないようにする */
    {
      const bedRockTarget = q === 'low' ? 600 : q === 'high' ? 2400 : 1500;
      const bedRocks = new THREE.InstancedMesh(
        rockGeo,
        new THREE.MeshStandardMaterial({ color: 0x5f635e, roughness: 0.97, flatShading: true }),
        bedRockTarget
      );
      bedRocks.receiveShadow = true;
      let bri = 0, bt = 0;
      while (bri < bedRockTarget && bt < bedRockTarget * 30) {
        bt++;
        const ang = rng() * TAU;
        const sr = this.shoreRadius(Math.cos(ang), Math.sin(ang));
        const rr = sr * (0.05 + Math.pow(rng(), 0.55) * 0.95);
        const x = Math.cos(ang) * rr, z = Math.sin(ang) * rr;
        const h = this.heightAt(x, z);
        const d = -h;
        if (d < 0.5 || d > 16) continue;                      // 汀線ぎわと深すぎる所は置かない
        const slope = this.slopeAt(x, z);
        if (slope > 1.45) continue;                           // 崖には置かない
        const bed = this.lake.bedAt(x, z, slope);
        if (bed.v < 0.64) continue;                           // 岩場だけ
        if (rng() > smoothstep(0.64, 0.92, bed.v)) continue;   // 境目はまばらに
        // 疎密をつける（一様にばら撒くと人工的に見える）
        const cluster = this.noise.fbm(x * 0.075 + 17.4, z * 0.075 - 8.9, 2) * 0.5 + 0.5;
        if (rng() > 0.55 + cluster * 0.6) continue;
        // ほとんどは拳〜頭くらいの石で、たまに大きめの転石
        const sc = 0.28 + Math.pow(rng(), 2.2) * 1.0;
        if (sc * 0.5 > d - 0.3) continue;                     // 水面から出さない
        qt.setFromEuler(new THREE.Euler(rng() * TAU, rng() * TAU, rng() * TAU));
        // 斜面ほど深く埋めて、浮いて見えないようにする
        p.set(x, h + sc * (0.05 - Math.min(0.5, slope) * 0.22), z);
        s.set(sc * (0.85 + rng() * 0.45), sc * (0.4 + rng() * 0.32), sc * (0.85 + rng() * 0.45));
        m.compose(p, qt, s);
        bedRocks.setMatrixAt(bri++, m);
      }
      bedRocks.count = bri;
      bedRocks.instanceMatrix.needsUpdate = true;
      this.scene.add(bedRocks);
      this.bedRockCount = bri;
    }

    /* --- 水中のストラクチャー（沈み岩・立ち枯れ） ---
       湖底に置いて、必ず水面より下に収める。糸は水面上を通るので
       キャストの邪魔にはならないが、水中カメラで見えて魚が付く */
    this.structures = [];
    {
      const sRocks = new THREE.InstancedMesh(
        rockGeo,
        new THREE.MeshStandardMaterial({ color: 0x4e5550, roughness: 0.98, flatShading: true }),
        Math.max(1, this.lake.structures.length * 3)
      );
      sRocks.receiveShadow = true;
      const snagMat = new THREE.MeshStandardMaterial({ color: 0x4a4034, roughness: 1, flatShading: true });
      const snagGeo = new THREE.CylinderGeometry(0.16, 0.30, 1, 5);
      snagGeo.translate(0, 0.5, 0);
      const snags = new THREE.InstancedMesh(snagGeo, snagMat, Math.max(1, this.lake.structures.length * 5));
      let si = 0, gi = 0;
      for (const t of this.lake.structures) {
        const bedY = this.heightAt(t.x, t.z);
        if (t.kind === 'rock') {
          // 3 つの岩を寄せて 1 つのシモリにする
          for (let k = 0; k < 3; k++) {
            const ox = (k === 0 ? 0 : (k === 1 ? 1 : -1)) * t.r * 0.75;
            const oz = (k === 0 ? 0 : (k === 1 ? -1 : 1)) * t.r * 0.55;
            const sc = t.r * (k === 0 ? 1 : 0.62) * (0.85 + t.v * 0.3);
            qt.setFromEuler(new THREE.Euler(t.rot + k, t.rot * 1.7, t.v * 3));
            p.set(t.x + ox, bedY + sc * 0.35, t.z + oz);
            s.set(sc, sc * (0.55 + t.v * 0.35), sc);
            m.compose(p, qt, s);
            if (si < sRocks.count) sRocks.setMatrixAt(si++, m);
          }
        } else {
          // 立ち枯れ：幹 + 枝 3〜4 本
          qt.setFromAxisAngle(UP, t.rot);
          const lean = 0.12 + t.v * 0.3;
          const q2 = new THREE.Quaternion().setFromEuler(new THREE.Euler(lean, t.rot, 0));
          p.set(t.x, bedY, t.z);
          s.set(t.r * 2.2, t.h, t.r * 2.2);
          m.compose(p, q2, s);
          if (gi < snags.count) snags.setMatrixAt(gi++, m);
          const branches = 3 + (t.v > 0.6 ? 1 : 0);
          for (let k = 0; k < branches; k++) {
            const ba = t.rot + k * (TAU / branches);
            const bh = bedY + t.h * (0.45 + 0.16 * k);
            const bq = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.0 + t.v * 0.5, ba, 0));
            p.set(t.x, bh, t.z);
            s.set(t.r * 1.1, t.h * (0.42 - k * 0.06), t.r * 1.1);
            m.compose(p, bq, s);
            if (gi < snags.count) snags.setMatrixAt(gi++, m);
          }
        }
        // 当たり判定（上端は水面下なので、糸には掛からない＝キャストの邪魔をしない）
        this.addObstacle(t.x, t.z, t.r * 1.15, bedY + t.h);
        this.structures.push({ x: t.x, z: t.z, kind: t.kind, r: t.r, top: bedY + t.h, depth: t.depth });
      }
      sRocks.count = si;
      snags.count = gi;
      sRocks.instanceMatrix.needsUpdate = true;
      snags.instanceMatrix.needsUpdate = true;
      this.scene.add(sRocks, snags);
    }

    /* --- 葦（浅場） --- */
    const reedGeo = new THREE.ConeGeometry(0.06, 1, 4, 1, true);
    reedGeo.translate(0, 0.5, 0);
    const reedMat = new THREE.MeshStandardMaterial({
      color: 0x4c6b34, roughness: 1, side: THREE.DoubleSide,
    });
    const reeds = new THREE.InstancedMesh(reedGeo, reedMat, reedTarget);
    let rdi = 0; tries = 0;
    while (rdi < reedTarget && tries < reedTarget * 40) {
      tries++;
      const ang = rng() * TAU;
      const rr = this.shoreRadius(Math.cos(ang) * 150, Math.sin(ang) * 150);
      const dist = rr - rng() * 16;
      const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
      const h = this.heightAt(x, z);
      if (h > 0.35 || h < -1.5) continue;
      if (this.distToDock(x, z) < 2.4) continue;   // 板を突き抜けないように
      const sc = 1.1 + rng() * 1.9;
      qt.setFromAxisAngle(new THREE.Vector3(rng() * 0.2 - 0.1, 1, rng() * 0.2 - 0.1).normalize(), rng() * TAU);
      p.set(x, h, z);
      s.set(1, sc, 1);
      m.compose(p, qt, s);
      reeds.setMatrixAt(rdi++, m);
    }
    reeds.count = rdi;
    reeds.instanceMatrix.needsUpdate = true;
    this.scene.add(reeds);

    // 藻場にも葦を密生させる
    const weedGeo = reedGeo.clone();
    const weeds = new THREE.InstancedMesh(weedGeo, reedMat, 240);
    let wi = 0; tries = 0;
    while (wi < 240 && tries < 4000) {
      tries++;
      const ang = rng() * TAU;
      const rad = Math.sqrt(rng()) * this.flat.r * 0.9;
      const x = this.flat.x + Math.cos(ang) * rad;
      const z = this.flat.z + Math.sin(ang) * rad;
      const h = this.heightAt(x, z);
      if (h > -0.1 || h < -2.6) continue;
      const sc = Math.abs(h) * 0.8 + 0.4;
      qt.setFromAxisAngle(UP, rng() * TAU);
      p.set(x, h, z);
      s.set(1.4, sc, 1.4);
      m.compose(p, qt, s);
      weeds.setMatrixAt(wi++, m);
    }
    weeds.count = wi;
    weeds.instanceMatrix.needsUpdate = true;
    this.scene.add(weeds);
  }

  /** 夜間の灯り更新 */
  updateLamp(nightAmount, dt) {
    const target = nightAmount;
    this.lampMat.emissiveIntensity = lerp(this.lampMat.emissiveIntensity, target * 2.4, 0.06);
    this.lampLight.intensity = lerp(this.lampLight.intensity, target * 26, 0.06);
  }
}
