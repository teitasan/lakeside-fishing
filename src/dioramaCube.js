/* ===========================================================
   渚ディオラマ «立方体に切り取る» モード

   水系アセットの見本でよく見る «ガラスの水槽に切り出した一片»。
   ちがうのは中身が本番の地形と水そのままで、しかも波打ち際が入ること。

   作りは 2 つある。

   1. 立方体の外を捨てる
      three のクリッピング面（ワールド空間）で切る。組み込みマテリアルは
      そのまま効く。水だけは ShaderMaterial なので water.js 側へチャンクを
      入れてある。空ドームは背景なので切らない。
      renderer.clippingPlanes（全体）ではなく localClippingEnabled +
      material.clippingPlanes（個別）を使うのは、切り口の «面» 自身が
      境界のちょうど上に乗るため。全体クリップだと自分自身が消える。

   2. 切り口に面を張る
      地形も水も «表面» しか無いので、切ったままだと中が空洞に見える。
      土の層と水柱の 2 枚を、立方体の 4 辺に沿って張る。
        土   上端は heightAt。下端は箱の底。深さで色を変えて地層にする
        水柱 上端は surfaceY で毎フレーム波に追従。下端は湖底
      切り口で波が上下して、砂の上を寄せては引くのが見せ場なので、
      水柱の上端だけは静止させない。
   =========================================================== */
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

/* 切り口を内側へ 3cm 寄せる。境界のちょうど上に置くと、三角形に割られた
   地形メッシュの縁と 1px 単位でずれて、継ぎ目が線になって見える */
const INSET = 0.03;

/* 土の層。上端からの深さの割合で刻む。上を細かくするのは、
   表土 → 砂 → 泥 の切り替わりが上に集まっているから。
   0.30〜0.325 と 0.66〜0.685 は «地層の縞» を出すための細い帯 */
const EARTH_ROWS = [0, 0.03, 0.05, 0.16, 0.30, 0.325, 0.46, 0.66, 0.685, 0.84, 1];
const EARTH_BANDS = [[0.30, 0.325], [0.66, 0.685]];
/* 水柱。水面際を細かくするのは、そこに «水面の線» を出したいから */
const WATER_ROWS = [0, 0.012, 0.05, 0.16, 0.42, 1];

const _v = new THREE.Vector3();
const _c = new THREE.Color();

/** 見た目で決めた sRGB の色を、頂点カラー（リニア）へ直す。
    そのまま入れると three はリニア値として扱うので、全体が白っぽく浮く */
function srgb(r, g, b) {
  _c.setRGB(r, g, b, THREE.SRGBColorSpace);
  return [_c.r, _c.g, _c.b];
}

/** 決定的な微小ノイズ。地層をのっぺりさせないため */
function hash2(x, z) {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/* 層の境目のうねり。«滑らかな» 関数でないと、列ごとに層の深さが跳んで
   縦縞（木目）になる。低い周波数を 3 枚重ねて地層のたわみを作る */
function strataWobble(x, z) {
  return Math.sin(x * 0.55 + z * 0.31) * 0.030
       + Math.sin(x * 1.31 - z * 0.87 + 1.7) * 0.016
       + Math.sin(x * 2.60 + z * 1.90 + 4.1) * 0.008;
}

export class DioramaCube {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./terrain.js').Terrain} terrain
   * @param {import('./water.js').Water} water
   * @param {{size?: number, segments?: number, exclude?: THREE.Object3D[]}} [opts]
   */
  constructor(scene, terrain, water, opts = {}) {
    this.scene = scene;
    this.terrain = terrain;
    this.water = water;
    this.size = opts.size ?? 14;
    this.segments = opts.segments ?? 160;
    /* 汀線を箱のどこへ置くか。0 で中心、正で陸側へ寄る（＝水が増える）。
       半辺に対する割合 */
    this.lakeBias = opts.lakeBias ?? 0.42;
    /* 土の層の最低の厚み。浅い岸でも «切り出した一片» に見える厚みを残す */
    this.minDepth = opts.minDepth ?? 4.6;
    this.radiusMul = opts.radiusMul ?? 1.42;   // 立方体の一辺に対するカメラ距離
    this.elevation = opts.elevation ?? 0.28;   // 仰角（rad）
    this.fov = opts.fov ?? 34;
    /** クリップしないもの（空ドームなど）。この配下は素通しする */
    this.exclude = opts.exclude ?? [];

    this.enabled = false;
    /* 水平角（rad）。0 で陸側から湖を見る。既定は湖側の角から見る向き
       ＝ 手前が水の断面、奥が砂浜。いちばん «水槽» に見える */
    this.orbit = opts.orbit ?? 2.55;
    this.orbitSpeed = 0.10;            // rad/s
    this.autoOrbit = true;
    this.center = new THREE.Vector3();
    this.half = this.size * 0.5;
    this.bottomY = -2;

    this.planes = [];
    for (let i = 0; i < 5; i++) this.planes.push(new THREE.Plane());

    this.group = new THREE.Group();
    this.group.name = 'diorama-cube';
    this.group.visible = false;
    scene.add(this.group);

    this.earthMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.97, metalness: 0, side: THREE.DoubleSide,
    });
    /* 水柱は «光» ではなく «水の色の厚み» なので陰影を付けない。
       深度は書かない（後ろの湖底が透けるのが本題） */
    this.waterMat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.earthMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.earthMat);
    this.earthMesh.name = 'cube-earth';
    /* 切り口は «土の中» なので、地形の影を受けさせない。
       受けさせると水面より下がまるごと影に入って真っ黒に潰れる */
    this.earthMesh.receiveShadow = false;
    this.earthMesh.castShadow = false;
    this.waterMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.waterMat);
    this.waterMesh.name = 'cube-waterwall';
    this.waterMesh.renderOrder = 4;    // 水面より後ろに描く
    this.group.add(this.earthMesh, this.waterMesh);

    this._patched = [];                // クリップ面を当てたマテリアル
    this._edges = [];                  // 辺ごとのサンプル点（水柱の更新に使う）
  }

  /* ---------------- 立方体を岸に合わせて置く ---------------- */

  /**
   * shoreFocus（岸の焦点と岸フレーム）から立方体の位置・深さを決めて、
   * 切り口の面を作り直す。
   * @param {{shore: THREE.Vector3, lakeDir: THREE.Vector3, alongShore: THREE.Vector3}} focus
   */
  setFocus(focus) {
    const S = this.size * 0.5;
    this.half = S;
    this.u = focus.alongShore.clone().setY(0).normalize();
    this.w = focus.lakeDir.clone().setY(0).normalize();
    /* 汀線を中心より陸側へ寄せる。«波打ち際のある水槽» は
       水が 7 割ほど入っているといちばん読みやすい */
    this.center.copy(focus.shore).addScaledVector(this.w, S * this.lakeBias);
    this.center.y = 0;

    // 底は足元の最深部より少し下。浅くても土の層が見えるよう下限を持つ
    let minH = 0;
    for (let i = 0; i <= 16; i++) {
      for (let j = 0; j <= 16; j++) {
        const a = (i / 16 - 0.5) * 2 * S;
        const b = (j / 16 - 0.5) * 2 * S;
        _v.copy(this.center).addScaledVector(this.u, a).addScaledVector(this.w, b);
        minH = Math.min(minH, this.terrain.heightAt(_v.x, _v.z));
      }
    }
    this.bottomY = Math.min(minH - 0.9, -this.minDepth);

    this._updatePlanes();
    this._buildShell();
  }

  _updatePlanes() {
    const S = this.half;
    const c = this.center;
    // 内側を残すので法線は内向き
    const set = (i, n, p) => this.planes[i].setFromNormalAndCoplanarPoint(n, p);
    set(0, this.u.clone().negate(), _v.copy(c).addScaledVector(this.u, S).clone());
    set(1, this.u.clone(), _v.copy(c).addScaledVector(this.u, -S).clone());
    set(2, this.w.clone().negate(), _v.copy(c).addScaledVector(this.w, S).clone());
    set(3, this.w.clone(), _v.copy(c).addScaledVector(this.w, -S).clone());
    set(4, UP.clone(), new THREE.Vector3(0, this.bottomY, 0));
  }

  /* ---------------- 切り口 ---------------- */

  /** 立方体の 4 辺を、内側へ INSET だけ寄せた折れ線として返す */
  _edgeLine(edge, t) {
    const S = this.half - INSET;
    // 上から見て反時計回り: (-u,-w) → (+u,-w) → (+u,+w) → (-u,+w)
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const a = corners[edge];
    const b = corners[(edge + 1) % 4];
    const ua = (a[0] + (b[0] - a[0]) * t) * S;
    const wa = (a[1] + (b[1] - a[1]) * t) * S;
    return _v.copy(this.center).addScaledVector(this.u, ua).addScaledVector(this.w, wa).clone();
  }

  _buildShell() {
    const N = this.segments;
    const shallow = this.water.uniforms.uShallow.value;
    const deep = this.water.uniforms.uDeep.value;

    const ePos = [], eNrm = [], eCol = [], eIdx = [];
    const wPos = [], wCol = [], wIdx = [];
    this._edges = [];

    for (let edge = 0; edge < 4; edge++) {
      const p0 = this._edgeLine(edge, 0);
      const p1 = this._edgeLine(edge, 1);
      const dir = p1.clone().sub(p0).normalize();
      const outward = UP.clone().cross(dir).normalize();   // 上から見て反時計回り
      /* 陰影用の法線は «真上寄り» に倒す。切り口は垂直な面なので、真面目に
         外向きの法線を入れると太陽と反対を向いた壁が環境光だけになり、
         真っ黒に潰れて断面が読めなくなる。地面と同じくらい光を拾わせつつ、
         外向き成分を少し残して 4 面の明るさに差を付ける。
         見本のジオラマが «マットな断面» に見えるのは、だいたいこの扱い */
      const shadeN = outward.clone().multiplyScalar(0.34).addScaledVector(UP, 0.66).normalize();

      const samples = [];
      for (let i = 0; i <= N; i++) {
        const p = this._edgeLine(edge, i / N);
        const h = this.terrain.heightAt(p.x, p.z);
        samples.push({ p, h });
      }
      this._edges.push({ samples, outward });

      /* --- 土の層 --- */
      const eBase = ePos.length / 3;
      for (let i = 0; i <= N; i++) {
        const { p, h } = samples[i];
        // 地形メッシュの縁と重ねるため、上端を 2cm 持ち上げる
        const top = h + 0.02;
        const span = Math.max(top - this.bottomY, 0.01);
        for (const f of EARTH_ROWS) {
          const y = top - span * f;
          ePos.push(p.x, y, p.z);
          eNrm.push(shadeN.x, shadeN.y, shadeN.z);
          const c = this._earthColor(h, f, p);
          eCol.push(c[0], c[1], c[2]);
        }
      }
      /* 巻きは «外から見て表» になる向きに揃える。DoubleSide だと three は
         裏面のとき法線を反転させるので、ここを間違えると shadeN が下向きに
         なって、切り口が全部真っ黒に落ちる */
      const ER = EARTH_ROWS.length;
      for (let i = 0; i < N; i++) {
        for (let r = 0; r < ER - 1; r++) {
          const a = eBase + i * ER + r;
          const b = a + ER;
          eIdx.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }

      /* --- 水柱 --- */
      const wBase = wPos.length / 3;
      for (let i = 0; i <= N; i++) {
        const { p, h } = samples[i];
        const bed = Math.min(h, 0);
        const depth = -bed;                              // 0 なら陸（潰れる）
        for (const f of WATER_ROWS) {
          const y = -depth * f;
          wPos.push(p.x, y, p.z);
          const c = this._waterColor(shallow, deep, depth * f, depth, f);
          wCol.push(c[0], c[1], c[2], c[3]);
        }
      }
      const WR = WATER_ROWS.length;
      for (let i = 0; i < N; i++) {
        for (let r = 0; r < WR - 1; r++) {
          const a = wBase + i * WR + r;
          const b = a + WR;
          wIdx.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }
    }

    /* --- 底面 --- */
    {
      const base = ePos.length / 3;
      const S = this.half - INSET;
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (const [a, b] of corners) {
        _v.copy(this.center).addScaledVector(this.u, a * S).addScaledVector(this.w, b * S);
        ePos.push(_v.x, this.bottomY, _v.z);
        eNrm.push(0, 1, 0);                              // 底面も潰さない
        const bc = srgb(0.26, 0.25, 0.24);
        eCol.push(bc[0], bc[1], bc[2]);
      }
      eIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    const eg = this.earthMesh.geometry;
    eg.setAttribute('position', new THREE.Float32BufferAttribute(ePos, 3));
    eg.setAttribute('normal', new THREE.Float32BufferAttribute(eNrm, 3));
    eg.setAttribute('color', new THREE.Float32BufferAttribute(eCol, 3));
    eg.setIndex(eIdx);
    eg.computeBoundingSphere();

    const wg = this.waterMesh.geometry;
    this._waterPos = new THREE.Float32BufferAttribute(wPos, 3);
    wg.setAttribute('position', this._waterPos);
    wg.setAttribute('color', new THREE.Float32BufferAttribute(wCol, 4));
    wg.setIndex(wIdx);
    wg.computeBoundingSphere();
  }

  /** 地層の色。上端からの割合 f（0=地表, 1=箱の底）で決める */
  _earthColor(surfH, f0, p) {
    /* 層の境目を横方向にうねらせる。まっすぐな縞は «塗った» ように見える */
    const f = Math.min(1, Math.max(0, f0 + strataWobble(p.x, p.z)));
    // 乾いた砂 / 濡れた泥。水面より上か下かで «地表» の色が変わる
    /* 影側の壁でも «土» に見える明るさにしておく。リニアに直すと
       sRGB 0.3 は 0.07 まで落ちるので、暗い色を置くと真っ黒に沈む */
    const dry = surfH > 0.02;
    const top = dry ? srgb(0.86, 0.78, 0.60) : srgb(0.50, 0.48, 0.36);
    const mid = srgb(0.44, 0.34, 0.24);
    const rock = srgb(0.29, 0.28, 0.27);
    const t1 = Math.min(1, f / 0.22);
    const t2 = Math.max(0, (f - 0.42) / 0.58);
    const out = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const a = top[k] + (mid[k] - top[k]) * (t1 * t1 * (3 - 2 * t1));
      out[k] = a + (rock[k] - a) * (t2 * t2 * (3 - 2 * t2));
    }
    // 地表すぐ下に明るい層を 1 本。地層らしさはこの «線» で出る
    if (f < 0.04) { for (let k = 0; k < 3; k++) out[k] *= 1.14; }
    // 深いところに細い暗帯を 2 本。«切り出した地層» はこの縞で読ませる
    for (const [lo, hi] of EARTH_BANDS) {
      if (f >= lo && f <= hi) { for (let k = 0; k < 3; k++) out[k] *= 0.78; }
    }
    // 粒のざらつき。形はうねりで出ているので、ここはごく弱く
    const n = 0.975 + hash2(p.x * 2.7 + p.z * 1.9, f * 13.7 + p.x * 0.7) * 0.05;
    for (let k = 0; k < 3; k++) out[k] = Math.min(1, out[k] * n);
    return out;
  }

  /** 水柱の色。厚みぶん濃くなる（横から見た Beer-Lambert の近似） */
  _waterColor(shallow, deep, y, total, f) {
    const d = Math.max(y, 0);
    const t = 1 - Math.exp(-d * 0.42);
    const r = shallow.r + (deep.r - shallow.r) * t;
    const g = shallow.g + (deep.g - shallow.g) * t;
    const b = shallow.b + (deep.b - shallow.b) * t;
    let a = 0.16 + t * 0.58;
    // いちばん上の 1 段だけ明るく詰める。これが «水面の線» になる
    if (f === 0) return [r * 1.5 + 0.10, g * 1.5 + 0.12, b * 1.5 + 0.14, total > 0.02 ? 0.80 : 0];
    if (total <= 0.02) a = 0;                            // 陸のところは消す
    return [r, g, b, Math.min(a, 0.78)];
  }

  /* ---------------- 毎フレーム ---------------- */

  /** 水柱の上端を波に追従させる。切り口で水が上下するのがこのモードの見せ場 */
  _updateWaterTop() {
    if (!this._waterPos) return;
    const arr = this._waterPos.array;
    const WR = WATER_ROWS.length;
    const N = this.segments;
    let vi = 0;
    for (const { samples } of this._edges) {
      for (let i = 0; i <= N; i++) {
        const { p, h } = samples[i];
        const bed = Math.min(h, 0);
        // 水面（波）と湖底のあいだを、作ったときと同じ割合で割り直す
        const surf = h < 0 ? this.water.surfaceY(p.x, p.z) : 0;
        const span = surf - bed;
        for (let r = 0; r < WR; r++) {
          arr[(vi + r) * 3 + 1] = surf - span * WATER_ROWS[r];
        }
        vi += WR;
      }
    }
    this._waterPos.needsUpdate = true;
  }

  update(dt) {
    if (!this.enabled) return;
    if (this.autoOrbit) this.orbit += dt * this.orbitSpeed;
    this._sinceRefresh = (this._sinceRefresh ?? 9) + dt;
    if (this._sinceRefresh > 0.5) { this._sinceRefresh = 0; this.refreshClipping(); }
    this._updateWaterTop();
  }

  /** 立方体を框に収めたカメラ姿勢を camera へ書く */
  applyCamera(camera) {
    const R = this.size * this.radiusMul;
    const el = this.elevation;
    const c = this.center.clone();
    c.y = this.bottomY * 0.34;                           // 少し下を狙って底まで見せる
    const flat = R * Math.cos(el);
    const eye = c.clone()
      .addScaledVector(this.u, Math.sin(this.orbit) * flat)
      .addScaledVector(this.w, -Math.cos(this.orbit) * flat)
      .addScaledVector(UP, R * Math.sin(el));
    camera.position.copy(eye);
    camera.lookAt(c);
    camera.fov = this.fov;
    camera.near = 0.08;
    camera.far = 3000;
    camera.updateProjectionMatrix();
  }

  /* ---------------- 有効・無効 ---------------- */

  _isExcluded(obj) {
    for (let o = obj; o; o = o.parent) {
      if (o === this.group) return true;
      if (this.exclude.includes(o)) return true;
    }
    return false;
  }

  /** シーン全体のマテリアルへクリップ面を配る。
      草の LOD のように «あとから出てくる» マテリアルがあるので、
      有効なあいだは定期的に呼ぶ。すでに配ったものは触らないので、
      シェーダの作り直しは起きない */
  refreshClipping() {
    if (!this.enabled) return;
    this.scene.traverse((obj) => {
      if (!obj.material || this._isExcluded(obj)) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (!mat || mat.clippingPlanes === this.planes) continue;
        // ShaderMaterial は自分でチャンクを入れたものだけ（空ドームは切らない）
        if (mat.isShaderMaterial && !mat.clipping) continue;
        this._patched.push({ mat, shadows: mat.clipShadows });
        mat.clippingPlanes = this.planes;
        mat.clipShadows = true;
      }
    });
  }

  enable(renderer) {
    if (this.enabled) return;
    this.enabled = true;
    renderer.localClippingEnabled = true;
    this.group.visible = true;
    this.refreshClipping();
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    for (const rec of this._patched) {
      rec.mat.clippingPlanes = null;
      rec.mat.clipShadows = rec.shadows;
    }
    this._patched.length = 0;
    this.group.visible = false;
  }

  /** 屈折・映り込みの撮影から外したいもの（水柱は水面の裏で二重に効くので） */
  get captureHidden() {
    return [this.waterMesh];
  }

  describe() {
    return `立方体 ${this.size.toFixed(1)}m / 底 ${this.bottomY.toFixed(2)}m`
      + ` / 方位 ${(this.orbit * 180 / Math.PI % 360).toFixed(0)}°`;
  }
}
