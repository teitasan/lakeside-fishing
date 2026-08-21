import * as THREE from 'three';
import { Fish, createFishMaterial } from '../fish.js';
import { REAL_FISH } from '../data.js';

const SPECIES = new Map(REAL_FISH.map((sp) => [sp.id, sp]));

export class RemoteFishSchool {
  constructor(scene) {
    this.scene = scene;
    this.geoCache = new Map();
    this.map = new Map();
    this.targets = new Map();
  }

  applySnapshot(items) {
    const seen = new Set();
    for (const s of items || []) {
      const sp = SPECIES.get(s.speciesId);
      if (!sp || !s.id) continue;
      seen.add(s.id);
      let f = this.map.get(s.id);
      if (!f) {
        f = new Fish(this.geoCache, () => createFishMaterial(0.4));
        this.scene.add(f.mesh);
        f.spawn(sp, s.length, new THREE.Vector3(s.x, s.y, s.z), { albino: !!s.albino });
        f.networkId = s.id;
        this.map.set(s.id, f);
      }
      f.networkState = s.state;
      f.networkOwner = s.ownerPlayerId || null;
      // 自分がファイト中の魚は既存fightロジックが位置を決める。
      if (f.state !== 'hooked') this.targets.set(s.id, new THREE.Vector3(s.x, s.y, s.z));
    }
    for (const [id, f] of this.map) {
      if (seen.has(id)) continue;
      f.despawn();
      this.scene.remove(f.mesh);
      this.map.delete(id);
      this.targets.delete(id);
    }
  }

  get(id) { return this.map.get(id) || null; }

  update(dt) {
    for (const [id, f] of this.map) {
      if (!f.active || f.state === 'hooked' || f.state === 'landed') continue;
      const target = this.targets.get(id);
      if (!target) continue;
      const oldX = f.pos.x, oldZ = f.pos.z;
      const k = 1 - Math.exp(-9 * dt);
      f.pos.lerp(target, k);
      f.mesh.position.copy(f.pos);
      const dx = f.pos.x - oldX, dz = f.pos.z - oldZ;
      if (dx * dx + dz * dz > 1e-7) {
        const dir = new THREE.Vector3(dx, 0, dz).normalize();
        f._orient(dt, dir, 0);
        f._wiggle(dt, 2.2, 0.07);
      }
    }
  }

  dispose() {
    for (const f of this.map.values()) {
      f.despawn();
      this.scene.remove(f.mesh);
    }
    this.map.clear();
    this.targets.clear();
  }
}
