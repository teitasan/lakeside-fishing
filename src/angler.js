/* ===========================================================
   釣り人・ロッド・ライン・ウキ
   =========================================================== */
import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, TAU, lineSagProfile } from './util.js';
import { createBaitMesh, disposeBaitMesh, updateBaitMesh, createHookMesh, HOOK } from './baitMesh.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

/** 関節の相対しなり（根本→先端）。先端ほどよく曲がる */
const ROD_FLEX = [0.22, 0.40, 0.70, 1.15, 1.70, 2.40];
const ROD_FLEX_SUM = ROD_FLEX.reduce((a, b) => a + b, 0);
/** 最大しなり角（半円） */
const ROD_BEND_MAX = Math.PI;
/* リールの連動。実物はハンドル 1 回転でローターがギア比ぶん回り、
   スプールは糸を均一に巻くためゆっくり前後する。ハンドルだけ回すと
   「軸だけ空回りしている」ように見えるので 3 つを繋ぐ */
const REEL_GEAR = 5.2;      // ギア比（ハンドル 1 回転あたりのローター回転）
const REEL_OSC = 0.30;      // スプールの往復（ハンドル回転に対する位相）
const REEL_STROKE = 0.004;  // スプールの前後幅（m）
/* 左腕のリンク長（肩→肘 / 肘→手）。逆運動学で使うので、
   _buildBody() の肘と手の位置を動かしたらここも合わせる */
const ARM_UPPER = 0.30;
const ARM_FORE = 0.262;
/* 糸は竿先から終点へ真っ直ぐ出す（たるみの形は Angler.sagAt が持つ）。
   穂先の向きへ寄せる追従ゾーンは、竿先に S 字のたるみを作ってしまうため廃止した */

/* ===========================================================
   モデルを組む小道具
   =========================================================== */
/** MeshStandardMaterial の短縮 */
const mat = (color, roughness = 0.8, metalness = 0) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });

/**
 * 半径プロファイル [[y, r], ...] を Y 軸まわりに回した回転体。
 * 箱を並べるより体・腕・脚・グリップ・スプールが滑らかに出る。
 * flatZ で断面を楕円に潰せる（人体は前後が薄いので z を縮める）
 */
function lathe(profile, radialSeg = 16, flatZ = 1, phiStart = 0, phiLength = TAU) {
  const pts = profile.map(([y, r]) => new THREE.Vector2(Math.max(0.0002, r), y));
  const g = new THREE.LatheGeometry(pts, radialSeg, phiStart, phiLength);
  if (flatZ !== 1) g.scale(1, 1, flatZ);
  g.computeVertexNormals();
  return g;
}

/**
 * 同じマテリアルの小パーツを 1 つのジオメトリにまとめる。
 * 釣り人とリールは 100 パーツ以上あるので、まとめないとドローコールと
 * 影の描画がその数だけ増えてしまう（動かす必要のある関節だけを分ける）。
 * parts: [{ geo, pos?, rot?, scale? }]（scale は数値か [x,y,z]）
 */
function mergeGeos(parts) {
  const P = [], N = [], U = [], I = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  let base = 0;
  for (const it of parts) {
    const g = it.geo.clone();
    const s = it.scale ?? 1;
    e.set(...(it.rot || [0, 0, 0]));
    q.setFromEuler(e);
    v.set(...(it.pos || [0, 0, 0]));
    sc.set(...(typeof s === 'number' ? [s, s, s] : s));
    g.applyMatrix4(m.compose(v, q, sc));
    const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      P.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      N.push(nor ? nor.getX(i) : 0, nor ? nor.getY(i) : 1, nor ? nor.getZ(i) : 0);
      U.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) I.push(g.index.getX(i) + base);
    else for (let i = 0; i < pos.count; i++) I.push(i + base);
    base += pos.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  out.setIndex(I);
  return out;
}

/* 頭の輪郭（1 本の回転体）。球を 2 つ交差させると必ず交線が段になって出るので、
   輪郭はこれだけで作り、顔のパーツは下の headZ() で表面に載せる */
const HEAD_PROFILE = [
  [-0.112, 0.008], [-0.101, 0.032], [-0.086, 0.052], [-0.066, 0.068], [-0.042, 0.080],
  [-0.014, 0.090], [0.014, 0.095], [0.042, 0.096], [0.066, 0.090], [0.086, 0.077],
  [0.102, 0.052], [0.110, 0.001],
];
const HEAD_SX = 0.94;   // 横を少し細く
const HEAD_SZ = 1.06;   // 前後を少し深く

/** 輪郭の半径（プロファイルの線形補間） */
function headR(y) {
  const P = HEAD_PROFILE;
  if (y <= P[0][0]) return P[0][1];
  for (let i = 1; i < P.length; i++) {
    if (y <= P[i][0]) {
      const t = (y - P[i - 1][0]) / (P[i][0] - P[i - 1][0]);
      return lerp(P[i - 1][1], P[i][1], t);
    }
  }
  return P[P.length - 1][1];
}

/**
 * (x, y) における頭の表面の z。目・眉・口をここに載せる。
 * 目分量で z を決めると必ず「埋まって見えない」か「浮いて縁が線になる」ので、
 * 輪郭を変えたらパーツが自動で追従するようにしておく
 */
function headZ(x, y) {
  const r = headR(y);
  const sx = x / (HEAD_SX * r);
  return HEAD_SZ * r * Math.sqrt(Math.max(0, 1 - sx * sx));
}

/** まとめたパーツから影を落とすメッシュを作る */
function part(parts, material) {
  const mesh = new THREE.Mesh(mergeGeos(parts), material);
  mesh.castShadow = true;
  return mesh;
}

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
    /* 竿のワールド上のピッチ（肩・肘を含めない見かけの角度）。
       ロッドを肘の子にしたので、rodRoot には「これ − 肘の角度」を入れる。
       こうしないと肘を曲げたぶん竿の角度まで変わってしまう */
    this.rodPitch = 0.8;
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
    /* ---- マテリアル ----
       一人称で消すパーツ（頭・首・胴）は colorWrite を個別に切るので、
       他のパーツとマテリアルを共有してはいけない（下で clone している） */
    const M = {
      skin:      mat(0xdcae86, 0.72),
      skinDark:  mat(0xc0906a, 0.75),
      hair:      mat(0x2b2118, 0.85),
      shirt:     mat(0x40614f, 0.86),
      shirtDark: mat(0x33503f, 0.88),
      vest:      mat(0xa08b5c, 0.90),
      vestDark:  mat(0x6d5c38, 0.90),
      pants:     mat(0x33404f, 0.92),
      boot:      mat(0x36291d, 0.78),
      sole:      mat(0x1a1712, 0.95),
      hat:       mat(0x8a6b3a, 0.90),
      hatBand:   mat(0x4a3a22, 0.88),
      strap:     mat(0x3a2e20, 0.85),
      eye:       mat(0x201a16, 0.35),
      metal:     mat(0xb9bfc6, 0.34, 0.72),
      metalDark: mat(0x60666e, 0.42, 0.68),
      steel:     mat(0xd7dce2, 0.24, 0.85),
      plastic:   mat(0x1c1e22, 0.55),
      rubber:    mat(0x131417, 0.95),
      eva:       mat(0x2b2724, 0.98),
      cork:      mat(0xbfa276, 0.92),
      gold:      mat(0xc9a552, 0.35, 0.80),
      lineWrap:  mat(0xdfe6ea, 0.55),
    };
    this.materials = M;

    this._fpvHide = [];
    this._buildBody(M);
    this._buildRod(M);
  }

  /* ===========================================================
     釣り人本体
     =========================================================== */
  _buildBody(M) {
    const g = this.root;

    /* ---- 脚（股 → 膝 → 足首）----
       股関節だけで振っていたのを膝まで入れた。歩幅の割に脚が棒だと
       いちばん animation の粗さが目立つ部分 */
    this.legs = [];
    this.knees = [];
    for (const s of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(s * 0.115, 0.86, 0);
      // 腿（付け根が太く膝で細い）
      hip.add(part([
        { geo: lathe([[-0.40, 0.062], [-0.36, 0.072], [-0.22, 0.085], [-0.08, 0.098], [0.00, 0.104], [0.04, 0.088], [0.055, 0.0]], 14, 0.92) },
        // 尻の丸み
        { geo: new THREE.SphereGeometry(0.070, 12, 10), pos: [s * -0.012, 0.008, -0.020], scale: [1, 0.92, 0.88] },
      ], M.pants));

      const knee = new THREE.Group();
      knee.position.y = -0.40;
      hip.add(knee);
      // 脛（膝の丸み → 足首）
      knee.add(part([
        { geo: new THREE.SphereGeometry(0.066, 12, 10), scale: [1, 0.92, 1] },
        { geo: lathe([[-0.30, 0.046], [-0.20, 0.054], [-0.10, 0.062], [0.00, 0.066], [0.02, 0.060]], 14, 0.95) },
        // 裾のだぶつき（ブーツに被せる）
        { geo: lathe([[-0.300, 0.058], [-0.285, 0.070], [-0.258, 0.068], [-0.240, 0.052]], 14, 0.95) },
      ], M.pants));

      // ブーツ（靴底・甲・つま先・履き口）
      const boot = new THREE.Group();
      boot.position.y = -0.325;
      knee.add(boot);
      /* 甲は「かかと側が高く、つま先へ下がる」形にする。同じ高さの箱に
         丸いつま先を足すと、靴底の上に石が乗ったような段が出る */
      boot.add(part([
        { geo: lathe([[0.045, 0.052], [0.070, 0.058], [0.082, 0.052], [0.090, 0.034]], 12, 1) }, // 履き口
        { geo: new THREE.BoxGeometry(0.086, 0.082, 0.100), pos: [0, 0.047, -0.028] },            // かかと側
        { geo: new THREE.BoxGeometry(0.082, 0.056, 0.082), pos: [0, 0.036, 0.030] },             // 甲
        { geo: new THREE.SphereGeometry(0.041, 12, 10), pos: [0, 0.030, 0.064], scale: [1.0, 0.74, 1.18] }, // つま先
      ], M.boot));
      boot.add(part([
        // 靴底はつま先の先端（z ≒ 0.112）に合わせる。長すぎると板の上に立って見える
        { geo: new THREE.BoxGeometry(0.092, 0.019, 0.198), pos: [0, 0.0095, 0.014] },
        { geo: new THREE.BoxGeometry(0.084, 0.016, 0.060), pos: [0, 0.026, -0.056] },            // かかとの積み上げ
      ], M.sole));
      // 靴紐（甲の上に横 3 本）
      boot.add(part([0, 1, 2].map((i) => ({
        geo: new THREE.BoxGeometry(0.050 - i * 0.005, 0.005, 0.007),
        pos: [0, 0.064 - i * 0.003, 0.008 + i * 0.017],
      })), M.strap));

      g.add(hip);
      this.legs.push(hip);
      this.knees.push(knee);
    }

    /* ---- 胴 ---- */
    this.torso = new THREE.Group();
    this.torso.position.y = 0.86;
    g.add(this.torso);

    // シャツ（腰 → 胸。前後を薄く潰した回転体）
    const shirtMat = M.shirt.clone();
    const shirt = part([
      { geo: lathe([
        [0.00, 0.001], [0.005, 0.120], [0.06, 0.134], [0.13, 0.132], [0.20, 0.126],
        [0.27, 0.136], [0.35, 0.156], [0.44, 0.168], [0.51, 0.163], [0.55, 0.142],
        [0.578, 0.112], [0.596, 0.082], [0.614, 0.070], [0.620, 0.001],
      ], 20, 0.70) },
      // 肩（左右へ張り出す）
      { geo: new THREE.SphereGeometry(0.078, 14, 10), pos: [-0.148, 0.492, 0], scale: [1, 0.86, 0.92] },
      { geo: new THREE.SphereGeometry(0.078, 14, 10), pos: [0.148, 0.492, 0], scale: [1, 0.86, 0.92] },
    ], shirtMat);
    this.torso.add(shirt);

    /* ベスト（胸〜腰。ポケットと襟とジッパー付き）。
       釣り人らしさがいちばん出るので、ここだけは形を作り込む */
    const vestMat = M.vest.clone();
    const vestDarkMat = M.vestDark.clone();
    const vest = part([
      { geo: lathe([
        [0.095, 0.001], [0.100, 0.090], [0.112, 0.130], [0.130, 0.140], [0.20, 0.142],
        [0.28, 0.148], [0.36, 0.158], [0.42, 0.160], [0.462, 0.152], [0.492, 0.128],
        [0.508, 0.092], [0.516, 0.001],
      ], 22, 0.78) },
    ], vestMat);
    this.torso.add(vest);
    const vestTrim = part([
      // 襟
      { geo: new THREE.TorusGeometry(0.098, 0.019, 6, 16), pos: [0, 0.505, 0], rot: [Math.PI / 2, 0, 0], scale: [1, 0.8, 1] },
      // 前ジッパー（細く。太いとポケットのフラップと合わせて十字に見える）
      { geo: new THREE.BoxGeometry(0.009, 0.375, 0.010), pos: [0, 0.308, 0.122] },
      // 胸ポケット×2・腹ポケット×2（上辺にフラップ）
      ...[[-0.058, 0.392, 0.050, 0.055], [0.058, 0.392, 0.050, 0.055],
          [-0.070, 0.278, 0.066, 0.074], [0.070, 0.278, 0.066, 0.074]].flatMap(([x, y, w, h]) => [
        { geo: new THREE.BoxGeometry(w, h, 0.018), pos: [x, y, 0.108] },
        { geo: new THREE.BoxGeometry(w + 0.006, 0.012, 0.026), pos: [x, y + h / 2 - 0.004, 0.109] },
      ]),
      // 背中のループ（ランディングネットを掛けるところ）
      { geo: new THREE.TorusGeometry(0.015, 0.0045, 5, 10), pos: [0, 0.440, -0.092], rot: [0.35, 0, 0] },
    ], vestDarkMat);
    this.torso.add(vestTrim);

    // 首
    const neckMat = M.skin.clone();
    const neck = part([
      { geo: lathe([[0.55, 0.044], [0.60, 0.046], [0.645, 0.053], [0.675, 0.062]], 12, 1) },
    ], neckMat);
    this.torso.add(neck);

    /* ---- 頭 ---- */
    this.head = new THREE.Group();
    this.head.position.y = 0.745;
    this.torso.add(this.head);
    const headMat = M.skin.clone();
    /* 頭は「球＋顎の球」を交差させると必ず交線が段になって出るので、
       輪郭は 1 本の回転体で作る。顔のパーツはそこへ深く埋めて足す
       （浅く置くと縁が線として浮いてしまう） */
    const skull = part([
      { geo: lathe(HEAD_PROFILE, 22, HEAD_SZ), scale: [HEAD_SX, 1, 1] },
      // 顎先（輪郭から 3mm だけ出す。出しすぎると瘤に見える）
      { geo: new THREE.SphereGeometry(0.026, 10, 8), pos: [0, -0.082, headZ(0, -0.082) - 0.022], scale: [1.10, 0.80, 1.0] },
      // 鼻（鼻筋と小鼻を重ねて 1 つの塊に見せる）
      { geo: new THREE.SphereGeometry(0.015, 10, 8), pos: [0, -0.008, headZ(0, -0.008) - 0.013], scale: [0.58, 1.50, 1.0] },
      { geo: new THREE.SphereGeometry(0.012, 10, 8), pos: [0, -0.030, headZ(0, -0.030) - 0.009], scale: [1.0, 0.72, 0.9] },
      // 耳
      { geo: new THREE.SphereGeometry(0.020, 8, 8), pos: [-0.082, -0.004, -0.006], scale: [0.35, 1.15, 0.85] },
      { geo: new THREE.SphereGeometry(0.020, 8, 8), pos: [0.082, -0.004, -0.006], scale: [0.35, 1.15, 0.85] },
    ], headMat);
    this.head.add(skull);
    /* 目・眉・口。真っ黒な太い線を貼ると凄い顔になるので、
       眉は髪と同じ色で細く、口は端を少し上げて 2 本に割る */
    const eyeMat = M.eye.clone();
    const eyes = part([
      { geo: new THREE.SphereGeometry(0.0105, 10, 8), pos: [-0.032, 0.008, headZ(-0.032, 0.008) - 0.0035], scale: [1, 0.92, 0.5] },
      { geo: new THREE.SphereGeometry(0.0105, 10, 8), pos: [0.032, 0.008, headZ(0.032, 0.008) - 0.0035], scale: [1, 0.92, 0.5] },
    ], eyeMat);
    this.head.add(eyes);
    const browMat = M.hair.clone();
    const brows = part([
      { geo: new THREE.BoxGeometry(0.028, 0.0060, 0.010), pos: [-0.033, 0.030, headZ(-0.033, 0.030) - 0.004], rot: [0, 0, -0.14] },
      { geo: new THREE.BoxGeometry(0.028, 0.0060, 0.010), pos: [0.033, 0.030, headZ(0.033, 0.030) - 0.004], rot: [0, 0, 0.14] },
      { geo: new THREE.BoxGeometry(0.016, 0.0045, 0.008), pos: [-0.009, -0.054, headZ(-0.009, -0.054) - 0.003], rot: [0, 0, 0.18] },
      { geo: new THREE.BoxGeometry(0.016, 0.0045, 0.008), pos: [0.009, -0.054, headZ(0.009, -0.054) - 0.003], rot: [0, 0, -0.18] },
    ], browMat);
    this.head.add(brows);
    /* 帽子から出る髪。頭蓋と同心の球を重ねると交差線がギザギザに出るので、
       lathe の部分回転で「後頭部から側頭部だけ」の薄い殻にする
       （phi=0 が +Z＝顔の正面なので、正面を開けて後ろ 200 度を覆う） */
    const hairMat = M.hair.clone();
    const hair = part([
      { geo: lathe([
        [-0.044, 0.082], [-0.014, 0.093], [0.014, 0.098], [0.042, 0.099], [0.062, 0.092],
      ], 20, 1.06, Math.PI * 0.42, Math.PI * 1.16), pos: [0, 0.000, -0.002], scale: [0.96, 1, 1] },
    ], hairMat);
    this.head.add(hair);

    /* 帽子（つば・冠・バンド）。つばは前が広く後ろが狭い実物寄りの形 */
    const hatMat = M.hat.clone();
    const hat = part([
      { geo: lathe([[0.010, 0.100], [0.006, 0.130], [-0.004, 0.160], [0.006, 0.162], [0.014, 0.132], [0.020, 0.100]], 20, 1), pos: [0, 0.060, 0], scale: [1, 1, 0.92] },
      { geo: lathe([[0.00, 0.100], [0.06, 0.098], [0.105, 0.088], [0.126, 0.064], [0.134, 0.001]], 20, 1), pos: [0, 0.058, 0] },
    ], hatMat);
    hat.position.z = 0.006;
    /* つばが顔に影を落とすと顔が完全に潰れて表情が読めないので、
       帽子だけ影を落とさない（体の影は残るので接地感は失われない） */
    hat.castShadow = false;
    this.head.add(hat);
    const hatBandMat = M.hatBand.clone();
    const hatBand = part([
      { geo: lathe([[0.00, 0.101], [0.026, 0.100]], 20, 1), pos: [0, 0.070, 0] },
    ], hatBandMat);
    hatBand.position.z = 0.006;
    this.head.add(hatBand);

    /* 一人称で視界を覆うパーツ。visible=false だと影も消えるので
       カラー出力と深度書き込みだけ止める（そのためマテリアルは clone 済み） */
    this._fpvHide.push(shirt, vest, vestTrim, neck, skull, eyes, brows, hair, hat, hatBand);

    /* ---- 腕（肩 → 肘 → 手首）。+X 側が左、-X 側が右。ロッドは右手 ---- */
    const mkArm = (s) => {
      const arm = new THREE.Group();
      arm.position.set(s * 0.155, 0.505, 0);
      // 上腕（袖）
      arm.add(part([
        { geo: new THREE.SphereGeometry(0.060, 12, 10), pos: [0, -0.006, 0], scale: [1, 0.95, 1] },
        { geo: lathe([[-0.30, 0.040], [-0.22, 0.045], [-0.10, 0.053], [-0.02, 0.057]], 14, 1) },
        // 袖口（まくった袖の折り返し）
        { geo: lathe([[-0.312, 0.042], [-0.296, 0.050], [-0.276, 0.048]], 14, 1) },
      ], M.shirtDark));

      const elbow = new THREE.Group();
      elbow.position.y = -0.30;
      arm.add(elbow);
      // 前腕（肘の丸み → 手首）
      elbow.add(part([
        { geo: new THREE.SphereGeometry(0.041, 12, 10) },
        { geo: lathe([[-0.245, 0.026], [-0.20, 0.029], [-0.10, 0.036], [0.00, 0.040]], 14, 1) },
      ], M.skin));

      this.torso.add(arm);
      return { arm, elbow };
    };
    const R = mkArm(-1);
    const L = mkArm(1);
    this.armR = R.arm;
    this.armL = L.arm;
    this.elbowR = R.elbow;
    this.elbowL = L.elbow;
    // Y を最後に掛ける（寝かせた竿を横へ振れるように。rotation.y=0 なら XYZ と同じ）
    this.armR.rotation.order = 'YXZ';

    // 左手（軽く握った形。何も持たないので前腕の先へ付ける）
    const handL = this._buildHand(M, 1);
    handL.position.set(0, -0.262, 0.012);
    handL.rotation.x = -0.25;
    this.elbowL.add(handL);
    this.handL = handL;
  }

  /**
   * 手（握り拳）。s = +1 で左手 / -1 で右手。
   * 指をロッドに巻き付ける向きに並べたいので、手のローカル +Z を「指の伸びる向き」、
   * +X を「親指側」に決めておく
   */
  _buildHand(M, s) {
    const g = new THREE.Group();
    g.add(part([
      // 掌（球ひとつだと団子になるので、掌・拳頭・指を分けて起伏を出す）
      { geo: new THREE.SphereGeometry(0.031, 12, 10), pos: [0, -0.004, 0.004], scale: [0.80, 0.66, 1.05] },
      // 拳頭（指の付け根の山。ここがあると握った形に見える）
      { geo: new THREE.CapsuleGeometry(0.0125, 0.042, 3, 8), pos: [0, -0.014, 0.019], rot: [0, 0, Math.PI / 2] },
      // 指 4 本（第 2 関節まで前へ、そこから折り返す）
      ...[0, 1, 2, 3].map((i) => ({
        geo: new THREE.CapsuleGeometry(0.0098 - i * 0.0007, 0.020, 2, 7),
        pos: [s * (0.019 - i * 0.0128), -0.017, 0.030 - i * 0.0018],
        rot: [Math.PI / 2 - 0.30, 0, 0],
      })),
      ...[0, 1, 2, 3].map((i) => ({
        geo: new THREE.CapsuleGeometry(0.0090 - i * 0.0007, 0.014, 2, 6),
        pos: [s * (0.019 - i * 0.0128), -0.033, 0.030 - i * 0.0018],
        rot: [0.30, 0, 0],
      })),
      // 親指（他の指と向き合って輪を閉じる）
      { geo: new THREE.CapsuleGeometry(0.0115, 0.022, 2, 8), pos: [s * 0.026, -0.006, 0.006], rot: [Math.PI / 2 - 0.75, 0, s * 0.40] },
      { geo: new THREE.CapsuleGeometry(0.0100, 0.016, 2, 8), pos: [s * 0.019, -0.014, 0.026], rot: [Math.PI / 2 - 0.30, 0, s * 0.9] },
    ], M.skin));
    return g;
  }

  /* ===========================================================
     ロッド（グリップ・リールシート・ブランク・ガイド）
     =========================================================== */
  _buildRod(M) {
    /* ロッドは肘の子にする。肩から真下に伸ばした腕の先だと竿が腰の高さに来て、
       左手をリールへ回すこともできない持ち方になる。肘を曲げれば竿ごと
       上がって前へ出るので、竿を構えた姿勢になる。
       肘 0 度のときに元と同じ位置に来るよう (0, -0.28, ...) に置く
       （肘は腕のローカル -0.30） */
    this.rodRoot = new THREE.Object3D();
    this.rodRoot.position.set(-0.02, -0.28, 0.05);
    this.elbowR.add(this.rodRoot);

    const rodMat = mat(0x3a2a1c, 0.55, 0.15);
    const rodTipMat = mat(0x8d8d94, 0.40, 0.40);
    this.rodMats = { rodMat, rodTipMat };

    /* グリップ周り（下から: エンドキャップ → リアグリップ → リールシート →
       ロックナット → フォアグリップ → ワインディングチェック）。
       全長は今までと同じ（穂先の位置＝糸の出どころを動かさないため） */
    this.rodRoot.add(part([
      { geo: lathe([[-0.170, 0.001], [-0.166, 0.016], [-0.150, 0.019]], 14, 1) },   // エンドキャップ
    ], M.rubber));
    this.rodRoot.add(part([
      { geo: lathe([[-0.150, 0.019], [-0.120, 0.021], [-0.060, 0.0205], [-0.020, 0.018], [0.010, 0.0165]], 16, 1) }, // リアグリップ
      { geo: lathe([[0.108, 0.0155], [0.130, 0.0165], [0.140, 0.0150]], 16, 1) },   // フォアグリップ
    ], M.eva));
    this.rodRoot.add(part([
      { geo: lathe([[0.014, 0.0148], [0.086, 0.0148]], 16, 1) },                    // リールシート（金属筒）
      { geo: lathe([[0.086, 0.0168], [0.106, 0.0172]], 16, 1) },                    // ロックナット
      { geo: new THREE.TorusGeometry(0.0162, 0.0020, 5, 16), pos: [0, 0.141, 0], rot: [Math.PI / 2, 0, 0] }, // ワインディングチェック
    ], M.metalDark));
    // ロックナットの滑り止め（縦溝）
    this.rodRoot.add(part(
      Array.from({ length: 12 }, (_, i) => ({
        geo: new THREE.BoxGeometry(0.0018, 0.014, 0.0018),
        pos: [Math.cos(i / 12 * TAU) * 0.0172, 0.096, Math.sin(i / 12 * TAU) * 0.0172],
      })), M.metal));

    this._buildReel(M);

    /* しなる向き（水平の方位角）専用のラッパー。グリップ・リールは rodRoot に
       直付けのままにして、これだけを回す＝しなっても手元の向きは動かない */
    this.rodFlexRoot = new THREE.Object3D();
    this.rodRoot.add(this.rodFlexRoot);

    /* 6 セグメント（全長 ≈ 2.12m）。先端ほど細く・しなる */
    const segLen = [0.42, 0.40, 0.36, 0.34, 0.32, 0.28];
    const r0 = 0.0135;
    const r1 = 0.0026;
    let parent = this.rodFlexRoot;
    this.rodSegs = [];
    for (let i = 0; i < segLen.length; i++) {
      const seg = new THREE.Object3D();
      seg.position.y = i === 0 ? 0.14 : segLen[i - 1];
      const t0 = i / segLen.length;
      const t1 = (i + 1) / segLen.length;
      const radBot = lerp(r0, r1, t0);
      const radTop = lerp(r0, r1, t1);
      const blank = [
        { geo: new THREE.CylinderGeometry(radTop, radBot, segLen[i], 10), pos: [0, segLen[i] / 2, 0] },
      ];
      // 継ぎ目の補強巻き
      if (i > 0) blank.push({ geo: lathe([[0.0, radBot * 1.14], [0.016, radBot * 1.10]], 10, 1) });
      seg.add(part(blank, i >= 4 ? rodTipMat : rodMat));

      /* ガイド（根本以外）。リング + 2 本脚 + 足元の巻き。
         リングだけだとブランクから浮いて見えるので脚を入れる */
      if (i > 0) {
        const gR = lerp(0.017, 0.0085, i / (segLen.length - 1));
        const y = segLen[i] * 0.72;
        const legTop = y - gR * 0.55;
        const legLen = gR * 1.35;
        seg.add(part([
          { geo: new THREE.TorusGeometry(gR, 0.0022, 5, 14), pos: [0, y, 0], rot: [Math.PI / 2, 0, 0] },
          { geo: new THREE.BoxGeometry(0.0026, legLen, 0.0055), pos: [0, legTop - legLen / 2, radTop * 0.7], rot: [0.38, 0, 0] },
          { geo: new THREE.BoxGeometry(0.0026, legLen, 0.0055), pos: [0, legTop - legLen / 2, -radTop * 0.7], rot: [-0.38, 0, 0] },
          { geo: lathe([[y - legLen - 0.006, radTop * 1.22], [y - legLen + 0.004, radTop * 1.20]], 10, 1) },
        ], rodTipMat));
      }
      parent.add(seg);
      parent = seg;
      this.rodSegs.push(seg);
    }
    this.rodTip = new THREE.Object3D();
    this.rodTip.position.y = segLen[segLen.length - 1];
    parent.add(this.rodTip);
    // トップガイド（穂先の輪。糸はここから出る）
    this.rodTip.add(part([
      { geo: lathe([[-0.012, 0.0042], [0.000, 0.0038], [0.004, 0.0034]], 8, 1) },
      { geo: new THREE.TorusGeometry(0.0062, 0.0016, 5, 12), pos: [0, 0.011, 0], rot: [Math.PI / 2, 0, 0] },
      { geo: new THREE.BoxGeometry(0.0022, 0.008, 0.0038), pos: [0, 0.0065, 0.0028], rot: [0.5, 0, 0] },
    ], rodTipMat));

    /* 右手はロッドの子にする。rodRoot の回転（構え／振りかぶり／立てる）に
       そのまま付いていくので、どの姿勢でもグリップを握った形が崩れない。
       手はローカル +X 方向の棒を握る作りなので、Z を −90 度回して
       握り軸をロッドの軸（+Y）に合わせ、握り位置がリールの脚の下に来るよう置く */
    const handR = this._buildHand(M, -1);
    handR.rotation.set(0, 0, -Math.PI / 2);
    handR.position.set(0.020, 0.030, -0.012);
    this.rodRoot.add(handR);
    this.handR = handR;

    // ロッドの基本姿勢
    this.rodRoot.rotation.x = 0.8;
  }

  /* ===========================================================
     スピニングリール
     ロッドのローカル座標では +Y が穂先・+Z がロッドの下側なので、
     脚は +Z へ伸ばし、スプールの軸は +Y（穂先向き）に取る
     =========================================================== */
  _buildReel(M) {
    const reel = new THREE.Group();
    reel.position.set(0, 0.050, 0.0145);     // リールシートの位置（ロッドの表面）
    this.rodRoot.add(reel);
    this.reel = reel;

    /* ボディ（脚・ステム・ギアボックス）。ステムは少し後ろへ倒れる */
    reel.add(part([
      // リールシートに咬ませる脚
      { geo: new THREE.BoxGeometry(0.015, 0.070, 0.007), pos: [0, 0, 0.003], rot: [0.05, 0, 0] },
      // ステム
      { geo: lathe([[0.000, 0.010], [0.022, 0.012], [0.040, 0.016]], 12, 1), pos: [0, -0.006, 0.028], rot: [Math.PI / 2, 0, 0] },
      // ギアボックス（前後に長い卵形）
      { geo: new THREE.SphereGeometry(0.025, 16, 12), pos: [0, -0.014, 0.070], scale: [0.84, 1.32, 1.06] },
      // ハンドル軸のふくらみ（左右）
      { geo: new THREE.SphereGeometry(0.017, 12, 10), pos: [0, -0.018, 0.072], scale: [1.50, 1, 1] },
      // 逆転レバー
      { geo: new THREE.BoxGeometry(0.008, 0.011, 0.018), pos: [-0.019, -0.040, 0.076], rot: [0.2, 0, 0] },
    ], M.metalDark));
    // ボディ側面のプレート（銘板のつもりの色差し）
    reel.add(part([
      { geo: lathe([[0.000, 0.0105], [0.0035, 0.0095]], 14, 1), pos: [0.0215, -0.018, 0.072], rot: [0, 0, -Math.PI / 2] },
      { geo: lathe([[0.000, 0.0105], [0.0035, 0.0095]], 14, 1), pos: [-0.0215, -0.018, 0.072], rot: [0, 0, Math.PI / 2] },
    ], M.metal));

    /* ローター（スプールを外から回す椀）+ ベール + ラインローラー。
       巻くと実物どおりこれが回る */
    const rotor = new THREE.Group();
    rotor.position.set(0, 0.020, 0.056);
    reel.add(rotor);
    this.reelRotor = rotor;
    rotor.add(part([
      // 椀（内壁まで作って肉厚を出す）
      { geo: lathe([
        [-0.036, 0.008], [-0.033, 0.017], [-0.023, 0.028], [-0.009, 0.0325], [0.009, 0.0325],
        [0.009, 0.0300], [-0.009, 0.0300], [-0.022, 0.0258], [-0.031, 0.0150], [-0.034, 0.008],
      ], 20, 1) },
      /* ベールを支える 2 本のアーム。ローターの前縁から立ち上がってスプールの
         前まで伸びる（実物は片方が太くベールを起こすレバーになっている） */
      { geo: new THREE.BoxGeometry(0.013, 0.030, 0.010), pos: [0.0300, 0.020, 0], rot: [0, 0, 0.20] },
      { geo: new THREE.BoxGeometry(0.009, 0.026, 0.009), pos: [-0.0300, 0.018, 0], rot: [0, 0, -0.20] },
    ], M.metal));
    rotor.add(part([
      /* ベール（スプール前を跨ぐ半円のワイヤ）。TorusGeometry は XY 平面に
         できるので回転させない＝X 方向に張って +Y（穂先側）へ張り出す。
         回すとスプールと同じ平面に寝てしまって「ただの輪」になる */
      { geo: new THREE.TorusGeometry(0.0305, 0.0018, 5, 20, Math.PI), pos: [0, 0.032, 0] },
      // ベールアームのカバー
      { geo: new THREE.BoxGeometry(0.011, 0.015, 0.011), pos: [0.0300, 0.032, 0], rot: [0, 0, 0.1] },
    ], M.steel));
    rotor.add(part([
      // ラインローラー（糸が乗る溝つきの小輪）。ベールの端＝アームの先に付く
      { geo: lathe([[-0.003, 0.0055], [-0.001, 0.0038], [0.001, 0.0038], [0.003, 0.0055]], 10, 1),
        pos: [0.0305, 0.032, 0], rot: [0, 0, Math.PI / 2] },
    ], M.plastic));

    /* スプール（糸巻き）。巻くとゆっくり前後する */
    const spool = new THREE.Group();
    spool.position.set(0, 0.020, 0.056);
    reel.add(spool);
    this.reelSpool = spool;
    this._spoolY0 = spool.position.y;
    spool.add(part([
      { geo: lathe([
        [-0.020, 0.009], [-0.019, 0.0270], [-0.016, 0.0270], [-0.013, 0.0215],
        [0.009, 0.0215], [0.012, 0.0270], [0.016, 0.0270], [0.017, 0.0215], [0.019, 0.0095],
      ], 20, 1) },
    ], M.metal));
    spool.add(part([
      { geo: lathe([[-0.0125, 0.0243], [0.0085, 0.0243]], 20, 1) },   // 巻いてある糸
    ], M.lineWrap));
    spool.add(part([
      // ドラグノブ（前面のつまみ）と滑り止め
      { geo: lathe([[0.019, 0.012], [0.023, 0.0165], [0.032, 0.0165], [0.034, 0.011], [0.035, 0.001]], 14, 1) },
      ...Array.from({ length: 8 }, (_, i) => ({
        geo: new THREE.BoxGeometry(0.0024, 0.009, 0.0024),
        pos: [Math.cos(i / 8 * TAU) * 0.0165, 0.0275, Math.sin(i / 8 * TAU) * 0.0165],
      })),
    ], M.plastic));

    /* ハンドル。回転軸をロッドの左右（X）へ向けたいので、
       固定の pivot で軸を寝かせ、その子（reelHandle）を Z だけ回す。
       既存のアニメーションが reelHandle.rotation.z を足しているのを壊さない */
    const pivot = new THREE.Group();
    pivot.position.set(0.0235, -0.018, 0.072);
    pivot.rotation.y = Math.PI / 2;
    reel.add(pivot);
    const handle = new THREE.Group();
    pivot.add(handle);
    this.reelHandle = handle;
    /* 左手が来る位置の目印（ハンドル軸の外側）。左腕の逆運動学の目標に使う。
       ノブそのものを目標にすると、回転に合わせて手が振り回されてしまう */
    this.reelGrip = new THREE.Object3D();
    this.reelGrip.position.z = 0.038;
    pivot.add(this.reelGrip);
    handle.add(part([
      { geo: lathe([[0.000, 0.0095], [0.010, 0.0080]], 12, 1), rot: [Math.PI / 2, 0, 0] },     // 軸のカバー
      { geo: new THREE.BoxGeometry(0.0085, 0.050, 0.0072), pos: [0, 0.025, 0.006] },           // クランクアーム
      { geo: lathe([[0.000, 0.0055], [0.016, 0.0050]], 10, 1), pos: [0, 0.048, 0.006], rot: [Math.PI / 2, 0, 0] }, // ノブの軸
    ], M.metal));
    handle.add(part([
      // ノブ（樽型）
      { geo: lathe([[0.000, 0.005], [0.005, 0.0110], [0.015, 0.0125], [0.025, 0.0110], [0.030, 0.005]], 14, 1),
        pos: [0, 0.048, 0.016], rot: [Math.PI / 2, 0, 0] },
    ], M.plastic));
    // 反対側のハンドルキャップ
    reel.add(part([
      { geo: lathe([[0.000, 0.0095], [0.006, 0.0075]], 12, 1), pos: [-0.0235, -0.018, 0.072], rot: [0, 0, Math.PI / 2] },
    ], M.metalDark));
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
    /* 膝。股だけで振ると脚が棒のまま前後して歩きに見えないので、
       後ろへ蹴り出したあと（股の角度が戻り始める側）で曲げる。
       曲がる向きは「かかとが尻へ寄る」＝+X 回転のみ（人の膝は逆に曲がらない） */
    const kneeOf = (ph) => (0.05 + 0.85 * Math.max(0, Math.sin(ph + 2.2))) * p.moving;
    this.knees[0].rotation.x = kneeOf(this.walkPhase);
    this.knees[1].rotation.x = kneeOf(this.walkPhase + Math.PI);
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
        this.elbowR.rotation.x = lerp(-1.05, -0.10, e);
        this.rodPitch = damp(this.rodPitch, rodT, 26, dt);
        this.rodRoot.rotation.x = this.rodPitch - this.elbowR.rotation.x;
        this.armR.rotation.x = this.armX;
        this.armZ = damp(this.armZ, 0, 14, dt);      // 振り抜きは正面で
        this.armR.rotation.z = this.armZ;
        this.armY = damp(this.armY, 0, 14, dt);
        this.armR.rotation.y = this.armY;
        this.armL.rotation.x = lerp(-0.3, -0.9, e);
        /* 振りかぶりで肘を畳み、振り抜きで伸ばす。肘が固定だと
           腕全体が板のように回るだけで「振った」感じが出ない */
        this.elbowL.rotation.x = lerp(-0.35, -1.00, e);
        this.torso.rotation.x = leanT;
        this._applyBend(dt, p);
        this._spinReel(dt * 2);
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
    /* 右肘。竿を構えている間は深く畳んで竿を体の前に持ってくる
       （竿の角度は rodPitch で保たれるので、ここを変えても狙いはずれない） */
    let elbowRT = -0.25 - p.moving * 0.25;
    if (st === 'wait' || st === 'flight' || st === 'nibble' || st === 'bite') elbowRT = -0.55;
    else if (st === 'fight') elbowRT = -0.75 - p.tension * 0.20;
    else if (st === 'landed') elbowRT = -0.85;
    else if (st === 'charge') elbowRT = lerp(-0.25, -0.95, p.charge);
    this.elbowR.rotation.x = damp(this.elbowR.rotation.x, elbowRT, 8, dt);
    /* 左腕は「竿を出している間はリールのハンドルを握る」。決め打ちの角度だと
       竿の角度が状態とテンションで動くぶん手が空を掴むので、毎フレーム解く */
    const holding = st === 'wait' || st === 'flight' || st === 'nibble' || st === 'bite'
      || st === 'fight' || st === 'landed';
    if (holding) {
      this._reachReel(dt);
    } else {
      this.armL.rotation.set(st === 'idle' ? -0.3 + swing * 0.6 : -0.75, 0, 0);
      this.elbowL.rotation.x = damp(this.elbowL.rotation.x, -0.30 - p.moving * 0.25, 8, dt);
    }
    this.rodPitch = damp(this.rodPitch, rodT, 9, dt);
    this.rodRoot.rotation.x = this.rodPitch - this.elbowR.rotation.x;
    this.bodyLean = damp(this.bodyLean, leanT, 8, dt);
    this.torso.rotation.x = this.bodyLean;
    // 頭は少し狙いの方を向く
    this.head.rotation.x = damp(this.head.rotation.x, clamp(-this.pitch * 0.5, -0.5, 0.5), 8, dt);

    if (p.reeling) this._spinReel(dt * 14);

    this._applyBend(dt, p);
  }

  /**
   * 左腕をリールのハンドルへ届かせる（肩の向き＋肘の曲げの 2 リンク逆運動学）。
   *
   * 肘は X 回転しか持たないので、腕のローカルでは手は必ず x=0 の面内に来る。
   * つまり「肘の曲げ角 φ」を距離だけから決め、そのときの手の向き
   * (0, −L1−L2cosφ, L2sinφ) を目標方向へ合わせる回転を肩に入れれば必ず届く。
   */
  _reachReel(dt) {
    // 目標（リールのハンドル軸の外側）を胴のローカル座標へ
    this.reelGrip.getWorldPosition(_v);
    this.torso.updateMatrixWorld();
    this.torso.worldToLocal(_v);
    _v.sub(this.armL.position);
    const reach = ARM_UPPER + ARM_FORE;
    const d = clamp(_v.length(), Math.abs(ARM_UPPER - ARM_FORE) + 0.02, reach - 0.012);
    // 肘の内角から曲げ角（人の肘は前へしか曲がらないので符号は負に固定）
    const cosPhi = clamp((d * d - ARM_UPPER * ARM_UPPER - ARM_FORE * ARM_FORE)
      / (2 * ARM_UPPER * ARM_FORE), -1, 1);
    const phi = Math.acos(cosPhi);
    this.elbowL.rotation.x = damp(this.elbowL.rotation.x, -phi, 12, dt);
    // その曲げのときの「肩から手へ」の向き（腕のローカル）
    _v2.set(0, -ARM_UPPER - ARM_FORE * Math.cos(phi), ARM_FORE * Math.sin(phi)).normalize();
    _q.setFromUnitVectors(_v2, _v.normalize());
    this.armL.quaternion.slerp(_q, 1 - Math.exp(-12 * dt));
  }

  /**
   * リールを回す。ハンドルの回転からローターの回転とスプールの前後を作る。
   * 既存の呼び出しが reelHandle.rotation.z を直接足していたのをここへ集約した
   */
  _spinReel(delta) {
    const h = (this.reelHandle.rotation.z += delta);
    this.reelRotor.rotation.y = -h * REEL_GEAR;
    this.reelSpool.position.y = this._spoolY0 + Math.sin(h * REEL_OSC) * REEL_STROKE;
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

  /** 糸のたるみ量（ウキを糸の上に乗せるので game 側でも使う） */
  static sagFor(dist, slack) {
    return Math.min(dist * 0.16, 1.2) * clamp(slack, 0, 1);
  }

  /** たるみの形（t: 0=竿先 1=終点 → 下がる量）。形の定義は util.js の lineSagProfile */
  static sagAt(t, sag) {
    return lineSagProfile(t) * sag;
  }

  /**
   * ロッド先端 → ウキ の糸を張る（slack: 0=ピンピン 1=たるみ）
   * clipY を渡すと、その高さ（水面）より下は描画しない
   */
  updateLine(tipPos, endPos, slack, camera, clipY = null) {
    const pts = this._linePts;
    const total = pts.length;
    const dist = tipPos.distanceTo(endPos);
    const sag = Angler.sagFor(dist, slack);
    /* 竿先からはピンと張って出て、ウキ寄りでたるむ。
       以前は穂先の向きへ糸を寄せる区間を設けて竿と糸をなめらかに繋いでいたが、
       穂先の向きと糸の向きの差ぶん、竿先の手前で糸が持ち上がって戻る S 字になり
       「竿先で糸がたるんでいる」ように見えていた。
       実際の竿先はガイドで糸が折れ返る＝竿と糸は鋭角に交わるので、
       糸は竿先から終点へ真っ直ぐ出す（たるみの形は sagAt が持つ） */
    for (let i = 0; i < total; i++) {
      const t = i / (total - 1);
      pts[i].set(
        lerp(tipPos.x, endPos.x, t),
        lerp(tipPos.y, endPos.y, t) - Angler.sagAt(t, sag),
        lerp(tipPos.z, endPos.z, t)
      );
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
