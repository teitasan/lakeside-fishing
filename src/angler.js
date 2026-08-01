/* ===========================================================
   釣り人・ロッド・ライン・ウキ
   =========================================================== */
import * as THREE from 'three';
import { clamp, lerp, damp, TAU } from './util.js';
import { createBaitMesh, disposeBaitMesh, updateBaitMesh, createHookMesh } from './baitMesh.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

/* ---------------- 画面上で一定の太さに見えるライン ---------------- */
class LineRibbon {
  constructor(scene, segments = 30) {
    this.segments = segments;
    const n = segments + 1;
    const pos = new Float32Array(n * 2 * 3);
    const idx = [];
    for (let i = 0; i < segments; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xeaf4ff, transparent: true, opacity: 0.62,
      side: THREE.DoubleSide, depthWrite: false, fog: true,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  /** points: Vector3[] / count: 実際に使う点数（省略時は全部） */
  update(points, camera, count) {
    const arr = this.mesh.geometry.attributes.position.array;
    const n = Math.min(count ?? points.length, points.length);
    if (n < 2) { this.mesh.visible = false; return; }
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const nx = points[Math.min(i + 1, n - 1)];
      const pv = points[Math.max(i - 1, 0)];
      _v.subVectors(nx, pv);
      if (_v.lengthSq() < 1e-10) _v.set(0, 1, 0);
      _v2.subVectors(camera.position, p);
      const dist = _v2.length();
      _v2.multiplyScalar(1 / Math.max(0.001, dist));
      _v3.crossVectors(_v, _v2);
      if (_v3.lengthSq() < 1e-10) _v3.set(1, 0, 0);
      _v3.normalize().multiplyScalar(clamp(dist * 0.0013, 0.006, 0.05));
      const o = i * 6;
      arr[o] = p.x + _v3.x; arr[o + 1] = p.y + _v3.y; arr[o + 2] = p.z + _v3.z;
      arr[o + 3] = p.x - _v3.x; arr[o + 4] = p.y - _v3.y; arr[o + 5] = p.z - _v3.z;
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, (n - 1) * 6);
  }
}

export class Angler {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    scene.add(this.root);

    this.yaw = 0;
    this.pitch = 0;
    this.walkPhase = 0;
    this.bend = 0;
    this.armX = -0.35;
    this.armZ = 0;
    this.armY = 0;
    this.castAnim = -1; // >=0 でキャストモーション中
    this.bodyLean = 0;
    this.fpv = false;

    this._build();
    this.line = new LineRibbon(scene, 26);
    this._linePts = [];
    for (let i = 0; i < 27; i++) this._linePts.push(new THREE.Vector3());
    this._buildBobber();
  }

  _build() {
    const skin = new THREE.MeshStandardMaterial({ color: 0xe0b48c, roughness: 0.85 });
    const coat = new THREE.MeshStandardMaterial({ color: 0x3f5a4a, roughness: 0.85 });
    const pants = new THREE.MeshStandardMaterial({ color: 0x2f3a4a, roughness: 0.9 });
    const hatMat = new THREE.MeshStandardMaterial({ color: 0x8a6b3a, roughness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x23282e, roughness: 0.8 });
    this.materials = { skin, coat, pants, hatMat, dark };

    const g = this.root;

    // 脚
    this.legs = [];
    for (const s of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(s * 0.13, 0.86, 0);
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.86, 0.19), pants);
      m.position.y = -0.43;
      m.castShadow = true;
      leg.add(m);
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.14, 0.28), dark);
      boot.position.set(0, -0.82, 0.04);
      boot.castShadow = true;
      leg.add(boot);
      g.add(leg);
      this.legs.push(leg);
    }

    // 胴
    this.torso = new THREE.Group();
    this.torso.position.y = 0.86;
    g.add(this.torso);
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.64, 0.27), coat.clone());
    chest.position.y = 0.32;
    chest.castShadow = true;
    this.torso.add(chest);
    // ベスト
    const vest = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.4, 0.3), new THREE.MeshStandardMaterial({ color: 0x6b5b3a, roughness: 0.9 }));
    vest.position.y = 0.36;
    this.torso.add(vest);

    // 首・頭
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 0.1, 8), skin.clone());
    neck.position.y = 0.68;
    this.torso.add(neck);
    this.head = new THREE.Group();
    this.head.position.y = 0.78;
    this.torso.add(this.head);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 12), skin.clone());
    skull.scale.set(1, 1.12, 1.05);
    skull.castShadow = true;
    this.head.add(skull);
    // 帽子
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.235, 0.022, 16), hatMat);
    brim.position.y = 0.09;
    brim.castShadow = true;
    this.head.add(brim);
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.125, 0.14, 0.13, 14), hatMat);
    crown.position.y = 0.155;
    crown.castShadow = true;
    this.head.add(crown);

    /* 一人称で視界を覆ってしまうパーツ（頭・首・胴）。
       visible=false にすると影も消えてしまうので、カラー出力だけ止めて影は残す。
       そのためにマテリアルは他のパーツと共有しないよう clone 済み */
    this._fpvHide = [skull, brim, crown, neck, chest, vest];

    // 腕（+X 側がプレイヤーの左、-X 側が右。ロッドは右手で持つ）
    const mkArm = (s) => {
      const arm = new THREE.Group();
      arm.position.set(s * 0.25, 0.55, 0);
      const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.062, 0.28, 3, 8), coat);
      upper.position.y = -0.19;
      upper.castShadow = true;
      arm.add(upper);
      const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.26, 3, 8), skin);
      fore.position.y = -0.47;
      fore.castShadow = true;
      arm.add(fore);
      this.torso.add(arm);
      return arm;
    };
    this.armR = mkArm(-1);
    this.armL = mkArm(1);
    // Y を最後に掛ける（寝かせた竿を横へ振れるように。rotation.y=0 なら XYZ と同じ）
    this.armR.rotation.order = 'YXZ';

    /* ---- ロッド ---- */
    this.rodRoot = new THREE.Object3D();
    this.rodRoot.position.set(-0.02, -0.58, 0.05);
    this.armR.add(this.rodRoot);

    const rodMat = new THREE.MeshStandardMaterial({ color: 0x4a3320, roughness: 0.6, metalness: 0.1 });
    const rodTipMat = new THREE.MeshStandardMaterial({ color: 0x8d8d94, roughness: 0.4, metalness: 0.4 });
    this.rodMats = { rodMat, rodTipMat };

    // グリップ
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.022, 0.3, 8), new THREE.MeshStandardMaterial({ color: 0x2a2118, roughness: 1 }));
    grip.position.y = -0.02;
    this.rodRoot.add(grip);
    // リール
    const reel = new THREE.Group();
    reel.position.set(0, 0.1, -0.06);
    const reelBody = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.035, 12), rodTipMat);
    reelBody.rotation.x = Math.PI / 2;
    reel.add(reelBody);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.06, 0.012), new THREE.MeshStandardMaterial({ color: 0x1d1d22 }));
    handle.position.set(0.04, 0.03, 0);
    reel.add(handle);
    this.reelHandle = handle;
    this.rodRoot.add(reel);

    const segLen = [0.78, 0.72, 0.62];
    const radii = [[0.019, 0.014], [0.014, 0.009], [0.009, 0.004]];
    let parent = this.rodRoot;
    this.rodSegs = [];
    for (let i = 0; i < 3; i++) {
      const seg = new THREE.Object3D();
      seg.position.y = i === 0 ? 0.14 : segLen[i - 1];
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(radii[i][1], radii[i][0], segLen[i], 6),
        i === 2 ? rodTipMat : rodMat
      );
      mesh.position.y = segLen[i] / 2;
      seg.add(mesh);
      // ガイド
      if (i > 0) {
        const guide = new THREE.Mesh(new THREE.TorusGeometry(0.016, 0.003, 4, 8), rodTipMat);
        guide.position.y = segLen[i] * 0.7;
        guide.rotation.x = Math.PI / 2;
        seg.add(guide);
      }
      parent.add(seg);
      parent = seg;
      this.rodSegs.push(seg);
    }
    this.rodTip = new THREE.Object3D();
    this.rodTip.position.y = segLen[2];
    parent.add(this.rodTip);

    // ロッドの基本姿勢
    this.rodRoot.rotation.x = 0.8;
  }

  _buildBobber() {
    const g = new THREE.Group();
    const red = new THREE.MeshStandardMaterial({ color: 0xe2452f, roughness: 0.55 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf7f7f2, roughness: 0.6 });
    const R = 0.1;
    const top = new THREE.Mesh(new THREE.SphereGeometry(R, 14, 9, 0, TAU, 0, Math.PI / 2), red);
    const bot = new THREE.Mesh(new THREE.SphereGeometry(R, 14, 9, 0, TAU, Math.PI / 2, Math.PI / 2), white);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.007, 0.34, 5), red);
    stem.position.y = 0.22;
    const tipBall = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), white);
    tipBall.position.y = 0.4;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.018, 0.004, 4, 8),
      new THREE.MeshStandardMaterial({ color: 0x9a9aa2, metalness: 0.6, roughness: 0.4 })
    );
    ring.position.y = -R - 0.01;
    ring.rotation.x = Math.PI / 2;
    g.add(top, bot, stem, tipBall, ring);
    g.visible = false;
    this.bobber = g;
    this.scene.add(g);

    // 水面のリング（遠くでもウキの位置が分かるように）
    const ringGeo = new THREE.RingGeometry(0.30, 0.40, 28);
    ringGeo.rotateX(-Math.PI / 2);
    this.bobberRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: 0xd8f0ff, transparent: true, opacity: 0.4, depthWrite: false, fog: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }));
    this.bobberRing.visible = false;
    this.bobberRing.renderOrder = 6;
    this.scene.add(this.bobberRing);

    // 仕掛け（オモリ・ハリ・エサ）
    const rig = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x8b8b93, metalness: 0.7, roughness: 0.35 });
    const sinker = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 6), metal);
    sinker.scale.set(1, 1.55, 1);
    sinker.position.y = 0.01;
    // ハリ：軸＋ふところ＋針先（エサと同じ座標系で作る）
    const hookG = createHookMesh(metal);
    // エサ（種別に差し替え）。ハリと同じ原点なので、エサ側が刺さる位置を持つ
    const baitRoot = new THREE.Group();
    this.baitRoot = baitRoot;
    this.baitMesh = null;
    this.baitId = null;
    this._baitTime = 0;
    rig.add(sinker, hookG, baitRoot);
    rig.visible = false;
    this.rig = rig;
    this.scene.add(rig);
    this.setBait('worm');

    this.lineLower = new LineRibbon(this.scene, 6);
    this._lowerPts = [];
    for (let i = 0; i < 7; i++) this._lowerPts.push(new THREE.Vector3());
  }

  /** 装備中のエサメッシュを差し替える */
  setBait(id) {
    const next = id || 'worm';
    if (this.baitId === next && this.baitMesh) return;
    if (this.baitMesh) {
      this.baitRoot.remove(this.baitMesh);
      disposeBaitMesh(this.baitMesh);
      this.baitMesh = null;
    }
    this.baitMesh = createBaitMesh(next);
    this.baitRoot.add(this.baitMesh);
    this.baitId = next;
  }

  /** ウキ → 仕掛け（水中）の糸と、仕掛けの表示。水中カメラの時だけ見せる */
  updateRig(bobberPos, baitPos, camera, show, dt = 0.016) {
    this.rig.visible = show;
    this.lineLower.mesh.visible = show;
    if (!show) return;
    this.rig.position.copy(baitPos);
    this._baitTime += dt;
    this._animateBait(this._baitTime);
    const pts = this._lowerPts;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      pts[i].lerpVectors(bobberPos, baitPos, t);
      pts[i].x += Math.sin(t * 2.2) * 0.04;
    }
    this.lineLower.update(pts, camera);
  }

  /** 種別ごとの弱いうねり・揺れ（関節ごとの動きは baitMesh 側が持つ） */
  _animateBait(t) {
    updateBaitMesh(this.baitMesh, t);
  }

  /* ---------------- 更新 ---------------- */
  setYaw(y) { this.yaw = y; }

  /** 一人称：頭・首・胴を画面から消す（腕とロッドは残す）。影はそのまま落ちる */
  setFirstPerson(on) {
    this.fpv = on;
    for (const m of this._fpvHide) {
      m.material.colorWrite = !on;
      m.material.depthWrite = !on;   // 深度に穴を空けないように
    }
  }

  playCast() { this.castAnim = 0; }

  /**
   * @param {object} p
   *  state: 'idle'|'charge'|'flight'|'wait'|'fight'|'landed'
   *  charge: 0..1  tension: 0..1  moving: 0..1  dt
   */
  update(dt, p) {
    const st = p.state;
    this.root.rotation.y = this.yaw;

    // 歩行
    this.walkPhase += dt * (4 + p.moving * 6) * (p.moving > 0.02 ? 1 : 0);
    const swing = Math.sin(this.walkPhase) * 0.55 * p.moving;
    this.legs[0].rotation.x = swing;
    this.legs[1].rotation.x = -swing;
    const bob = Math.abs(Math.sin(this.walkPhase)) * 0.045 * p.moving;
    this.torso.position.y = 0.86 + bob;
    this.torso.rotation.z = Math.sin(this.walkPhase) * 0.03 * p.moving;

    /* 腕・ロッドの目標角度
       腕: 負 = 手が前／正 = 手が後ろ
       ロッドの向き = (腕 + ロッド) の合計角。正で前傾（水面側）、0 で真上 */
    let armT = -0.35;
    let rodT = 0.80;   // 合計 +0.45（やや前に立てて構える）
    let leanT = 0;
    if (st === 'charge') {
      // 振りかぶる：合計 +0.45 -> -0.95（後方へ）
      armT = lerp(-0.35, 0.50, p.charge);
      rodT = lerp(0.80, -1.45, p.charge);
      leanT = -0.12 * p.charge;
    } else if (st === 'wait' || st === 'flight') {
      // アタリ待ちは竿を寝かせる（合計 +1.0 = 垂直から 57°、水平から 33°）
      armT = -0.42;
      rodT = 1.42;
    } else if (st === 'fight') {
      // テンションが上がるほど竿を立てる
      armT = -0.72 - p.tension * 0.30;
      rodT = 1.28 - p.tension * 0.22;
      leanT = 0.16 + p.tension * 0.14;
    } else if (st === 'landed') {
      armT = -1.00;
      rodT = 1.10;
    }

    /* 一人称は視界に穂先を残したいので、待ちとファイトをさらに寝かせる
       （構え・キャストは三人称と同じ＝飛距離の計算が視点で変わらないように） */
    if (this.fpv) {
      if (st === 'wait' || st === 'flight') {
        armT = -0.30; rodT = 1.50;                            // 合計 1.20（水平から 21°）
      } else if (st === 'fight') {
        armT = -0.55 - p.tension * 0.22;
        rodT = 1.45 - p.tension * 0.16;                       // 合計 0.90 → 0.52（立てていく）
      }
    }

    // キャストのスイング
    if (this.castAnim >= 0) {
      this.castAnim += dt;
      const t = this.castAnim / 0.34;
      if (t >= 1) {
        this.castAnim = -1;
      } else {
        // 後方 -> 前方へ振り抜く
        const e = t * t * (3 - 2 * t);
        this.armX = lerp(0.50, -0.55, e);
        armT = this.armX;
        rodT = lerp(-1.45, 1.15, e);
        leanT = lerp(-0.12, 0.1, e);
        this.rodRoot.rotation.x = damp(this.rodRoot.rotation.x, rodT, 26, dt);
        this.armR.rotation.x = this.armX;
        this.armZ = damp(this.armZ, 0, 14, dt);      // 振り抜きは正面で
        this.armR.rotation.z = this.armZ;
        this.armY = damp(this.armY, 0, 14, dt);
        this.armR.rotation.y = this.armY;
        this.armL.rotation.x = lerp(-0.3, -0.9, e);
        this.torso.rotation.x = leanT;
        this._applyBend(dt, p.tension, true);
        this.reelHandle.rotation.z += dt * 2;
        return;
      }
    }

    this.armX = damp(this.armX, armT, 9, dt);
    this.armR.rotation.x = this.armX;
    /* 横向きの角度
       Z（傾ける）: 三人称のアタリ待ちで竿を少し外（右）へ倒す＝真後ろからでも向きが分かる
       Y（振る）  : 一人称で竿を右へ振る＝寝かせた竿が画面中央（レティクル・ウキ）を塞がない
                   （寝かせた竿は Z で傾けても向きがほとんど変わらないため Y を使う） */
    let armZ = 0;
    let armY = 0;
    if (st === 'wait' || st === 'flight') {
      if (this.fpv) armY = -0.30; else armZ = 0.24;
    } else if (st === 'fight') {
      armZ = Math.sin(p.time * 6) * 0.05 * p.tension;
      if (this.fpv) armY = -0.24;
    }
    this.armZ = damp(this.armZ, armZ, 7, dt);
    this.armR.rotation.z = this.armZ;
    this.armY = damp(this.armY, armY, 7, dt);
    this.armR.rotation.y = this.armY;
    this.armL.rotation.x = damp(this.armL.rotation.x, st === 'idle' ? -0.3 + swing * 0.6 : -0.75, 8, dt);
    this.rodRoot.rotation.x = damp(this.rodRoot.rotation.x, rodT, 9, dt);
    this.bodyLean = damp(this.bodyLean, leanT, 8, dt);
    this.torso.rotation.x = this.bodyLean;
    // 頭は少し狙いの方を向く
    this.head.rotation.x = damp(this.head.rotation.x, clamp(-this.pitch * 0.5, -0.5, 0.5), 8, dt);

    if (p.reeling) this.reelHandle.rotation.z += dt * 14;

    this._applyBend(dt, p.tension, st === 'fight' || st === 'wait');
  }

  _applyBend(dt, tension, active) {
    // 魚に引かれて穂先が前（水面側）に曲がる
    const target = active ? tension * 0.55 + 0.04 : 0.02;
    this.bend = damp(this.bend, target, 8, dt);
    this.rodSegs[1].rotation.x = this.bend * 0.55;
    this.rodSegs[2].rotation.x = this.bend * 1.0;
  }

  getRodTip(out = new THREE.Vector3()) {
    this.root.updateMatrixWorld(true);
    return this.rodTip.getWorldPosition(out);
  }

  /**
   * ロッド先端 → ウキ の糸を張る（slack: 0=ピンピン 1=たるみ）
   * clipY を渡すと、その高さ（水面）より下は描画しない
   */
  /** 糸のたるみ量（ウキを糸の上に乗せるので game 側でも使う） */
  static sagFor(dist, slack) {
    return Math.min(dist * 0.16, 1.2) * clamp(slack, 0, 1);
  }

  updateLine(tipPos, endPos, slack, camera, clipY = null) {
    const pts = this._linePts;
    const total = pts.length;
    const dist = tipPos.distanceTo(endPos);
    const sag = Angler.sagFor(dist, slack);
    for (let i = 0; i < total; i++) {
      const t = i / (total - 1);
      pts[i].lerpVectors(tipPos, endPos, t);
      pts[i].y -= Math.sin(t * Math.PI) * sag;
    }

    // 水面より下は切る（水中の糸は見せない）
    let n = total;
    if (clipY !== null) {
      for (let i = 1; i < total; i++) {
        if (pts[i].y < clipY) {
          const a = _v.copy(pts[i - 1]);
          const b = pts[i];
          const denom = a.y - b.y;
          const t = denom > 1e-5 ? clamp((a.y - clipY) / denom, 0, 1) : 0;
          pts[i].lerpVectors(a, b, t);
          n = i + 1;
          break;
        }
      }
    }
    if (n < 2) { this.line.mesh.visible = false; return; }
    this.line.update(pts, camera, n);
    this.line.mesh.visible = true;
  }

  hideLine() {
    this.line.mesh.visible = false;
    this.lineLower.mesh.visible = false;
    this.rig.visible = false;
    this.bobberRing.visible = false;
  }

  setPosition(x, y, z) { this.root.position.set(x, y, z); }
}
