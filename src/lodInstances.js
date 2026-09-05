/* ===========================================================
   LOD 付き InstancedMesh の管理（植生共通）

   「見た目 1 種類（種 × バリエーション）」ごとに LOD 段の描画パーツを
   登録しておき、カメラ距離で各株を段へ振り分ける。
   段が変わった株があったときだけ行列を作り直して再アップロードする。

   1 株が持つのは座標・向き・大きさ・色ムラだけで、ジオメトリは
   «高さ 1 に正規化したもの» を共有する（scale がそのまま実寸になる）。
   =========================================================== */
import * as THREE from 'three';
import { lodForList, lodFadeMate } from './util.js?v=20260830-zone5';
export { tintAt } from './util.js?v=20260830-zone5';

/* 枠を自動で広げるときの上限（登録時の何倍まで）。
   青天井にするとバグで際限なく確保してしまう */
const GROW_LIMIT = 8;

export class LodInstances {
  /**
   * @param {THREE.Scene} scene
   * @param {{lodDist: number[], hysteresis?: number, interval?: number}} opts
   *   lodDist    昇順のしきい値。最後の値より遠い株は最終段になる
   *   hysteresis 境界の遊び幅（m）。往復での作り直しを防ぐ
   *   interval   振り直しの最短間隔（秒）
   */
  constructor(scene, { lodDist, hysteresis = 8, interval = 0.15, fadeBand = 0 } = {}) {
    this.scene = scene;
    this.lodDist = lodDist;
    this.hysteresis = hysteresis;
    this.interval = interval;
    /* 境界の前後この幅だけ «両方の段» を描き、画面空間のディザで
       それぞれを間引いてクロスフェードする（materialPatch.lodDitherFade）。
       0 なら従来どおり瞬時に切り替わる */
    this.fadeBand = fadeBand;
    this._lodDistKey = lodDist.join(',');
    this.maxLod = -1;
    this.items = [];
    /* 動かない株。カメラがどう動いても段が変わらないと «配置のときに»
       分かっているものは、こちらへ入れて 1 回だけ書く。以後 update も
       rebuild も触らないので、何万本あっても毎フレームの費用は増えない */
    this.fixed = [];
    this.meshes = [];
    this.buckets = new Map();   // `${key}|${lod}` -> InstancedMesh[]
    this.fixedBuckets = new Map();
    this._dirty = true;
    this._timer = 0;
  }

  /**
   * 1 つの見た目の、ある LOD 段の描画パーツを登録する。
   * @param {string} key 見た目の識別子（`種|バリエーション` など）
   * @param {number} lod 段（0 が最も細かい）
   * @param {Array<{geo: THREE.BufferGeometry, mat: THREE.Material, shadow?: boolean}>} parts
   * @param {number} capacity この段が同時に抱えられる最大株数
   */
  register(key, lod, parts, capacity) {
    const list = [];
    /* この段が受け持つ距離の範囲。マテリアルは段をまたいで共有するので、
       範囲は «頂点属性» で渡す（0 以下は «境界なし» の意味） */
    const lo = lod === 0 ? -1 : this.lodDist[lod - 1];
    const hi = lod < this.lodDist.length ? this.lodDist[lod] : -1;
    for (const p of parts) {
      const geo = this.fadeBand > 0 ? withLodBand(p.geo, lo, hi) : p.geo;
      const im = new THREE.InstancedMesh(geo, p.mat, capacity);
      im.count = 0;
      im.castShadow = !!p.shadow;
      im.receiveShadow = false;
      /* 株は湖の全周に散るので、ジオメトリの境界球で判定させると
         カメラの向きによって群落ごと消える。個別カリングに任せる */
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.userData.baseCap = capacity;
      this.scene.add(im);
      this.meshes.push(im);
      list.push(im);
    }
    this.buckets.set(`${key}|${lod}`, list);
    this.maxLod = Math.max(this.maxLod, lod);
    return list;
  }

  /** ある段のパーツを差し替える（遠景インポスターを後から焼いたときなど） */
  replace(key, lod, parts) {
    const lo = lod === 0 ? -1 : this.lodDist[lod - 1];
    const hi = lod < this.lodDist.length ? this.lodDist[lod] : -1;
    const replacements = parts.map(p => p.geo && this.fadeBand > 0
      ? withLodBand(p.geo, lo, hi) : p.geo);
    for (const map of [this.buckets, this.fixedBuckets]) {
      const list = map.get(`${key}|${lod}`);
      if (!list) continue;
      for (let i = 0; i < list.length && i < parts.length; i++) {
        if (replacements[i]) list[i].geometry = replacements[i];
        if (parts[i].mat) list[i].material = parts[i].mat;
      }
    }
    this._dirty = true;
  }

  /**
   * 段が決まっている株を足す（プレイヤーが絶対に近づけないもの）。
   *
   * 動く株と違って毎フレームの距離判定も行列の作り直しも要らない。
   * 配置がぜんぶ終わったら buildFixed() を 1 回呼ぶ。
   */
  addFixed(x, y, z, scale, key, lod, ry = 0, tint = null) {
    const s = typeof scale === 'number' ? { x: scale, y: scale, z: scale } : scale;
    this.fixed.push({
      x, y, z, sx: s.x, sy: s.y, sz: s.z, key, lod, ry,
      cr: tint ? tint.r : 1, cg: tint ? tint.g : 1, cb: tint ? tint.b : 1,
      tinted: !!tint,
    });
  }

  /** addFixed で溜めた株を、段ごとにぴったりの枠へ 1 回だけ書き込む */
  buildFixed() {
    if (!this.fixed.length) return 0;
    const need = new Map();
    for (const it of this.fixed) {
      const k = `${it.key}|${it.lod}`;
      need.set(k, (need.get(k) || 0) + 1);
    }
    for (const [k, n] of need) {
      const src = this.buckets.get(k);
      if (!src) continue;                  // その段を持たない＝描かない
      const list = [];
      for (const im of src) {
        const next = new THREE.InstancedMesh(im.geometry, im.material, n);
        next.count = 0;
        next.castShadow = im.castShadow;
        next.receiveShadow = im.receiveShadow;
        next.frustumCulled = false;
        // 動かないので毎フレーム送り直さない
        next.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        this.scene.add(next);
        this.meshes.push(next);
        list.push(next);
      }
      this.fixedBuckets.set(k, list);
    }

    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const counts = new Map();
    for (const it of this.fixed) {
      const list = this.fixedBuckets.get(`${it.key}|${it.lod}`);
      if (!list) continue;
      p.set(it.x, it.y, it.z);
      q.setFromAxisAngle(up, it.ry);
      sc.set(it.sx, it.sy, it.sz);
      m.compose(p, q, sc);
      col.setRGB(it.cr, it.cg, it.cb);
      for (const im of list) {
        const n = counts.get(im) || 0;
        im.setMatrixAt(n, m);
        if (it.tinted) im.setColorAt(n, col);
        counts.set(im, n + 1);
      }
    }
    for (const [im, n] of counts) {
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    return this.fixed.length;
  }

  /**
   * 株を 1 つ足す。
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number|{x:number,y:number,z:number}} scale 実寸（ジオメトリは高さ 1 想定）
   * @param {string} key register で使った識別子
   * @param {number} ry Y 軸まわりの向き（rad）
   * @param {{r:number,g:number,b:number}|null} tint 株ごとの色ムラ
   */
  add(x, y, z, scale, key, ry = 0, tint = null) {
    const s = typeof scale === 'number' ? { x: scale, y: scale, z: scale } : scale;
    this.items.push({
      x, y, z, sx: s.x, sy: s.y, sz: s.z, key, ry, lod: -1, lod2: -1,
      cr: tint ? tint.r : 1, cg: tint ? tint.g : 1, cb: tint ? tint.b : 1,
      tinted: !!tint,
    });
    this._dirty = true;
  }

  /** setLodScale などで lodDist が変わったあと、頂点属性 aLodBand を同期する */
  _syncLodBands() {
    if (this.fadeBand <= 0) return;
    const key = this.lodDist.join(',');
    if (key === this._lodDistKey) return;
    this._lodDistKey = key;
    this._dirty = true;
    for (const [bk, list] of this.buckets) {
      const lod = Number(bk.slice(bk.lastIndexOf('|') + 1));
      const lo = lod === 0 ? -1 : this.lodDist[lod - 1];
      const hi = lod < this.lodDist.length ? this.lodDist[lod] : -1;
      for (const im of list) {
        const attr = im.geometry.getAttribute('aLodBand');
        if (!attr) continue;
        const arr = attr.array;
        for (let i = 0; i < arr.length; i += 2) { arr[i] = lo; arr[i + 1] = hi; }
        attr.needsUpdate = true;
      }
    }
  }

  /** カメラ距離で段を振り直す。変化があったときだけ行列を作り直す */
  update(dt, cameraPos) {
    this._syncLodBands();
    this._timer -= dt;
    if (this._timer > 0 && !this._dirty) return;
    this._timer = this.interval;

    let changed = this._dirty;
    const band = this.fadeBand;
    for (const it of this.items) {
      const d = Math.hypot(it.x - cameraPos.x, it.y - cameraPos.y, it.z - cameraPos.z);
      const l = lodForList(d, this.lodDist, it.lod, this.hysteresis);
      /* 境界の帯では主段 l と隣接段のもう一方を両方描く。
         帯の内外だけで隣段を決めるとヒステリシスと食い違い、
         フェード中の片方だけが残ってポッと消える */
      const l2 = lodFadeMate(d, this.lodDist, l, band, this.maxLod);
      if (l !== it.lod || l2 !== it.lod2) { it.lod = l; it.lod2 = l2; changed = true; }
    }
    if (!changed) return;
    this._dirty = false;
    this.rebuild();
  }

  /** 各段が今回いくつ抱えるか。書き込む前に数える（枠が足りるかの判断に使う） */
  _demand() {
    const demand = new Map();
    for (const list of this.buckets.values()) for (const im of list) demand.set(im, 0);
    for (const it of this.items) {
      // 帯の中の株は 2 段ぶん要る（片方はディザで間引かれて消える）
      for (const lod of [it.lod, it.lod2]) {
        if (lod < 0) continue;
        const list = this.buckets.get(`${it.key}|${lod}`);
        if (!list) continue;                   // 最終段より遠い＝描かない
        for (const im of list) demand.set(im, demand.get(im) + 1);
      }
    }
    return demand;
  }

  /**
   * 枠が足りない段を張り替える。
   *
   * InstancedMesh の枠は作ったあと増やせないので、大きいものを作って差し替える。
   * ジオメトリとマテリアルは使い回すので、増えるのは行列と色のバッファだけ。
   */
  _grow(im, need) {
    const base = im.userData.baseCap || im.instanceMatrix.count;
    const cap = Math.min(Math.ceil(need * 1.3) + 8, base * GROW_LIMIT);
    if (cap <= im.instanceMatrix.count) {
      if (!this._grewWarned) {
        this._grewWarned = true;
        console.warn(`LodInstances: 枠の上限（登録時の ${GROW_LIMIT} 倍）に達した。`
          + `${need} 株ぶん要るが ${im.instanceMatrix.count} までしか描けない`);
      }
      return null;
    }
    const next = new THREE.InstancedMesh(im.geometry, im.material, cap);
    next.count = 0;
    next.castShadow = im.castShadow;
    next.receiveShadow = im.receiveShadow;
    next.frustumCulled = false;
    next.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    next.userData.baseCap = base;
    this.scene.add(next);
    this.scene.remove(im);
    const i = this.meshes.indexOf(im);
    if (i >= 0) this.meshes[i] = next;
    im.dispose();   // ジオメトリとマテリアルは next が引き継ぐので捨てない
    return next;
  }

  rebuild() {
    /* まず «いくつ要るか» を数えて、足りない段は枠を広げてから書き込む。
       以前はここで溢れたぶんを黙って捨てていた。捨てられる株はカメラの位置で
       変わるので、近づくと株が消え、視点を振ると戻る、という見え方になっていた
       （クロスフェードで帯の中の株が 2 段ぶん枠を食うようになって表面化した） */
    const demand = this._demand();
    for (const list of this.buckets.values()) {
      for (let i = 0; i < list.length; i++) {
        const im = list[i];
        const need = demand.get(im) || 0;
        if (need <= im.instanceMatrix.count) continue;
        const grown = this._grow(im, need);
        if (!grown) continue;
        demand.delete(im);
        demand.set(grown, need);
        list[i] = grown;
      }
    }

    const counts = new Map();
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();

    for (const list of this.buckets.values()) for (const im of list) counts.set(im, 0);

    for (const it of this.items) {
      p.set(it.x, it.y, it.z);
      q.setFromAxisAngle(up, it.ry);
      s.set(it.sx, it.sy, it.sz);
      m.compose(p, q, s);
      col.setRGB(it.cr, it.cg, it.cb);
      for (const lod of [it.lod, it.lod2]) {
        if (lod < 0) continue;
        const list = this.buckets.get(`${it.key}|${lod}`);
        if (!list) continue;
        for (const im of list) {
          const n = counts.get(im);
          if (n >= im.instanceMatrix.count) continue;   // 上限に達した段だけ
          im.setMatrixAt(n, m);
          if (it.tinted) im.setColorAt(n, col);
          counts.set(im, n + 1);
        }
      }
    }
    for (const [im, n] of counts) {
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }

  /** 段ごとの株数（デバッグ／テスト用） */
  counts() {
    const out = new Array(this.lodDist.length + 1).fill(0);
    for (const it of this.items) if (it.lod >= 0) out[it.lod]++;
    for (const it of this.fixed) if (it.lod >= 0) out[it.lod]++;
    return out;
  }

  dispose() {
    for (const im of this.meshes) {
      this.scene.remove(im);
      im.geometry.dispose();
    }
    this.meshes.length = 0;
    this.buckets.clear();
    this.fixedBuckets.clear();
    this.items.length = 0;
    this.fixed.length = 0;
  }
}

/**
 * «この段が受け持つ距離» を持たせたジオメトリを返す。
 * 属性バッファは共有したまま、別の BufferGeometry として包む
 * （同じジオメトリを別の段でも使うことがあるので、上書きしない）。
 */
function withLodBand(geo, lo, hi) {
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) out.setAttribute(name, attr);
  if (geo.index) out.setIndex(geo.index);
  const n = geo.attributes.position.count;
  const band = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { band[i * 2] = lo; band[i * 2 + 1] = hi; }
  out.setAttribute('aLodBand', new THREE.BufferAttribute(band, 2));
  out.userData.lodBandSource = geo;
  return out;
}
