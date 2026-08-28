/* ===========================================================
   LOD 付き InstancedMesh の管理（植生共通）

   「見た目 1 種類（種 × バリエーション）」ごとに LOD 段の描画パーツを
   登録しておき、カメラ距離で各株を段へ振り分ける。
   段が変わった株があったときだけ行列を作り直して再アップロードする。

   1 株が持つのは座標・向き・大きさ・色ムラだけで、ジオメトリは
   «高さ 1 に正規化したもの» を共有する（scale がそのまま実寸になる）。
   =========================================================== */
import * as THREE from 'three';
import { lodForList } from './util.js';

export class LodInstances {
  /**
   * @param {THREE.Scene} scene
   * @param {{lodDist: number[], hysteresis?: number, interval?: number}} opts
   *   lodDist    昇順のしきい値。最後の値より遠い株は最終段になる
   *   hysteresis 境界の遊び幅（m）。往復での作り直しを防ぐ
   *   interval   振り直しの最短間隔（秒）
   */
  constructor(scene, { lodDist, hysteresis = 8, interval = 0.15 } = {}) {
    this.scene = scene;
    this.lodDist = lodDist;
    this.hysteresis = hysteresis;
    this.interval = interval;
    this.items = [];
    this.meshes = [];
    this.buckets = new Map();   // `${key}|${lod}` -> InstancedMesh[]
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
    for (const p of parts) {
      const im = new THREE.InstancedMesh(p.geo, p.mat, capacity);
      im.count = 0;
      im.castShadow = !!p.shadow;
      im.receiveShadow = false;
      /* 株は湖の全周に散るので、ジオメトリの境界球で判定させると
         カメラの向きによって群落ごと消える。個別カリングに任せる */
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(im);
      this.meshes.push(im);
      list.push(im);
    }
    this.buckets.set(`${key}|${lod}`, list);
    return list;
  }

  /** ある段のパーツを差し替える（遠景インポスターを後から焼いたときなど） */
  replace(key, lod, parts) {
    const list = this.buckets.get(`${key}|${lod}`);
    if (!list) return;
    for (let i = 0; i < list.length && i < parts.length; i++) {
      if (parts[i].geo) list[i].geometry = parts[i].geo;
      if (parts[i].mat) list[i].material = parts[i].mat;
    }
    this._dirty = true;
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
      x, y, z, sx: s.x, sy: s.y, sz: s.z, key, ry, lod: -1,
      cr: tint ? tint.r : 1, cg: tint ? tint.g : 1, cb: tint ? tint.b : 1,
      tinted: !!tint,
    });
    this._dirty = true;
  }

  /** カメラ距離で段を振り直す。変化があったときだけ行列を作り直す */
  update(dt, cameraPos) {
    this._timer -= dt;
    if (this._timer > 0 && !this._dirty) return;
    this._timer = this.interval;

    let changed = this._dirty;
    for (const it of this.items) {
      const d = Math.hypot(it.x - cameraPos.x, it.y - cameraPos.y, it.z - cameraPos.z);
      const l = lodForList(d, this.lodDist, it.lod, this.hysteresis);
      if (l !== it.lod) { it.lod = l; changed = true; }
    }
    if (!changed) return;
    this._dirty = false;
    this.rebuild();
  }

  rebuild() {
    const counts = new Map();
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();

    for (const list of this.buckets.values()) for (const im of list) counts.set(im, 0);

    for (const it of this.items) {
      const list = this.buckets.get(`${it.key}|${it.lod}`);
      if (!list) continue;                     // 最終段より遠い＝描かない
      p.set(it.x, it.y, it.z);
      q.setFromAxisAngle(up, it.ry);
      s.set(it.sx, it.sy, it.sz);
      m.compose(p, q, s);
      col.setRGB(it.cr, it.cg, it.cb);
      for (const im of list) {
        const n = counts.get(im);
        if (n >= im.instanceMatrix.count) continue;
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
  }

  /** 段ごとの株数（デバッグ／テスト用） */
  counts() {
    const out = new Array(this.lodDist.length + 1).fill(0);
    for (const it of this.items) if (it.lod >= 0) out[it.lod]++;
    return out;
  }

  dispose() {
    for (const im of this.meshes) {
      this.scene.remove(im);
      im.geometry.dispose();
    }
    this.meshes.length = 0;
    this.buckets.clear();
    this.items.length = 0;
  }
}

/**
 * 位置から決める株ごとの色ムラ。
 * 同じ緑が何百株も並ぶと、形をいくら作り込んでも «同じ物を並べた» と分かる。
 * seed ではなく座標から決めるので、ワールドは再現できる。
 * @param {number} x
 * @param {number} z
 * @param {number} valSpan 明るさの振れ幅
 * @param {number} warmSpan 色温度の振れ幅（+ で黄寄り, - で青寄り）
 */
export function tintAt(x, z, valSpan = 0.30, warmSpan = 0.16) {
  const hp = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  const hb = Math.sin(x * 39.3468 - z * 11.135) * 24634.6345;
  const a = hp - Math.floor(hp), b = hb - Math.floor(hb);
  const val = 1 - valSpan * 0.5 + a * valSpan;
  const warm = (b - 0.5) * warmSpan;
  return { r: val * (1 + warm), g: val, b: val * (1 - warm) };
}
