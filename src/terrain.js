/* ===========================================================
   地形・湖底・岸辺の装飾・桟橋
   =========================================================== */
import * as THREE from 'three';
import { makeRng, clamp01, lerp, smoothstep, TAU } from './util.js';
import { WORLD_SIZE, WATER_REGION, MAX_DEPTH, resolveLake } from './lakefield.js';

export { WORLD_SIZE, WATER_REGION, MAX_DEPTH };

const tmpColor = new THREE.Color();
const tmpSand = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

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
      // 湖底：浅場は砂、深場は暗い泥
      const d = clamp01(-h / 16);
      out.setRGB(
        lerp(0.42, 0.075, d) + n * 0.05,
        lerp(0.38, 0.10, d) + n * 0.05,
        lerp(0.26, 0.09, d) + n * 0.03
      );
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

    this.dock = g;
    this.scene.add(g);
  }

  /** 桟橋の上か（歩行判定用） */
  onDock(x, z) {
    const a = this.dockStart, b = this.dockEnd;
    const abx = b.x - a.x, abz = b.z - a.z;
    const l2 = abx * abx + abz * abz;
    const t = clamp01(((x - a.x) * abx + (z - a.z) * abz) / l2);
    const cx = a.x + abx * t, cz = a.z + abz * t;
    const d = Math.hypot(x - cx, z - cz);
    return d < 1.7 ? this.dockY : null;
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
      if (this.onDock(x, z) !== null) continue;
      if (Math.hypot(x - this.spawnPos.x, z - this.spawnPos.z) < 6) continue;

      const scale = 2.6 + rng() * 4.4 * (1 - clamp01(h / 80));
      qt.setFromAxisAngle(UP, rng() * TAU);
      p.set(x, h - 0.2, z);
      s.set(scale * (0.7 + rng() * 0.35), scale, scale * (0.7 + rng() * 0.35));
      m.compose(p, qt, s);
      trunks.setMatrixAt(ti, m);

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
      if (this.onDock(x, z) !== null) continue;
      const sc = 0.5 + Math.pow(rng(), 2) * 3.4;
      qt.setFromEuler(new THREE.Euler(rng() * TAU, rng() * TAU, rng() * TAU));
      p.set(x, h + sc * 0.15, z);
      s.set(sc * (0.7 + rng() * 0.6), sc * (0.5 + rng() * 0.5), sc * (0.7 + rng() * 0.6));
      m.compose(p, qt, s);
      rocks.setMatrixAt(ri++, m);
    }
    rocks.count = ri;
    rocks.instanceMatrix.needsUpdate = true;
    this.scene.add(rocks);

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
      if (this.onDock(x, z) !== null) continue;
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
