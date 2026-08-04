/* ===========================================================
   釣り人・ロッド・ライン・ウキ
   =========================================================== */
import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, smoothstep, TAU } from './util.js';
import { createBaitMesh, disposeBaitMesh, updateBaitMesh, createHookMesh, HOOK } from './baitMesh.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

/** 関節の相対しなり（根本→先端）。先端ほどよく曲がる */
const ROD_FLEX = [0.22, 0.40, 0.70, 1.15, 1.70, 2.40];
const ROD_FLEX_SUM = ROD_FLEX.reduce((a, b) => a + b, 0);
/** 最大しなり角（半円） */
const ROD_BEND_MAX = Math.PI;
/** 糸が穂先の向きに引っ張られる区間（m）。ロッドより急に曲がる糸に見えないように、
    穂先からこの距離だけは「穂先の実際の向き」へ寄せ、そこから先で自然な弛みへ合流する */
const LINE_TIP_FOLLOW = 0.85;
/** そのうち何点をこのゾーン専用に確保するか（残りは自然な弛み側） */
const LINE_TIP_PTS = 10;
/** 「これくらい弛んでいれば穂先の向きに沿う」の基準（アタリ待ちの弛み量） */
const LINE_SLACK_REF = 0.62;

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
      _v3.normalize().multiplyScalar(clamp(dist * 0.000433, 0.002, 0.0167));
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
    this.bend = 0;       // 0..1（1 で半円）
    this._bendAz = 0;    // しなる向き（rodRoot 局所・水平面内の方位角）
    this._segBase = null; // 関節ごとの「滑らかな曲げ」の現在値（震え・引き込みはこれに乗せる別枠）
    this._nibbleT = 0;    // ピクピク（ナブル）の経過時間
    this._biteT = 0;      // アタリ本番の経過時間（0 未満＝未突入）
    this._prevSt = null;  // 前フレームの状態（'nibble'/'bite' への切り替わり検出用）
    this._lineEnd = new THREE.Vector3();
    this._hasLineEnd = false;
    this.armX = -0.35;
    this.armZ = 0;
    this.armY = 0;
    this.castAnim = -1; // >=0 でキャストモーション中
    this.bodyLean = 0;
    this.fpv = false;

    this._build();
    this._segBase = this.rodSegs.map(() => 0);
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

    /* しなる向き（水平の方位角）専用のラッパー。グリップ・リールは rodRoot に
       直付けのままにして、これだけを回す＝しなっても手元の向きは動かない */
    this.rodFlexRoot = new THREE.Object3D();
    this.rodRoot.add(this.rodFlexRoot);

    /* 6 セグメント（全長 ≈ 旧 3 本と同じ 2.12m）。先端ほど細く・しなる */
    const segLen = [0.42, 0.40, 0.36, 0.34, 0.32, 0.28];
    const r0 = 0.019;
    const r1 = 0.0035;
    let parent = this.rodFlexRoot;
    this.rodSegs = [];
    for (let i = 0; i < segLen.length; i++) {
      const seg = new THREE.Object3D();
      seg.position.y = i === 0 ? 0.14 : segLen[i - 1];
      const t0 = i / segLen.length;
      const t1 = (i + 1) / segLen.length;
      const radBot = lerp(r0, r1, t0);
      const radTop = lerp(r0, r1, t1);
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(radTop, radBot, segLen[i], 7),
        i >= 4 ? rodTipMat : rodMat
      );
      mesh.position.y = segLen[i] / 2;
      mesh.castShadow = true;
      seg.add(mesh);
      // ガイド（根本以外）
      if (i > 0) {
        const gR = lerp(0.018, 0.010, i / (segLen.length - 1));
        const guide = new THREE.Mesh(new THREE.TorusGeometry(gR, 0.0028, 4, 8), rodTipMat);
        guide.position.y = segLen[i] * 0.72;
        guide.rotation.x = Math.PI / 2;
        seg.add(guide);
      }
      parent.add(seg);
      parent = seg;
      this.rodSegs.push(seg);
    }
    this.rodTip = new THREE.Object3D();
    this.rodTip.position.y = segLen[segLen.length - 1];
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
    // 座標系：原点＝道糸の付け根（ハリのチモト）、局所 -Y＝軸方向（水底側）
    const rig = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x8b8b93, metalness: 0.7, roughness: 0.35 });
    // オモリはハリ軸に沿った小さな涙滴。大きすぎると糸が「重心」に刺さって見える
    const sinker = new THREE.Mesh(new THREE.SphereGeometry(0.0075, 8, 6), metal);
    sinker.scale.set(0.85, 1.45, 0.85);
    sinker.position.y = HOOK.shankTop * 0.55;
    // チモトの環（糸がここに着く見た目）
    const eye = new THREE.Mesh(new THREE.TorusGeometry(0.0036, 0.00105, 4, 8), metal);
    eye.position.y = 0.0005;
    eye.rotation.x = Math.PI / 2;
    // ハリ：軸＋ふところ＋針先（エサと同じ座標系で作る）
    const hookG = createHookMesh(metal);
    // エサ（種別に差し替え）。ハリと同じ原点なので、エサ側が刺さる位置を持つ
    const baitRoot = new THREE.Group();
    this.baitRoot = baitRoot;
    this.baitMesh = null;
    this.baitId = null;
    this._baitTime = 0;
    rig.add(sinker, eye, hookG, baitRoot);
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
    // 糸の先＝チモト（原点）。ハリ軸（局所 -Y）が糸の延長になるよう向ける
    this.rig.position.copy(baitPos);
    _v.subVectors(bobberPos, baitPos);
    if (_v.lengthSq() > 1e-8) {
      _v.normalize();
      this.rig.quaternion.setFromUnitVectors(_up, _v);
    }
    this._baitTime += dt;
    this._animateBait(this._baitTime);
    const pts = this._lowerPts;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      // ウキ→チモトを直線。横ブレを入れると針軸とずれた「重心へ刺さる」見た目になる
      pts[i].lerpVectors(bobberPos, baitPos, t);
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
   *  state: 'idle'|'charge'|'flight'|'wait'|'nibble'|'bite'|'fight'|'landed'
   *  charge: 0..1  tension: 0..1  moving: 0..1  dt
   *  reeling: bool  ファイト中に巻いているか（根本を余計に立てる）
   *  rarity?: 0..5  掛かっている（掛かりかけの）魚のレア度。ナブル・アタリの
   *           震え・引き込みの強さに使う（無指定は 0 扱い）
   *  lineEnd?: Vector3  糸の先（ウキ／魚の口）。しなり方向の目標
   */
  update(dt, p) {
    const st = p.state;
    // 外部の一時 Vector3 を参照し続けない（毎フレームコピー）
    if (p.lineEnd) {
      this._lineEnd.copy(p.lineEnd);
      this._hasLineEnd = true;
    } else {
      this._hasLineEnd = false;
    }
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
    } else if (st === 'wait' || st === 'flight' || st === 'nibble' || st === 'bite') {
      // アタリ待ちは竿を寝かせる（合計 +1.0 = 垂直から 57°、水平から 33°）
      armT = -0.42;
      rodT = 1.42;
    } else if (st === 'fight') {
      // テンションが上がるほど竿を立てる
      armT = -0.72 - p.tension * 0.30;
      rodT = 1.28 - p.tension * 0.22;
      leanT = 0.16 + p.tension * 0.14;
      /* 巻いている間はさらに根本を立てる（ポンピングの「立てる」側）。
         離すとテンション基準の角度へ戻るので、巻く/離すのリズムがそのまま
         「立てて溜める→送り込む」の見た目になる */
      if (p.reeling) {
        armT -= 0.16;
        rodT -= 0.14;
        leanT += 0.05;
      }
    } else if (st === 'landed') {
      armT = -1.00;
      rodT = 1.10;
    }

    /* 一人称は視界に穂先を残したいので、待ちとファイトをさらに寝かせる
       （構え・キャストは三人称と同じ＝飛距離の計算が視点で変わらないように） */
    if (this.fpv) {
      if (st === 'wait' || st === 'flight' || st === 'nibble' || st === 'bite') {
        armT = -0.30; rodT = 1.50;                            // 合計 1.20（水平から 21°）
      } else if (st === 'fight') {
        armT = -0.55 - p.tension * 0.22;
        rodT = 1.45 - p.tension * 0.16;                       // 合計 0.90 → 0.52（立てていく）
        if (p.reeling) { armT -= 0.14; rodT -= 0.12; }
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
        this._applyBend(dt, p);
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
    if (st === 'wait' || st === 'flight' || st === 'nibble' || st === 'bite') {
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

    this._applyBend(dt, p);
  }

  /**
   * 竿のしなりを作る。「滑らかな曲げ」（テンション相応・時定数で追従）と
   * 「竿先の一時的な動き」（震え・引き込み・強い減衰をかけない）を分けて
   * 合成する。分けないと、震えのような速い動きが damp() で丸められて
   * 「ピクピク」が「もっさり」になってしまう。
   *
   * 向き（水平の方位角）と曲げ（各関節の X 回転）も分けて扱う：
   *  - rodFlexRoot の Y 回転で「どの向きへしなるか」を 1 回だけ決める
   *  - 各セグメントはその局所 X だけを回す（先端ほど大きく＝ROD_FLEX の比率）
   * 関節ごとに X・Z の両方を独立に回すと、チェーンの先ほど姿勢がねじれて
   * 破綻する（先端に行くほど「局所X」の向きが親の回転でずれるため）。
   * X だけなら回転軸そのものは回転で変わらないので、何関節つないでも
   * 同じ平面内で綺麗に曲がる。
   */
  _applyBend(dt, p) {
    const st = p.state;
    const tension = p.tension || 0;
    const rf = clamp01((p.rarity ?? 0) / 5);   // レア度 0..5 → 0..1

    /* --- 滑らかな曲げ（土台）。ファイトは以前よりずっと過敏に反応させる
       （生の tension に比例させると、大物の引き / ラインブレイク寸前まで
       ほとんど曲がらず地味に見えるため、べき乗で低めのテンションから
       大きく曲がるようにする） */
    let targetAmt = 0.05;
    if (st === 'fight') {
      /* テンション 1.0 でようやく最大しなりに届く曲線にする。
         以前は pow(t,0.55)*1.25 で、テンション 67% で半円に飽和していたため
         そこから切れる 100% までまったく見た目が変わらず、
         いちばん知りたい危険域が竿から読み取れなかった。
         低いテンションでも大きく曲がる「速い立ち上がり」は指数で維持する */
      targetAmt = tension > 0.001 ? clamp01(Math.pow(tension, 0.5)) : 0.08;
    } else if (st === 'nibble' || st === 'bite') {
      targetAmt = 0.10;
    }
    this.bend = damp(this.bend, targetAmt, 10, dt);
    const total = this.bend * ROD_BEND_MAX;

    /* --- 竿先の一時的な動き ---
       ナブル：小さく速い震え（レアなほど速く・大きく＝警戒感）
       アタリ：ガクッと引き込まれ、そのまま小刻みに震え続ける */
    let tip = 0;
    if (st === 'nibble') {
      if (this._prevSt !== 'nibble') this._nibbleT = 0;
      this._nibbleT += dt;
      const freq = lerp(12, 20, rf);
      const amp = lerp(0.05, 0.11, rf);
      tip = Math.sin(this._nibbleT * freq) * amp * (0.55 + 0.45 * Math.sin(this._nibbleT * 3.1 + 1));
    } else if (st === 'bite') {
      if (this._prevSt !== 'bite') this._biteT = 0;
      this._biteT += dt;
      const kickWindow = 0.16;
      const kick = Math.sin(clamp01(this._biteT / kickWindow) * Math.PI);       // 0→1→0 の速いガクッ
      const kickAmp = lerp(0.32, 0.62, rf);
      const settleAmp = lerp(0.08, 0.20, rf);
      const settle = Math.sin(this._biteT * 22) * settleAmp * clamp01(this._biteT / kickWindow);
      tip = kick * kickAmp + settle;
    }
    this._prevSt = st;

    /* しなる向き。糸の先（バット基準）がほぼ真上／真下で水平方向の
       手がかりが無い時（取り込み間際など）は向きを求め直さず、
       直前の向きを保つ（さもないと正規化が暴れて画面が乱れる） */
    if (this._hasLineEnd) {
      this.rodRoot.updateWorldMatrix(true, false);
      _m.copy(this.rodRoot.matrixWorld).invert();
      _v2.copy(this._lineEnd).applyMatrix4(_m);
      const hl = Math.hypot(_v2.x, _v2.z);
      if (hl > 0.12 && Number.isFinite(hl)) {
        const az = Math.atan2(_v2.x, _v2.z);
        let d = az - this._bendAz;
        d = ((d + Math.PI) % TAU + TAU) % TAU - Math.PI;    // 最短方向に正規化
        this._bendAz += d * (1 - Math.exp(-8 * dt));
      }
    }
    if (!Number.isFinite(this._bendAz)) this._bendAz = 0;
    this.rodFlexRoot.rotation.y = this._bendAz;

    const n = this.rodSegs.length;
    for (let i = 0; i < n; i++) {
      const share = (ROD_FLEX[i] ?? ROD_FLEX[ROD_FLEX.length - 1]) / ROD_FLEX_SUM;
      const seg = this.rodSegs[i];
      // 土台（滑らかに追従）と竿先の一時的な動き（減衰させず生で乗せる）を別々に持つ。
      // 同じ場所へ混ぜて damp() すると、震えの成分まで丸められて鈍ってしまうため
      this._segBase[i] = damp(this._segBase[i], total * share, 14, dt);
      seg.rotation.x = this._segBase[i] + tip * share;
      if (!Number.isFinite(seg.rotation.x)) seg.rotation.x = 0;
    }
  }

  getRodTip(out = new THREE.Vector3()) {
    this.root.updateMatrixWorld(true);
    return this.rodTip.getWorldPosition(out);
  }

  /**
   * 穂先（最後のガイド）が実際に向いている方向（ワールド空間、単位ベクトル）。
   * getRodTip() の直後（同フレーム内）に呼ぶ前提で、ここでは updateMatrixWorld を
   * 呼び直さない（毎フレーム 2 回計算するのは無駄なため）
   */
  getRodTipDir(out = new THREE.Vector3()) {
    this.rodTip.getWorldQuaternion(_q);
    return out.copy(_up).applyQuaternion(_q);
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
    /* 自然な弛み曲線（従来の直線＋弛み）。穂先の追従ゾーンを抜けた後の位置に使う */
    const naturalAt = (t, out) => out.set(
      lerp(tipPos.x, endPos.x, t),
      lerp(tipPos.y, endPos.y, t) - Math.sin(t * Math.PI) * sag,
      lerp(tipPos.z, endPos.z, t)
    );
    /* 穂先の実際の向きより急な角度で糸が出ることはない（＝ガイドで曲げられている）
       ので、穂先から LINE_TIP_FOLLOW ぶんはその向きへ寄せ、そこから先は
       自然な弛み曲線へ合流させる。等間隔の t で全長を割ると、遠くへ投げた
       ときに追従ゾーンへ点が 1 個も入らなくなる（全長 30m なら 1 点で 1m 超）
       ため、点配列の前半 TIP_PTS 個をこのゾーン専用に確保して密に敷く */
    this.getRodTipDir(_v4);
    const followT = dist > 1e-4 ? clamp(LINE_TIP_FOLLOW / dist, 0.006, 0.7) : 0;
    /* 穂先の向きへ寄せるのは「たるんでいる糸」だけにする。
       張った糸は魚まで一直線に伸びるのが正しく、そこで穂先の向きへ寄せると、
       しなった竿の穂先が魚の方向とずれているぶん接続部に折れ目が出る
       （ファイト中に糸が根元で曲がって見えていた原因）。
       LINE_SLACK_REF（アタリ待ちの弛み）で正規化して 0〜1 にする */
    const followK = clamp01(slack / LINE_SLACK_REF);
    // 追従ゾーン専用に確保する点数（末尾は自然な弛み側に必ず 1 点以上残す）
    const tipN = followT > 0 ? Math.min(LINE_TIP_PTS, total - 2) : 0;
    for (let i = 0; i < total; i++) {
      // 前半 tipN 点で [0, followT] を密に敷き、残りで (followT, 1] を敷く。
      // i = tipN の点がちょうど followT で、両ゾーンの継ぎ目が連続になる
      const t = i <= tipN
        ? (tipN > 0 ? (i / tipN) * followT : i / (total - 1))
        : followT + ((i - tipN) / (total - 1 - tipN)) * (1 - followT);
      naturalAt(t, _v3);
      if (t < followT && followK > 0.01) {
        // w=0 で穂先の向き / w=1 で自然な曲線。たるみが小さいほど自然な曲線（直線）に寄せる
        const w = 1 - (1 - smoothstep(0, followT, t)) * followK;
        const fx = tipPos.x + _v4.x * t * dist;
        const fy = tipPos.y + _v4.y * t * dist;
        const fz = tipPos.z + _v4.z * t * dist;
        pts[i].set(lerp(fx, _v3.x, w), lerp(fy, _v3.y, w), lerp(fz, _v3.z, w));
      } else {
        pts[i].copy(_v3);
      }
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
