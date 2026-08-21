/* ===========================================================
   他プレイヤーの表示（RemotePlayer）
   ------------------------------------------------------------
   自分の Angler と違って入力・カメラ・竿の計算は持たない。
   サーバーから来る位置・向き・アクションを補間して見せるだけ。
   モデルは Angler と同じ glTF（Quaternius / CC0）を 1 度だけ読み、
   プレイヤーごとに SkeletonUtils.clone で複製する。
   =========================================================== */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { clamp01, damp, TAU } from '../util.js';
import { t } from '../i18n.js';

const MODEL_URL = './assets/models/player-lowpoly.glb';
const WALK_SPEED = 3.1;   // 自分の歩き速度と同じ。歩きアニメの重み付けに使う

const _v = new THREE.Vector3();

/** 頭上の名前ラベル（canvas → Sprite） */
function makeLabel(name) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  g.font = '600 30px "Hiragino Sans", "Noto Sans JP", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // 縁取りで背景の空・水のどちらでも読めるように
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(10, 22, 34, 0.85)';
  g.strokeText(name, 128, 34);
  g.fillStyle = '#eaf4ff';
  g.fillText(name, 128, 34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, fog: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.7, 0.42, 1);
  sprite.renderOrder = 7;
  return sprite;
}

class RemotePlayer {
  constructor(scene, gltf, info) {
    this.scene = scene;
    this.id = info.id;
    this.name = info.name || '';
    this.action = info.a || 'idle';
    this.group = new THREE.Group();

    const model = cloneSkeleton(gltf.scene);
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
      }
    });
    this.group.add(model);

    // 歩きと待機はアセット付属のアニメーションを速度で混ぜる（Angler と同じ考え方）
    this.mixer = new THREE.AnimationMixer(model);
    const clip = (n) => gltf.animations.find((a) => a.name === n);
    this.actIdle = this.mixer.clipAction(clip('Idle'));
    this.actWalk = this.mixer.clipAction(clip('Walk'));
    this.actIdle.play();
    this.actWalk.play();
    this.actWalk.setEffectiveWeight(0);
    // 全員の足並みが揃って見えないよう、再生位置をずらす
    this.mixer.update(Math.random() * 2);

    this.label = makeLabel(this.name);
    this.label.position.y = 2.1;
    this.group.add(this.label);

    this.target = new THREE.Vector3(info.x || 0, info.y || 0, info.z || 0);
    this.yawTarget = info.yaw || 0;
    this.yaw = this.yawTarget;
    this.speed = 0;
    /* 初回の welcome には位置がまだ無い（0,0,0）ことがある。
       最初の状態を受け取るまでは見せず、届いた瞬間にその場へ置く */
    this.hasPos = isFinite(info.x) && (info.x !== 0 || info.z !== 0);
    this.group.position.copy(this.target);
    this.group.rotation.y = this.yaw;
    this.group.visible = this.hasPos;
    scene.add(this.group);
  }

  setState(s) {
    this.target.set(s.x, s.y, s.z);
    this.yawTarget = s.yaw || 0;
    this.action = s.a || 'idle';
    if (!this.hasPos) {
      // 初回はワープさせてから補間に切り替える
      this.hasPos = true;
      this.group.position.copy(this.target);
      this.yaw = this.yawTarget;
      this.group.visible = true;
    }
  }

  update(dt) {
    if (!this.hasPos) return;
    const p = this.group.position;
    _v.copy(p);
    // 受信は 10Hz・描画は 60fps なので、受信位置へは damp で寄せる（瞬間移動させない）
    p.x = damp(p.x, this.target.x, 10, dt);
    p.y = damp(p.y, this.target.y, 10, dt);
    p.z = damp(p.z, this.target.z, 10, dt);
    // 実際に動いた速さから歩き・走りのアニメを決める（補間と必ず一致する）
    const spd = Math.hypot(p.x - _v.x, p.z - _v.z) / Math.max(dt, 1e-4);
    this.speed = damp(this.speed, spd, 6, dt);

    let d = this.yawTarget - this.yaw;
    d = ((d + Math.PI) % TAU + TAU) % TAU - Math.PI;   // 最短方向に回す
    this.yaw += d * (1 - Math.exp(-10 * dt));
    this.group.rotation.y = this.yaw;

    const mv = clamp01(this.speed / WALK_SPEED);
    this.actWalk.setEffectiveWeight(mv);
    this.actIdle.setEffectiveWeight(1 - mv);
    this.actWalk.setEffectiveTimeScale(0.85 + mv * 0.5);
    this.mixer.update(dt);
  }

  dispose() {
    this.scene.remove(this.group);
    // モデルのジオメトリ・マテリアルは元 glTF と共有なので捨てない。ラベルだけ自前
    this.label.material.map.dispose();
    this.label.material.dispose();
  }
}

export class RemotePlayers {
  constructor(scene) {
    this.scene = scene;
    this.gltf = null;
    this.map = new Map();   // id -> RemotePlayer
  }

  async load(onProgress) {
    if (onProgress) await onProgress(t('ui.loadingPlayers'));
    this.gltf = await new GLTFLoader().loadAsync(MODEL_URL);
  }

  /** 参加・状態更新のどちらもこれ 1 本で受ける */
  upsert(info) {
    if (!this.gltf || !info || !info.id) return;
    const cur = this.map.get(info.id);
    if (cur) {
      cur.setState(info);
      return;
    }
    this.map.set(info.id, new RemotePlayer(this.scene, this.gltf, info));
  }

  remove(id) {
    const p = this.map.get(id);
    if (!p) return;
    p.dispose();
    this.map.delete(id);
  }

  nameOf(id) {
    const p = this.map.get(id);
    return p ? p.name : '';
  }

  get count() { return this.map.size; }

  update(dt) {
    for (const p of this.map.values()) p.update(dt);
  }
}
